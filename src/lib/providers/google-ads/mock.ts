import { addDays, daysInclusive, eachDay, todayInTimeZone } from "@/lib/dates";
import { hashString, rng, seasonality } from "@/lib/providers/mock/random";
import type { GoogleAuth } from "@/lib/providers/google-fetch";
import type { AdsReport } from "./queries";
import type { AdsAccount, AdsRow, GoogleAdsProvider } from "./types";

/**
 * Deterministic Google Ads fixtures returned in the REST JSON shape (camelCase, int64 as
 * strings) so the real normalization code runs against them. Includes wasted-spend search
 * terms and a conversion drop on the generic campaign in the last 7 days.
 */
const CAMPAIGNS = [
  { id: "111", name: "Brand - Search", type: "SEARCH", budget: 60, ctr: 0.18, cpc: 0.45, cvr: 0.09, aov: 110 },
  { id: "222", name: "Running Shoes - Generic", type: "SEARCH", budget: 180, ctr: 0.045, cpc: 1.35, cvr: 0.025, aov: 95 },
  { id: "333", name: "Trail - Performance Max", type: "PERFORMANCE_MAX", budget: 90, ctr: 0.012, cpc: 0.7, cvr: 0.018, aov: 120 },
];
const AD_GROUPS: Record<string, Array<{ id: string; name: string; keywords: Array<{ id: string; text: string; match: string }>; terms: string[] }>> = {
  "111": [{ id: "1101", name: "Brand Exact", keywords: [{ id: "90001", text: "acme store", match: "EXACT" }, { id: "90002", text: "acme shoes", match: "PHRASE" }], terms: ["acme store", "acme shoes", "acme store coupon"] }],
  "222": [
    { id: "2201", name: "Running Shoes", keywords: [{ id: "90011", text: "running shoes", match: "BROAD" }, { id: "90012", text: "buy running shoes", match: "PHRASE" }], terms: ["running shoes", "buy running shoes online", "free running shoes", "running shoes repair near me", "how to clean running shoes"] },
    { id: "2202", name: "Trail Shoes", keywords: [{ id: "90021", text: "trail running shoes", match: "PHRASE" }], terms: ["trail running shoes", "best trail running shoes", "trail running shoes jobs"] },
  ],
  "333": [],
};
const WASTED = new Set(["free running shoes", "running shoes repair near me", "how to clean running shoes", "trail running shoes jobs"]);
const DEVICES: Array<[string, number]> = [["MOBILE", 0.62], ["DESKTOP", 0.32], ["TABLET", 0.06]];

