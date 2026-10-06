import { z } from "zod";
import { withUserDb, many, one } from "@/lib/db/pool";
import { change, comparisonRange, num, round, safeDiv, smallSampleWarning, type DateRange } from "@/lib/analytics/common";

/**
 * Search Console analytics. All aggregation is SQL; ratios are recomputed from sums:
 * CTR = clicks / impressions; average position = Σ(position×impressions) / Σ impressions.
 * Queries run under the user's RLS context.
 */
export type GscTotals = { clicks: number; impressions: number; ctr: number | null; position: number | null };

const TOTALS_SQL = `select coalesce(sum(clicks),0)::float8 as clicks, coalesce(sum(impressions),0)::float8 as impressions,
  coalesce(sum(position_impressions),0)::float8 as position_impressions`;

function totalsFromRow(r: { clicks: number; impressions: number; position_impressions: number } | null): GscTotals {
  const clicks = num(r?.clicks);
  const impressions = num(r?.impressions);
  return { clicks, impressions, ctr: round(safeDiv(clicks, impressions), 4), position: round(safeDiv(num(r?.position_impressions), impressions), 1) };
}

export type BrandFilter = "all" | "brand" | "non_brand";

function brandCondition(brandQueries: string[], filter: BrandFilter, paramIndex: number): { sql: string; params: unknown[] } {
  if (filter === "all" || brandQueries.length === 0) return { sql: "", params: [] };
  const patterns = brandQueries.map((b) => `%${b.toLowerCase()}%`);
  const op = filter === "brand" ? "" : "not ";
  return { sql: ` and ${op}(lower(query) like any($${paramIndex}::text[]))`, params: [patterns] };
}

export async function getSearchPerformance(
  userId: string,
  websiteId: string,
  range: DateRange,
  opts: { compare: boolean; breakdown: "none" | "date" | "device" | "country"; brandQueries: string[] },
) {
  const prev = comparisonRange(range);
  return withUserDb(userId, async (db) => {
    const cur = await one<{ clicks: number; impressions: number; position_impressions: number }>(
      db,
      `${TOTALS_SQL} from public.gsc_daily_totals where website_id = $1 and date between $2 and $3`,
      [websiteId, range.start, range.end],
    );
    const current = totalsFromRow(cur);
    let previous: GscTotals | null = null;
    if (opts.compare) {
      const p = await one<{ clicks: number; impressions: number; position_impressions: number }>(
        db,
        `${TOTALS_SQL} from public.gsc_daily_totals where website_id = $1 and date between $2 and $3`,
        [websiteId, prev.start, prev.end],
      );
      previous = totalsFromRow(p);
    }

    let breakdown: Array<Record<string, unknown>> = [];
    if (opts.breakdown === "date") {
      const rows = await many<{ date: string; clicks: number; impressions: number; position_impressions: number }>(
        db,
        `select date::text as date, ${TOTALS_SQL.replace("select ", "")} from public.gsc_daily_totals where website_id = $1 and date between $2 and $3 group by date order by date`,
        [websiteId, range.start, range.end],
      );
      breakdown = rows.map((r) => ({ date: r.date, ...totalsFromRow(r) }));
    } else if (opts.breakdown === "device" || opts.breakdown === "country") {
      const table = opts.breakdown === "device" ? "gsc_device_daily" : "gsc_country_daily";
      const rows = await many<{ key: string; clicks: number; impressions: number; position_impressions: number }>(
        db,
        `select ${opts.breakdown} as key, ${TOTALS_SQL.replace("select ", "")} from public.${table} where website_id = $1 and date between $2 and $3 group by ${opts.breakdown} order by sum(clicks) desc limit 25`,
        [websiteId, range.start, range.end],
      );
      breakdown = rows.map((r) => ({ [opts.breakdown]: r.key, ...totalsFromRow(r) }));
    }

    let brandSplit: { brand: GscTotals; non_brand: GscTotals } | null = null;
    if (opts.brandQueries.length > 0) {
      const b = brandCondition(opts.brandQueries, "brand", 4);
      const brand = await one<{ clicks: number; impressions: number; position_impressions: number }>(
        db,
        `${TOTALS_SQL} from public.gsc_query_daily where website_id = $1 and date between $2 and $3${b.sql}`,
        [websiteId, range.start, range.end, ...b.params],
      );
      const nb = brandCondition(opts.brandQueries, "non_brand", 4);
      const nonBrand = await one<{ clicks: number; impressions: number; position_impressions: number }>(
        db,
        `${TOTALS_SQL} from public.gsc_query_daily where website_id = $1 and date between $2 and $3${nb.sql}`,
        [websiteId, range.start, range.end, ...nb.params],
      );
      brandSplit = { brand: totalsFromRow(brand), non_brand: totalsFromRow(nonBrand) };
    }

    const warnings: string[] = [];
    if (previous) {
      const w = smallSampleWarning("Click comparison", current.clicks, previous.clicks);
      if (w) warnings.push(w);
    }
    if (current.impressions === 0) warnings.push("No Search Console data in this date range.");

    return {
      date_range: range,
      comparison_range: opts.compare ? prev : null,
      totals: current,
      previous_totals: previous,
      changes: previous
        ? {
            clicks: change(current.clicks, previous.clicks, 0),
            impressions: change(current.impressions, previous.impressions, 0),
            ctr: change(current.ctr ?? 0, previous.ctr ?? 0, 4),
            position: change(current.position ?? 0, previous.position ?? 0, 1),
          }
        : null,
      breakdown: opts.breakdown === "none" ? null : { by: opts.breakdown, rows: breakdown },
      brand_split: brandSplit,
      warnings,
    };
  });
}

