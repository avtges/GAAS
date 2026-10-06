import { addDays, daysInclusive, eachDay, todayInTimeZone } from "@/lib/dates";
import { hashString, rng, seasonality } from "@/lib/providers/mock/random";
import type { GoogleAuth } from "@/lib/providers/google-fetch";
import { GA4_DIMENSIONS, GA4_METRICS } from "./schema";
import type { AccountSummary, Ga4Metadata, Ga4Property, Ga4Provider, KeyEvent, RunReportRequest, RunReportResponse } from "./types";

/**
 * Deterministic GA4 fixtures. runReport honours dimensions, metrics, date ranges, limit and
 * offset like the real API (string values; rows grouped by the requested dimensions).
 * Event-scoped rows (eventName) are generated separately from session-scoped rows.
 */
const CHANNELS: Array<{ group: string; source: string; medium: string; campaign: string; share: number }> = [
  { group: "Organic Search", source: "google", medium: "organic", campaign: "(organic)", share: 0.42 },
  { group: "Paid Search", source: "google", medium: "cpc", campaign: "Brand - Search", share: 0.1 },
  { group: "Paid Search", source: "google", medium: "cpc", campaign: "Running Shoes - Generic", share: 0.12 },
  { group: "Direct", source: "(direct)", medium: "(none)", campaign: "(direct)", share: 0.16 },
  { group: "Referral", source: "runnersworld.com", medium: "referral", campaign: "(referral)", share: 0.06 },
  { group: "Organic Social", source: "instagram", medium: "social", campaign: "(social)", share: 0.08 },
  { group: "Email", source: "newsletter", medium: "email", campaign: "weekly_digest", share: 0.06 },
];
const PAGES = ["/", "/running-shoes", "/trail-running-shoes", "/blog/how-to-choose-running-shoes", "/sale", "/blog/marathon-training-plan", "/hiking-boots", "/size-guide"];
const DEVICES: Array<[string, number]> = [["mobile", 0.6], ["desktop", 0.33], ["tablet", 0.07]];
const EVENTS: Array<{ name: string; perSession: number; key: boolean }> = [
  { name: "page_view", perSession: 3.2, key: false },
  { name: "session_start", perSession: 1, key: false },
  { name: "view_item", perSession: 0.9, key: false },
  { name: "add_to_cart", perSession: 0.18, key: false },
  { name: "sign_up", perSession: 0.025, key: true },
  { name: "generate_lead", perSession: 0.012, key: true },
  { name: "purchase", perSession: 0.021, key: true },
];

type Atom = Record<string, string | number>;

