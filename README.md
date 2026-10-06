# GAAS — talk to your marketing data

A read-only, multi-tenant MVP that connects **Google Search Console**, **Google Analytics 4**
and **Google Ads**, keeps their data synchronized in Postgres, and answers natural-language
questions through an AI chat that is grounded only in the connected data.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- What was verified against official sources, and what was not: [`docs/integration-verification.md`](docs/integration-verification.md)
- Schema: [`docs/schema.md`](docs/schema.md) and [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
- Status and remaining work: [`docs/implementation-checklist.md`](docs/implementation-checklist.md)

## What it looks like

| | |
| --- | --- |
| ![Chat answer with sources, period, freshness and audit](docs/screenshots/5-chat-answer.png) | ![Connections and sync status](docs/screenshots/3-connections.png) |
| ![Suggested questions](docs/screenshots/4-chat-empty.png) | ![Semantic configuration and delete actions](docs/screenshots/6-settings.png) |

Screenshots are from mock mode, where the assistant lists observations only. With
`OPENAI_MODE=live` the answer is written by the model from the same tool results.

## Try it in your browser (GitHub Codespaces, nothing to install)

1. On the repository page on GitHub, click **Code**, then the **Codespaces** tab, then
   **Create codespace on** this branch.
2. Wait for setup to finish (a few minutes the first time). It installs Postgres and the
   npm packages, creates the database, and writes a mock-mode `.env.local` for you.
3. In the terminal at the bottom, run `npm run dev`. A browser tab opens with the app; if it
   doesn't, open the **Ports** tab and click the globe icon next to port 3000.
4. Sign in with any email and follow the checklist in the next section.

Run the automated tests in the same terminal with `npm test`. Stop the codespace from
github.com/codespaces when you're done so it doesn't use your free hours.

## Run locally without any credentials (mock mode)

Requires Node 22+ and a local Postgres 16 superuser (`postgres:postgres@127.0.0.1:5432`).

```bash
npm install
TEST_DATABASE_NAME=gaas_dev ./scripts/test-db.sh   # creates gaas_dev with a Supabase shim + migrations
cp .env.example .env.local                        # then set:
#   AUTH_MODE=local  GOOGLE_PROVIDER_MODE=mock  OPENAI_MODE=mock
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gaas_dev
#   TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
npm run dev
```

Open http://localhost:3000, sign in with any email (dev-only auth), add a website, click
**Connect Google**, choose the mock Search Console property, GA4 property and Ads account,
and ask questions. Mock providers return deterministic fixtures through the same interfaces
and normalization code as the live providers. The mock model routes questions to tools by
keyword and reports observations only.

## Tests

```bash
npm test          # creates a throwaway gaas_test database, applies migrations, runs vitest
npm run lint
npm run typecheck
```

The suite includes the mandatory cross-tenant tests (RLS and application layer), sync
normalization and failure isolation per source, OAuth error handling, metric calculations,
strict tool-schema validity, tool authorization, and AI behaviour tests (tool routing,
grounding metadata, no unsupported numbers, missing-configuration disclosure, and the
hallucination self-repair loop).

## Production setup

1. **Supabase**: create a project; apply `supabase/migrations/*.sql` (never the shim);
   set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `DATABASE_URL`
   (pooler connection string). Set `AUTH_MODE=supabase`.
2. **Google Cloud**: enable the Search Console API, Google Analytics Data API, Google
   Analytics Admin API and Google Ads API; configure the OAuth consent screen; create a Web
   OAuth client with redirect URI `<APP_URL>/api/google/oauth/callback`. While the consent
   screen is in *Testing*, only listed test users can connect and refresh tokens expire after
   7 days. Public use requires sensitive-scope verification.
3. **Google Ads**: get a developer token from a Google Ads **manager** account (API Center)
   and apply for **Basic access**; test-level tokens cannot read real accounts.
4. **OpenAI**: set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`; set `OPENAI_MODE=live`.
5. Generate `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) and `CRON_SECRET`.
6. **Scheduling**: `vercel.json` calls `/api/cron/sync` hourly (requires a Vercel plan that
   allows hourly crons; Hobby allows daily). Any scheduler can call it with
   `Authorization: Bearer $CRON_SECRET`.

Every variable is documented in [`.env.example`](.env.example).
