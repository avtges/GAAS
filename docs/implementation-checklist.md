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
- [ ] Next.js 16 + TS + Tailwind + App Router scaffold; `.env.example`
- [ ] Supabase Auth (register, login, logout) via @supabase/ssr; proxy/middleware session refresh
- [ ] Postgres access layer (`withUserDb`, `withServiceDb`), structured logger with redaction
- [ ] Migrations: core tables, analytics tables, RLS policies, helper functions
- [ ] Organization bootstrap (first org on signup), membership checks, website CRUD
- [ ] Local Postgres test harness with `auth` shim; cross-tenant RLS tests (mandatory)
- [ ] Rate limiting primitive

## Phase 2 — Google OAuth
- [ ] `/api/google/oauth/start` (state + PKCE in httpOnly cookie, incremental scopes)
- [ ] `/api/google/oauth/callback` (state check, code exchange, scope recording, encrypted refresh token)
- [ ] Token refresh helper; `invalid_grant` ⇒ revoked
- [ ] Disconnect (revoke + delete); tests for state mismatch, denied consent, partial scopes

## Phase 3 — Search Console (vertical slice to chat)
- [ ] Provider interface + LIVE + MOCK (sites.list, searchAnalytics.query with paging)
- [ ] Property discovery UI + selection
- [ ] Backfill 90 days → gsc_* tables; incremental with reconciliation window; data_through from firstIncompleteDate
- [ ] One analytics function + one AI tool (`get_search_queries`) + chat answer with grounding metadata

## Phase 4 — GA4
- [ ] Provider (accountSummaries, properties.get, keyEvents.list, getMetadata, runReport with paging)
- [ ] Runtime schema validation of dimension/metric names (guards U1)
- [ ] Backfill/incremental → ga4_* tables; semantic config (business_conversion_event, revenue_event)

## Phase 5 — Google Ads
- [ ] Provider (listAccessibleCustomers, customer_client expansion, searchStream fixed GAQL)
- [ ] Account discovery UI (manager → client accounts, login-customer-id)
- [ ] Backfill/incremental → ads_* tables (cost in micros → currency units at read time)
- [!] Requires a developer token with Basic access for real accounts (operational)

## Phase 6 — Analytics service
- [ ] Period totals / comparisons / % change with zero guards / sample-size flags
- [ ] Query opportunity score, wasted spend, brand split, top movers
- [ ] Unit tests for every calculation

## Phase 7 — AI
- [ ] Tool registry (Zod → strict JSON schema), server-context injection, bounded outputs
- [ ] Responses API loop, mock client, grounding metadata builder, system prompt
- [ ] Tests: schema strictness, authorization inside tools, insufficient-data disclosure

## Phase 8 — UI
- [ ] Sidebar (workspaces, connections, chats, settings), chat panel, status header, suggested questions
- [ ] Connections page with three product rows, errors shown plainly
- [ ] Settings: semantic configuration; Danger zone: disconnect Google, delete data (confirmed)

## Phase 9 — Tests & hardening
- [ ] Unit (analytics, dates, semantic config) · Integration (sync normalization, tool validation, org authz)
- [ ] Security (cross-tenant website/analytics/tool access, forged org IDs) · Sync-failure isolation · OAuth error handling
- [ ] AI tests (tool selection, no fabrication, insufficient data) — live ones gated on OPENAI_API_KEY

## Blockers / assumptions not yet verified
See "Unverified / must confirm before go-live" in docs/integration-verification.md (U1–U9).
Operational prerequisites for a real deployment:
1. Google Cloud project with OAuth client (web), consent screen, the three APIs enabled, sensitive-scope verification for public use.
2. Google Ads developer token (manager account) at Basic access or higher.
3. Supabase project (Auth + Postgres) and its pooler connection string.
4. OpenAI API key.
5. Vercel project (Pro plan for hourly cron; Hobby allows daily only) or any scheduler that can call the cron endpoint with the bearer secret.
