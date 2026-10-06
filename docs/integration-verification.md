# Integration verification

This file records, for every external integration, what was verified against an
**official** source, how, and on what date. Anything that could not be verified
from an official source is listed under **Unverified / must confirm before go-live**
at the bottom and is also guarded in code where possible.

Verification method note (2026-10-06): the development environment's egress proxy
blocks `developers.google.com`, `support.google.com`, `platform.openai.com`,
`supabase.com` and `vercel.com`. Verification was therefore done against these
official, machine-readable artifacts instead, which Google and OpenAI publish and
which define the APIs exactly:

| Artifact | Why it is authoritative |
| --- | --- |
| Google API Discovery documents (`https://www.googleapis.com/discovery/v1/apis/searchconsole/v1/rest`, `https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta`, `https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta`) | Google-generated service descriptions; the official client libraries are generated from them. Revisions fetched: searchconsole `20261005`, analyticsdata `20261005`, analyticsadmin `20261003`. |
| `https://accounts.google.com/.well-known/openid-configuration` | Google's own OAuth 2.0 / OIDC metadata document (endpoints, grant types, PKCE methods). |
| `google-ads` 33.0.0 on PyPI (published by Google LLC, 2026-09-23) | Google's official Google Ads API client library; it ships the generated proto definitions (resources, metrics, segments, enums) for each supported API version. |
| Live endpoint probes (unauthenticated requests) | A real path answers `401 UNAUTHENTICATED`; a non-existent version or path answers `404`. Used to confirm which Google Ads API versions and REST paths exist today. |
| `openai` 7.28.0 on npm | OpenAI's official TypeScript SDK; its type definitions mirror the Responses API request/response schema. |
| `@supabase/ssr` 0.12.7 on npm | Supabase's official SSR helper package (README and type definitions). |

Human-readable documentation URLs are listed so the operator can re-check them
from a machine with normal network access.

---

## 1. Google OAuth 2.0 (web server flow)

- **Docs:** https://developers.google.com/identity/protocols/oauth2/web-server ,
  scopes list: https://developers.google.com/identity/protocols/oauth2/scopes
- **Verified from:** `https://accounts.google.com/.well-known/openid-configuration` (fetched 2026-10-06)
- **Endpoints (verified):**
  - Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
  - Token: `https://oauth2.googleapis.com/token` (grant types `authorization_code`, `refresh_token`; client auth `client_secret_post`)
  - Revocation: `https://oauth2.googleapis.com/revoke`
  - Userinfo: `https://openidconnect.googleapis.com/v1/userinfo`
  - PKCE `S256` supported; `authorization_response_iss_parameter_supported: true`
- **Flow used:** Authorization Code + PKCE + `state` (CSRF), `access_type=offline`,
  `include_granted_scopes=true` (incremental authorization), `prompt=consent` only when we
  need a new refresh token.
- **Scopes requested (all verified in the Discovery documents of the respective APIs):**
  - `openid email` (to identify the Google user; `sub` claim = `google_user_id`)
  - `https://www.googleapis.com/auth/webmasters.readonly` — "View Search Console data for your verified sites"
  - `https://www.googleapis.com/auth/analytics.readonly` — "See and download your Google Analytics data" (accepted by both the Data API and the Admin API `accountSummaries.list` / `keyEvents.list`)
  - `https://www.googleapis.com/auth/adwords` — the only scope for the Google Ads API (verified in `google/ads/googleads/oauth2.py` of the official library). **There is no read-only Google Ads scope.** This scope grants management capability at the OAuth level; the application never calls mutate methods and this is enforced in code (only `googleAds:searchStream` and `customers:listAccessibleCustomers` are reachable from the provider).
- **Refresh-token behaviour (from Google docs, NOT re-verifiable offline — see Unverified):**
  refresh tokens for projects whose OAuth consent screen is in *Testing* publishing
  status expire after 7 days; published apps' refresh tokens do not expire unless
  revoked or unused for ~6 months. Treat `invalid_grant` from the token endpoint as
  "connection revoked/expired" → mark connection `revoked`, stop syncs, ask user to reconnect.
