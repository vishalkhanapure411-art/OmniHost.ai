-- OmniHost.ai — reference data seed (roles, tool registry, role→permission, feature
-- registry). Re-runnable: every statement is an upsert, so `db:seed` can be run
-- repeatedly against a live database without duplicating anything.
--
-- This file holds *platform vocabulary* only, which is why it is pure SQL: no
-- tenant data and no secrets. Tenant + user demo data lives in scripts/seed.ts,
-- because user rows need a password digest and SQL cannot compute scrypt.

-- ---------------------------------------------------------------------------
-- 1. Roles — the spec's grid, generated rather than hand-listed so it stays
--    faithful to "Central functions run Head + Team; Site mirrors the same
--    functions as a Team reporting to its Site Head; MDM has no site presence".
-- ---------------------------------------------------------------------------
insert into role (code, name, layer, function_code, seniority, description) values
  ('APP_ADMIN', 'AppAdmin', 'app', null, 'operator',
   'Configures anything on the platform (spec, Admin & Configuration Model).'),
  ('APP_CONFIG', 'AppConfig', 'app', null, 'operator',
   'Holds the slice of AppAdmin capability delegated to them — per person, grantable and revocable, not a fixed second tier of roles.'),
  ('APP_SUPPORT', 'AppSupport', 'app', null, 'operator',
   'Holds the slice of AppAdmin capability delegated to them; any access into a chain''s data is scoped, time-boxed and audit-logged.'),
  ('SITE_HEAD', 'Site Head', 'site', null, 'site_head',
   'Owns everything at one outlet, is the site-level escalation point for every Site Team, and approves at site level within the budget/policy set centrally.')
on conflict (code) do update set
  name = excluded.name, layer = excluded.layer, function_code = excluded.function_code,
  seniority = excluded.seniority, description = excluded.description;

with fn (fn_code, fn_name, has_site) as (
  values
    ('it',                 'IT',                  true),
    ('revenue_assurance',  'Revenue Assurance',   true),
    ('quality_assurance',  'Quality Assurance',   true),
    ('maintenance',        'Maintenance',         true),
    ('controls',           'Controls',            true),
    ('purchase',           'Purchase',            true),
    ('store',              'Store',               true),
    ('operations',         'Operations',          true),
    ('culinary',           'Culinary',            true),
    ('mdm',                'MDM',                 false),
    ('marketing',          'Marketing',           true)
)
insert into role (code, name, layer, function_code, seniority, description)
select 'CENTRAL_' || upper(fn_code) || '_HEAD', fn_name || ' Head', 'central', fn_code, 'head',
       'Configures ' || lower(fn_name) || ' policy and approves above the configured threshold for the function.'
  from fn
union all
select 'CENTRAL_' || upper(fn_code) || '_TEAM', fn_name || ' Team', 'central', fn_code, 'team',
       'Executes and proposes ' || lower(fn_name) || ' work at head office.'
  from fn
union all
select 'SITE_' || upper(fn_code) || '_TEAM', 'Site ' || fn_name || ' Team', 'site', fn_code, 'team',
       'Executes and proposes ' || lower(fn_name) || ' work at one outlet, reporting to the Site Head with a dotted line to the Central ' || fn_name || ' Head.'
  from fn
 where has_site
on conflict (code) do update set
  name = excluded.name, layer = excluded.layer, function_code = excluded.function_code,
  seniority = excluded.seniority, description = excluded.description;