export class MockGa4Provider implements Ga4Provider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async listAccountSummaries(): Promise<AccountSummary[]> {
    return [
      { account: "accounts/100", displayName: "Acme Inc", propertySummaries: [{ property: "properties/123456789", displayName: "Acme Store (GA4)", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/100" }, { property: "properties/987654321", displayName: "Acme Blog", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/100" }] },
      { account: "accounts/200", displayName: "Side Project", propertySummaries: [{ property: "properties/555555555", displayName: "Side Project Site", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/200" }] },
    ];
  }

  async getProperty(_auth: GoogleAuth, propertyId: string): Promise<Ga4Property> {
    return { name: `properties/${propertyId}`, displayName: propertyId === "123456789" ? "Acme Store (GA4)" : `Property ${propertyId}`, timeZone: "America/New_York", currencyCode: "USD" };
  }

  async listKeyEvents(): Promise<KeyEvent[]> {
    return EVENTS.filter((e) => e.key).map((e) => ({ eventName: e.name, countingMethod: "ONCE_PER_EVENT", custom: e.name !== "purchase", deletable: true }));
  }

  async getMetadata(): Promise<Ga4Metadata> {
    return {
      dimensions: [...Object.values(GA4_DIMENSIONS), "landingPagePlusQueryString", "country"].map((apiName) => ({ apiName })),
      metrics: [...Object.values(GA4_METRICS), "conversions"].map((apiName) => ({ apiName })),
    };
  }

  private atoms(propertyId: string, start: string, end: string, eventScoped: boolean): Atom[] {
    const today = todayInTimeZone("America/New_York", this.now());
    const seed = hashString(propertyId);
    const baseDay = addDays(today, -400);
    const out: Atom[] = [];
    for (const date of eachDay(start, end)) {
      if (date > today) continue;
      const dayIndex = daysInclusive(baseDay, date);
      const r = rng(seed ^ hashString(date));
      const season = seasonality(date, 0.001, dayIndex);
      const dailySessions = 1400 * season * (0.85 + r() * 0.3);
      // Event: paid search conversions fell ~40% in the last 7 days (tracking issue in the fixture).
      const paidDip = date >= addDays(today, -7) ? 0.6 : 1;
      if (eventScoped) {
        for (const ev of EVENTS) {
          const paidShare = CHANNELS.filter((c) => c.group === "Paid Search").reduce((s, c) => s + c.share, 0);
          const count = Math.round(dailySessions * ev.perSession * (ev.key ? 1 - paidShare + paidShare * paidDip : 1) * (0.9 + r() * 0.2));
          out.push({ date: date.replace(/-/g, ""), eventName: ev.name, eventCount: count, keyEvents: ev.key ? count : 0 });
        }
        continue;
      }
      for (const ch of CHANNELS) {
        for (const [device, dshare] of DEVICES) {
          for (const [pi, page] of PAGES.entries()) {
            const pshare = 1 / (1 + pi * 0.6) / 3.2;
            const sessions = Math.round(dailySessions * ch.share * dshare * pshare * (0.8 + r() * 0.4));
            if (sessions === 0) continue;
            const conv = ch.group === "Paid Search" ? paidDip : 1;
            const purchases = Math.round(sessions * 0.021 * conv * (0.7 + r() * 0.6));
            const keyEvents = purchases + Math.round(sessions * 0.037 * conv * (0.7 + r() * 0.6));
            out.push({
              date: date.replace(/-/g, ""),
              sessionSource: ch.source,
              sessionMedium: ch.medium,
              sessionCampaignName: ch.campaign,
              sessionDefaultChannelGroup: ch.group,
              landingPage: page,
              deviceCategory: device,
              sessions,
              totalUsers: Math.round(sessions * 0.86),
              newUsers: Math.round(sessions * 0.55),
              engagedSessions: Math.round(sessions * (ch.group === "Paid Search" ? 0.52 : 0.61)),
              keyEvents,
              ecommercePurchases: purchases,
              purchaseRevenue: Math.round(purchases * (85 + r() * 40) * 100) / 100,
              screenPageViews: Math.round(sessions * 3.2),
            });
          }
        }
      }
    }
    return out;
  }

  async runReport(_auth: GoogleAuth, propertyId: string, req: RunReportRequest): Promise<RunReportResponse> {
    const dims = req.dimensions.map((d) => d.name);
    const mets = req.metrics.map((m) => m.name);
    const eventScoped = dims.includes("eventName") || mets.includes("eventCount");
    const grouped = new Map<string, { dims: string[]; mets: number[] }>();
    for (const range of req.dateRanges) {
      const atoms = this.atoms(propertyId, range.startDate, range.endDate, eventScoped);
      for (const a of atoms) {
        const dv = dims.map((d) => String(a[d] ?? "(not set)"));
        const k = dv.join("\u0001");
        const g = grouped.get(k) ?? { dims: dv, mets: mets.map(() => 0) };
        mets.forEach((m, i) => (g.mets[i] += Number(a[m] ?? 0)));
        grouped.set(k, g);
      }
    }
    let rows = [...grouped.values()];
    rows.sort((a, b) => a.dims.join().localeCompare(b.dims.join()));
    const offset = req.offset ?? 0;
    const limit = req.limit ?? 10000;
    const rowCount = rows.length;
    rows = rows.slice(offset, offset + limit);
    return {
      dimensionHeaders: dims.map((name) => ({ name })),
      metricHeaders: mets.map((name) => ({ name, type: name === "purchaseRevenue" ? "TYPE_CURRENCY" : "TYPE_INTEGER" })),
      rows: rows.map((r) => ({ dimensionValues: r.dims.map((value) => ({ value })), metricValues: r.mets.map((v) => ({ value: String(Math.round(v * 100) / 100) })) })),
      rowCount,
      metadata: { timeZone: "America/New_York", currencyCode: "USD", dataLossFromOtherRow: false, subjectToThresholding: false },
    };
  }
}
