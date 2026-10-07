-- OmniHost.ai — migration 0018: the booking read's own capability (S-B/2c)
-- ---------------------------------------------------------------------------------------------
-- `readOutletOrder` in `src/domain/order.ts` was gated on **`order.book`** — a mutation — with
-- its own comment saying so and calling it one line to change:
--
--   "SPEC-GAP, flagged rather than papered over: §2.4 registers no read capability for the
--    order side … This read is gated on `order.book`, the capability of the people who take
--    them, because the alternative was inventing an `order.view` code the spec does not have."
--
-- S-B/2c makes the split: reading a booking is **`order.view`**, and taking one stays
-- `order.book`. Without this row in a live database the read path would refuse **every**
-- caller — `guard()` resolves a capability by looking the code up in `permission`, and a code
-- that is not registered is held by nobody, so the pilot's own read-back would fail closed
-- against a correct product. That is the shape 0015 exists for, and this is the same move.
--
-- **The code's name is `order.view`, not `order.read`.** Every read in this registry already
-- ends in `.view` — `display.view`, `kds.route.view`, `kds.ticket.view`, `cds.display.view` —
-- and a second word for one act is how a code vocabulary starts needing a translation table.
-- The reasoning is written in `src/domain/order-rules.ts` (`ORDER_READ_CAPABILITY`), which is
-- where the booking's capabilities are declared; this migration is only what makes it true in
-- a database.
--
-- **The holders, and why these three.** §2.4 registers no order-side read at all, so there is
-- no table to copy. The rule applied is the honest one: nobody gains reach they did not
-- effectively have, and exactly one role gains a read it should have had without a write.
--
--   SITE_OPERATIONS_TEAM   takes bookings (`order.book`) — the read it already had through it
--   SITE_HEAD              runs the service at a site — likewise
--   SITE_CULINARY_TEAM     works the tickets a booking produced (`kds.ticket.view`,
--                          `kds.ticket.advance`) and reads the booking they belong to — and
--                          holds no booking mutation, which is the point of the split
--
-- A fresh database gets the same three grants from `db/seed.sql` section 8, whose
-- `implemented_in` case now names `display-sB2c` for this code, so a reset cannot revert this.
-- The grants are written as a join against `role` because on a fresh database migrations run
-- *before* the seed: the join then produces no rows and the seed carries them. `on conflict do
-- nothing` keeps a re-run harmless.

with cap (code, name, description) as (
  values
    ('order.view', 'Read a booking',
     'What a booking contains: its lines, the versions and prices they were pinned to, its service charge and tax, and where each line was routed at fire. Reading a booking is not taking one, so this is its own capability and not `order.book`.')
)
insert into permission (code, module, name, description, action_kind, layer, requires_site_scope,
                        check_function, financial_or_stock, implemented_in)
select cap.code, 'order', cap.name, cap.description, 'query', 'tenant', true, false, false,
       'display-sB2c'
  from cap
on conflict (code) do update set
  module = excluded.module,
  name = excluded.name,
  description = excluded.description,
  action_kind = excluded.action_kind,
  layer = excluded.layer,
  requires_site_scope = excluded.requires_site_scope,
  check_function = excluded.check_function,
  financial_or_stock = excluded.financial_or_stock,
  implemented_in = excluded.implemented_in;

with grant_row (permission_code, role_code) as (
  values
    ('order.view', 'SITE_OPERATIONS_TEAM'),
    ('order.view', 'SITE_HEAD'),
    ('order.view', 'SITE_CULINARY_TEAM')
)
insert into role_permission (role_id, permission_id)
select r.id, p.id
  from grant_row g
  join role r on r.code = g.role_code
  join permission p on p.code = g.permission_code
on conflict (role_id, permission_id) do nothing;