- **Compliance notes:** Search Console, Analytics and Ads scopes are not on Google's
  *restricted* list (that list is Gmail/Drive/Fitness/etc.), but they are classed as
  *sensitive* and therefore require **Sensitive Scope Verification** (brand verification + use-case review)
  before the app can be published to users outside the test-user list. Until the app is
  verified and published, only test users (max 100) can connect, and refresh tokens expire
  after 7 days. This must be planned for; it is not hidden.

## 2. Google Search Console API

- **Docs:** https://developers.google.com/webmaster-tools/v1/searchanalytics/query ,
  https://developers.google.com/webmaster-tools/v1/sites/list , limits: https://developers.google.com/webmaster-tools/limits
- **Verified from:** Discovery document `searchconsole v1` rev `20261005`, live probe of `GET https://searchconsole.googleapis.com/webmasters/v3/sites` → 401 (path exists).
- **Service / version:** `searchconsole` `v1`, root URL `https://searchconsole.googleapis.com/`.
- **Methods used:**
  - `GET webmasters/v3/sites` → `SitesListResponse { siteEntry: [{ siteUrl, permissionLevel }] }`.
    `permissionLevel` enum: `SITE_PERMISSION_LEVEL_UNSPECIFIED | SITE_OWNER | SITE_FULL_USER | SITE_RESTRICTED_USER | SITE_UNVERIFIED_USER`.
    Domain properties appear as `sc-domain:example.com`; URL-prefix properties as `https://example.com/`.
  - `POST webmasters/v3/sites/{siteUrl}/searchAnalytics/query` with body `SearchAnalyticsQueryRequest`:
    - `startDate`, `endDate` (required, `YYYY-MM-DD`, **in PST (UTC-8)**, inclusive)
    - `dimensions`: array of strings; filter dimension enum confirms the set `QUERY | PAGE | COUNTRY | DEVICE | SEARCH_APPEARANCE` plus `date`; results are grouped in the order supplied
    - `type`: `WEB | IMAGE | VIDEO | NEWS | DISCOVER | GOOGLE_NEWS` (default web)
    - `dimensionFilterGroups[].filters[]`: `{ dimension, operator: EQUALS|NOT_EQUALS|CONTAINS|NOT_CONTAINS|INCLUDING_REGEX|EXCLUDING_REGEX, expression }`; `groupType` only `AND`
    - `aggregationType`: `AUTO | BY_PROPERTY | BY_PAGE | BY_NEWS_SHOWCASE_PANEL`
    - `rowLimit`: default 1000, **1..25,000**; `startRow` zero-based for paging
    - `dataState`: `FINAL` (default-equivalent, final data only) | `ALL` (includes partial/fresh data) | `HOURLY_ALL`
    - Response: `rows[] { keys[], clicks, impressions, ctr, position }`, `responseAggregationType`, and `metadata.firstIncompleteDate` (only when `dataState=ALL`, grouped by `DATE`, and the range contains incomplete days: "All values after the first_incomplete_date may still change noticeably", dates in `America/Los_Angeles`).
- **Quotas (from the limits page via search-engine snippet of the official page, see Unverified for exact numbers):** Search Analytics: 1,200 QPM per site per user; 40,000 QPM and 30,000,000 QPD per project; plus short-term (10 min) and long-term (1 day) *load* quotas — on load-quota errors wait 15 minutes or reduce query complexity.
- **Freshness:** data is reported per PST day; recent days are partial until finalised. The API tells us the first incomplete date via `metadata.firstIncompleteDate` — we store `data_through = firstIncompleteDate - 1 day` when present, else the last date row returned. We do not hard-code "2–3 days of latency".
- **Known limitations:** the API only returns rows for days that have data; anonymised queries are not returned (query-level totals are lower than property totals). Row count is bounded by `rowLimit` and paging; we cap rows per day per dimension (configurable).

## 3. Google Analytics Data API (GA4 reporting)

- **Docs:** https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport ,
  schema: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema ,
  quotas: https://developers.google.com/analytics/devguides/reporting/data/v1/quotas
