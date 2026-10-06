-- GAAS initial schema. Supabase Postgres (auth.uid() provided by Supabase; the test
-- harness provides a shim). All tenant tables carry organization_id and have RLS.
-- Conventions: timestamps are timestamptz; dates are DATE in the source's reporting
-- time zone (GSC: America/Los_Angeles; GA4: property time zone; Ads: account time zone).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Core tenancy
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null,               -- auth.users.id
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,                  -- auth.users.id
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id);

-- Users: Supabase keeps identities in auth.users. We keep a light public profile so
-- the app never needs the service role for ordinary reads.
create table public.users (
  id uuid primary key,                    -- = auth.users.id
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper: membership check used by every RLS policy. SECURITY DEFINER so that the
-- policy on organization_members itself does not recurse.
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function public.org_role(org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role from public.organization_members m
  where m.organization_id = org and m.user_id = auth.uid()
  limit 1;
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.org_role(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.org_role(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Google connections (one per organization per Google account)
-- ---------------------------------------------------------------------------
create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  google_user_id text not null,           -- OIDC "sub"
  google_email text,
  encrypted_refresh_token text not null,  -- "v1:<iv>:<tag>:<ciphertext>" base64 parts
  granted_scopes text[] not null default '{}',
  access_token_expiry timestamptz,        -- informational; access tokens are not stored
  status text not null default 'active' check (status in ('active','revoked')),
  last_error text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, google_user_id)
);

-- ---------------------------------------------------------------------------
-- Websites (workspaces) + semantic configuration
-- ---------------------------------------------------------------------------
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain text not null check (char_length(domain) between 1 and 253),
  display_name text not null check (char_length(display_name) between 1 and 120),
  timezone text not null default 'UTC',
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  google_connection_id uuid references public.google_connections(id) on delete set null,
  gsc_property text,                      -- e.g. 'sc-domain:example.com' or 'https://example.com/'
  ga4_property_id text,                   -- numeric id as text, e.g. '123456789'
  google_ads_customer_id text,            -- 10 digits, no dashes
  google_ads_login_customer_id text,      -- manager account used to reach the customer (optional)
  -- semantic configuration (business meaning of platform metrics)
  business_conversion_event text,         -- GA4 event name that means "a business conversion"
  revenue_event text,                     -- GA4 event name whose value is revenue (usually 'purchase')
  primary_google_ads_conversion text,     -- Google Ads conversion action name
  brand_queries text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index websites_org_idx on public.websites(organization_id);

-- Per website × source sync state. Exactly one row per (website, source).
create table public.website_sources (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (source in ('gsc','ga4','ads')),
  status text not null default 'not_configured'
    check (status in ('not_configured','ok','syncing','error','revoked','disconnected')),
  backfill_done boolean not null default false,
  backfill_cursor date,                   -- next day to import during a resumable backfill
  last_sync_started_at timestamptz,
  last_sync_succeeded_at timestamptz,
  data_through date,
  last_error text,
  next_sync_at timestamptz,
  limitations jsonb not null default '{}'::jsonb,   -- e.g. {"sampled":true,"thresholded":true}
  primary key (website_id, source)
);
create index website_sources_due_idx on public.website_sources(next_sync_at) where status in ('ok','error');

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  source text not null check (source in ('gsc','ga4','ads')),
  kind text not null check (kind in ('backfill','incremental')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  error_message text,
  data_through date,
  range_start date,
  range_end date,
  rows_written integer not null default 0,
  duration_ms integer
);
create index sync_jobs_website_idx on public.sync_jobs(website_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  created_by uuid not null,
  title text,
  created_at timestamptz not null default now()
);
create index chat_threads_website_idx on public.chat_threads(website_id, created_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  metadata jsonb,                          -- grounding metadata for assistant messages
  created_at timestamptz not null default now()
);
create index chat_messages_thread_idx on public.chat_messages(thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Search Console (dates are PST days as returned by the API)
-- position is stored impression-weighted so averages can be recomputed correctly.
-- ---------------------------------------------------------------------------
create table public.gsc_daily_totals (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  search_type text not null default 'WEB',
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_impressions double precision not null default 0,  -- sum(position * impressions)
  primary key (website_id, search_type, date)
);

create table public.gsc_query_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  query text not null,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_impressions double precision not null default 0,
  primary key (website_id, date, query)
);

create table public.gsc_page_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  page text not null,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_impressions double precision not null default 0,
  primary key (website_id, date, page)
);

create table public.gsc_device_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  device text not null,      -- DESKTOP | MOBILE | TABLET
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_impressions double precision not null default 0,
  primary key (website_id, date, device)
);

