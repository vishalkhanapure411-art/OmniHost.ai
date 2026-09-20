-- OmniHost.ai — migration 0005: AppConfig vertical, AppSupport vertical, real site locale
-- ---------------------------------------------------------------------------
-- Three Phase 0 items, one migration, because they share the same shape:
--   1. **AppConfig** (spec "Admin & Configuration Model": "AppConfig and AppSupport
--      hold whatever slice of AppAdmin chooses to delegate"). Two configuration
--      surfaces at chain level:
--        * authentication / SSO setup, which the capability table marks
--          "SSO / authentication setup — AppAdmin: yes; AppConfig: typically
--          delegated; AppSupport: no";
--        * delegated chain settings — the App layer publishes a *definition* with
--          hard bounds, and a chain-side admin may set a value inside those bounds.
--          Bounds live in the definition, never in the screen, so a client cannot
--          widen them.
--   2. **AppSupport** — the escalated-ticket queue and time-boxed chain access.
--      Spec: "Any AppSupport or AppConfig access into a specific chain's data is
--      scoped, time-boxed and audit-logged the same way an internal approval is."
--   3. **site.locale** — the real per-site language column. Until now the site hop of
--      the owner-set resolution order (user → site → chain → platform) was derived
--      from `site.tax_jurisdiction`, which the designer flagged as an interim hack.
--
-- Tenant rule (spec "Data Model & Sync Architecture"): every business table carries
-- chain_id, and site-scoped tables carry site_id. The two *registry* tables below
-- (`setting_definition`) carry neither, for the same reason `role`, `permission` and
-- `feature` do not: they are the platform's own vocabulary, not a tenant's data.

-- ---------------------------------------------------------------------------
-- 1. site.locale — the site hop, as a real stored column.
--
-- A BCP-47-shaped tag (`hi-IN`, `en-IN`, `ar-AE`), not a foreign key into a locale
-- table: the catalog list is a build artefact (src/i18n/locales.ts), and a chain may
-- name a tag whose catalog has not shipped yet — the resolver falls back to English
-- and reports the coverage rather than refusing the value. NULL keeps the previous
-- behaviour for a site whose language has not been decided yet: the resolver falls
-- through to the chain's jurisdiction-derived default. This is a display default,
-- not a permission, so it is deliberately not restricted to the platform default.
-- ---------------------------------------------------------------------------
alter table site add column if not exists locale text;

alter table site drop constraint if exists site_locale_format;
alter table site add constraint site_locale_format
  check (locale is null or locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

comment on column site.locale is
  'Interface language default for this site (BCP-47 tag). NULL = fall through to the chain default. Set by AppConfig/chain admin; every change is audit-logged as site.locale.update.';

-- ---------------------------------------------------------------------------
-- 1b. user.locale becomes optional.
--
-- The owner-set order is user preference → site default → chain → platform. With a
-- NOT NULL default of 'en-IN' the first hop always won, so the site hop could never be
-- observed — a floor team whose outlet runs in Hindi was served English because the
-- account carried the platform default rather than no preference at all. NULL now means
-- exactly that: no personal preference, follow my site. Existing rows are untouched.
-- ---------------------------------------------------------------------------
alter table "user" alter column locale drop default;
alter table "user" alter column locale drop not null;

comment on column "user".locale is
  'Personal interface-language preference (BCP-47 tag). NULL = no preference; resolution falls through to the site default.';

-- ---------------------------------------------------------------------------
-- 2. chain_auth_config — per-chain authentication / SSO configuration.
--
-- One row per chain that has been configured; a chain with no row is on native login
-- with the platform defaults, which is why this is a separate table rather than columns
-- on `chain` (the settings are chain-scoped configuration with their own audit trail,
-- not properties of the tenant record).
--
-- No secrets. `sso_client_secret_ref` is a *reference* into the platform secret store —
-- the same rule the payments decision sets for card data ("our database never stores a
-- full card number"): the database stores where the secret lives, never the secret.
-- ---------------------------------------------------------------------------
create table if not exists chain_auth_config (
  chain_id              uuid primary key references chain (id) on delete cascade,
  auth_mode             text not null default 'native'
                        check (auth_mode in ('native', 'sso')),
  sso_protocol          text check (sso_protocol is null or sso_protocol in ('saml', 'oidc')),
  idp_display_name      text,
  -- SAML entityID, or the OIDC issuer.
  idp_entity_id         text,
  sso_authorize_url     text,
  sso_metadata_url      text,
  sso_client_id         text,
  -- Reference (not value) to the client secret in the platform secret store.
  sso_client_secret_ref text,
  -- Just-in-time user provisioning on first SSO sign-in.
  jit_provisioning      boolean not null default true,
  allowed_email_domains text[] not null default '{}',
  -- Role a JIT-provisioned user receives before any explicit assignment. A role code,
  -- validated against `role` at write time rather than by a foreign key, so the
  -- catalogue can grow without a migration here.
  default_role_code     text,
  -- Session lifetime for this chain's identities. Spec names a session policy but
  -- states no number (see the SPEC-OPEN note in src/server/session.ts); this is where
  -- the policy becomes per-chain instead of a constant.
  session_ttl_minutes   integer not null default 720
                        check (session_ttl_minutes between 15 and 4320),
  enforce_sso           boolean not null default false,
  notes                 text,
  updated_by_user_id    uuid references "user" (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- An SSO configuration has to be complete enough to actually work.
  constraint chain_auth_config_sso_complete check (
    auth_mode = 'native'
    or (sso_protocol is not null and idp_entity_id is not null and sso_authorize_url is not null)
  ),
  -- Enforcing SSO while configured for native login would lock a chain out.
  constraint chain_auth_config_enforce_needs_sso check (auth_mode = 'sso' or enforce_sso = false)
);

comment on table chain_auth_config is
  'Per-chain authentication settings (spec capability table: "SSO / authentication setup", AppAdmin or delegated AppConfig). Never holds a secret value.';

-- ---------------------------------------------------------------------------
-- 3. setting_definition — what a chain may configure, and the bounds it may do it in.
--
-- The App layer owns the definition (including min/max/enum); the chain owns the value.
-- That split is the whole point: "AppConfig sets what is overridable at all; within
-- that, the Site Head sets the site's own values" (spec, Guest Ordering prep-time SLA).
-- A verified value is checked against these bounds server-side on every write, so a
-- crafted request cannot store 10,000 minutes where the platform allows 60.
--
-- Platform vocabulary, hence no chain_id (same reason as `feature` and `permission`).
-- ---------------------------------------------------------------------------
create table if not exists setting_definition (
  key            text primary key,        -- 'purchase.approval_threshold', ...
  module         text not null,
  scope          text not null default 'chain' check (scope in ('chain', 'site')),
  value_type     text not null check (value_type in ('integer', 'decimal', 'text', 'boolean', 'enum')),
  min_value      numeric,
  max_value      numeric,
  enum_options   text[],
  default_value  jsonb not null,
  unit           text,
  -- Message-catalog ID (never an English literal) so the label translates like every
  -- other string in the console.
  label_key      text not null,
  help_key       text,
  -- Who may set a value inside these bounds: the App layer only, the chain's admin
  -- (a Central head), or the site head. This is the delegation switch.
  delegate_to    text not null default 'none'
                 check (delegate_to in ('none', 'chain_head', 'site_head')),
  -- A value fixed by a regulator (e.g. a statutory retention period) is listed so a
  -- reviewer sees it, but cannot be overridden by anyone.
  set_by         text not null default 'app' check (set_by in ('app', 'regulator')),
  sort_order     integer not null default 100,
  created_at     timestamptz not null default now(),
  constraint setting_definition_bounds_ordered check (
    min_value is null or max_value is null or max_value >= min_value
  ),
  constraint setting_definition_enum_needs_options check (
    value_type <> 'enum' or (enum_options is not null and array_length(enum_options, 1) > 0)
  )
);

-- ---------------------------------------------------------------------------
-- 4. chain_setting — the value a chain has actually set. Tenant data, hence chain_id.
-- ---------------------------------------------------------------------------
create table if not exists chain_setting (
  chain_id            uuid not null references chain (id) on delete cascade,
  setting_key         text not null references setting_definition (key) on delete restrict,
  value               jsonb not null,
  updated_by_user_id  uuid references "user" (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (chain_id, setting_key)
);

create index if not exists chain_setting_key_idx on chain_setting (setting_key);

-- ---------------------------------------------------------------------------
-- 5. support_ticket — the escalated queue AppSupport works.
--
-- The platform-side half of the spec's one ticket model ("One ticket model serves
-- Revenue Assurance, Quality Assurance and Maintenance, distinguished by category
-- rather than three separate trackers"). The chain-side half already exists as
-- `approval_task` (0003): a maker-checker item raised *inside* a chain. This table is
-- the item raised *at* the platform — spec "Chatbot Interaction Model": "Low-confidence
-- intent or an unsupported request opens a ticket to AppSupport".
--
-- Because a chatbot escalation can arrive before any chain is resolved, chain_id is
-- nullable here, unlike approval_task. Reach into the ticket's chain is what the
-- permission check uses, so an AppSupport operator with a grant for one chain cannot
-- act on another chain's ticket (see src/domain/support.ts).
--
-- Unification of the two tables is a Phase 4 decision, taken when the modules that
-- raise chain-side tickets exist and their field needs are known; noted in the PR.
-- ---------------------------------------------------------------------------
create table if not exists support_ticket (
  id                   uuid primary key default gen_random_uuid(),
  -- Human-quotable reference ("TCK-1042"): the spec's example intents quote ticket ids.
  reference            text not null unique,
  -- NULL = a platform-level escalation with no chain context.
  chain_id             uuid references chain (id) on delete restrict,
  site_id              uuid references site (id) on delete restrict,
  category             text not null default 'support'
                       check (category in ('support', 'access', 'ra', 'qa', 'maintenance', 'controls')),
  severity             text not null default 'medium'
                       check (severity in ('low', 'medium', 'high', 'critical')),
  -- Where it came from. 'chatbot' is the spec's normal case; 'system' is the
  -- auto-raised ticket (SLA breach, variance); 'screen' is an operator logging one.
  source               text not null default 'chatbot'
                       check (source in ('chatbot', 'screen', 'system')),
  subject              text not null,
  detail               text,
  status               text not null default 'new'
                       check (status in ('new', 'triaged', 'assigned', 'waiting', 'resolved', 'closed', 'cancelled')),
  raised_by_user_id    uuid references "user" (id) on delete set null,
  -- Free text for a chatbot/system-raised ticket, whose "raiser" is a conversation
  -- rather than a person.
  raised_by_label      text,
  assigned_user_id     uuid references "user" (id) on delete set null,
  assigned_at          timestamptz,
  -- Severity-based SLA (spec "Incident & Ticket Management"). Two clocks: first
  -- response and resolution.
  response_due_at      timestamptz,
  resolve_due_at       timestamptz,
  escalated_at         timestamptz,
  escalated_to         text,
  resolution_note      text,
  resolved_by_user_id  uuid references "user" (id) on delete set null,
  resolved_at          timestamptz,
  closed_at            timestamptz,
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint support_ticket_site_needs_chain check (site_id is null or chain_id is not null)
);

create index if not exists support_ticket_queue_idx
  on support_ticket (status, severity, created_at desc);
create index if not exists support_ticket_chain_idx on support_ticket (chain_id);
create index if not exists support_ticket_assignee_idx on support_ticket (assigned_user_id, status);

-- ---------------------------------------------------------------------------
-- 6. support_access_request — asking for time-boxed access, and the answer.
--
-- The spec requires support access into a chain's account to be "scoped, time-boxed
-- and audit-logged", and separately that any such access be visible to the chain
-- ("a chain should be able to see exactly who at OmniHost.ai touched their data and
-- why"). So access is not implied by holding an App-layer role: a support person asks,
-- an AppAdmin decides (scope.grant.manage — the spec's "Grant scopes to
-- AppConfig/AppSupport: AppAdmin only"), and the approval creates a `scope_grant` with
-- a non-null expiry, which `resolvePrincipal` already refuses to load once it passes.
-- Time-boxing is therefore enforced on every request by the session resolver, not by a
-- cleanup job, and an un-approved request grants nothing at all.
-- ---------------------------------------------------------------------------
create table if not exists support_access_request (
  id                  uuid primary key default gen_random_uuid(),
  requested_by_user_id uuid not null references "user" (id) on delete cascade,
  chain_id            uuid not null references chain (id) on delete cascade,
  site_id             uuid references site (id) on delete set null,
  -- Why this person needs in. Copied onto the resulting grant, so the chain can read it.
  reason              text not null,
  ticket_id           uuid references support_ticket (id) on delete set null,
  requested_hours     integer not null check (requested_hours between 1 and 720),
  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'denied', 'withdrawn', 'expired')),
  decided_by_user_id  uuid references "user" (id) on delete set null,
  decided_at          timestamptz,
  decision_note       text,
  -- The grant this approval produced, so the decision and the access are one link.
  scope_grant_id      uuid references scope_grant (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint support_access_request_site_needs_chain check (site_id is null or chain_id is not null),
  constraint support_access_request_decided_has_decider check (
    status <> 'approved' or (decided_by_user_id is not null and decided_at is not null)
  )
);

create index if not exists support_access_request_queue_idx
  on support_access_request (status, created_at desc);
create index if not exists support_access_request_requester_idx
  on support_access_request (requested_by_user_id, status);