- **Verified from:** Discovery document `analyticsdata v1beta` rev `20261005`; live probes `POST /v1beta/properties/123:runReport` → 401, `GET /v1beta/properties/123/metadata` → 401.
- **Service / version:** `analyticsdata` `v1beta`, root `https://analyticsdata.googleapis.com/`.
- **Scopes:** `analytics.readonly` (or `analytics`).
- **Methods used:**
  - `POST v1beta/properties/{propertyId}:runReport` — `RunReportRequest { dateRanges[] (up to 4, YYYY-MM-DD or NdaysAgo/yesterday/today in the property's reporting time zone), dimensions[] (max 9), metrics[] (max 10), dimensionFilter, metricFilter, orderBys[], limit (default 10,000, max 250,000), offset, keepEmptyRows, returnPropertyQuota, currencyCode }`.
    Response: `dimensionHeaders[]`, `metricHeaders[] { name, type }`, `rows[] { dimensionValues[].value, metricValues[].value }` (all values are strings), `rowCount`, `metadata { timeZone, currencyCode, dataLossFromOtherRow, samplingMetadatas[], subjectToThresholding, emptyReason }`, `propertyQuota`.
  - `GET v1beta/properties/{propertyId}/metadata` — returns `dimensions[] { apiName, uiName, deprecatedApiNames[], customDefinition }` and `metrics[] { apiName, uiName, deprecatedApiNames[], blockedReasons[], type }`. **We call this before the first sync of a property and verify every dimension/metric name we intend to use exists; the sync fails with an explicit error if any name is missing.** This is the runtime guard against guessed names.
- **Dimension / metric API names we use** (see Unverified: the names themselves could not be checked against the schema page offline; they are verified at runtime via `getMetadata`): dimensions `date`, `sessionSource`, `sessionMedium`, `sessionCampaignName`, `sessionDefaultChannelGroup`, `landingPage`, `deviceCategory`, `eventName`; metrics `sessions`, `totalUsers`, `newUsers`, `engagedSessions`, `keyEvents`, `eventCount`, `ecommercePurchases`, `purchaseRevenue`, `screenPageViews`.
- **Key events vs conversions:** the Admin API Discovery document marks `conversionEvents.*` as *Deprecated: Use KeyEvents instead*; the Data API metric family is `keyEvents`. We never call a generic "conversion" a business conversion: the website's `business_conversion_event` (an event name) must be configured, and business conversions are read from the per-event-name key-event table.
- **Quotas (verified from Discovery `PropertyQuota` descriptions):** standard properties 200,000 tokens/day, 40,000 tokens/hour, 10 concurrent requests, 14,000 tokens/project/hour, 120 potentially-thresholded requests/hour, 10 server errors/project/hour (GA 360: ×10). "Most requests consume fewer than 10 tokens."
- **Freshness:** not fixed by the API. Rows for recent days can change as processing completes (and intraday data may be partial). We re-fetch a rolling reconciliation window (configurable, default 3 days) and report `data_through` as the latest date that returned data.
- **Data caveats surfaced to the AI:** `dataLossFromOtherRow` ("(other)" bucketing), `subjectToThresholding`, sampling metadata — stored per sync and reported in freshness/limitations.

## 4. Google Analytics Admin API (property discovery + key events)

- **Docs:** https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list
- **Verified from:** Discovery document `analyticsadmin v1beta` rev `20261003`; live probes `GET /v1beta/accountSummaries` → 401, `GET /v1beta/properties/123/keyEvents` → 401.
- **Methods used (both accept `analytics.readonly`):**
  - `GET v1beta/accountSummaries?pageSize=200&pageToken=` → `accountSummaries[] { account, displayName, propertySummaries[] { property: "properties/{id}", displayName, propertyType: PROPERTY_TYPE_ORDINARY|SUBPROPERTY|ROLLUP, parent } }`, `nextPageToken`.
  - `GET v1beta/properties/{id}/keyEvents` → `keyEvents[] { eventName, countingMethod, custom, deletable }` — used to populate the semantic-configuration dropdown for `business_conversion_event`.
  - `GET v1beta/properties/{id}` → `{ timeZone, currencyCode, displayName }` — used to default website timezone/currency.

