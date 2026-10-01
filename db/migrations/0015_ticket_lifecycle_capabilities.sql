-- OmniHost.ai — migration 0015: the ticket-lifecycle capabilities (§2.4), true in the database
-- ------------------------------------------------------------------------------------------------
-- Slice S-B/2b builds §2.3's lifecycle (T2–T7 and T9) in `src/domain/ticket.ts`. Every transition
-- it makes is under one of five capabilities, and this migration is what makes those five true in
-- a **database**, as distinct from registered in a file.
--
--   kds.ticket.advance  T2 acknowledge, T3 start, T4 ready   (the kitchen's one tap)
--   kds.ticket.serve    T6 serve
--   kds.ticket.recall   T5 recall from ready
--   kds.ticket.void     T7 void
--   kds.ticket.reroute  T9 re-route to another station
--
-- **Where these rows came from, stated plainly.** S-A registered all five (and `kds.ticket.view`)
-- in `db/seed.sql` section 8 while designing the display vocabulary, marked `implemented_in =
-- 'display-sA'` — i.e. *registered, not implemented*, which is the distinction that column exists
-- to keep. S-B/2b is the slice that implements them. Read back from the pilot database before this
-- migration ran (1 Oct 2026, `permission` joined to `role_permission`):
--
--   kds.ticket.advance  SITE_CULINARY_TEAM, SITE_OPERATIONS_TEAM
--   kds.ticket.serve    SITE_OPERATIONS_TEAM, SITE_HEAD
--   kds.ticket.recall   SITE_CULINARY_TEAM, SITE_HEAD
--   kds.ticket.void     SITE_CULINARY_TEAM, SITE_HEAD
--   kds.ticket.reroute  SITE_CULINARY_TEAM, SITE_HEAD
--
-- So on that database the first two statements below are **no-ops held as deliberate safety**: a
-- database that has never had S-A's seed block applied (or that had a code deleted by hand) would
-- otherwise run a lifecycle whose every capability is unheld, and every transition would refuse.
-- What this migration actually changes there is the third statement: `implemented_in` moves from
-- `display-sA` to `display-sB2b` for the five, because a registry that says a code is implemented
-- by a slice that only registered it is a false claim, and the licensing and capability surfaces
-- read this column.
--
-- **`kds.ticket.view` is deliberately left alone.** Its read path is the station screen's, which is
-- S-C's, so `display-sA` on that row is still the honest — if unflattering — value: registered, and
-- not yet implemented by any slice. Flagged here rather than quietly corrected, because correcting
-- it would hide a gap that S-C has to close.
--
-- **Why the grants are written as a join against `role`.** On a fresh database migrations run
-- *before* the seed (0001–0015, then `db/seed.sql`), so `role` is empty at this point and the join
-- produces no rows; the seed's own section 8 carries these same grants for a fresh dataset (and its
-- `implemented_in` case now names `display-sB2b` for the five, so a reset cannot revert this). A
-- grant insert that assumed the roles existed would either fail the migration or, worse, silently
-- grant nothing while reporting success. `on conflict do nothing` keeps a re-run harmless.
--
-- The holders are §2.4's own list, and no role is invented for them (§2.4 item 1: there is no
-- KITCHEN role). Scope is `requires_site_scope = true` on all five, so `guard()` refuses a caller
-- whose role is not held at the ticket's site — the same model every other capability uses, and the
-- reason no scope_grant row appears here: delegation to AppConfig/AppSupport is for App-layer codes,
-- and a chain's own kitchen capability is not an App-layer grant.

with cap (code, name, description) as (
  values
    ('kds.ticket.advance', 'Acknowledge, start and mark a ticket ready',
     'The kitchen''s one tap (T2 acknowledge, T3 start, T4 ready), and the capability under which a station display acts on its own station''s tickets.'),
    ('kds.ticket.serve', 'Serve a ready ticket',
     'A movement at the pass (T6). Serving the last open ticket of a booking is also what moves the booking itself to served, which is the state T11 closes from.'),
    ('kds.ticket.recall', 'Recall a ticket marked ready in error',
     'From `ready` only (T5); from `served` the honest act is a void and a new ticket. A reason code is required.'),
    ('kds.ticket.void', 'Void a ticket',
     'A production act, not a money act (D9): the PRD routes a *sale* void to Revenue Assurance, and a dish dropped on the floor is not a financial event. A reason code is required.'),
    ('kds.ticket.reroute', 'Re-route a ticket to another station',
     'An explicit, audited act (T9) with a reason: a ticket carries the section it was routed to at fire and routing changes never move it silently (D4).')
)
insert into permission (code, module, name, description, action_kind, layer, requires_site_scope,
                        check_function, financial_or_stock, implemented_in)
select cap.code, 'kds', cap.name, cap.description, 'mutation', 'tenant', true, false, false,
       'display-sB2b'
  from cap
on conflict (code) do update set implemented_in = excluded.implemented_in;

-- §2.4's holders, one row per grant, applied only where the role exists in this database.
with grant_row (permission_code, role_code) as (
  values
    ('kds.ticket.advance', 'SITE_CULINARY_TEAM'),
    ('kds.ticket.advance', 'SITE_OPERATIONS_TEAM'),
    ('kds.ticket.serve',   'SITE_OPERATIONS_TEAM'),
    ('kds.ticket.serve',   'SITE_HEAD'),
    ('kds.ticket.recall',  'SITE_CULINARY_TEAM'),
    ('kds.ticket.recall',  'SITE_HEAD'),
    ('kds.ticket.void',    'SITE_CULINARY_TEAM'),
    ('kds.ticket.void',    'SITE_HEAD'),
    ('kds.ticket.reroute', 'SITE_CULINARY_TEAM'),
    ('kds.ticket.reroute', 'SITE_HEAD')
)
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from grant_row g
  join role r on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict (role_id, permission_id) do nothing;
