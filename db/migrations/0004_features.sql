-- OmniHost.ai — migration 0004: per-chain feature toggles
-- ---------------------------------------------------------------------------
-- Spec "Admin & Configuration Model": "Feature toggles per chain — AppAdmin: yes;
-- AppConfig (delegated): typically delegated; AppSupport: no."
--
-- Modelled as a registry (feature) plus a per-chain join (chain_feature) rather than
-- one jsonb blob on chain, for two reasons:
--   * a toggle change is one row, so the audit log's before/after state is exactly
--     the toggle that changed instead of a whole settings document;
--   * the registry can carry the tier at which a capability becomes available, which
--     is how "Silver/Gold/Platinum gate module depth" is enforced without hardcoding
--     tier names in screens.

-- ---------------------------------------------------------------------------
-- feature — the catalog of switchable platform capabilities. Platform-wide, not
-- tenant data (the same reason role/permission carry no chain_id).
-- ---------------------------------------------------------------------------
create table if not exists feature (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,     -- 'sso', 'ai_indenting', 'cds', ...
  name           text not null,
  description    text,
  module         text not null,
  -- Minimum licence tier at which the feature may be switched on. Spec "Licensing
  -- Tiers": the tier decides depth, and AI-assisted variants are a Platinum
  -- capability "layered on the same manual workflow everyone else runs".
  min_tier       text not null default 'silver'
                 check (min_tier in ('silver', 'gold', 'platinum')),
  -- Operational features (like native login) are always on and are listed so the
  -- toggle screen shows the whole picture rather than a silently missing row.
  toggleable     boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- chain_feature — the per-chain toggle state. Tenant data, hence chain_id.
-- ---------------------------------------------------------------------------
create table if not exists chain_feature (
  chain_id            uuid not null references chain (id) on delete cascade,
  feature_code        text not null references feature (code) on delete restrict,
  enabled             boolean not null default false,
  updated_by_user_id  uuid references "user" (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (chain_id, feature_code)
);
