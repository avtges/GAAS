import { googleFetch, type GoogleAuth } from "@/lib/providers/google-fetch";
import { SearchAnalyticsQueryRequest, SearchAnalyticsQueryResponse, SitesListResponse, type SearchConsoleProvider, type SiteEntry } from "./types";

const BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** Live Search Console API client (read-only methods only). */
export class LiveSearchConsoleProvider implements SearchConsoleProvider {
  async listSites(auth: GoogleAuth): Promise<SiteEntry[]> {
    const res = await googleFetch(`${BASE}/sites`, auth, SitesListResponse, { service: "searchconsole.sites.list" });
    return res.siteEntry ?? [];
  }

  async query(auth: GoogleAuth, siteUrl: string, request: SearchAnalyticsQueryRequest): Promise<SearchAnalyticsQueryResponse> {
    const body = SearchAnalyticsQueryRequest.parse(request);
    return googleFetch(`${BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, auth, SearchAnalyticsQueryResponse, {
      method: "POST",
      body,
      service: "searchconsole.searchanalytics.query",
    });
  }
}
