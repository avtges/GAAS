# Database schema

The authoritative schema is `supabase/migrations/0001_init.sql` (applied in order with any
later files). This page summarises intent; read the SQL for exact columns and policies.

## Access model
- Every tenant table has `organization_id` and Row Level Security. Policies call
  `public.is_org_member(org)` / `public.org_role(org)` (SECURITY DEFINER helpers that read
  `organization_members` for `auth.uid()`).
- Application reads/writes run as role `authenticated` with the user's claims set
  (`src/lib/db/pool.ts: withUserDb`). Sync workers and the OAuth callback use the owning
  role (`withServiceDb`) and always filter by `organization_id` / `website_id`.
- `google_connections.encrypted_refresh_token` is excluded from the `authenticated` role's
  column grants, so it cannot be read even by a member of the organization.

## Tables
| Table | Purpose |
| --- | --- |
| `organizations`, `organization_members(role: owner/admin/member)`, `users` | tenancy |
| `google_connections` | one per org × Google account; encrypted refresh token; granted scopes; status active/revoked |
| `websites` | workspace: domain, timezone, currency, selected `gsc_property`, `ga4_property_id`, `google_ads_customer_id` (+ `google_ads_login_customer_id`), semantic config (`business_conversion_event`, `revenue_event`, `primary_google_ads_conversion`, `brand_queries`) |
| `website_sources` | one row per website × source: status, last sync times, `data_through`, `last_error`, `next_sync_at`, `limitations` jsonb |
| `sync_jobs` | audit of each sync run: kind backfill/incremental, range, rows written, duration, error |
| `chat_threads`, `chat_messages(metadata jsonb)` | chat history; assistant messages carry grounding metadata |
| `gsc_daily_totals`, `gsc_query_daily`, `gsc_page_daily`, `gsc_device_daily`, `gsc_country_daily` | Search Console; `position_impressions = Σ position×impressions` |
| `ga4_daily_totals`, `ga4_acquisition_daily`, `ga4_landing_page_daily`, `ga4_device_daily`, `ga4_event_daily` | GA4 |
| `ads_campaign_daily`, `ads_ad_group_daily`, `ads_keyword_daily`, `ads_search_term_daily`, `ads_device_daily`, `ads_conversion_action_daily` | Google Ads; money in `cost_micros` |

## Local test harness
`scripts/test-db.sh` creates a throwaway database, applies `supabase/shim/supabase_shim.sql`
(roles `anon/authenticated/service_role`, `auth.users`, `auth.uid()`), then the migrations.
`npm test` runs it automatically; it needs a local Postgres superuser at
`postgresql://postgres:postgres@127.0.0.1:5432/postgres` (override with
`TEST_DATABASE_ADMIN_URL`).

## Applying to Supabase
Run the migration files in the SQL editor or with the Supabase CLI
(`supabase db push`). Do **not** apply the shim to a Supabase project.
