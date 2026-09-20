-- OmniHost.ai — migration 0002: RBAC (role catalog, tool registry, scoping)
-- ---------------------------------------------------------------------------
-- The spec's model in three sentences, from "Roles, Org Model & Permission Matrix"
-- and "Admin & Configuration Model":
--   1. Every role sits in one of three layers (App / Central / Site). Central
--      functions run Head + Team; Site mirrors the same functions as a Team
--      reporting to its Site Head; MDM has no site presence.
--   2. Permission pattern: "Central Heads configure policy and approve above a
--      threshold for their function; Central and Site Teams execute and propose; a
--      Site Head approves at site level within budget/policy set centrally".
--   3. AppAdmin can configure anything on the platform; AppConfig and AppSupport
--      hold "whatever slice of that AppAdmin chooses to delegate — delegation is
--      itself a configuration action, grantable and revocable per person, not a
--      fixed second tier of roles." Any AppSupport/AppConfig access into a specific
--      chain's data is "scoped, time-boxed and audit-logged".
--
-- That is why there are two grant surfaces below:
--   role_assignment — the durable fact "this person holds this role, at this scope"
--   scope_grant     — per-person delegation from AppAdmin to AppConfig/AppSupport,
--                     optionally chain-scoped and time-boxed, holding a chosen slice
--                     of the permission (tool) registry.
--
-- role / permission / feature carry no chain_id on purpose: they are the platform's
-- own vocabulary, and the spec is explicit that "every role in this spec is
-- available at every tier" and that the App layer "cuts across all chains". No
-- tenant data lives in them.

-- ---------------------------------------------------------------------------
-- role — the catalog of roles. Platform-wide, not tenant data.
-- ---------------------------------------------------------------------------
create table if not exists role (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,   -- APP_ADMIN, CENTRAL_PURCHASE_HEAD, SITE_HEAD, ...
  name          text not null,
  layer         text not null check (layer in ('app', 'central', 'site')),
  -- e.g. 'purchase', 'culinary', 'revenue_assurance'. NULL for the App-layer roles
  -- and for Site Head, which sit outside the function grid.
  function_code text,
  -- 'head' | 'team' | 'site_head' | 'operator' — see the permission pattern above.
  seniority     text not null check (seniority in ('head', 'team', 'site_head', 'operator')),
  description   text,
  created_at    timestamptz not null default now()
);

create index if not exists role_layer_idx on role (layer);