-- ---------------------------------------------------------------------------
-- 2. Tool registry — App layer. Every row is drawn from the spec's
--    "Admin & Configuration Model" capability table.
-- ---------------------------------------------------------------------------
insert into permission (code, module, name, description, action_kind, layer, requires_site_scope, check_function, financial_or_stock, implemented_in) values
  ('platform.settings.update', 'platform', 'Change platform / infrastructure settings',
   'AppAdmin only: AppConfig and AppSupport never hold this (spec capability table).',
   'mutation', 'app', false, false, false, null),
  ('chain.list', 'licensing', 'List chains',
   'Lists the chains the caller may reach. An AppAdmin reaches all; a delegated operator only the chains they were granted.',
   'query', 'app', false, false, false, 'phase0a'),
  ('chain.read', 'licensing', 'View a chain',
   'Chain detail: licence tier, feature toggles, sites and outlets.',
   'query', 'app', false, false, false, 'phase0a'),
  ('chain.onboard', 'licensing', 'Onboard a chain',
   'Creates the tenant, sets its initial licence tier and seeds its feature toggles. Spec example intent: "Onboard chain X on Platinum".',
   'mutation', 'app', false, false, false, 'phase0a'),
  ('chain.tier.update', 'licensing', 'Change a chain''s licence tier',
   'Tier is set per chain (Central), never per site — every site inherits it.',
   'mutation', 'app', false, false, false, 'phase0a'),
  ('chain.feature.update', 'licensing', 'Toggle a per-chain feature',
   'Spec capability table: "Feature toggles per chain".',
   'mutation', 'app', false, false, false, 'phase0a'),
  ('chain.audit.read', 'audit', 'Read a chain''s audit log',
   'A chain must be able to see who at OmniHost.ai touched its data and why.',
   'query', 'app', false, false, false, 'phase0a'),
  ('scope.grant.manage', 'admin', 'Grant / revoke AppConfig and AppSupport scopes',
   'Delegation is itself a configuration action, grantable and revocable per person. AppAdmin only.',
   'mutation', 'app', false, false, false, null),
  ('auth.sso.configure', 'admin', 'Configure SSO / authentication setup for a chain',
   'Spec capability table: "SSO / authentication setup" — AppAdmin, typically delegated to AppConfig.',
   'mutation', 'app', false, false, false, null),
  ('support.ticket.resolve', 'support', 'Resolve escalated tickets',
   'Where a low-confidence intent or an unsupported chatbot request lands (spec guardrails).',
   'mutation', 'app', false, false, false, null),
  ('support.chain_access.timeboxed', 'support', 'Use time-boxed support access into a chain account',
   'Scoped, time-boxed and audit-logged. Held only through a scope_grant that names an expiry.',
   'query', 'app', false, false, false, 'phase0a'),
  ('audit.read', 'audit', 'Read own chain''s audit trail',
   'The chain-side counterpart of chain.audit.read: the spec requires that "a chain should be able to see exactly who at OmniHost.ai touched their data and why, which matters for a platform holding another company''s sales and cost data". Held by the compliance-facing roles rather than everyone.',
   'query', 'tenant', false, false, false, 'phase0a')
on conflict (code) do update set
  module = excluded.module, name = excluded.name, description = excluded.description,
  action_kind = excluded.action_kind, layer = excluded.layer,
  requires_site_scope = excluded.requires_site_scope,
  check_function = excluded.check_function, financial_or_stock = excluded.financial_or_stock,
  implemented_in = excluded.implemented_in;

-- ---------------------------------------------------------------------------
-- 3. Tool registry — the per-function pattern the spec states once and applies
--    everywhere: "Central Heads configure policy and approve above a threshold for
--    their function; Central and Site Teams execute and propose; a Site Head
--    approves at site level within budget/policy set centrally."
-- ---------------------------------------------------------------------------
with fn (fn_code, fn_name, is_check) as (
  values
    ('it',                'IT',                false),
    ('revenue_assurance', 'Revenue Assurance', true),
    ('quality_assurance', 'Quality Assurance', true),
    ('maintenance',       'Maintenance',       false),
    ('controls',          'Controls',          true),
    ('purchase',          'Purchase',          false),
    ('store',             'Store',             false),
    ('operations',        'Operations',        false),
    ('culinary',          'Culinary',          false),
    ('mdm',               'MDM',               false),
    ('marketing',         'Marketing',         false)
),
suffix (suffix_code, suffix_name, action_kind, requires_site, financial, role_note) as (
  values
    ('view',              'View',             'query',    false, false, 'Held by every role in the function.'),
    ('execute',           'Execute',          'mutation', false, false, 'Held by Central and Site Teams.'),
    ('propose',           'Propose',          'mutation', false, false, 'Held by Central and Site Teams; the Head approves.'),
    ('approve.threshold', 'Approve above threshold', 'mutation', false, true,  'Held by the Central Head.'),
    ('policy.configure',  'Configure policy', 'mutation', false, false, 'Held by the Central Head.'),
    ('approve.site',      'Approve at site level', 'mutation', true, true, 'Held by the Site Head, within centrally-set budget/policy.'),
    ('check.approve',     'Approve / sign off (check function)', 'mutation', false, true, 'Held by the cross-cutting check functions: Revenue Assurance, Quality Assurance, Controls.'),
    ('flag.raise',        'Flag an exception (check function)', 'mutation', false, false, 'Held by the cross-cutting check functions: Revenue Assurance, Quality Assurance, Controls.')
)
insert into permission (code, module, name, description, action_kind, layer, requires_site_scope, check_function, financial_or_stock, implemented_in)
select fn.fn_code || '.' || suffix.suffix_code,
       fn.fn_code,
       fn.fn_name || ': ' || suffix.suffix_name,
       fn.fn_name || ' function — ' || suffix.role_note,
       suffix.action_kind,
       'tenant',
       suffix.requires_site,
       fn.is_check and suffix.suffix_code in ('check.approve', 'flag.raise'),
       suffix.financial,
       null
  from fn cross join suffix
 where fn.is_check
    or suffix.suffix_code not in ('check.approve', 'flag.raise')