export const QuerySort = z.enum(["clicks", "impressions", "ctr", "position", "clicks_change", "impressions_change", "opportunity"]);
export type QuerySort = z.infer<typeof QuerySort>;

type DimRow = { key: string; clicks: number; impressions: number; position_impressions: number; prev_clicks: number; prev_impressions: number; prev_position_impressions: number };

/**
 * Expected CTR by average position (a conservative, widely published shape; used only to
 * rank "opportunity", never reported as a measured value). Position 1 ≈ 0.28 … position 10 ≈ 0.02.
 */
export function expectedCtrForPosition(position: number): number {
  const table = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.022, 0.02];
  if (position <= 1) return table[0];
  if (position >= 10) return Math.max(0.005, 0.02 * (10 / position));
  const lo = Math.floor(position);
  const frac = position - lo;
  return table[lo - 1] + (table[lo] - table[lo - 1]) * frac;
}

export function opportunityScore(row: { impressions: number; ctr: number | null; position: number | null }): number {
  if (!row.position || row.impressions < 50) return 0;
  const expected = expectedCtrForPosition(row.position);
  const gap = Math.max(0, expected - (row.ctr ?? 0));
  return round(gap * row.impressions, 1) ?? 0; // ≈ clicks left on the table
}

async function dimensionReport(
  userId: string,
  websiteId: string,
  table: "gsc_query_daily" | "gsc_page_daily",
  dim: "query" | "page",
  range: DateRange,
  opts: { limit: number; sort: QuerySort; minImpressions: number; brand: BrandFilter; brandQueries: string[]; contains: string | null },
) {
  const prev = comparisonRange(range);
  const params: unknown[] = [websiteId, range.start, range.end, prev.start, prev.end];
  let where = "";
  if (dim === "query") {
    const b = brandCondition(opts.brandQueries, opts.brand, params.length + 1);
    where += b.sql;
    params.push(...b.params);
  }
  if (opts.contains) {
    params.push(`%${opts.contains.toLowerCase()}%`);
    where += ` and lower(${dim}) like $${params.length}`;
  }
  const rows = await withUserDb(userId, (db) =>
    many<DimRow>(
      db,
      `select ${dim} as key,
         sum(clicks) filter (where date between $2 and $3)::float8 as clicks,
         sum(impressions) filter (where date between $2 and $3)::float8 as impressions,
         sum(position_impressions) filter (where date between $2 and $3)::float8 as position_impressions,
         sum(clicks) filter (where date between $4 and $5)::float8 as prev_clicks,
         sum(impressions) filter (where date between $4 and $5)::float8 as prev_impressions,
         sum(position_impressions) filter (where date between $4 and $5)::float8 as prev_position_impressions
       from public.${table}
       where website_id = $1 and date between $4 and $3${where}
       group by ${dim}
       having coalesce(sum(impressions) filter (where date between $2 and $3), 0) >= ${Math.max(0, Math.floor(opts.minImpressions))}
          or coalesce(sum(impressions) filter (where date between $4 and $5), 0) > 0
       limit 5000`,
      params,
    ),
  );
  const enriched = rows.map((r) => {
    const current = totalsFromRow({ clicks: num(r.clicks), impressions: num(r.impressions), position_impressions: num(r.position_impressions) });
    const previous = totalsFromRow({ clicks: num(r.prev_clicks), impressions: num(r.prev_impressions), position_impressions: num(r.prev_position_impressions) });
    return {
      [dim]: r.key,
      ...current,
      previous,
      clicks_change: change(current.clicks, previous.clicks, 0),
      impressions_change: change(current.impressions, previous.impressions, 0),
      position_change: current.position !== null && previous.position !== null ? round(current.position - previous.position, 1) : null,
      opportunity_score: opportunityScore(current),
    };
  });
  const sorters: Record<QuerySort, (a: (typeof enriched)[number], b: (typeof enriched)[number]) => number> = {
    clicks: (a, b) => b.clicks - a.clicks,
    impressions: (a, b) => b.impressions - a.impressions,
    ctr: (a, b) => (b.ctr ?? 0) - (a.ctr ?? 0),
    position: (a, b) => (a.position ?? 999) - (b.position ?? 999),
    clicks_change: (a, b) => a.clicks_change.change - b.clicks_change.change,
    impressions_change: (a, b) => b.impressions_change.change - a.impressions_change.change,
    opportunity: (a, b) => b.opportunity_score - a.opportunity_score,
  };
  const sorted = enriched
    .filter((r) => r.impressions >= opts.minImpressions || opts.sort === "clicks_change")
    .filter((r) => opts.sort !== "opportunity" || r.opportunity_score > 0)
    .sort(sorters[opts.sort])
    .slice(0, opts.limit);
  return {
    date_range: range,
    comparison_range: prev,
    total_rows_considered: rows.length,
    rows: sorted,
    notes: [
      "Rows limited to the top rows per day stored during sync; Google excludes anonymized (rare) queries, so query-level totals are lower than property totals.",
      "opportunity_score ≈ estimated extra clicks if CTR reached a typical CTR for the row's average position; a ranking heuristic, not a measured value.",
    ],
  };
}

export const getSearchQueries = (userId: string, websiteId: string, range: DateRange, opts: Parameters<typeof dimensionReport>[5]) =>
  dimensionReport(userId, websiteId, "gsc_query_daily", "query", range, opts);
export const getSearchPages = (userId: string, websiteId: string, range: DateRange, opts: Parameters<typeof dimensionReport>[5]) =>
  dimensionReport(userId, websiteId, "gsc_page_daily", "page", range, opts);
