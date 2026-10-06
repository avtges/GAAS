import { withUserDb, many, one } from "@/lib/db/pool";
import { change, comparisonRange, num, round, safeDiv, smallSampleWarning, type DateRange } from "@/lib/analytics/common";

/**
 * GA4 analytics over the normalized tables. Session-scoped metrics only; rates are
 * recomputed from sums. "key_events" is GA4's platform metric and is never presented as
 * a business conversion (see getBusinessConversions).
 */
const SUMS = `coalesce(sum(sessions),0)::float8 as sessions, coalesce(sum(total_users),0)::float8 as total_users,
  coalesce(sum(new_users),0)::float8 as new_users, coalesce(sum(engaged_sessions),0)::float8 as engaged_sessions,
  coalesce(sum(key_events),0)::float8 as key_events, coalesce(sum(purchases),0)::float8 as purchases,
  coalesce(sum(purchase_revenue),0)::float8 as purchase_revenue`;

type SumRow = { sessions: number; total_users: number; new_users: number; engaged_sessions: number; key_events: number; purchases: number; purchase_revenue: number };

export function ga4Metrics(r: Partial<SumRow> | null) {
  const sessions = num(r?.sessions);
  return {
    sessions,
    total_users: num(r?.total_users),
    new_users: num(r?.new_users),
    engaged_sessions: num(r?.engaged_sessions),
    engagement_rate: round(safeDiv(num(r?.engaged_sessions), sessions), 4),
    key_events: round(num(r?.key_events), 1)!,
    key_event_rate_per_session: round(safeDiv(num(r?.key_events), sessions), 4),
    purchases: num(r?.purchases),
    purchase_revenue: round(num(r?.purchase_revenue), 2)!,
  };
}
export type Ga4Metrics = ReturnType<typeof ga4Metrics>;

function changes(cur: Ga4Metrics, prev: Ga4Metrics) {
  return {
    sessions: change(cur.sessions, prev.sessions, 0),
    total_users: change(cur.total_users, prev.total_users, 0),
    engaged_sessions: change(cur.engaged_sessions, prev.engaged_sessions, 0),
    key_events: change(cur.key_events, prev.key_events, 1),
    purchases: change(cur.purchases, prev.purchases, 0),
    purchase_revenue: change(cur.purchase_revenue, prev.purchase_revenue, 2),
  };
}

export async function getGa4Totals(userId: string, websiteId: string, range: DateRange) {
  const r = await withUserDb(userId, (db) => one<SumRow>(db, `select ${SUMS} from public.ga4_daily_totals where website_id = $1 and date between $2 and $3`, [websiteId, range.start, range.end]));
  return ga4Metrics(r);
}

export type AcquisitionGroup = "channel_group" | "source_medium" | "campaign";
const GROUP_SQL: Record<AcquisitionGroup, string> = {
  channel_group: "session_default_channel_group",
  source_medium: "session_source || ' / ' || session_medium",
  campaign: "session_campaign",
};

async function grouped(userId: string, websiteId: string, table: string, keySql: string, range: DateRange, prev: DateRange, where = "", params: unknown[] = []) {
  return withUserDb(userId, (db) =>
    many<{ key: string } & { cur: SumRow; prev: SumRow } & Record<string, number>>(
      db,
      `select ${keySql} as key,
        ${["sessions", "total_users", "new_users", "engaged_sessions", "key_events", "purchases", "purchase_revenue"]
          .map((m) => `coalesce(sum(${m}) filter (where date between $2 and $3),0)::float8 as c_${m}, coalesce(sum(${m}) filter (where date between $4 and $5),0)::float8 as p_${m}`)
          .join(",\n        ")}
       from public.${table}
       where website_id = $1 and date between $4 and $3${where}
       group by 1`,
      [websiteId, range.start, range.end, prev.start, prev.end, ...params],
    ),
  ).then((rows) =>
    rows.map((r) => {
      const pick = (prefix: string) => ga4Metrics({ sessions: r[`${prefix}_sessions`], total_users: r[`${prefix}_total_users`], new_users: r[`${prefix}_new_users`], engaged_sessions: r[`${prefix}_engaged_sessions`], key_events: r[`${prefix}_key_events`], purchases: r[`${prefix}_purchases`], purchase_revenue: r[`${prefix}_purchase_revenue`] });
      const current = pick("c");
      const previous = pick("p");
      return { key: r.key, current, previous, changes: changes(current, previous) };
    }),
  );
}