on conflict (code) do update set
  module = excluded.module, name = excluded.name, description = excluded.description,
  action_kind = excluded.action_kind, layer = excluded.layer,
  requires_site_scope = excluded.requires_site_scope,
  check_function = excluded.check_function, financial_or_stock = excluded.financial_or_stock,
  implemented_in = excluded.implemented_in;

-- ---------------------------------------------------------------------------
-- 4. Tool registry — specific tools the spec names in its own example intents
--    (Chatbot Interaction Model). Registered now, implemented with their module,
--    so the registry is honest about registered ≠ implemented.
-- ---------------------------------------------------------------------------
insert into permission (code, module, name, description, action_kind, layer, requires_site_scope, check_function, financial_or_stock, implemented_in) values
  ('purchase.indent.raise', 'purchase', 'Raise an indent',
   'Spec example intent: "Raise indent for tomatoes, 20kg, Site 12".',
   'mutation', 'tenant', false, false, true, null),
  ('purchase.po.approve', 'purchase', 'Approve a purchase order',
   'Spec example intent: "Approve PO #2044" — Purchase Head confirms above the configured value.',
   'mutation', 'tenant', false, false, true, null),
  ('store.grn.receive', 'store', 'Receive a GRN against a PO',
   'Spec example intent: "Receive GRN against PO #2044". Nothing posts to sellable inventory until Revenue Assurance approves.',
   'mutation', 'tenant', true, false, true, null),
  ('culinary.stockout.mark', 'culinary', 'Mark an article unavailable (86)',
   'Spec example intent: "86 the paneer tikka, Site 12".',
   'mutation', 'tenant', false, false, false, null),
  ('culinary.waste.writeoff', 'culinary', 'Log a waste write-off',
   'Spec example intent: "Log 2kg wastage, spoiled tomatoes". Above a site-configured value it needs Revenue Assurance co-sign.',
   'mutation', 'tenant', true, false, true, null),
  ('revenue_assurance.receipt.approve', 'revenue_assurance', 'Approve a stock receipt',
   'Spec example intent: "Approve stock receipt GRN-1042".',
   'mutation', 'tenant', false, true, true, null),
  ('quality_assurance.ticket.raise', 'quality_assurance', 'Raise a QA ticket',
   'Spec example intent: "Raise a QA ticket, Site 4, undercooked complaint".',
   'mutation', 'tenant', false, true, false, null),
  ('maintenance.ticket.raise', 'maintenance', 'Log a maintenance fault',
   'Spec example intent: "Log AC breakdown, Site 7, kitchen line 2".',
   'mutation', 'tenant', false, false, false, null),
  ('operations.atv.view', 'operations', 'View ATV against target',
   'Spec example intent: "Today''s ATV vs target, Site 12" (Site Head) and the Executive/Operations dashboards.',
   'query', 'tenant', false, false, false, null),
  ('content.draft', 'content', 'Draft content for a site',
   'Site-authored content always routes through the Marketing Head approval step before it can go live.',
   'mutation', 'tenant', true, false, false, null),
  ('marketing.campaign.push', 'marketing', 'Publish / schedule a campaign',
   'Spec example intent: "Push 20% weekday lunch offer, Sites 3–8". Only centrally-approved content ever goes live.',
   'mutation', 'tenant', false, false, false, null)
