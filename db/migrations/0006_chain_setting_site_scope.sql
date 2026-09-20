-- OmniHost.ai — migration 0006: a site dimension for chain_setting, and honest grants
-- ---------------------------------------------------------------------------
-- Two correctness fixes found by verification of the AppConfig vertical, both of the
-- same shape: a stored row claimed something the rules did not actually give it.
--
--   1. **`chain_setting` had no site dimension.** `setting_definition.scope` may be
--      'site' (store.stockout_reset_minutes, guest.prep_time_sla_minutes,
--      payments.service_charge_percent — all delegated to the *site head*), and
--      `updateChainSetting` took no site, so writing one of those keys stored a single
--      chain-level row. Two outlets with different stock-out windows could not be
--      represented at all, and the value set at one site was silently the value in force
--      at every other site in the chain — exactly the "set at the site" rule the spec
--      states for the guest prep-time SLA.
--
--   2. **`scope_grant.status` outlived its window.** A grant is refused because
--      `expires_at` has passed (`resolvePrincipal` filters on it, which is what makes the
--      time-box real), but the stored `status` stayed 'active' forever, so the row a
--      reviewer or a chain-side auditor reads said the opposite of the truth. Status is
--      now *reconciled* — see src/domain/grants.ts, which flips a lapsed grant to
--      'expired' — and the index below is what makes that reconcile cheap.
--
-- Nothing here changes a rule. `setting_definition` still owns the bounds and the
-- delegation; a site-scoped definition simply now stores its value against a site.

-- ---------------------------------------------------------------------------
-- 1a. chain_setting gains site_id.
--
-- NULL = the chain-level row (a chain-scoped definition, or the chain-wide default of a
-- site-scoped one). A non-null site_id = the value in force at that one site.
-- ---------------------------------------------------------------------------
alter table chain_setting add column if not exists site_id uuid references site (id) on delete cascade;

comment on column chain_setting.site_id is
  'The site a site-scoped value applies to. NULL = chain level. A site-scoped setting_definition must be written with a site; a chain-scoped one must not carry one (enforced in src/domain/appconfig.ts).';

-- ---------------------------------------------------------------------------
-- 1b. Uniqueness has to survive NULL.
--
-- The old primary key was (chain_id, setting_key), which is exactly the bug: it left no
-- room for a second row of the same key at another site. Two partial unique indexes
-- replace it — one for the chain-level row, one per site — and each is also the conflict
-- target the write path uses, so an insert cannot race a second one into existence.
-- (A plain (chain_id, site_id, setting_key) index would not do: NULLs are distinct, so
-- the chain-level row could be inserted twice.)
-- ---------------------------------------------------------------------------
alter table chain_setting drop constraint if exists chain_setting_pkey;
create unique index if not exists chain_setting_chain_level_key
  on chain_setting (chain_id, setting_key) where site_id is null;
create unique index if not exists chain_setting_site_level_key
  on chain_setting (chain_id, site_id, setting_key) where site_id is not null;
create index if not exists chain_setting_site_idx on chain_setting (chain_id, site_id);

-- ---------------------------------------------------------------------------
-- 1c. A site-scoped row must belong to the chain on its own row.
--
-- Every tenant table carries chain_id, and a site-scoped table carries site_id with it
-- (spec "Data Model & Sync Architecture"). The composite foreign key makes the two
-- columns agree in the database rather than trusting the writer: a row cannot name chain
-- A and a site that lives in chain B. The unique index it references is only there to
-- give the key something to point at.
-- ---------------------------------------------------------------------------
create unique index if not exists site_id_chain_idx on site (id, chain_id);
alter table chain_setting drop constraint if exists chain_setting_site_in_chain;
alter table chain_setting add constraint chain_setting_site_in_chain
  foreign key (site_id, chain_id) references site (id, chain_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. scope_grant status reconciliation.
--
-- A grant carries two independent facts: what the grantor decided (status: active /
-- revoked) and where the window ends (expires_at). The window closing is not a decision
-- by anybody, so it is *derived* — reconciled into `status = 'expired'` rather than
-- written as a manual revocation. This partial index is the one the reconciler scans.
-- ---------------------------------------------------------------------------
create index if not exists scope_grant_lapsed_idx
  on scope_grant (expires_at) where status = 'active';

comment on column scope_grant.status is
  'active | revoked | expired. ''revoked'' is a decision by an AppAdmin; ''expired'' is derived from expires_at passing (src/domain/grants.ts) — refusals are computed from expires_at either way, this only keeps the stored row honest.';
