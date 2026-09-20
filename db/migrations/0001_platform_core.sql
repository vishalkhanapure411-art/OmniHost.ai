-- OmniHost.ai — migration 0001: platform core (tenant hierarchy + identity)
-- ---------------------------------------------------------------------------
-- Org model, per the spec's "Roles, Org Model & Permission Matrix":
--   App      OmniHost.ai's own SaaS operators (no chain) — cuts across all chains
--   Central  a chain's head office (the tenant)
--   Site     one outlet's back office, reporting to a Site Head with a dotted
--            line to the matching Central Head
--
-- Tenant rule, per "Data Model & Sync Architecture": "every table carries a tenant
-- (chain) id and, where relevant, a site id, scoped at the API layer rather than
-- trusted to the client". So:
--   * every business table below carries chain_id
--   * every site-scoped table carries site_id as well
--   * app-layer tables that are platform *configuration* rather than tenant data
--     (role, permission, feature — see 0002/0004) are deliberately chain-less and
--     are marked with a comment explaining why.
--
-- Types: text + CHECK constraints rather than PostgreSQL enums, so adding a tier or
-- a role layer later is a migration and not an ALTER TYPE that locks the table.
--
-- Spec says MySQL as the system of record; the team's working decision (revision 2
-- of the business plan) is PostgreSQL, pending the owner's call. Nothing here is
-- MySQL-specific.

-- Applied-migration ledger. The runner (scripts/db.ts) reads this to decide which
-- files are pending, which is what makes re-running `db:migrate` a no-op.
create table if not exists schema_migration (
  filename     text primary key,
  checksum     text not null,
  applied_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- chain — the tenant. One row per customer chain.
-- ---------------------------------------------------------------------------
create table if not exists chain (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  code              text not null unique,          -- short slug used in URLs and exports
  -- Spec "Licensing Tiers": the tier is set per chain (Central), never per site —
  -- "every site in a chain runs the same tier". Tier gates module *depth*, never
  -- which roles exist.
  licence_tier      text not null default 'silver'
                    check (licence_tier in ('silver', 'gold', 'platinum')),
  tax_jurisdiction  text,
  status            text not null default 'active'
                    check (status in ('active', 'suspended', 'offboarded')),
  onboarded_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- site — one physical location (one or more outlets) belonging to a chain.
-- ---------------------------------------------------------------------------
create table if not exists site (
  id                uuid primary key default gen_random_uuid(),
  chain_id          uuid not null references chain (id) on delete cascade,
  name              text not null,
  code              text not null,
  timezone          text not null default 'Asia/Kolkata',
  tax_jurisdiction  text,
  -- The site-level configuration overrides that recur through the spec: prep-time
  -- SLA (Guest Ordering), stock-out reset policy (Stock Receiving/Transfer/Waste)
  -- and the service-charge default (Payments & Settlement). AppConfig decides what
  -- is overridable at all; the Site Head sets this site's own values. Held as jsonb
  -- so the keys can be added per module without a migration.
  config_overrides  jsonb not null default '{}'::jsonb,
  address           jsonb not null default '{}'::jsonb,
  status            text not null default 'active' check (status in ('active', 'closed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (chain_id, code)
);

create index if not exists site_chain_idx on site (chain_id);

-- ---------------------------------------------------------------------------
-- outlet — the unit that raises sub-orders and owns its own pricing/tax.
-- ---------------------------------------------------------------------------
create table if not exists outlet (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  site_id     uuid not null references site (id) on delete cascade,
  name        text not null,
  code        text not null,
  kind        text not null default 'restaurant'
              check (kind in ('restaurant', 'bar', 'qsr', 'banquet', 'kitchen', 'room_service')),
  status      text not null default 'active' check (status in ('active', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (site_id, code)
);

create index if not exists outlet_chain_idx on outlet (chain_id);
create index if not exists outlet_site_idx on outlet (site_id);

-- ---------------------------------------------------------------------------
-- user — a platform operator, a chain's head-office staff, or a site's staff.
-- Quoted because `user` is a SQL keyword; every reference in code is `"user"`.
-- ---------------------------------------------------------------------------
create table if not exists "user" (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  display_name      text not null,
  -- Spec "Roles, Org Model & Permission Matrix": authentication is SSO (SAML/OIDC)
  -- or OmniHost-native username/password, configured per chain by AppConfig. This
  -- phase ships native login only; the column exists now so switching a chain to
  -- SSO later is a config change, not a schema change. Role/permission resolution is
  -- identical either way ("login method never changes what a role can do").
  auth_provider     text not null default 'native' check (auth_provider in ('native', 'sso')),
  password_hash     text,     -- scrypt digest; null when auth_provider = 'sso'
  password_salt     text,
  password_algo     text,     -- e.g. 'scrypt$16384$8$1$64' — recorded so it can be re-hashed on login
  status            text not null default 'active' check (status in ('active', 'disabled')),
  -- Spec "Chatbot Interaction Model": language is configurable per user or site.
  locale            text not null default 'en-IN',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Case-insensitive uniqueness without citext.
create unique index if not exists user_email_lower_key on "user" (lower(email));

-- ---------------------------------------------------------------------------
-- app_session — the server-side session model.
-- The raw bearer token only ever exists in the client's HttpOnly cookie; the
-- database stores its SHA-256 so a database leak does not hand over live sessions.
-- ---------------------------------------------------------------------------
create table if not exists app_session (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  user_id         uuid not null references "user" (id) on delete cascade,
  -- Active tenant context for the session. NULL for an App-layer session: an App
  -- operator is not inside any one chain until they pick one, and what they may
  -- reach is resolved from their role assignments / delegated scope grants, never
  -- from anything the client sends.
  chain_id        uuid references chain (id) on delete set null,
  site_id         uuid references site (id) on delete set null,
  auth_provider   text not null default 'native' check (auth_provider in ('native', 'sso')),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text,
  ip              text,
  user_agent      text
);

create index if not exists app_session_user_idx on app_session (user_id);
create index if not exists app_session_expiry_idx on app_session (expires_at);