export async function getGa4Acquisition(userId: string, websiteId: string, range: DateRange, opts: { groupBy: AcquisitionGroup; limit: number; compare: boolean; channelGroup: string | null }) {
  const prev = comparisonRange(range);
  const params: unknown[] = [];
  let where = "";
  if (opts.channelGroup) {
    params.push(opts.channelGroup);
    where = ` and session_default_channel_group = $6`;
  }
  const rows = await grouped(userId, websiteId, "ga4_acquisition_daily", GROUP_SQL[opts.groupBy], range, prev, where, params);
  rows.sort((a, b) => b.current.sessions - a.current.sessions);
  const totals = await getGa4Totals(userId, websiteId, range);
  const previousTotals = opts.compare ? await getGa4Totals(userId, websiteId, prev) : null;
  const warnings: string[] = [];
  if (totals.sessions === 0) warnings.push("No GA4 sessions in this date range.");
  if (previousTotals) {
    const w = smallSampleWarning("Key event comparison", totals.key_events, previousTotals.key_events);
    if (w) warnings.push(w);
  }
  return {
    date_range: range,
    comparison_range: opts.compare ? prev : null,
    totals,
    previous_totals: previousTotals,
    changes: previousTotals ? changes(totals, previousTotals) : null,
    rows: rows.slice(0, opts.limit).map((r) => ({ [opts.groupBy]: r.key, ...r.current, ...(opts.compare ? { previous: r.previous, changes: r.changes } : {}) })),
    total_groups: rows.length,
    warnings,
  };
}

export async function getGa4LandingPages(userId: string, websiteId: string, range: DateRange, opts: { limit: number; sortBy: "sessions" | "sessions_change" | "key_events" | "engagement_rate" | "purchase_revenue"; minSessions: number }) {
  const prev = comparisonRange(range);
  const rows = (await grouped(userId, websiteId, "ga4_landing_page_daily", "landing_page", range, prev)).filter((r) => r.current.sessions >= opts.minSessions || r.previous.sessions >= opts.minSessions);
  const sorters = {
    sessions: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.current.sessions - a.current.sessions,
    sessions_change: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.changes.sessions.change - a.changes.sessions.change,
    key_events: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.current.key_events - a.current.key_events,
    engagement_rate: (a: (typeof rows)[number], b: (typeof rows)[number]) => (b.current.engagement_rate ?? 0) - (a.current.engagement_rate ?? 0),
    purchase_revenue: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.current.purchase_revenue - a.current.purchase_revenue,
  };
  rows.sort(sorters[opts.sortBy]);
  return {
    date_range: range,
    comparison_range: prev,
    rows: rows.slice(0, opts.limit).map((r) => ({ landing_page: r.key, ...r.current, sessions_change: r.changes.sessions, key_events_change: r.changes.key_events })),
    total_pages: rows.length,
    notes: ["GA4 landing page = the first page of each session; all channels unless filtered."],
  };
}

export async function getGa4Devices(userId: string, websiteId: string, range: DateRange) {
  const prev = comparisonRange(range);
  const rows = await grouped(userId, websiteId, "ga4_device_daily", "device_category", range, prev);
  rows.sort((a, b) => b.current.sessions - a.current.sessions);
  return { date_range: range, comparison_range: prev, rows: rows.map((r) => ({ device_category: r.key, ...r.current, changes: r.changes })) };
}

export async function getEventCounts(userId: string, websiteId: string, range: DateRange, eventName: string) {
  const r = await withUserDb(userId, (db) =>
    one<{ event_count: number; key_events: number; days: number }>(
      db,
      `select coalesce(sum(event_count),0)::float8 as event_count, coalesce(sum(key_events),0)::float8 as key_events, count(distinct date)::int as days
       from public.ga4_event_daily where website_id = $1 and event_name = $2 and date between $3 and $4`,
      [websiteId, eventName, range.start, range.end],
    ),
  );
  return { event_count: num(r?.event_count), key_events: num(r?.key_events), days_with_data: num(r?.days) };
}

export async function listObservedEvents(userId: string, websiteId: string, range: DateRange) {
  return withUserDb(userId, (db) =>
    many<{ event_name: string; event_count: number; key_events: number }>(
      db,
      `select event_name, sum(event_count)::float8 as event_count, sum(key_events)::float8 as key_events
       from public.ga4_event_daily where website_id = $1 and date between $2 and $3 group by event_name order by 2 desc limit 30`,
      [websiteId, range.start, range.end],
    ),
  );
}