on conflict (code) do update set
  module = excluded.module, name = excluded.name, description = excluded.description,
  action_kind = excluded.action_kind, layer = excluded.layer,
  requires_site_scope = excluded.requires_site_scope,
  check_function = excluded.check_function, financial_or_stock = excluded.financial_or_stock,
  implemented_in = excluded.implemented_in;

-- ---------------------------------------------------------------------------
-- 5. role → permission. AppConfig and AppSupport are deliberately absent: their
--    capability arrives per person through scope_grant, exactly as the spec
--    describes delegation.
-- ---------------------------------------------------------------------------
-- AppAdmin holds every App-layer capability.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.layer = 'app'
 where r.code = 'APP_ADMIN'
on conflict (role_id, permission_id) do nothing;

-- Central Head: view + propose + approve above threshold + configure policy.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in (
         r.function_code || '.view',
         r.function_code || '.propose',
         r.function_code || '.approve.threshold',
         r.function_code || '.policy.configure'
       )
 where r.layer = 'central' and r.seniority = 'head'
on conflict (role_id, permission_id) do nothing;

-- Central and Site Team: view, propose, execute.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in (
         r.function_code || '.view',
         r.function_code || '.propose',
         r.function_code || '.execute'
       )
 where r.seniority = 'team' and r.function_code is not null
on conflict (role_id, permission_id) do nothing;

-- Check functions (Revenue Assurance, QA, Controls) additionally hold the
-- approve/flag pair for their function.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in (r.function_code || '.check.approve', r.function_code || '.flag.raise')
 where r.function_code in ('revenue_assurance', 'quality_assurance', 'controls')
on conflict (role_id, permission_id) do nothing;

-- Site Head: view for every function, and site-level approval for every function.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code like '%.view' and p.layer = 'tenant'
 where r.code = 'SITE_HEAD'
on conflict (role_id, permission_id) do nothing;

insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p on p.code like '%.approve.site'
 where r.code = 'SITE_HEAD'
on conflict (role_id, permission_id) do nothing;

-- The spec's own example intents, mapped to the role the spec names beside each.
with seed_tool_role (permission_code, role_code) as (values
  ('purchase.indent.raise',             'CENTRAL_PURCHASE_TEAM'),
  ('purchase.indent.raise',             'SITE_PURCHASE_TEAM'),
  ('purchase.po.approve',               'CENTRAL_PURCHASE_HEAD'),
  ('store.grn.receive',                 'CENTRAL_STORE_TEAM'),
  ('store.grn.receive',                 'SITE_STORE_TEAM'),
  ('culinary.stockout.mark',            'CENTRAL_CULINARY_TEAM'),
  ('culinary.stockout.mark',            'SITE_CULINARY_TEAM'),
  ('culinary.waste.writeoff',           'CENTRAL_CULINARY_TEAM'),
  ('culinary.waste.writeoff',           'SITE_CULINARY_TEAM'),
  ('revenue_assurance.receipt.approve', 'CENTRAL_REVENUE_ASSURANCE_TEAM'),
  ('revenue_assurance.receipt.approve', 'SITE_REVENUE_ASSURANCE_TEAM'),
  ('quality_assurance.ticket.raise',    'CENTRAL_QUALITY_ASSURANCE_TEAM'),
  ('quality_assurance.ticket.raise',    'SITE_QUALITY_ASSURANCE_TEAM'),
  ('maintenance.ticket.raise',          'CENTRAL_MAINTENANCE_TEAM'),
  ('maintenance.ticket.raise',          'SITE_MAINTENANCE_TEAM'),
  ('operations.atv.view',               'CENTRAL_OPERATIONS_HEAD'),
  ('operations.atv.view',               'CENTRAL_OPERATIONS_TEAM'),
  ('operations.atv.view',               'SITE_HEAD'),
  ('content.draft',                     'CENTRAL_MARKETING_TEAM'),
  ('content.draft',                     'SITE_MARKETING_TEAM'),
  ('marketing.campaign.push',           'CENTRAL_MARKETING_HEAD'),
  ('marketing.campaign.push',           'CENTRAL_MARKETING_TEAM'))
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from seed_tool_role str
  join role r on r.code = str.role_code
  join permission p on p.code = str.permission_code
on conflict (role_id, permission_id) do nothing;

