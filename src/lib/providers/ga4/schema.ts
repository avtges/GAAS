import type { Ga4Metadata } from "./types";

/**
 * The ONLY place GA4 Data API dimension/metric names are written down.
 * These could not be checked against the API schema page offline (see
 * docs/integration-verification.md U1), so validateGa4Schema() checks them against the
 * property's live `getMetadata` response before the first sync. Rename here if Google
 * reports a name is missing.
 */
export const GA4_DIMENSIONS = {
  date: "date",
  sessionSource: "sessionSource",
  sessionMedium: "sessionMedium",
  sessionCampaignName: "sessionCampaignName",
  sessionDefaultChannelGroup: "sessionDefaultChannelGroup",
  landingPage: "landingPage",
  deviceCategory: "deviceCategory",
  eventName: "eventName",
} as const;

export const GA4_METRICS = {
  sessions: "sessions",
  totalUsers: "totalUsers",
  newUsers: "newUsers",
  engagedSessions: "engagedSessions",
  keyEvents: "keyEvents",
  eventCount: "eventCount",
  ecommercePurchases: "ecommercePurchases",
  purchaseRevenue: "purchaseRevenue",
  screenPageViews: "screenPageViews",
} as const;

export const GA4_SESSION_METRICS = [GA4_METRICS.sessions, GA4_METRICS.totalUsers, GA4_METRICS.newUsers, GA4_METRICS.engagedSessions, GA4_METRICS.keyEvents, GA4_METRICS.ecommercePurchases, GA4_METRICS.purchaseRevenue] as const;

export function validateGa4Schema(metadata: Ga4Metadata): { ok: boolean; missingDimensions: string[]; missingMetrics: string[] } {
  const dims = new Set<string>();
  for (const d of metadata.dimensions ?? []) {
    dims.add(d.apiName);
    for (const n of d.deprecatedApiNames ?? []) dims.add(n);
  }
  const mets = new Set<string>();
  for (const m of metadata.metrics ?? []) {
    mets.add(m.apiName);
    for (const n of m.deprecatedApiNames ?? []) mets.add(n);
  }
  const missingDimensions = Object.values(GA4_DIMENSIONS).filter((n) => !dims.has(n));
  const missingMetrics = Object.values(GA4_METRICS).filter((n) => !mets.has(n));
  return { ok: missingDimensions.length === 0 && missingMetrics.length === 0, missingDimensions, missingMetrics };
}