create table public.gsc_country_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  country text not null,     -- ISO 3166-1 alpha-3 lower-case as returned (e.g. 'usa')
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_impressions double precision not null default 0,
  primary key (website_id, date, country)
);

-- ---------------------------------------------------------------------------
-- GA4 (dates in the property's reporting time zone)
-- ---------------------------------------------------------------------------
create table public.ga4_daily_totals (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  sessions bigint not null default 0,
  total_users bigint not null default 0,
  new_users bigint not null default 0,
  engaged_sessions bigint not null default 0,
  key_events double precision not null default 0,
  purchases bigint not null default 0,           -- ecommercePurchases
  purchase_revenue numeric(18,4) not null default 0,
  screen_page_views bigint not null default 0,
  primary key (website_id, date)
);

create table public.ga4_acquisition_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  session_source text not null,
  session_medium text not null,
  session_campaign text not null,
  session_default_channel_group text not null,
  sessions bigint not null default 0,
  total_users bigint not null default 0,
  new_users bigint not null default 0,
  engaged_sessions bigint not null default 0,
  key_events double precision not null default 0,
  purchases bigint not null default 0,
  purchase_revenue numeric(18,4) not null default 0,
  primary key (website_id, date, session_source, session_medium, session_campaign, session_default_channel_group)
);
create index ga4_acq_channel_idx on public.ga4_acquisition_daily(website_id, session_default_channel_group, date);

create table public.ga4_landing_page_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  landing_page text not null,
  sessions bigint not null default 0,
  total_users bigint not null default 0,
  new_users bigint not null default 0,
  engaged_sessions bigint not null default 0,
  key_events double precision not null default 0,
  purchases bigint not null default 0,
  purchase_revenue numeric(18,4) not null default 0,
  primary key (website_id, date, landing_page)
);

create table public.ga4_device_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  device_category text not null,
  sessions bigint not null default 0,
  total_users bigint not null default 0,
  new_users bigint not null default 0,
  engaged_sessions bigint not null default 0,
  key_events double precision not null default 0,
  purchases bigint not null default 0,
  purchase_revenue numeric(18,4) not null default 0,
  primary key (website_id, date, device_category)
);

-- Per event name: event_count (all occurrences) and key_events (only if the event is a
-- configured key event). The business conversion is looked up here by event name.
create table public.ga4_event_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  event_name text not null,
  event_count bigint not null default 0,
  key_events double precision not null default 0,
  primary key (website_id, date, event_name)
);

-- ---------------------------------------------------------------------------
-- Google Ads (dates in the account time zone; money in micros of the account currency)
-- ---------------------------------------------------------------------------
create table public.ads_campaign_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  campaign_name text not null,
  campaign_status text not null,
  channel_type text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  all_conversions double precision not null default 0,
  primary key (website_id, date, campaign_id)
);

create table public.ads_ad_group_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  campaign_name text not null,
  ad_group_id bigint not null,
  ad_group_name text not null,
  ad_group_status text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  primary key (website_id, date, ad_group_id)
);

create table public.ads_keyword_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  ad_group_id bigint not null,
  criterion_id bigint not null,
  keyword_text text not null,
  match_type text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  primary key (website_id, date, ad_group_id, criterion_id)
);

create table public.ads_search_term_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  ad_group_id bigint not null,
  search_term text not null,
  targeting_status text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  primary key (website_id, date, ad_group_id, search_term)
);

create table public.ads_device_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  device text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_micros bigint not null default 0,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  primary key (website_id, date, campaign_id, device)
);

