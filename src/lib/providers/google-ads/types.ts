import { z } from "zod";
import type { GoogleAuth } from "@/lib/providers/google-fetch";
import type { AdsReport } from "./queries";

/**
 * Google Ads REST responses use the proto3 JSON mapping: lowerCamelCase field names,
 * int64 values as strings, enums as their names. Numbers are accepted as string or number.
 */
export const numeric = z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite());
export const idString = z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().regex(/^\d+$/));

export type AdsRow = Record<string, unknown>;

export const SearchStreamResponse = z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).optional(), fieldMask: z.string().optional(), requestId: z.string().optional() }));
export const ListAccessibleCustomersResponse = z.object({ resourceNames: z.array(z.string()).optional() });

export type AdsAccount = {
  customerId: string;
  descriptiveName: string;
  manager: boolean;
  testAccount: boolean;
  currencyCode: string | null;
  timeZone: string | null;
  /** Manager account to send as login-customer-id, or null to use the account itself. */
  loginCustomerId: string | null;
  status: string | null;
};

export interface GoogleAdsProvider {
  /** customers:listAccessibleCustomers → bare 10-digit ids. */
  listAccessibleCustomers(auth: GoogleAuth): Promise<string[]>;
  getCustomer(auth: GoogleAuth, customerId: string): Promise<AdsAccount>;
  /** Direct client accounts (level 1) of a manager account. */
  listClientAccounts(auth: GoogleAuth, managerId: string): Promise<AdsAccount[]>;
  /** Runs one of the fixed report queries via googleAds:searchStream; returns REST JSON rows. */
  fetchReport(auth: GoogleAuth, args: { customerId: string; loginCustomerId: string | null; report: AdsReport; start: string; end: string }): Promise<AdsRow[]>;
}
