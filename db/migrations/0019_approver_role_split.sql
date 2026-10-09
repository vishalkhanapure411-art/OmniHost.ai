-- OmniHost.ai — migration 0019: the approver-role split (session 1 of 2, the grant change)
-- ---------------------------------------------------------------------------
-- Owner direction, 7 Oct 2026 (DECISIONS.md §"OWNER DIRECTION: a single central
-- approver, requesters at BOTH central and outlet level"): approval authority becomes a
-- role of its own — `CENTRAL_<FN>_APPROVER` — holding the function's approve acts and NO
-- raise act; raisers stay at central and site level; the head keeps policy plus
-- above-threshold. This is a deliberate deviation from the spec's role grid (prd.txt
-- p3–p4), which has no approver role — there the head approves.
--
-- What this migration changes on a live database (the fresh-seed mirror of every grant
-- below lives in db/seed.sql §1 and §7, so `db:seed` reproduces exactly this state):
--
--   1. admit `approver` to `role.seniority`'s check constraint (the fact sheet's TRAP 3 —
--      reusing `head` would hand the approver the head block's propose/threshold grants,
--      and `team` is worse, db/seed.sql grants view/propose/execute to every `team`);
--   2. generate `CENTRAL_<FN>_APPROVER` for all eleven functions (one has capability today);
--   3. remove the head's blanket `('CENTRAL_MDM_HEAD','mdm.%')` and re-grant the head its
--      explicit set — the four coarse codes (view, propose, approve.threshold,
--      policy.configure) plus every entity read (`mdm.%.view`, `mdm.%.search`) — so the
--      head keeps its screens (TRAP 1) and its above-threshold + policy authority, and
--      loses the create/update/approve acts;
--   4. grant the MDM approver the four approve acts plus the reads it needs to decide them
--      (`mdm.article.approve` / `.raw_material.approve` / `.vendor.approve` /
--      `.tax_class.approve`, and the matching `.view` codes). `mdm.vendor.bank.view` is
--      deliberately NOT granted — no vendor approval write path reads it (lead judgement
--      call 2);
--   5. move the raise acts the head alone held to `CENTRAL_MDM_TEAM`, so the capability does
--      not disappear: three `.reactivate`, the five financial/maintenance `.update` codes,
--      and `mdm.tax_class.deactivate` + `mdm.site.deactivate` (the spec's Team row lists
--      `deactivate`/`reactivate` for every entity; the design's enumerated list named eight
--      of these ten, and the two deactivates are covered by the same "otherwise the
--      capability disappears" rule — recorded here, not silently added);
--   6. grant `SITE_CULINARY_TEAM` `mdm.article.create` / `.update` / `.price.update` so an
--      outlet's own team can genuinely raise (all three are `requires_site_scope = false`).
--
-- The routing constant `ARTICLE_APPROVER_ROLE` (src/domain/approvals.ts) is switched to
-- `CENTRAL_MDM_APPROVER` in the same session, so the queue scope (`inbox.ts`) and the
-- task's `assigned_role_code` (mdm-approvals.ts) agree with this role.
-- ---------------------------------------------------------------------------

-- 1. Admit `approver` seniority.
alter table role drop constraint role_seniority_check;
alter table role add constraint role_seniority_check
  check (seniority in ('head', 'team', 'site_head', 'operator', 'approver'));

-- 2. Generate CENTRAL_<FN>_APPROVER for every function.
with fn (fn_code, fn_name) as (
  values
    ('it',                 'IT'),
    ('revenue_assurance',  'Revenue Assurance'),
    ('quality_assurance',  'Quality Assurance'),
    ('maintenance',        'Maintenance'),
    ('controls',           'Controls'),
    ('purchase',           'Purchase'),
    ('store',              'Store'),
    ('operations',         'Operations'),
    ('culinary',           'Culinary'),
    ('mdm',                'MDM'),
    ('marketing',          'Marketing')
)
insert into role (code, name, layer, function_code, seniority, description)
select 'CENTRAL_' || upper(fn_code) || '_APPROVER', fn_name || ' Approver', 'central', fn_code, 'approver',
       'Approves ' || lower(fn_name) || ' work raised by the central and site teams; holds no create, update or propose act.'
  from fn
on conflict (code) do update set
  name = excluded.name, layer = excluded.layer, function_code = excluded.function_code,
  seniority = excluded.seniority, description = excluded.description;

-- 3. Remove the head's blanket `mdm.%` (it reaches the entity codes AND the coarse
--    `mdm.view`/`mdm.propose`/`mdm.execute`/`mdm.approve.threshold`/`mdm.policy.configure`/
--    `mdm.approve.site`), then re-grant the explicit set below.
delete from role_permission rp
 using permission p, role r
 where rp.permission_id = p.id
   and rp.role_id = r.id
   and r.code = 'CENTRAL_MDM_HEAD'
   and p.code like 'mdm.%';

-- The head's coarse set (the same four codes db/seed.sql's head block grants; `mdm.execute`
-- and `mdm.approve.site` are deliberately NOT re-granted — execute is the teams', and
-- approve.site is the Site Head's).
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in ('mdm.view', 'mdm.propose', 'mdm.approve.threshold', 'mdm.policy.configure')
   and p.layer = 'tenant'
 where r.code = 'CENTRAL_MDM_HEAD'
on conflict (role_id, permission_id) do nothing;

-- The head's entity reads, re-granted explicitly (TRAP 1: without these the head loses its
-- screens). `mdm.%.view` reaches `mdm.vendor.bank.view`, which the head keeps as the
-- master-data owner.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on (p.code like 'mdm.%.view' or p.code like 'mdm.%.search')
   and p.layer = 'tenant'
 where r.code = 'CENTRAL_MDM_HEAD'
on conflict (role_id, permission_id) do nothing;

-- 4. The MDM approver: the four approve acts, plus the reads it needs to decide them.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in (
         'mdm.article.approve', 'mdm.raw_material.approve',
         'mdm.vendor.approve', 'mdm.tax_class.approve',
         'mdm.article.view', 'mdm.raw_material.view',
         'mdm.vendor.view', 'mdm.tax_class.view'
       )
   and p.layer = 'tenant'
 where r.code = 'CENTRAL_MDM_APPROVER'
on conflict (role_id, permission_id) do nothing;

-- 5. The raise acts the head alone held, moved to the team so the capability survives.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in (
         'mdm.article.reactivate', 'mdm.raw_material.reactivate', 'mdm.vendor.reactivate',
         'mdm.raw_material.cost.update', 'mdm.vendor.bank.update', 'mdm.vendor.terms.update',
         'mdm.uom.conversion.update', 'mdm.tax_class.rate.update',
         'mdm.tax_class.deactivate', 'mdm.site.deactivate'
       )
   and p.layer = 'tenant'
 where r.code = 'CENTRAL_MDM_TEAM'
on conflict (role_id, permission_id) do nothing;

-- 6. The outlet's own team can raise an article: create, edit, re-price — decided centrally.
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from role r
  join permission p
    on p.code in ('mdm.article.create', 'mdm.article.update', 'mdm.article.price.update')
   and p.layer = 'tenant'
 where r.code = 'SITE_CULINARY_TEAM'
on conflict (role_id, permission_id) do nothing;
