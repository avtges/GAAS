# Architecture

**Product:** "Connect your website marketing data and talk to it." A read-only,
multi-tenant analytics assistant over Google Search Console, GA4 and Google Ads.

**Guiding rule:** when a clever architecture and a boring reliable one compete,
the boring one wins. No queues, no Redis, no vector DB, no microservices.

## 1. System overview

```
Browser (Next.js React UI, Tailwind)
   │  HTTPS, Supabase session cookie
   ▼
Next.js App Router (server components, route handlers, server actions)
   ├── Supabase Auth (registration, login, session cookies via @supabase/ssr)
   ├── Postgres access layer (pg) ── runs every user query under RLS
   │       ├── withUserDb(user)   : SET LOCAL ROLE authenticated + request.jwt.claims
   │       └── withServiceDb()    : sync workers, explicitly org-scoped
   ├── Google OAuth (authorization code + PKCE + state; refresh tokens encrypted at rest)
   ├── Providers (interface + LIVE and MOCK implementations)
   │       ├── Search Console  : sites.list, searchAnalytics.query
   │       ├── GA4             : accountSummaries.list, keyEvents.list, properties.get, runReport, getMetadata
   │       └── Google Ads      : listAccessibleCustomers, googleAds:searchStream (fixed GAQL)
   ├── Sync engine (per website × source; backfill 90 days, incremental + reconciliation window)
   ├── Analytics service (deterministic SQL aggregations, comparisons, derived metrics)
   ├── AI tools (typed, bounded, org-scoped wrappers over the analytics service)
   └── Chat engine (OpenAI Responses API tool loop; server-side grounding metadata)
   ▼
Supabase Postgres (RLS on every tenant table)
```

External calls go **only** from the server. The browser never sees Google tokens,
the OpenAI key, or another tenant's rows.

## 2. Stack and versions

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript | Vercel-compatible |
| Styling | Tailwind CSS v4 | minimal UI |
| Auth | Supabase Auth via `@supabase/ssr` | email+password (magic link optional) |
| Database | Supabase Postgres, `pg` driver server-side | migrations in `supabase/migrations` |
| Validation | Zod 4 | all route inputs, provider responses, tool arguments |
| AI | OpenAI Responses API (`openai` SDK) | function tools, strict schemas |
| Jobs | Vercel Cron → `/api/cron/sync` (bearer secret) + manual "Sync now" | no queue |
| Tests | Vitest; RLS tests against local Postgres 16 | CI needs only Postgres |
| Crypto | Node `crypto` AES-256-GCM | `TOKEN_ENCRYPTION_KEY` |

## 3. Tenancy and authorization

- **Organization** is the tenant. Users belong to organizations through
  `organization_members(role)`. Every tenant table carries `organization_id`.
- **Two enforcement layers, always both:**
  1. Application code resolves the current user, loads the membership for the
     requested organization/website, and refuses otherwise (403). Route inputs are
     Zod-validated; organization and website IDs come from the URL/body but are
     *checked against membership*, never trusted.
  2. Postgres RLS. Application queries run inside a transaction that executes
     `SET LOCAL ROLE authenticated` and `SELECT set_config('request.jwt.claims', '{"sub":"<uid>","role":"authenticated"}', true)`,
     so Supabase's `auth.uid()` evaluates to the verified user and the policies in
     `supabase/migrations` apply — even to hand-written SQL in the analytics layer.
- Sync workers run with the owning database role (RLS not applied) but every statement
  is parameterised with the `website_id`/`organization_id` of the job being processed.
- Cross-tenant tests (mandatory) exercise both layers: HTTP-level forged IDs and SQL-level
  RLS with two users in a local Postgres.

## 4. Google connection model

One `google_connections` row per organization per Google account (`google_user_id`).
A single OAuth consent can grant any subset of the three product scopes; `granted_scopes`
records what was actually granted (Google may return fewer scopes than requested). The
connections page therefore shows three product rows that all derive from the same
connection:

```
Google account: alice@example.com (connected 2026-10-06)
  Search Console   scope granted ✔   property selected ✔   last sync …
  Google Analytics scope granted ✔   property selected ✘ (choose one)
  Google Ads       scope granted ✘   [Grant access]  → incremental authorization
```

- Refresh tokens are encrypted (AES-256-GCM, key id prefix for rotation) before insert
  and decrypted only inside the token-refresh helper on the server.
- Access tokens are cached in memory per request only; they are never persisted.
- `invalid_grant` on refresh ⇒ connection `status = 'revoked'`, syncs stop, UI prompts reconnect.
- Disconnect ⇒ call Google's revocation endpoint (best effort), delete the connection row,
  mark source statuses `disconnected`. Imported data stays until the user deletes it.

## 5. Data model (summary; full DDL in `supabase/migrations/0001_init.sql`)

Core: `organizations`, `organization_members`, `google_connections`, `websites`
(+ semantic config columns), `website_sources` (per website × source: selection,
status, last sync, data_through, last error), `sync_jobs`, `chat_threads`, `chat_messages`.

Analytics (all keyed by `website_id` + `date`, one row per natural key, upserted):

| Source | Table | Grain |
| --- | --- | --- |
| GSC | `gsc_daily_totals` | date (no dimension) |
| GSC | `gsc_query_daily` | date × query (top N/day) |
| GSC | `gsc_page_daily` | date × page (top N/day) |
| GSC | `gsc_device_daily` | date × device |
| GSC | `gsc_country_daily` | date × country |
| GA4 | `ga4_daily_totals` | date |
| GA4 | `ga4_acquisition_daily` | date × source × medium × campaign × channel group |
| GA4 | `ga4_landing_page_daily` | date × landing page |
| GA4 | `ga4_device_daily` | date × device category |
| GA4 | `ga4_event_daily` | date × event name (eventCount, keyEvents) |
| Ads | `ads_campaign_daily` | date × campaign |
| Ads | `ads_ad_group_daily` | date × ad group |
| Ads | `ads_keyword_daily` | date × ad group × criterion |
| Ads | `ads_search_term_daily` | date × ad group × search term |
| Ads | `ads_device_daily` | date × campaign × device |
| Ads | `ads_conversion_action_daily` | date × campaign × conversion action |