## 5. Google Ads API (reporting only)

- **Docs:** https://developers.google.com/google-ads/api/docs/start , REST: https://developers.google.com/google-ads/api/rest/reference/rest/v25/customers.googleAds/searchStream , fields: https://developers.google.com/google-ads/api/fields/v25/search_term_view , access levels: https://developers.google.com/google-ads/api/docs/access-levels , release notes: https://developers.google.com/google-ads/api/docs/release-notes
- **Verified from:** official `google-ads` 33.0.0 Python library (`_VALID_API_VERSIONS = ["v25","v24","v23"]`, default `v25`); live probes on `https://googleads.googleapis.com/`: `v19`–`v21` → 404 (sunset), `v22`–`v26` → 401 (live). Paths `customers/{id}/googleAds:searchStream`, `customers/{id}/googleAds:search`, `customers:listAccessibleCustomers` → 401 (exist); a misspelled path → 404.
- **Version used:** `v25` (default of the official client library as of 2026-09-23; live). Configurable via `GOOGLE_ADS_API_VERSION`. Major versions are supported for about one year; plan an upgrade check each quarter.
- **Scope:** `https://www.googleapis.com/auth/adwords`.
- **Required headers:** `Authorization: Bearer <access token>`, `developer-token: <token>`, and `login-customer-id: <manager customer id without dashes>` when accessing a client account through a manager account (verified: the official library sends `developer-token` and `login-customer-id` metadata).
- **Access requirements (official access-levels page, confirmed via search snippet of that page):** a developer token is obtained from a **Google Ads Manager account** (API Center). Levels: *Test account* (test accounts only), *Basic* (production accounts, 15,000 operations/day), *Standard* (unlimited). A new token starts at test-account level; **Basic access must be applied for before any real customer account can be read.** This is an operational blocker for go-live, not a code issue.
- **Methods used:**
  - `GET v25/customers:listAccessibleCustomers` → `{ resourceNames: ["customers/1234567890", ...] }` — accounts directly accessible to the OAuth user.
  - `POST v25/customers/{customerId}/googleAds:searchStream` body `{ query }` → array of `{ results[], fieldMask, requestId }` chunks. Used for every report and for manager→client expansion via the `customer_client` resource.
- **GAQL resources / fields (verified in v25 protos):**
  - `customer`: `id, descriptive_name, currency_code, time_zone, manager, test_account, status`
  - `customer_client`: `client_customer, id, descriptive_name, currency_code, time_zone, level, manager, hidden, status`
  - `campaign`: `id, name, status, advertising_channel_type` (enum `SEARCH, DISPLAY, SHOPPING, HOTEL, VIDEO, MULTI_CHANNEL, LOCAL, ...`)
  - `ad_group`: `id, name, status, campaign`
  - `keyword_view` (attributed `ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type` (enum `EXACT, PHRASE, BROAD`), `ad_group`, `campaign`)
  - `search_term_view`: `search_term, status (SearchTermTargetingStatus: ADDED, EXCLUDED, ADDED_EXCLUDED, NONE), ad_group`
  - `metrics`: `impressions (int), clicks (int), cost_micros (int, micros of account currency), conversions (float; only conversion actions included in the "Conversions" column), conversions_value (float), all_conversions (float), all_conversions_value, ctr, average_cpc`
  - `segments`: `date` (`YYYY-MM-DD`), `device` (enum `MOBILE, TABLET, DESKTOP, CONNECTED_TV, OTHER`), `conversion_action_name`
- **GAQL** (grammar page not fetchable offline; the queries used are fixed strings in `src/lib/providers/google-ads/queries.ts`, parameterised only by validated date strings): `SELECT ... FROM <resource> WHERE segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' [AND campaign.status != 'REMOVED'] ORDER BY ... LIMIT n`. No user- or model-supplied GAQL is ever executed.
- **Mutations:** none implemented. The provider interface exposes only `listAccessibleCustomers`, `listClientAccounts`, and typed report fetchers.
- **Quotas:** Basic access 15,000 operations/day (reporting requests count as operations); searchStream has no page size (streams all rows). Exact per-second limits not verifiable offline.
- **Freshness:** Google Ads conversion metrics are attributed and can change for days/weeks after the click (conversion windows). We re-fetch a rolling window (configurable, default 7 days) and label Ads conversions as "Google Ads attribution" in tool outputs.

