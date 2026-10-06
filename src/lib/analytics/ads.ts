import { withUserDb, many, one } from "@/lib/db/pool";
import { change, comparisonRange, num, round, safeDiv, smallSampleWarning, type DateRange } from "@/lib/analytics/common";

/**
 * Google Ads analytics. Money is stored in micros of the account currency and converted
 * here. Derived metrics are null when their denominator is zero (e.g. CPA with 0 conversions).
 */
const SUMS = `coalesce(sum(impressions),0)::float8 as impressions, coalesce(sum(clicks),0)::float8 as clicks,
  coalesce(sum(cost_micros),0)::float8 as cost_micros, coalesce(sum(conversions),0)::float8 as conversions,
  coalesce(sum(conversions_value),0)::float8 as conversions_value`;
type Sums = { impressions: number; clicks: number; cost_micros: number; conversions: number; conversions_value: number };

export function adsMetrics(r: Partial<Sums> | null) {
  const impressions = num(r?.impressions);
  const clicks = num(r?.clicks);
  const cost = num(r?.cost_micros) / 1_000_000;
  const conversions = num(r?.conversions);
  const value = num(r?.conversions_value);
  return {
    impressions,
    clicks,
    cost: round(cost, 2)!,
    conversions: round(conversions, 2)!,
    conversions_value: round(value, 2)!,
    ctr: round(safeDiv(clicks, impressions), 4),
    avg_cpc: round(safeDiv(cost, clicks), 2),
    conversion_rate: round(safeDiv(conversions, clicks), 4),
    cpa: round(safeDiv(cost, conversions), 2),
    roas: round(safeDiv(value, cost), 2),
  };
}
export type AdsMetrics = ReturnType<typeof adsMetrics>;

function adsChanges(c: AdsMetrics, p: AdsMetrics) {
  return {
    cost: change(c.cost, p.cost, 2),
    clicks: change(c.clicks, p.clicks, 0),
    impressions: change(c.impressions, p.impressions, 0),
    conversions: change(c.conversions, p.conversions, 2),
    conversions_value: change(c.conversions_value, p.conversions_value, 2),
    cpa: c.cpa !== null && p.cpa !== null ? change(c.cpa, p.cpa, 2) : null,
    roas: c.roas !== null && p.roas !== null ? change(c.roas, p.roas, 2) : null,
  };
}

export async function getAdsTotals(userId: string, websiteId: string, range: DateRange) {
  return adsMetrics(await withUserDb(userId, (db) => one<Sums>(db, `select ${SUMS} from public.ads_campaign_daily where website_id = $1 and date between $2 and $3`, [websiteId, range.start, range.end])));
}

async function groupedAds(userId: string, websiteId: string, table: string, keyCols: string[], range: DateRange, prev: DateRange) {
  const metricCols = ["impressions", "clicks", "cost_micros", "conversions", "conversions_value"];
  // Every key column is either a bare column name or "<expr> as <alias>".
  const aliases = keyCols.map((k) => k.match(/\sas\s+([a-z_]+)$/)?.[1] ?? k);
  const rows = await withUserDb(userId, (db) =>
    many<Record<string, string | number>>(
      db,
      `select ${keyCols.join(", ")},
        ${metricCols.map((m) => `coalesce(sum(${m}) filter (where date between $2 and $3),0)::float8 as c_${m}, coalesce(sum(${m}) filter (where date between $4 and $5),0)::float8 as p_${m}`).join(",\n        ")}
       from public.${table} where website_id = $1 and date between $4 and $3
       group by ${keyCols.map((k, i) => (/^(max|min|string_agg)\(/.test(k) ? null : i + 1)).filter((x) => x !== null).join(", ")}
       limit 20000`,
      [websiteId, range.start, range.end, prev.start, prev.end],
    ),
  );
  return rows.map((r) => {
    const pick = (p: string) => adsMetrics({ impressions: Number(r[`${p}_impressions`]), clicks: Number(r[`${p}_clicks`]), cost_micros: Number(r[`${p}_cost_micros`]), conversions: Number(r[`${p}_conversions`]), conversions_value: Number(r[`${p}_conversions_value`]) });
    const current = pick("c");
    const previous = pick("p");
    const keys = Object.fromEntries(aliases.map((a) => [a, r[a]]));
    return { keys, current, previous, changes: adsChanges(current, previous) };
  });
}