export class MockGoogleAdsProvider implements GoogleAdsProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async listAccessibleCustomers(): Promise<string[]> {
    return ["1234567890", "5550001111"];
  }

  async getCustomer(_auth: GoogleAuth, customerId: string): Promise<AdsAccount> {
    if (customerId === "1234567890") return { customerId, descriptiveName: "Acme Agency MCC", manager: true, testAccount: false, currencyCode: "USD", timeZone: "America/New_York", loginCustomerId: null, status: "ENABLED" };
    return { customerId, descriptiveName: "Side Project Ads", manager: false, testAccount: false, currencyCode: "USD", timeZone: "America/Los_Angeles", loginCustomerId: null, status: "ENABLED" };
  }

  async listClientAccounts(_auth: GoogleAuth, managerId: string): Promise<AdsAccount[]> {
    if (managerId !== "1234567890") return [];
    return [
      { customerId: "9876543210", descriptiveName: "Acme Store", manager: false, testAccount: false, currencyCode: "USD", timeZone: "America/New_York", loginCustomerId: managerId, status: "ENABLED" },
      { customerId: "1112223333", descriptiveName: "Acme Outlet (paused)", manager: false, testAccount: false, currencyCode: "USD", timeZone: "America/New_York", loginCustomerId: managerId, status: "CANCELED" },
    ];
  }

  async fetchReport(_auth: GoogleAuth, args: { customerId: string; loginCustomerId: string | null; report: AdsReport; start: string; end: string }): Promise<AdsRow[]> {
    const today = todayInTimeZone("America/New_York", this.now());
    const seed = hashString(args.customerId);
    const baseDay = addDays(today, -400);
    const rows: AdsRow[] = [];
    const m = (impr: number, clicks: number, costMicros: number, conv: number, value: number) => ({
      impressions: String(impr),
      clicks: String(clicks),
      costMicros: String(costMicros),
      conversions: Math.round(conv * 100) / 100,
      conversionsValue: Math.round(value * 100) / 100,
      allConversions: Math.round(conv * 1.3 * 100) / 100,
    });
    for (const date of eachDay(args.start, args.end)) {
      if (date > today) continue;
      const r = rng(seed ^ hashString(date));
      const season = seasonality(date, 0.0005, daysInclusive(baseDay, date));
      const recent = date >= addDays(today, -7);
      for (const c of CAMPAIGNS) {
        const cost = c.budget * season * (0.85 + r() * 0.3);
        const clicks = Math.max(0, Math.round(cost / c.cpc));
        const impressions = Math.round(clicks / c.ctr);
        const cvr = c.id === "222" && recent ? c.cvr * 0.45 : c.cvr;
        const conv = clicks * cvr * (0.7 + r() * 0.6);
        const value = conv * c.aov;
        const costMicros = Math.round(cost * 1_000_000);
        const campaign = { resourceName: `customers/${args.customerId}/campaigns/${c.id}`, id: c.id, name: c.name, status: "ENABLED", advertisingChannelType: c.type };
        if (args.report === "campaign") rows.push({ campaign, segments: { date }, metrics: m(impressions, clicks, costMicros, conv, value) });
        if (args.report === "device") {
          for (const [device, share] of DEVICES) rows.push({ campaign: { id: c.id }, segments: { date, device }, metrics: m(Math.round(impressions * share), Math.round(clicks * share), Math.round(costMicros * share), conv * share, value * share) });
        }
        if (args.report === "conversion_action") {
          rows.push({ campaign: { id: c.id }, segments: { date, conversionActionName: "Purchase" }, metrics: { conversions: Math.round(conv * 0.8 * 100) / 100, conversionsValue: Math.round(value * 100) / 100, allConversions: Math.round(conv * 0.8 * 100) / 100 } });
          rows.push({ campaign: { id: c.id }, segments: { date, conversionActionName: "Newsletter signup" }, metrics: { conversions: Math.round(conv * 0.2 * 100) / 100, conversionsValue: 0, allConversions: Math.round(conv * 0.5 * 100) / 100 } });
        }
        const groups = AD_GROUPS[c.id];
        groups.forEach((g, gi) => {
          const share = 1 / groups.length;
          if (args.report === "ad_group") {
            rows.push({ campaign: { id: c.id, name: c.name }, adGroup: { id: g.id, name: g.name, status: "ENABLED" }, segments: { date }, metrics: m(Math.round(impressions * share), Math.round(clicks * share), Math.round(costMicros * share), conv * share, value * share) });
          }
          if (args.report === "keyword") {
            g.keywords.forEach((k, ki) => {
              const ks = share / g.keywords.length;
              rows.push({ campaign: { id: c.id }, adGroup: { id: g.id }, adGroupCriterion: { criterionId: k.id, keyword: { text: k.text, matchType: k.match } }, segments: { date }, metrics: m(Math.round(impressions * ks), Math.round(clicks * ks), Math.round(costMicros * ks), conv * ks * (ki === 0 ? 1.2 : 0.8), value * ks) });
            });
          }
          if (args.report === "search_term") {
            g.terms.forEach((term, ti) => {
              const ts = share / g.terms.length;
              const wasted = WASTED.has(term);
              rows.push({
                campaign: { id: c.id },
                adGroup: { id: g.id },
                searchTermView: { searchTerm: term, status: ti === 0 ? "ADDED" : "NONE" },
                segments: { date },
                metrics: m(Math.round(impressions * ts), Math.round(clicks * ts), Math.round(costMicros * ts * (wasted ? 1.1 : 1)), wasted ? 0 : conv * ts * (gi === 0 ? 1.3 : 1), wasted ? 0 : value * ts),
              });
            });
          }
        });
      }
    }
    return rows;
  }
}