Row-count control: GSC query/page tables are capped per day (`GSC_ROW_CAP_PER_DAY`,
default 2,500); we do not store query×page×country×device combinations. Metrics that
are ratios (CTR, position, average CPC) are recomputed from sums at query time
(position is impression-weighted); only sums are stored except GSC `position`, which is
stored as `position_impressions` (position × impressions) to allow correct weighting.

## 6. Sync strategy

- `website_sources` holds, per source: `status` (`not_configured | ok | syncing | error | revoked | disconnected`),
  `last_sync_started_at`, `last_sync_succeeded_at`, `data_through` (date), `last_error`,
  `backfill_done`.
- **Initial sync**: `SYNC_BACKFILL_DAYS` (default 90) in chunks (GSC: per-day requests
  per dimension set with paging; GA4: one report per table over the whole range with
  paging; Ads: one searchStream per table over the range).
- **Incremental sync**: fetch from `data_through - RECONCILIATION_DAYS[source]` to today
  (defaults: GSC 3, GA4 3, Ads 7 — all configurable via env). Rows are upserted on the
  natural key, so re-fetched days overwrite earlier partial values.
- **`data_through`**: GSC uses `metadata.firstIncompleteDate - 1` when present; otherwise
  all sources use the max date that returned data. No latency assumptions are hard-coded.
- **Independence**: each source is a separate job with its own try/catch and status; a
  failing Ads sync never blocks GSC/GA4.
- **Scheduling**: `/api/cron/sync` (bearer `CRON_SECRET`) claims up to `SYNC_BATCH_SIZE`
  due sources (`next_sync_at <= now()`, lease via `syncing` status with timeout), runs
  them sequentially, records `sync_jobs`. Manual trigger from the UI uses the same code.
- **Errors**: Google 401/`invalid_grant` ⇒ revoked; 403 ⇒ `permission_denied` (property
  removed / Ads access removed); 404 ⇒ `not_found` (deleted property); 429/5xx ⇒ retry
  with exponential backoff (bounded), then `error`; malformed JSON ⇒ Zod error recorded.

## 7. Analytics service (deterministic)

Pure functions + parameterised SQL in `src/lib/analytics`. Responsibilities:
period totals, period-over-period comparison (absolute and % change with zero guards),
top movers, CTR/CPA/ROAS/conversion-rate with `null` when the denominator is 0,
`sample_size_warning` flags (e.g. conversions < 20 in either period), query-opportunity
scoring (impressions high, CTR below the site's position-adjusted expectation), wasted-spend
detection (cost with zero conversions over the window), brand/non-brand split using
`brand_queries`. All date ranges are explicit and bounded (max 400 days).

## 8. AI layer

- OpenAI Responses API with function tools generated from Zod schemas (strict mode).
- Tools (initial set): `get_sync_status`, `get_search_performance`, `get_search_queries`,
  `get_search_pages`, `get_ga4_acquisition`, `get_ga4_landing_pages`, `get_ga4_devices`,
  `get_ga4_business_conversions`, `get_ads_campaign_performance`,
  `get_ads_ad_group_performance`, `get_ads_keyword_performance`, `get_ads_search_terms`,
  `compare_date_ranges`, `compare_channels`.
- Each tool: receives `{ organizationId, websiteId, userId }` **from the server context**,
  never from the model; validates args with Zod; enforces max rows; returns structured JSON
  with `source`, `date_range`, `data_through`, `attribution`/`measurement` labels and any
  `warnings` (insufficient data, thresholding, sampling, missing semantic config).
- Loop: up to `AI_MAX_TOOL_ROUNDS` (default 6). Tool outputs are appended as
  `function_call_output` items. `store: false`.
- **Grounding metadata** is built server-side from the executed tool calls (sources,
  date ranges, comparison ranges, filters, data_through per source) and saved on the
  assistant message. The UI renders it under every answer. The model cannot fabricate it.
- The system prompt encodes the answer rules (never invent metrics, separate observation
  from hypothesis, disclose sample sizes and freshness, label attribution systems, do not
  combine incompatible numbers).

## 9. Modes

`GOOGLE_PROVIDER_MODE=live|mock` and `OPENAI_MODE=live|mock`. Mock providers implement the
same TypeScript interfaces as the live ones and return deterministic fixtures (seeded) so
the whole pipeline (discovery → sync → tables → tools → chat) runs with no credentials.
The mock OpenAI client performs a deterministic keyword→tool routing so the UI and the
tool loop can be exercised; model-quality tests are gated on `OPENAI_API_KEY`.

## 10. Security checklist (implemented or tested in Phase 1/9)

tenant isolation (app + RLS) · encrypted refresh tokens · protected routes · env-only
secrets · no secrets in client bundles (only `NEXT_PUBLIC_*` reach the browser) ·
structured logs with token redaction · parameterised SQL only · Zod on every input ·
rate limiting on chat and OAuth routes (in-memory token bucket per user; adequate for MVP
single-region deploys, documented limitation) · explicit, confirmed destructive actions.

## 11. Out of scope (by design)

Campaign editing, bidding, crawler, rank tracker, CMS, agents, vector DB/RAG, CSV upload,
email/Slack, dashboards, billing, mobile, extension, MCP server.
