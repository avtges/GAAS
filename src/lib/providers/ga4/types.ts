import { z } from "zod";
import type { GoogleAuth } from "@/lib/providers/google-fetch";

/** Shapes verified against the analyticsadmin v1beta (rev 20261003) and analyticsdata v1beta (rev 20261005) Discovery documents. */
export const PropertySummary = z.object({
  property: z.string(), // "properties/{id}"
  displayName: z.string().optional(),
  propertyType: z.enum(["PROPERTY_TYPE_UNSPECIFIED", "PROPERTY_TYPE_ORDINARY", "PROPERTY_TYPE_SUBPROPERTY", "PROPERTY_TYPE_ROLLUP"]).optional(),
  parent: z.string().optional(),
});
export const AccountSummary = z.object({
  name: z.string().optional(),
  account: z.string(),
  displayName: z.string().optional(),
  propertySummaries: z.array(PropertySummary).optional(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;
export const ListAccountSummariesResponse = z.object({ accountSummaries: z.array(AccountSummary).optional(), nextPageToken: z.string().optional() });

export const Ga4Property = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  timeZone: z.string().optional(),
  currencyCode: z.string().optional(),
  propertyType: z.string().optional(),
});
export type Ga4Property = z.infer<typeof Ga4Property>;

export const KeyEvent = z.object({
  name: z.string().optional(),
  eventName: z.string(),
  countingMethod: z.enum(["COUNTING_METHOD_UNSPECIFIED", "ONCE_PER_EVENT", "ONCE_PER_SESSION"]).optional(),
  custom: z.boolean().optional(),
  deletable: z.boolean().optional(),
});
export type KeyEvent = z.infer<typeof KeyEvent>;
export const ListKeyEventsResponse = z.object({ keyEvents: z.array(KeyEvent).optional(), nextPageToken: z.string().optional() });

export const DimensionMetadata = z.object({ apiName: z.string(), uiName: z.string().optional(), deprecatedApiNames: z.array(z.string()).optional(), customDefinition: z.boolean().optional() });
export const MetricMetadata = z.object({ apiName: z.string(), uiName: z.string().optional(), deprecatedApiNames: z.array(z.string()).optional(), blockedReasons: z.array(z.unknown()).optional(), type: z.string().optional() });
export const Ga4Metadata = z.object({ name: z.string().optional(), dimensions: z.array(DimensionMetadata).optional(), metrics: z.array(MetricMetadata).optional() });
export type Ga4Metadata = z.infer<typeof Ga4Metadata>;

export const RunReportRequest = z.object({
  dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string(), name: z.string().optional() })).min(1).max(4),
  dimensions: z.array(z.object({ name: z.string() })).max(9),
  metrics: z.array(z.object({ name: z.string() })).min(1).max(10),
  dimensionFilter: z.unknown().optional(),
  orderBys: z.array(z.unknown()).optional(),
  limit: z.number().int().min(1).max(250000).optional(),
  offset: z.number().int().min(0).optional(),
  keepEmptyRows: z.boolean().optional(),
  returnPropertyQuota: z.boolean().optional(),
});
export type RunReportRequest = z.infer<typeof RunReportRequest>;

export const RunReportResponse = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
  metricHeaders: z.array(z.object({ name: z.string(), type: z.string().optional() })).optional(),
  rows: z.array(z.object({ dimensionValues: z.array(z.object({ value: z.string().optional() })).optional(), metricValues: z.array(z.object({ value: z.string().optional() })).optional() })).optional(),
  rowCount: z.number().int().optional(),
  metadata: z
    .object({
      timeZone: z.string().optional(),
      currencyCode: z.string().optional(),
      dataLossFromOtherRow: z.boolean().optional(),
      samplingMetadatas: z.array(z.unknown()).optional(),
      subjectToThresholding: z.boolean().optional(),
      emptyReason: z.string().optional(),
    })
    .optional(),
  propertyQuota: z.unknown().optional(),
});
export type RunReportResponse = z.infer<typeof RunReportResponse>;

export interface Ga4Provider {
  listAccountSummaries(auth: GoogleAuth): Promise<AccountSummary[]>;
  getProperty(auth: GoogleAuth, propertyId: string): Promise<Ga4Property>;
  listKeyEvents(auth: GoogleAuth, propertyId: string): Promise<KeyEvent[]>;
  getMetadata(auth: GoogleAuth, propertyId: string): Promise<Ga4Metadata>;
  runReport(auth: GoogleAuth, propertyId: string, request: RunReportRequest): Promise<RunReportResponse>;
}