export type CampaignSort = "cost" | "conversions" | "cpa" | "roas" | "clicks" | "cost_change";

export async function getAdsCampaigns(userId: string, websiteId: string, range: DateRange, opts: { sortBy: CampaignSort; limit: number; compare: boolean; primaryConversion: string | null }) {
  const prev = comparisonRange(range);
  const rows = await withUserDb(userId, (db) =>
    many<Record<string, number | string>>(
      db,
      `select campaign_id::text as campaign_id, max(campaign_name) as campaign_name, max(campaign_status) as campaign_status, max(channel_type) as channel_type,
        ${["impressions", "clicks", "cost_micros", "conversions", "conversions_value"].map((m) => `coalesce(sum(${m}) filter (where date between $2 and $3),0)::float8 as c_${m}, coalesce(sum(${m}) filter (where date between $4 and $5),0)::float8 as p_${m}`).join(",\n        ")}
       from public.ads_campaign_daily where website_id = $1 and date between $4 and $3 group by campaign_id`,
      [websiteId, range.start, range.end, prev.start, prev.end],
    ),
  );
  let primary: Map<string, { cur: number; prev: number }> | null = null;
  if (opts.primaryConversion) {
    const pr = await withUserDb(userId, (db) =>
      many<{ campaign_id: string; cur: number; prev: number }>(
        db,
        `select campaign_id::text as campaign_id, coalesce(sum(conversions) filter (where date between $2 and $3),0)::float8 as cur, coalesce(sum(conversions) filter (where date between $4 and $5),0)::float8 as prev
         from public.ads_conversion_action_daily where website_id = $1 and conversion_action_name = $6 and date between $4 and $3 group by campaign_id`,
        [websiteId, range.start, range.end, prev.start, prev.end, opts.primaryConversion],
      ),
    );
    primary = new Map(pr.map((p) => [p.campaign_id, { cur: Number(p.cur), prev: Number(p.prev) }]));
  }
  const out = rows.map((r) => {
    const pick = (p: string) => adsMetrics({ impressions: Number(r[`${p}_impressions`]), clicks: Number(r[`${p}_clicks`]), cost_micros: Number(r[`${p}_cost_micros`]), conversions: Number(r[`${p}_conversions`]), conversions_value: Number(r[`${p}_conversions_value`]) });
    const current = pick("c");
    const previous = pick("p");
    const pc = primary?.get(String(r.campaign_id));
    return {
      campaign_id: String(r.campaign_id),
      campaign_name: String(r.campaign_name),
      status: String(r.campaign_status),
      channel_type: String(r.channel_type),
      ...current,
      ...(opts.compare ? { previous, changes: adsChanges(current, previous) } : {}),
      ...(primary ? { primary_conversion: { action: opts.primaryConversion, conversions: round(pc?.cur ?? 0, 2), previous: round(pc?.prev ?? 0, 2), cpa: round(safeDiv(current.cost, pc?.cur ?? 0), 2) } } : {}),
      sample_warning: smallSampleWarning("Conversions", current.conversions, ...(opts.compare ? [previous.conversions] : [])),
    };
  });
  const active = out.filter((r) => r.cost > 0 || r.impressions > 0);
  const sorters: Record<CampaignSort, (a: (typeof out)[number], b: (typeof out)[number]) => number> = {
    cost: (a, b) => b.cost - a.cost,
    conversions: (a, b) => b.conversions - a.conversions,
    // Highest CPA first; campaigns with spend but no conversions (CPA undefined) first of all.
    cpa: (a, b) => (b.cpa ?? (b.cost > 0 ? Infinity : -1)) - (a.cpa ?? (a.cost > 0 ? Infinity : -1)),
    roas: (a, b) => (b.roas ?? -1) - (a.roas ?? -1),
    clicks: (a, b) => b.clicks - a.clicks,
    cost_change: (a, b) => Math.abs(b.cost - (b.previous?.cost ?? 0)) - Math.abs(a.cost - (a.previous?.cost ?? 0)),
  };
  active.sort(sorters[opts.sortBy]);
  const totals = await getAdsTotals(userId, websiteId, range);
  const previousTotals = opts.compare ? await getAdsTotals(userId, websiteId, prev) : null;
  return { date_range: range, comparison_range: opts.compare ? prev : null, totals, previous_totals: previousTotals, changes: previousTotals ? adsChanges(totals, previousTotals) : null, rows: active.slice(0, opts.limit), total_campaigns: active.length };
}