-- The chain-side audit read. The spec requires the trail to be visible to the chain
-- itself; these are the compliance-facing roles that would ask for it (Controls is
-- the compliance/audit-exception counterpart to Revenue Assurance), plus IT, who own
-- the chain's own access questions, and the Site Head for their own site.
with seed_audit_role (role_code) as (values
  ('CENTRAL_CONTROLS_HEAD'),
  ('CENTRAL_IT_HEAD'),
  ('CENTRAL_REVENUE_ASSURANCE_HEAD'),
  ('CENTRAL_REVENUE_ASSURANCE_TEAM'),
  ('SITE_HEAD'))
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from seed_audit_role sar
  join role r on r.code = sar.role_code
  join permission p on p.code = 'audit.read'
on conflict (role_id, permission_id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Feature registry — the capabilities the Licensing Tiers table names, with the
--    tier at which each becomes available.
-- ---------------------------------------------------------------------------
insert into feature (code, name, module, description, min_tier, toggleable) values
  ('native_login', 'Native username/password login', 'auth',
   'Silver baseline: native login only.', 'silver', false),
  ('sso', 'SSO (SAML/OIDC against the chain''s own IdP)', 'auth',
   'Gold and up: configurable SSO. Login method never changes what a role can do.', 'gold', true),
  ('cds', 'Customer Display System', 'operations',
   'Gold and up: CDS included, with personalised promo targeting at Platinum.', 'gold', true),
  ('kds_multi_station', 'KDS multi-station routing', 'operations',
   'Gold and up: multi-station routing and prep-time auto-tuning (Silver is single station).', 'gold', true),
  ('table_floorplan_editor', 'Visual floor-plan editor', 'operations',
   'Gold and up: Silver gets list/status table management only.', 'gold', true),
  ('recipe_full_bom', 'Full 3-tier recipe BOM with versioning', 'culinary',
   'Gold and up: Silver is manual, single-level recipes.', 'gold', true),
  ('ai_recipe_costing', 'AI costing suggestions', 'culinary',
   'Platinum: AI-assisted cost suggestions layered on the same manual recipe workflow.', 'platinum', true),
  ('ai_indenting', 'AI-based indenting', 'purchase',
   'Platinum: proposes an indent from consumption against par level; a human always accepts it.', 'platinum', true),
  ('ai_po_suggestions', 'AI-based PO suggestions', 'purchase',
   'Platinum: suggests vendor and quantity from price history, lead time and MOQs.', 'platinum', true),
  ('predictive_stockout', 'Predictive stock-out alerts', 'store',
   'Platinum: raised on top of the basic receiving/transfer/waste workflow.', 'platinum', true),
  ('mdm_approval_gated', 'Approval-gated MDM golden record', 'mdm',
   'Gold and up: full approval-gated golden record (Silver gets basic master lists).', 'gold', true),
  ('operations_dashboards', 'Operations (cross-site) dashboards', 'analytics',
   'Gold and up: cross-site comparison on the same metrics.', 'gold', true),
  ('executive_dashboards', 'Executive dashboards + predictive analytics', 'analytics',
   'Platinum: PnL by site/chain, like-for-like sales, tier adoption, predictive analytics.', 'platinum', true),
  ('auto_escalation_sla', 'Ticket SLA timers with auto-escalation', 'ticketing',
   'Gold and up: SLA timers and automatic one-level escalation.', 'gold', true),
  ('site_content_authoring', 'Site content authoring with approval', 'content',
   'Gold and up: Platinum adds AI-suggested campaign targeting.', 'gold', true),
  ('ai_campaign_targeting', 'AI-suggested campaign targeting', 'marketing',
   'Platinum: suggested targeting on top of the same offers/campaign workflow.', 'platinum', true),
  ('voice_input', 'Voice input on mobile', 'mobile',
   'Platinum: hands-busy roles, Culinary and Store in particular.', 'platinum', true),
  ('room_folio_posting', 'Room / folio posting as a payment method', 'payments',
   'Proposed addition for hotel properties; flagged in the spec''s open questions and deliberately deferred out of the early phases.', 'platinum', true)
on conflict (code) do update set
  name = excluded.name, module = excluded.module, description = excluded.description,
  min_tier = excluded.min_tier, toggleable = excluded.toggleable;