## 6. OpenAI Responses API (function calling)

- **Docs:** https://platform.openai.com/docs/api-reference/responses/create , https://platform.openai.com/docs/guides/function-calling
- **Verified from:** `openai` npm 7.28.0 type definitions (`resources/responses/responses.d.ts`, `resources/shared.d.ts`), fetched 2026-10-06. Requires Node ≥ 22.
- **Request (`client.responses.create`)**: `model`, `instructions` (system text), `input` (string or array of items; message items `{ role: 'user'|'assistant'|'system'|'developer', content }`), `tools[]`, `tool_choice`, `parallel_tool_calls`, `max_output_tokens`, `previous_response_id`, `store`, `metadata`, `text.format` (`{ type: 'json_schema', name, schema, strict }`).
- **Function tool definition:** `{ type: 'function', name, description, parameters: <JSON Schema>, strict: boolean }`. With `strict: true` the schema must have `additionalProperties: false` and list every property in `required` (optional values are expressed as nullable). Our tool schemas are generated from Zod and post-processed to satisfy this; a unit test asserts it.
- **Model tool call output item:** `{ type: 'function_call', call_id, name, arguments: string(JSON), id, status }`.
- **Returning results:** append `{ type: 'function_call_output', call_id, output: string }` to `input` (we send the full item list each turn rather than relying on `previous_response_id`, and set `store: false` so no analytics data is retained by OpenAI beyond the request).
- **Response:** `{ id, status: 'completed'|'failed'|'in_progress'|'cancelled'|'queued'|'incomplete', output[], output_text, usage { input_tokens, output_tokens, total_tokens }, incomplete_details, error }`.
- **Model IDs present in the SDK's type union** (any string is accepted; we default to `gpt-4.1` and allow override via `OPENAI_MODEL`): `gpt-4.1`, `gpt-4.1-mini`, `gpt-5`, `gpt-5-mini`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.5`, ... Pricing/availability per account is not verifiable from here.
- **What we never send to OpenAI:** refresh/access tokens, client secrets, raw Google API responses, or more rows than a tool's bounded result size.

## 7. Supabase (Auth + Postgres + RLS)

- **Docs:** https://supabase.com/docs/guides/auth/server-side/nextjs
- **Verified from:** `@supabase/ssr` 0.12.7 README and `createServerClient.d.ts` / `types.d.ts`: `createServerClient(url, key, { cookies: { getAll(), setAll(cookiesToSet) } })`; call `auth.getClaims()` / `getUser()` early in the request (middleware) so refreshed cookies are written before the response commits; set `Cache-Control: private, no-store` on auth-handling routes. Peer dependency `@supabase/supabase-js ^2.114.0` (Node ≥ 22).
- **How we use it:** Supabase Auth for registration/login/session cookies only. All data access runs server-side through a `pg` connection to the Supabase Postgres database inside a transaction that executes `SET LOCAL ROLE authenticated` and sets `request.jwt.claims` to the verified user's claims, so **Row Level Security policies apply to every application query**, including those written in SQL. Sync workers use the owning role with explicit `organization_id` scoping. This is what makes the RLS tests runnable against a plain local Postgres (with a small `auth` schema shim) in CI.
- **Service role key** is only needed for user deletion/admin tasks and is never shipped to the browser.

## 8. Vercel Cron (scheduled syncs)