export async function getAdsAdGroups(userId: string, websiteId: string, range: DateRange, opts: { sortBy: CampaignSort; limit: number; campaignId: string | null }) {
  const prev = comparisonRange(range);
  let rows = await groupedAds(userId, websiteId, "ads_ad_group_daily", ["ad_group_id::text as ad_group_id", "max(ad_group_name) as ad_group_name", "max(campaign_name) as campaign_name", "campaign_id::text as campaign_id"], range, prev);
  rows = rows.filter((r) => r.current.cost > 0 || r.current.impressions > 0);
  if (opts.campaignId) rows = rows.filter((r) => String(r.keys.campaign_id) === opts.campaignId);
  sortRows(rows, opts.sortBy);
  return { date_range: range, comparison_range: prev, rows: rows.slice(0, opts.limit).map(flatten) };
}

export async function getAdsKeywords(userId: string, websiteId: string, range: DateRange, opts: { sortBy: CampaignSort; limit: number }) {
  const prev = comparisonRange(range);
  const rows = (await groupedAds(userId, websiteId, "ads_keyword_daily", ["criterion_id::text as criterion_id", "max(keyword_text) as keyword_text", "max(match_type) as match_type", "ad_group_id::text as ad_group_id"], range, prev)).filter(
    (r) => r.current.cost > 0 || r.current.impressions > 0,
  );
  sortRows(rows, opts.sortBy);
  return { date_range: range, comparison_range: prev, rows: rows.slice(0, opts.limit).map(flatten) };
}

export async function getAdsSearchTerms(userId: string, websiteId: string, range: DateRange, opts: { sortBy: "cost" | "conversions" | "wasted_spend" | "clicks"; limit: number; minCost: number }) {
  const prev = comparisonRange(range);
  const rows = (await groupedAds(userId, websiteId, "ads_search_term_daily", ["search_term", "max(targeting_status) as targeting_status", "string_agg(distinct ad_group_id::text, ',') as ad_group_ids"], range, prev)).filter((r) => r.current.cost >= opts.minCost && (r.current.cost > 0 || r.current.clicks > 0));
  const totalCost = rows.reduce((s, r) => s + r.current.cost, 0);
  const wasted = rows.filter((r) => r.current.conversions === 0 && r.current.cost > 0);
  if (opts.sortBy === "wasted_spend") {
    wasted.sort((a, b) => b.current.cost - a.current.cost);
  } else {
    rows.sort((a, b) => (opts.sortBy === "cost" ? b.current.cost - a.current.cost : opts.sortBy === "conversions" ? b.current.conversions - a.current.conversions : b.current.clicks - a.current.clicks));
  }
  const list = opts.sortBy === "wasted_spend" ? wasted : rows;
  const wastedCost = wasted.reduce((s, r) => s + r.current.cost, 0);
  return {
    date_range: range,
    comparison_range: prev,
    rows: list.slice(0, opts.limit).map(flatten),
    summary: { search_terms_with_spend: rows.length, total_cost: round(totalCost, 2), zero_conversion_terms: wasted.length, zero_conversion_cost: round(wastedCost, 2), zero_conversion_share_of_cost: round(safeDiv(wastedCost, totalCost), 4) },
    definition: "Wasted spend candidates = search terms with cost but zero Google Ads conversions in the period. A term with few clicks may simply not have had enough traffic to convert; check clicks before excluding it.",
  };
}

function sortRows(rows: Awaited<ReturnType<typeof groupedAds>>, sortBy: CampaignSort) {
  rows.sort((a, b) =>
    sortBy === "cpa"
      ? (b.current.cpa ?? (b.current.cost > 0 ? Infinity : -1)) - (a.current.cpa ?? (a.current.cost > 0 ? Infinity : -1))
      : sortBy === "roas"
        ? (b.current.roas ?? -1) - (a.current.roas ?? -1)
        : sortBy === "cost_change"
          ? Math.abs(b.changes.cost.change) - Math.abs(a.changes.cost.change)
          : (b.current[sortBy as "cost" | "conversions" | "clicks"] ?? 0) - (a.current[sortBy as "cost" | "conversions" | "clicks"] ?? 0),
  );
}

function flatten(r: Awaited<ReturnType<typeof groupedAds>>[number]) {
  return { ...r.keys, ...r.current, cost_change: r.changes.cost, conversions_change: r.changes.conversions };
}
