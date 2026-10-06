import { addDays, daysInclusive, eachDay, todayInTimeZone } from "@/lib/dates";
import { hashString, rng, seasonality } from "@/lib/providers/mock/random";
import type { GoogleAuth } from "@/lib/providers/google-fetch";
import type { ApiDataRow, SearchAnalyticsQueryRequest, SearchAnalyticsQueryResponse, SearchConsoleProvider, SiteEntry } from "./types";

/**
 * Deterministic Search Console fixtures. The mock honours the same request semantics as
 * the live API that our sync relies on: date range, dimensions (grouping order), rowLimit
 * + startRow paging, default sort by clicks desc, dataState=ALL metadata, and omits days
 * with no data. Data for the last 2 PST days is "incomplete" (scaled down), mirroring the
 * API's partial recent data.
 */
const QUERIES = [
  "acme store", "acme store reviews", "buy running shoes online", "best trail running shoes", "running shoes for flat feet",
  "acme coupon code", "lightweight hiking boots", "waterproof running shoes", "acme returns policy", "marathon training plan",
  "how to choose running shoes", "trail shoes vs road shoes", "acme free shipping", "running socks", "acme shoe size guide",
  "cheap running shoes", "running shoes sale", "acme outlet", "best shoes for walking", "shoe care tips",
  "acme store near me", "running shoe durability", "acme vs rival", "stability running shoes", "carbon plate shoes",
  "acme discount", "kids running shoes", "wide running shoes", "running shoes under 100", "acme gift card",
];
const PAGES = ["/", "/running-shoes", "/trail-running-shoes", "/blog/how-to-choose-running-shoes", "/sale", "/returns", "/blog/marathon-training-plan", "/hiking-boots", "/size-guide", "/socks", "/kids", "/blog/trail-vs-road", "/outlet", "/gift-cards", "/about"];
const COUNTRIES = ["usa", "gbr", "can", "aus", "deu", "fra", "ind", "nld"];
const DEVICES = ["MOBILE", "DESKTOP", "TABLET"];

function brandish(q: string) {
  return q.includes("acme");
}

export class MockSearchConsoleProvider implements SearchConsoleProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async listSites(): Promise<SiteEntry[]> {
    return [
      { siteUrl: "sc-domain:acme.example", permissionLevel: "SITE_OWNER" },
      { siteUrl: "https://acme.example/", permissionLevel: "SITE_FULL_USER" },
      { siteUrl: "https://blog.acme.example/", permissionLevel: "SITE_RESTRICTED_USER" },
    ];
  }

  async query(_auth: GoogleAuth, siteUrl: string, req: SearchAnalyticsQueryRequest): Promise<SearchAnalyticsQueryResponse> {
    const today = todayInTimeZone("America/Los_Angeles", this.now());
    const firstIncomplete = addDays(today, -2);
    const dims = req.dimensions ?? [];
    const seed = hashString(siteUrl);
    const rowsByKey = new Map<string, ApiDataRow & { keys: string[] }>();
    const baseDay = addDays(today, -400);

    for (const date of eachDay(req.startDate, req.endDate)) {
      if (date > today) continue;
      const dayIndex = daysInclusive(baseDay, date);
      const r = rng(seed ^ hashString(date));
      const season = seasonality(date, 0.0015, dayIndex);
      // A visible event: non-brand queries dipped ~25% starting 10 days ago.
      const dip = date >= addDays(today, -10) ? 0.75 : 1;
      const incomplete = req.dataState === "ALL" && date >= firstIncomplete ? 0.6 : date >= firstIncomplete ? 0 : 1;
      if (incomplete === 0) continue;

      for (const [qi, query] of QUERIES.entries()) {
        const page = PAGES[(qi + Math.floor(r() * 3)) % PAGES.length];
        const country = COUNTRIES[Math.floor(r() * COUNTRIES.length)];
        const device = DEVICES[r() < 0.6 ? 0 : r() < 0.85 ? 1 : 2];
        const popularity = 1 / (1 + qi * 0.35);
        const impressions = Math.max(0, Math.round(900 * popularity * season * (brandish(query) ? 1 : dip) * incomplete * (0.8 + r() * 0.4)));
        if (impressions === 0) continue;
        const position = Math.min(60, Math.max(1, (brandish(query) ? 1.2 : 4 + qi * 0.6) * (0.9 + r() * 0.2)));
        const ctrBase = brandish(query) ? 0.35 : Math.max(0.005, 0.25 / position);
        const clicks = Math.round(impressions * ctrBase * (0.8 + r() * 0.4));
        const keyValues: Record<string, string> = { date, query, page: `https://acme.example${page}`, country, device, searchAppearance: "AMP_BLUE_LINK" };
        const keys = dims.map((d) => keyValues[d]);
        const k = keys.join("\u0001");
        const existing = rowsByKey.get(k);
        if (existing) {
          existing.clicks += clicks;
          existing.impressions += impressions;
          existing.position = (existing.position * (existing.impressions - impressions) + position * impressions) / existing.impressions;
        } else {
          rowsByKey.set(k, { keys, clicks, impressions, ctr: 0, position });
        }
      }
    }

    let rows = [...rowsByKey.values()].map((row) => ({ ...row, ctr: row.impressions ? row.clicks / row.impressions : 0 }));
    rows.sort((a, b) => b.clicks - a.clicks);
    const start = req.startRow ?? 0;
    const limit = req.rowLimit ?? 1000;
    rows = rows.slice(start, start + limit);
    const includesIncomplete = req.dataState === "ALL" && dims.includes("date") && req.endDate >= firstIncomplete;
    return {
      rows: rows.map((r) => (dims.length ? r : { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      responseAggregationType: req.aggregationType === "BY_PAGE" || dims.includes("page") ? "BY_PAGE" : "BY_PROPERTY",
      ...(includesIncomplete ? { metadata: { firstIncompleteDate: firstIncomplete } } : {}),
    };
  }
}