create table public.ads_conversion_action_daily (
  website_id uuid not null references public.websites(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  campaign_id bigint not null,
  conversion_action_name text not null,
  conversions double precision not null default 0,
  conversions_value double precision not null default 0,
  all_conversions double precision not null default 0,
  primary key (website_id, date, campaign_id, conversion_action_name)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.users enable row level security;
alter table public.google_connections enable row level security;
alter table public.websites enable row level security;
alter table public.website_sources enable row level security;
alter table public.sync_jobs enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;

-- organizations: members can read; creator inserts; owners/admins update; owners delete
create policy org_select on public.organizations for select to authenticated
  using (public.is_org_member(id) or created_by = auth.uid());
create policy org_insert on public.organizations for insert to authenticated
  with check (created_by = auth.uid());
create policy org_update on public.organizations for update to authenticated
  using (public.org_role(id) in ('owner','admin'));
create policy org_delete on public.organizations for delete to authenticated
  using (public.org_role(id) = 'owner');

-- organization_members: members can see co-members; a user may add themselves as owner
-- only to an organization they created with no members yet; owners/admins manage others.
create policy members_select on public.organization_members for select to authenticated
  using (public.is_org_member(organization_id));
create policy members_insert_bootstrap on public.organization_members for insert to authenticated
  with check (
    user_id = auth.uid() and role = 'owner'
    and exists (select 1 from public.organizations o
                where o.id = organization_members.organization_id and o.created_by = auth.uid())
    and not exists (select 1 from public.organization_members m
                    where m.organization_id = organization_members.organization_id)
  );
create policy members_insert_admin on public.organization_members for insert to authenticated
  with check (public.org_role(organization_id) in ('owner','admin'));
create policy members_delete on public.organization_members for delete to authenticated
  using (public.org_role(organization_id) in ('owner','admin') or user_id = auth.uid());

-- users: self only
create policy users_self_select on public.users for select to authenticated using (id = auth.uid());
create policy users_self_insert on public.users for insert to authenticated with check (id = auth.uid());
create policy users_self_update on public.users for update to authenticated using (id = auth.uid());

-- google_connections: members read (the encrypted token column is never selected by app
-- code under the user role; see src/lib/db for the column allow-list); admins write
create policy gconn_select on public.google_connections for select to authenticated
  using (public.is_org_member(organization_id));
create policy gconn_insert on public.google_connections for insert to authenticated
  with check (public.org_role(organization_id) in ('owner','admin'));
create policy gconn_update on public.google_connections for update to authenticated
  using (public.org_role(organization_id) in ('owner','admin'));
create policy gconn_delete on public.google_connections for delete to authenticated
  using (public.org_role(organization_id) in ('owner','admin'));

-- websites
create policy websites_select on public.websites for select to authenticated
  using (public.is_org_member(organization_id));
create policy websites_insert on public.websites for insert to authenticated
  with check (public.org_role(organization_id) in ('owner','admin'));
create policy websites_update on public.websites for update to authenticated
  using (public.org_role(organization_id) in ('owner','admin'));
create policy websites_delete on public.websites for delete to authenticated
  using (public.org_role(organization_id) in ('owner','admin'));

-- website_sources, sync_jobs: members read; writes happen in service context, except
-- admins may reset/request syncs (update) and create/remove source rows
create policy wsrc_select on public.website_sources for select to authenticated
  using (public.is_org_member(organization_id));
create policy wsrc_write on public.website_sources for all to authenticated
  using (public.org_role(organization_id) in ('owner','admin'))
  with check (public.org_role(organization_id) in ('owner','admin'));
create policy sync_jobs_select on public.sync_jobs for select to authenticated
  using (public.is_org_member(organization_id));

-- chat
create policy threads_select on public.chat_threads for select to authenticated
  using (public.is_org_member(organization_id));
create policy threads_insert on public.chat_threads for insert to authenticated
  with check (public.is_org_member(organization_id) and created_by = auth.uid());
create policy threads_delete on public.chat_threads for delete to authenticated
  using (public.is_org_member(organization_id));
create policy messages_select on public.chat_messages for select to authenticated
  using (public.is_org_member(organization_id));
create policy messages_insert on public.chat_messages for insert to authenticated
  with check (public.is_org_member(organization_id));

-- analytics tables: members read; only service context writes
do $$
declare t text;
begin
  foreach t in array array[
    'gsc_daily_totals','gsc_query_daily','gsc_page_daily','gsc_device_daily','gsc_country_daily',
    'ga4_daily_totals','ga4_acquisition_daily','ga4_landing_page_daily','ga4_device_daily','ga4_event_daily',
    'ads_campaign_daily','ads_ad_group_daily','ads_keyword_daily','ads_search_term_daily','ads_device_daily','ads_conversion_action_daily'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_org_member(organization_id))', t || '_select', t);
  end loop;
end $$;

-- Grants (Supabase creates the roles; the test harness creates shims)
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- The encrypted refresh token must never be readable under the user role: replace the
-- table-level grant with column-level grants that exclude it. (A column-level REVOKE
-- would not override a table-level GRANT.)
revoke all on public.google_connections from authenticated;
grant select (id, organization_id, google_user_id, google_email, granted_scopes,
              access_token_expiry, status, last_error, created_by, created_at, updated_at)
  on public.google_connections to authenticated;
grant update (granted_scopes, status, last_error) on public.google_connections to authenticated;
grant delete on public.google_connections to authenticated;

-- updated_at maintenance
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger websites_updated_at before update on public.websites
  for each row execute function public.set_updated_at();
create trigger gconn_updated_at before update on public.google_connections
  for each row execute function public.set_updated_at();
