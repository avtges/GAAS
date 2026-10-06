# Deploy to Vercel (with Supabase)

This gets a working production URL in about 20 minutes, using mock Google data and a mock AI
first. Real Google and OpenAI credentials are switched on afterwards, one at a time.

You need free accounts at supabase.com and vercel.com, and access to the GitHub repo.

## 1. Supabase: database and login

1. At supabase.com, click **New project**. Choose a name and region, and **save the
   database password** it asks you to create.
2. When the project is ready, open **SQL Editor**, then **New query**. Paste the whole
   contents of [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql)
   and click **Run**. It should finish with "Success. No rows returned".
   Do not run anything from the `supabase/shim` folder; that is for local tests only.
3. For quick testing, open **Authentication**, then **Sign In / Providers**, then **Email**,
   and turn off **Confirm email**. (Leave it on if you want real email confirmation.)
4. Click **Connect** at the top of the project. Copy these three values somewhere safe:
   - the **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **anon** or **publishable** API key
   - under **Connection string**, the **Transaction pooler** URI (port 6543). Replace
     `[YOUR-PASSWORD]` in it with the database password from step 1.
5. Optional but recommended: in **Project Settings**, then **Database**, find
   **SSL Configuration** and click **Download certificate**. Open the file in a text editor
   and keep its contents for `DATABASE_SSL_CA` below. Without it, the connection is still
   encrypted, but the database's identity isn't verified.

## 2. Vercel: the app

1. At vercel.com, click **Add New**, then **Project**, and import the `avtges/GAAS`
   repository. The framework is detected as Next.js; keep the default build settings.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from step 1.4 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon or publishable key from step 1.4 |
   | `DATABASE_URL` | Transaction pooler URI from step 1.4, with your password |
   | `DATABASE_SSL_CA` | Certificate contents from step 1.5 (optional) |
   | `AUTH_MODE` | `supabase` |
   | `GOOGLE_PROVIDER_MODE` | `mock` |
   | `OPENAI_MODE` | `mock` |
   | `TOKEN_ENCRYPTION_KEY` | output of `openssl rand -base64 32` in a Mac terminal |
   | `CRON_SECRET` | output of `openssl rand -hex 32` |
   | `APP_URL` | leave out for now; set it in step 4 |

3. Click **Deploy** and wait for it to finish.
4. Copy the production domain Vercel shows (for example `https://gaas-xyz.vercel.app`).
   In **Settings**, then **Environment Variables**, add `APP_URL` with that address
   (no trailing slash). Then open **Deployments**, click the three dots on the latest one,
   and choose **Redeploy**.

## 3. Tell Supabase where the app lives

In Supabase, open **Authentication**, then **URL Configuration**:
- **Site URL**: your `APP_URL`
- **Redirect URLs**: add `APP_URL/auth/callback` (for example
  `https://gaas-xyz.vercel.app/auth/callback`)

## 4. Try it

Open your `APP_URL`, click **Register**, and create an account. If you left email
confirmation on, click the link in the email first. Then:

1. Add a website.
2. On **Connections**, click **Connect Google**. In mock mode no Google screen appears.
3. Choose the Search Console property, GA4 property and Ads account. The import runs in the
   background; refresh after a minute and the status bar shows "data through" dates.
4. Ask questions on the chat page.

Scheduled syncs run once a day (the Hobby plan allows daily cron jobs only; on Pro you can
change `vercel.json` to `0 * * * *` for hourly). "Sync now" on the Connections page runs
one immediately.

## 5. Switch on real data, one source at a time

- **Google**: in Google Cloud Console, enable the Search Console API, Google Analytics Data
  API, Google Analytics Admin API and Google Ads API; configure the OAuth consent screen
  (add yourself as a test user); create a **Web application** OAuth client with redirect
  URI `APP_URL/api/google/oauth/callback`. In Vercel set `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and `GOOGLE_PROVIDER_MODE=live`, then redeploy. Disconnect the mock
  connection and connect again.
- **Google Ads**: also set `GOOGLE_ADS_DEVELOPER_TOKEN`. New tokens only read test
  accounts until Google approves Basic access.
- **OpenAI**: set `OPENAI_API_KEY` and `OPENAI_MODE=live`, then redeploy.

## If something fails

Open the project in Vercel and click **Logs**. Every server error and every sync is logged
as one line of JSON. Common messages:

| Message | Fix |
| --- | --- |
| `Invalid environment configuration: DATABASE_URL` | `DATABASE_URL` is missing in Vercel. |
| `password authentication failed` | The password inside `DATABASE_URL` is wrong. |
| `relation "public.organizations" does not exist` | The SQL in step 1.2 was not run on this project. |
| `self-signed certificate` / `unable to verify` | `DATABASE_SSL_CA` has the wrong certificate; remove it or download it again. |
| Login page says Supabase is not configured | The two `NEXT_PUBLIC_SUPABASE_*` variables are missing; add them and redeploy. |
| Email link opens localhost | `APP_URL` or the Supabase Site URL still points at localhost. |
| `AUTH_MODE=local is a development-only setting` | Set `AUTH_MODE=supabase` in Vercel. |
