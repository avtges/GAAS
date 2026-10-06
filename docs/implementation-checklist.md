# Implementation checklist

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (see docs/integration-verification.md "Unverified")

## Phase 0 — Planning (this document set)
- [x] Inspect repository (empty: no commits, no files)
- [x] Verify Google OAuth, Search Console, GA4 Data/Admin, Google Ads, OpenAI Responses, Supabase SSR against official artifacts
- [x] docs/architecture.md
- [x] docs/integration-verification.md
- [x] Concrete schema: supabase/migrations/0001_init.sql (+ docs/schema.md)
- [x] This checklist

## Phase 1 — Foundation
- [x] Next.js 16 + TS + Tailwind + App Router scaffold; `.env.example`
- [x] Supabase Auth (register, login, logout) via @supabase/ssr; proxy session refresh; dev-only local auth
- [x] Postgres access layer (`withUserDb` under RLS, `withServiceDb`), structured logger with redaction
- [x] Migrations: core tables, analytics tables, RLS policies, helper functions, token column grants
- [x] Organization bootstrap, membership checks, website CRUD
- [x] Local Postgres harness with `auth` shim; cross-tenant RLS tests
- [x] Rate limiting primitive (in-memory; per-instance limitation documented)

## Phase 2 — Google OAuth
- [x] Start route (state + PKCE in signed httpOnly cookie, incremental scopes)
- [x] Callback (state/user check, code exchange, scope recording, encrypted refresh token)
- [x] Token refresh helper; `invalid_grant` ⇒ connection and sources revoked
- [x] Disconnect (revoke at Google + delete); tests for revoked, refresh caching, cross-tenant
- [ ] Live verification against a real Google Cloud OAuth client (needs credentials)

## Phase 3 — Search Console
- [x] Provider interface + LIVE + MOCK (sites.list, searchAnalytics.query with paging)
- [x] Property discovery and selection UI
- [x] Resumable 90-day backfill; incremental with reconciliation window; data_through from firstIncompleteDate
- [x] Analytics + tools + chat with grounding metadata

## Phase 4 — GA4
- [x] Provider (accountSummaries, properties.get, keyEvents.list, getMetadata, runReport with paging)
- [x] Runtime validation of dimension/metric names (guards U1)
- [x] Backfill/incremental → ga4_* tables; semantic config (business_conversion_event, revenue_event)

## Phase 5 — Google Ads
- [x] Provider (listAccessibleCustomers, customer_client expansion, searchStream with fixed GAQL)
- [x] Account discovery UI (manager → client accounts, login-customer-id)
- [x] Backfill/incremental → ads_* tables
- [!] Requires a developer token with Basic access for real accounts (operational)
- [ ] Confirm REST JSON casing with one live call (U10)

## Phase 6 — Analytics service
- [x] Period totals, comparisons, % change with zero guards, small-sample warnings
- [x] Query opportunity score, wasted spend, brand split, four-period baseline
- [x] Unit tests for calculations

## Phase 7 — AI
- [x] 14 typed tools (Zod → strict JSON schema), server-context injection, bounded outputs
- [x] Responses API loop (`store:false`), mock client, grounding metadata, system prompt
- [x] Hallucination audit with one-round self-repair, shown under each answer
- [ ] Live-model evaluation run (needs OPENAI_API_KEY); mock-model behaviour tests pass

## Phase 8 — UI
- [x] Sidebar (websites, chat, connections, settings), chat with threads, status header, suggested questions
- [x] Connections page: grant/selection per product, errors, Sync now, recent sync jobs
- [x] Settings: semantic configuration; confirmed delete-data and delete-website

## Phase 9 — Tests & hardening
- [x] Unit, integration, security (cross-tenant DB, tools, chat, forged IDs), sync-failure isolation, OAuth errors, AI behaviour
- [x] End-to-end browser walkthrough of the MVP definition of done in mock mode
- [ ] Distributed rate limiting if deployed on more than one instance

## Blockers / assumptions not yet verified
See "Unverified / must confirm before go-live" in docs/integration-verification.md (U1–U9).
Operational prerequisites for a real deployment:
1. Google Cloud project with OAuth client (web), consent screen, the three APIs enabled, sensitive-scope verification for public use.
2. Google Ads developer token (manager account) at Basic access or higher.
3. Supabase project (Auth + Postgres) and its pooler connection string.
4. OpenAI API key.
5. Vercel project (Pro plan for hourly cron; Hobby allows daily only) or any scheduler that can call the cron endpoint with the bearer secret.