-- ---------------------------------------------------------------------------
-- permission — the tool registry the chatbot gateway resolves a session against
-- (spec "Chatbot Interaction Model": "the gateway resolves the session's role,
-- site/central scope and license tier into a bounded tool registry: the specific
-- set of actions ... that identity is allowed to invoke").
-- ---------------------------------------------------------------------------
create table if not exists permission (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,   -- 'chain.onboard', 'purchase.indent.raise', ...
  module            text not null,          -- 'licensing', 'purchase', 'culinary', ...
  name              text not null,
  description       text,
  action_kind       text not null check (action_kind in ('query', 'mutation')),
  -- 'app'    — platform configuration: no chain context required, and only reachable
  --            by an App-layer identity or an explicit per-chain delegation.
  -- 'tenant' — acts on a chain's own data. Whether that means "any site in my chain"
  --            (Central) or "only my site" (Site) is decided by the caller's own
  --            scope, not by the permission code: the spec is explicit that role and
  --            permission resolution are identical regardless of how someone logged
  --            in, and the same tool ("raise an indent") is legitimately held by both
  --            a Central Team and a Site Team.
  layer             text not null check (layer in ('app', 'tenant')),
  -- True when the action can only be performed inside a site context (a site-level
  -- approval, a goods receipt on arrival). The permission check then refuses a
  -- Central-scoped caller, because Central has no site.
  requires_site_scope boolean not null default false,
  -- Spec: Revenue Assurance, Quality Assurance and Controls are cross-cutting check
  -- functions that approve or flag other functions' transactions.
  check_function    boolean not null default false,
  -- Spec "Chatbot Interaction Model" / "Payments & Settlement": anything financial
  -- or stock-affecting needs an explicit confirm before it posts. Later phases read
  -- this flag to decide whether a structured confirmation card is mandatory.
  financial_or_stock boolean not null default false,
  -- NULL until the owning module is built; 'phase0a' for what this phase implements.
  -- Keeps the registry honest: registered ≠ implemented.
  implemented_in    text,
  created_at        timestamptz not null default now()
);

create index if not exists permission_module_idx on permission (module);

-- ---------------------------------------------------------------------------
-- role_permission — what a role holds by default, independent of any tenant.
-- AppConfig/AppSupport deliberately hold nothing here: their capability is
-- delegated per person via scope_grant (see the header).
-- ---------------------------------------------------------------------------
create table if not exists role_permission (
  role_id       uuid not null references role (id) on delete cascade,
  permission_id uuid not null references permission (id) on delete cascade,
  effect        text not null default 'allow' check (effect in ('allow', 'deny')),
  created_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- role_assignment — the durable "who holds which role, where".
--   App layer      chain_id NULL, site_id NULL (cuts across all chains)
--   Central layer  chain_id set,  site_id NULL
--   Site layer     chain_id set,  site_id set
-- ---------------------------------------------------------------------------
create table if not exists role_assignment (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references "user" (id) on delete cascade,
  role_id             uuid not null references role (id) on delete restrict,
  chain_id            uuid references chain (id) on delete cascade,
  site_id             uuid references site (id) on delete cascade,
  status              text not null default 'active'
                      check (status in ('active', 'revoked', 'expired')),
  granted_by_user_id  uuid references "user" (id) on delete set null,
  granted_at          timestamptz not null default now(),
  -- Time-boxed access. Spec: an operator's access into a chain's account is
  -- "scoped, time-boxed and audit-logged". NULL means the assignment is permanent
  -- (a chain's own staff member), which is the normal case for Central/Site roles.
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid references "user" (id) on delete set null,
  revoke_reason       text,
  -- 'user|role|chain|site', with '-' for an absent level. Carrying the natural key
  -- explicitly keeps the seed re-runnable (ON CONFLICT (scope_key) DO UPDATE works,
  -- which partial indexes on nullable columns would not allow).
  scope_key           text not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- A site-scoped assignment must name its chain too: every site-scoped row carries
  -- both ids (spec "Data Model & Sync Architecture").
  constraint role_assignment_site_needs_chain check (site_id is null or chain_id is not null),
  constraint role_assignment_window check (expires_at is null or expires_at > granted_at)
);

create index if not exists role_assignment_user_idx on role_assignment (user_id);
create index if not exists role_assignment_chain_idx on role_assignment (chain_id, site_id);

-- ---------------------------------------------------------------------------
-- scope_grant — AppAdmin's per-person delegation to AppConfig/AppSupport.
-- ---------------------------------------------------------------------------
create table if not exists scope_grant (
  id                  uuid primary key default gen_random_uuid(),
  granted_to_user_id  uuid not null references "user" (id) on delete cascade,
  granted_by_user_id  uuid not null references "user" (id) on delete restrict,
  -- NULL chain_id = platform-wide delegation. A non-null chain_id means access into
  -- that one chain's data, which the spec requires to be time-boxed.
  chain_id            uuid references chain (id) on delete cascade,
  site_id             uuid references site (id) on delete cascade,
  -- Why this person has this access — the chain has to be able to see "exactly who
  -- at OmniHost.ai touched their data and why" (Admin & Configuration Model).
  reason              text not null,
  status              text not null default 'active'
                      check (status in ('active', 'revoked', 'expired')),
  granted_at          timestamptz not null default now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid references "user" (id) on delete set null,
  revoke_reason       text,
  scope_key           text not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint scope_grant_site_needs_chain check (site_id is null or chain_id is not null),
  -- Chain data access must be time-boxed; a platform-wide grant may be open-ended.
  constraint scope_grant_chain_access_timeboxed check (chain_id is null or expires_at is not null),
  constraint scope_grant_window check (expires_at is null or expires_at > granted_at)
);

create index if not exists scope_grant_grantee_idx on scope_grant (granted_to_user_id);
create index if not exists scope_grant_chain_idx on scope_grant (chain_id, site_id);

-- The slice of the tool registry a grant carries.
create table if not exists scope_grant_permission (
  scope_grant_id  uuid not null references scope_grant (id) on delete cascade,
  permission_id   uuid not null references permission (id) on delete cascade,
  effect          text not null default 'allow' check (effect in ('allow', 'deny')),
  created_at      timestamptz not null default now(),
  primary key (scope_grant_id, permission_id)
);