- **Docs:** https://vercel.com/docs/cron-jobs , https://vercel.com/docs/cron-jobs/usage-and-pricing
- **Verified from:** search-engine snippets of the official page only (page blocked offline) — see Unverified.
- **Configuration:** `vercel.json` `{ "crons": [{ "path": "/api/cron/sync", "schedule": "0 * * * *" }] }`; Vercel sends `Authorization: Bearer $CRON_SECRET`; the route rejects anything else with 401.
- **Limits reported by the docs:** Hobby plan allows cron jobs that run at most once per day (hourly expressions fail deployment) and invocation time is imprecise within the hour; Pro allows frequent schedules. Function execution time limits apply, so each cron invocation processes a bounded batch of due sync jobs and the rest wait for the next tick. A manual "Sync now" button and a `curl`-able endpoint cover non-Vercel deployments.

---

## Answer grounding and hallucination audit (application behaviour, not an external API)

Every assistant answer is audited server-side (`src/lib/ai/audit.ts`): each numeric figure
must match a value in the tool results for that turn (allowing rounding, separators, k/M
suffixes and ratio→percent), or appear in the user's question. If any figure is unsupported,
the model gets exactly one repair round with the list of unsupported figures and no tools.
The final audit (`supported`, `unsupported`, `repaired`, `initial_unsupported`) is stored in
the message's grounding metadata and shown under the answer; remaining unsupported figures
are added to the caveats as "Unverified figures". The audit checks numbers only; it cannot
detect an unsupported causal claim, which is handled by the system prompt rules.

## Unverified / must confirm before go-live

| # | Item | Why it matters | Mitigation in code |
| --- | --- | --- | --- |
| U1 | GA4 Data API dimension/metric API names (`sessionSource`, `landingPage`, `keyEvents`, `ecommercePurchases`, ...) | Schema page could not be fetched; names come from prior knowledge (search snippets confirmed `sessionDefaultChannelGroup` and `keyEvents` exist). | `getMetadata` is called before the first GA4 sync and every name is checked; missing names fail the sync with an explicit message. Names live in one file (`src/lib/providers/ga4/schema.ts`). |
| U2 | Google OAuth refresh-token expiry rules (7-day expiry in Testing status; 100-token cap per user per client) | Affects reliability for unverified apps. | Any `invalid_grant` marks the connection as revoked and stops syncs; UI asks to reconnect. |
| U3 | Sensitive-scope classification of `webmasters.readonly`, `analytics.readonly`, `adwords` and the verification process | Affects when non-test users can connect. | Documented above; confirm in the Cloud Console scope picker which labels each scope. |
| U4 | Exact Search Console quota numbers (1,200 QPM/site/user etc.) | Sync pacing. | Syncs are serial per website and retry with backoff on 429/503. |
| U5 | Exact Google Ads API rate limits and GAQL grammar page | Query correctness. | Queries are fixed, small, and exercised in LIVE mode during Phase 5 with a test account; any `INVALID_ARGUMENT`/`QUERY_ERROR` surfaces as a sync error with the Google message. |
| U6 | Whether `segments.conversion_action_name` can be combined with non-conversion metrics in one GAQL query | Conversion-action breakdown table. | The conversion-action query selects conversion metrics only. |
| U7 | Vercel cron plan limits and `CRON_SECRET` header behaviour | Scheduling frequency. | Endpoint also callable by any scheduler with the bearer secret. |
| U8 | OpenAI model availability/pricing for the configured model | Cost. | `OPENAI_MODEL` env var; failures surface as chat errors with no fabricated answer. |
| U10 | Google Ads REST JSON field casing (camelCase, int64 as strings) in `searchStream` responses | The official library is gRPC-only, so the REST JSON shape was inferred from the standard proto3 JSON mapping. | Every row is Zod-validated (`src/lib/sync/ads-normalize.ts`); a shape mismatch fails the Ads sync with the exact field path and leaves other sources untouched. Confirm with one live call to a test account. |
| U11 | Whether `search_term_view` returns rows for Performance Max campaigns | Affects "wasted spend" coverage. | The tool warns that PMax and some campaign types may not report search terms. |
| U9 | Supabase `postgres` role RLS bypass semantics via the pooler | Service-role sync writes. | Migrations use `FORCE ROW LEVEL SECURITY`-free tables owned by the migration role; sync code always filters by `organization_id` and tests cover it against local Postgres. Confirm on the real project that `SET LOCAL ROLE authenticated` is permitted for the connection user. |
