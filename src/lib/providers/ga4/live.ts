import { googleFetch, type GoogleAuth } from "@/lib/providers/google-fetch";
import { GoogleApiError } from "@/lib/providers/errors";
import {
  Ga4Metadata,
  Ga4Property,
  ListAccountSummariesResponse,
  ListKeyEventsResponse,
  RunReportRequest,
  RunReportResponse,
  type AccountSummary,
  type Ga4Provider,
  type KeyEvent,
} from "./types";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

function assertPropertyId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new GoogleApiError("invalid_request", "GA4 property id must be numeric");
  return id;
}

/** Live GA4 client (Admin API for discovery, Data API for reporting). Read-only methods only. */
export class LiveGa4Provider implements Ga4Provider {
  async listAccountSummaries(auth: GoogleAuth): Promise<AccountSummary[]> {
    const out: AccountSummary[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const url = new URL(`${ADMIN}/accountSummaries`);
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await googleFetch(url.toString(), auth, ListAccountSummariesResponse, { service: "analyticsadmin.accountSummaries.list" });
      out.push(...(res.accountSummaries ?? []));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async getProperty(auth: GoogleAuth, propertyId: string) {
    return googleFetch(`${ADMIN}/properties/${assertPropertyId(propertyId)}`, auth, Ga4Property, { service: "analyticsadmin.properties.get" });
  }

  async listKeyEvents(auth: GoogleAuth, propertyId: string): Promise<KeyEvent[]> {
    const out: KeyEvent[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 10; i++) {
      const url = new URL(`${ADMIN}/properties/${assertPropertyId(propertyId)}/keyEvents`);
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await googleFetch(url.toString(), auth, ListKeyEventsResponse, { service: "analyticsadmin.keyEvents.list" });
      out.push(...(res.keyEvents ?? []));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async getMetadata(auth: GoogleAuth, propertyId: string) {
    return googleFetch(`${DATA}/properties/${assertPropertyId(propertyId)}/metadata`, auth, Ga4Metadata, { service: "analyticsdata.getMetadata" });
  }

  async runReport(auth: GoogleAuth, propertyId: string, request: RunReportRequest) {
    const body = RunReportRequest.parse(request);
    return googleFetch(`${DATA}/properties/${assertPropertyId(propertyId)}:runReport`, auth, RunReportResponse, { method: "POST", body, service: "analyticsdata.runReport" });
  }
}
