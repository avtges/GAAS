import { z } from "zod";
import type { GoogleAuth } from "@/lib/providers/google-fetch";

/** Shapes verified against the searchconsole v1 Discovery document (rev 20261005). */
export const SiteEntry = z.object({
  siteUrl: z.string(),
  permissionLevel: z.enum(["SITE_PERMISSION_LEVEL_UNSPECIFIED", "SITE_OWNER", "SITE_FULL_USER", "SITE_RESTRICTED_USER", "SITE_UNVERIFIED_USER"]),
});
export type SiteEntry = z.infer<typeof SiteEntry>;
export const SitesListResponse = z.object({ siteEntry: z.array(SiteEntry).optional() });

export const GscDimension = z.enum(["date", "query", "page", "country", "device", "searchAppearance"]);
export type GscDimension = z.infer<typeof GscDimension>;

export const GscFilter = z.object({
  dimension: z.enum(["QUERY", "PAGE", "COUNTRY", "DEVICE", "SEARCH_APPEARANCE"]),
  operator: z.enum(["EQUALS", "NOT_EQUALS", "CONTAINS", "NOT_CONTAINS", "INCLUDING_REGEX", "EXCLUDING_REGEX"]),
  expression: z.string(),
});

export const SearchAnalyticsQueryRequest = z.object({
  startDate: z.string(),
  endDate: z.string(),
  dimensions: z.array(GscDimension).optional(),
  type: z.enum(["WEB", "IMAGE", "VIDEO", "NEWS", "DISCOVER", "GOOGLE_NEWS"]).optional(),
  dimensionFilterGroups: z.array(z.object({ groupType: z.literal("AND").optional(), filters: z.array(GscFilter) })).optional(),
  aggregationType: z.enum(["AUTO", "BY_PROPERTY", "BY_PAGE"]).optional(),
  rowLimit: z.number().int().min(1).max(25000).optional(),
  startRow: z.number().int().min(0).optional(),
  dataState: z.enum(["FINAL", "ALL"]).optional(),
});
export type SearchAnalyticsQueryRequest = z.infer<typeof SearchAnalyticsQueryRequest>;

export const ApiDataRow = z.object({
  keys: z.array(z.string()).optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});
export type ApiDataRow = z.infer<typeof ApiDataRow>;

export const SearchAnalyticsQueryResponse = z.object({
  rows: z.array(ApiDataRow).optional(),
  responseAggregationType: z.string().optional(),
  metadata: z.object({ firstIncompleteDate: z.string().optional(), firstIncompleteHour: z.string().optional() }).optional(),
});
export type SearchAnalyticsQueryResponse = z.infer<typeof SearchAnalyticsQueryResponse>;

export interface SearchConsoleProvider {
  listSites(auth: GoogleAuth): Promise<SiteEntry[]>;
  query(auth: GoogleAuth, siteUrl: string, request: SearchAnalyticsQueryRequest): Promise<SearchAnalyticsQueryResponse>;
}
