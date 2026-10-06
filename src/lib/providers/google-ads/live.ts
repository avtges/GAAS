import { z } from "zod";
import { getEnv } from "@/lib/env";
import { googleFetch, type GoogleAuth } from "@/lib/providers/google-fetch";
import { GoogleApiError } from "@/lib/providers/errors";
import { CUSTOMER_CLIENT_QUERY, CUSTOMER_QUERY, buildReportQuery } from "./queries";
import { ListAccessibleCustomersResponse, SearchStreamResponse, idString, type AdsAccount, type AdsRow, type GoogleAdsProvider } from "./types";

const HOST = "https://googleads.googleapis.com";

function assertCustomerId(id: string): string {
  if (!/^\d{10}$/.test(id)) throw new GoogleApiError("invalid_request", "Google Ads customer id must be 10 digits without dashes");
  return id;
}

const CustomerRow = z.object({
  customer: z.object({ id: idString, descriptiveName: z.string().optional(), manager: z.boolean().optional(), testAccount: z.boolean().optional(), currencyCode: z.string().optional(), timeZone: z.string().optional(), status: z.string().optional() }),
});
const CustomerClientRow = z.object({
  customerClient: z.object({ id: idString, descriptiveName: z.string().optional(), manager: z.boolean().optional(), level: z.union([z.string(), z.number()]).optional(), status: z.string().optional(), currencyCode: z.string().optional(), timeZone: z.string().optional(), testAccount: z.boolean().optional() }),
});

/**
 * Live Google Ads API client. Only read endpoints are implemented:
 * customers:listAccessibleCustomers and customers/{id}/googleAds:searchStream.
 */
export class LiveGoogleAdsProvider implements GoogleAdsProvider {
  private headers(loginCustomerId: string | null): Record<string, string> {
    const token = getEnv().GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!token) throw new GoogleApiError("invalid_request", "GOOGLE_ADS_DEVELOPER_TOKEN is not configured; Google Ads cannot be queried.");
    return { "developer-token": token, ...(loginCustomerId ? { "login-customer-id": assertCustomerId(loginCustomerId) } : {}) };
  }
  private base(): string {
    return `${HOST}/${getEnv().GOOGLE_ADS_API_VERSION}`;
  }

  private async stream(auth: GoogleAuth, customerId: string, loginCustomerId: string | null, query: string): Promise<AdsRow[]> {
    const chunks = await googleFetch(`${this.base()}/customers/${assertCustomerId(customerId)}/googleAds:searchStream`, auth, SearchStreamResponse, {
      method: "POST",
      body: { query },
      headers: this.headers(loginCustomerId),
      service: "googleads.searchStream",
    });
    return chunks.flatMap((c) => c.results ?? []);
  }

  async listAccessibleCustomers(auth: GoogleAuth): Promise<string[]> {
    const res = await googleFetch(`${this.base()}/customers:listAccessibleCustomers`, auth, ListAccessibleCustomersResponse, { headers: this.headers(null), service: "googleads.listAccessibleCustomers" });
    return (res.resourceNames ?? []).map((r) => r.replace(/^customers\//, "")).filter((id) => /^\d{10}$/.test(id));
  }

  async getCustomer(auth: GoogleAuth, customerId: string): Promise<AdsAccount> {
    const rows = await this.stream(auth, customerId, customerId, CUSTOMER_QUERY);
    const parsed = CustomerRow.safeParse(rows[0]);
    if (!parsed.success) throw new GoogleApiError("malformed", "googleads.searchStream: unexpected customer row shape");
    const c = parsed.data.customer;
    return { customerId: c.id, descriptiveName: c.descriptiveName ?? c.id, manager: !!c.manager, testAccount: !!c.testAccount, currencyCode: c.currencyCode ?? null, timeZone: c.timeZone ?? null, loginCustomerId: null, status: c.status ?? null };
  }

  async listClientAccounts(auth: GoogleAuth, managerId: string): Promise<AdsAccount[]> {
    const rows = await this.stream(auth, managerId, managerId, CUSTOMER_CLIENT_QUERY);
    const out: AdsAccount[] = [];
    for (const row of rows) {
      const parsed = CustomerClientRow.safeParse(row);
      if (!parsed.success) throw new GoogleApiError("malformed", "googleads.searchStream: unexpected customer_client row shape");
      const c = parsed.data.customerClient;
      if (Number(c.level ?? 0) !== 1) continue;
      out.push({ customerId: c.id, descriptiveName: c.descriptiveName ?? c.id, manager: !!c.manager, testAccount: !!c.testAccount, currencyCode: c.currencyCode ?? null, timeZone: c.timeZone ?? null, loginCustomerId: managerId, status: c.status ?? null });
    }
    return out;
  }

  async fetchReport(auth: GoogleAuth, args: { customerId: string; loginCustomerId: string | null; report: Parameters<typeof buildReportQuery>[0]; start: string; end: string }): Promise<AdsRow[]> {
    return this.stream(auth, args.customerId, args.loginCustomerId ?? args.customerId, buildReportQuery(args.report, args.start, args.end));
  }
}
