-- OmniHost.ai — migration 0012: the booking side (KDS/CDS/KOT slice S-B, part 1 of 3)
-- ---------------------------------------------------------------------------
-- `order`, `outlet_order` and `order_line` — DESIGN-kds-and-ticket-routing.md §2.1, and
-- nothing else. Additive: no table is dropped or renamed, no existing row changes
-- meaning, and the only change to a live table is one unique index on `outlet` so a
-- composite foreign key can point at a real parent (the same pattern
-- `display_credential_display_fk` used in 0011).
--
-- **What this migration deliberately does not create.** `ticket`, `ticket_line` and
-- `ticket_transition` (S-B/2), `print_job` (S-E). And no `bill`, `payment`,
-- `settlement`, `allocation` or `refund` row of any kind: no payment provider is
-- connected and no money has moved, so the pilot order is *priced and not paid*
-- (D24, §11.5.1). A table nothing can populate is a promise the platform cannot keep.
--
-- **Money is an integer number of minor units plus an ISO 4217 code, never a float and
-- never a bare number.** `article_price.amount` is `numeric(18,4)` in *major* units
-- because that is the master-data contract; the conversion to minor units happens once,
-- in `src/domain/order.ts`, at booking time, and what is stored here is the pinned
-- integer paise. Every amount column is `integer` with a `>= 0` check, and the
-- arithmetic identities between them are check constraints rather than a convention —
-- a line whose total is not its amount plus its service charge cannot be stored at all.
--
-- **Version pinning is the point of these columns** (§2.1, §11.3.5). A line pins
-- `article_version_id`, `article_price_id`, `tax_rate_id`, `tax_rate_pct`,
-- `tax_inclusive`, `unit_amount_minor` and the three amounts it resolved to, so a bill
-- reproduces what was sold under even after the draft-version rule supersedes the
-- version and a new price window opens (0010_article_version_supersede.sql).
--
-- **Per-chain isolation has no RLS policy behind it** (DECISIONS.md:8, D22). Every new
-- table carries `chain_id`, and where the boundary can be enforced *by the database* it
-- is: an `outlet_order` cannot point at an outlet in another site, and an `order_line`
-- cannot hang off another chain's outlet order.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- (a) `outlet` gains one unique key so a composite foreign key can name it.
--     `unique (site_id, id)` is trivially satisfied by every existing row (`id` is the
--     primary key) and is what makes "this outlet order's outlet really is in the site
--     the order names" a database invariant rather than a code habit.
-- ---------------------------------------------------------------------------
create unique index if not exists outlet_site_id_key on outlet (site_id, id);
comment on index outlet_site_id_key is
  'Parent key for composite foreign keys that must name an outlet *inside* a site (outlet_order_outlet_fk). Satisfied by every existing row; it exists so the site/outlet pair cannot be crossed by a bad write.';
-- ---------------------------------------------------------------------------
-- (b) `order` — one row per booking (§2.1). The parent exists from the first commit
--     even though the pilot takes bookings at one outlet, so a second outlet is a data
--     change and not a schema change.
--
--     `order` is a SQL keyword, so the table name is quoted everywhere it appears —
--     deliberately, because `guest_order` or `booking` would be a private name for a
--     thing the spec and the PRD both call an order, and the code that reads it would
--     then have to translate between two vocabularies.
--
--     `service_reference` is the token the guest is called by (§2.1). There is no
--     `table` entity and none is invented here: the booking carries a free-text
--     `table_label`, and the floor-plan module brings the real table (D7).
-- ---------------------------------------------------------------------------
create table if not exists "order" (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  site_id            uuid not null references site (id) on delete cascade,
  -- The number a human says out loud. Unique per site, so two guests are never called
  -- by the same token on the same day at the same site.
  service_reference  text not null,
  -- `origin` is where the booking came *from* — a channel, not a device. It is a code
  -- in the ledger and a worded label on a screen (the owner's codes-stay-codes rule).
  origin             text not null
                     check (origin in ('pos', 'kiosk', 'tab', 'guest_app', 'chat')),
  -- Free text, never a foreign key: D7 says no fabricated half-table.
  table_label        text,
  placed_by_user_id  uuid references "user" (id) on delete set null,
  placed_at          timestamptz not null default now(),
  -- The order mirrors its outlet order while there is exactly one (§2.1). The roll-up
  -- rule for several outlet orders is deliberately out of this slice (§8).
  status             text not null default 'placed'
                     check (status in ('placed','accepted','fired','in_progress','ready','served','closed','cancelled')),
  cancelled_at       timestamptz,
  cancel_reason_code text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (chain_id, site_id, service_reference),
  -- A cancelled order without a stated reason is the state this constraint makes
  -- unrepresentable: §2.7's ledger and the screen both need the reason, and a NULL here
  -- would read as "nobody knows why".
  constraint order_cancel_reason
    check (status <> 'cancelled' or length(btrim(coalesce(cancel_reason_code, ''))) > 0)
);
comment on table "order" is
  'One row per booking (§2.1). Parent of one or more outlet_order rows; one in the pilot. Quoted because ORDER is a SQL keyword — the name is the spec''s.';
comment on column "order".service_reference is
  'The token the guest is called by. Unique per chain and site. An identifier position: printed and spoken verbatim, never translated.';
create index if not exists order_tenant_idx on "order" (chain_id, site_id, placed_at desc);
create index if not exists order_status_idx on "order" (chain_id, site_id, status);
-- ---------------------------------------------------------------------------
-- (c) `outlet_order` — the PRD's Outlet Sub-Order (p.7): what one outlet accepted,
--     priced and taxed under its own configuration and jurisdiction.
--
--     The three amount identities below are check constraints, not conventions. A row
--     whose `total_minor` is not its subtotal plus its service charge, or whose status
--     is `cancelled` with no reason, cannot be written by any code path — including a
--     future bulk import, which is exactly the class of write that ignores a code habit.
-- ---------------------------------------------------------------------------
create table if not exists outlet_order (
  id                       uuid primary key default gen_random_uuid(),
  chain_id                 uuid not null references chain (id) on delete cascade,
  site_id                  uuid not null references site (id) on delete cascade,
  outlet_id                uuid not null references outlet (id) on delete cascade,
  order_id                 uuid not null references "order" (id) on delete cascade,
  status                   text not null default 'placed'
                           check (status in ('placed','accepted','fired','in_progress','ready','served','closed','cancelled')),
  -- Which surface took it (§2.4's request_source vocabulary, the same values the audit
  -- row carries). The auto-accept at booking writes `screen` and says so in the audit.
  request_source           text not null default 'screen'
                           check (request_source in ('screen','chatbot','api','system','import')),
  accepted_at              timestamptz,
  accepted_by_user_id      uuid references "user" (id) on delete set null,
  fired_at                 timestamptz,
  -- Captured at fire from the site's `guest.prep_time_sla_minutes` and never recomputed
  -- (§2.5). NULL until S-B/2 fires this outlet order.
  prep_deadline_at         timestamptz,
  served_at                timestamptz,
  closed_at                timestamptz,
  cancelled_at             timestamptz,
  cancel_reason_code       text,
  -- Money: integer minor units + ISO 4217. `char(3)` because a currency is always
  -- three letters; a shorter or longer value cannot be stored.
  currency_code            char(3) not null,
  -- Pinned at booking from the site's `payments.service_charge_percent`, so a later
  -- settings change does not move a bill that has already been priced.
  service_charge_percent   numeric(7,4) not null default 0,
  subtotal_minor           integer not null default 0 check (subtotal_minor >= 0),
  tax_minor                integer not null default 0 check (tax_minor >= 0),
  service_charge_minor     integer not null default 0 check (service_charge_minor >= 0),
  total_minor              integer not null default 0 check (total_minor >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- One outlet order per outlet per booking: a second one for the same outlet would be a
  -- split, and a split is not in this slice (§8).
  unique (order_id, outlet_id),
  -- Two parent keys for order_line's composite foreign keys (see D22 above): one that
  -- carries the tenant, and one that carries the currency, so a line cannot be written
  -- against another chain's order *or* in a different currency from the order it
  -- belongs to. Both are trivially satisfied by every row (`id` is the primary key).
  unique (chain_id, id),
  unique (currency_code, id),
  constraint outlet_order_total
    check (total_minor = subtotal_minor + service_charge_minor),
  constraint outlet_order_cancel_reason
    check (status <> 'cancelled' or length(btrim(coalesce(cancel_reason_code, ''))) > 0),
  -- The outlet named is in the site named. A crafted (site, outlet) pair updates nothing.
  constraint outlet_order_outlet_fk
    foreign key (site_id, outlet_id) references outlet (site_id, id) on delete cascade
);
comment on table outlet_order is
  'The PRD''s Outlet Sub-Order: what one outlet accepted, priced and taxed under its own configuration and jurisdiction. Subtotal, tax, service charge and total are integers in minor units; total = subtotal + service charge is a check constraint, not a convention.';
comment on column outlet_order.service_charge_percent is
  'Pinned from the site''s payments.service_charge_percent at booking. Per cent, not a fraction, matching tax_rate.rate_pct.';
create index if not exists outlet_order_tenant_idx on outlet_order (chain_id, outlet_id, status);
create index if not exists outlet_order_site_idx on outlet_order (chain_id, site_id, status);
create index if not exists outlet_order_order_idx on outlet_order (order_id);
-- ---------------------------------------------------------------------------
-- (d) `order_line` — the priced, version-pinned line (§2.1).
--
--     `routing_section_id` and `routing_source` are the fire-time resolution (§1.4):
--     both NULL here until S-B/2 fires the order, because they are resolved *once, at
--     fire, and never recomputed* (D4). §1.4 calls the same column
--     `order_line.routed_section_id` in its prose and `routing_section_id` in §2.1's
--     field list; this build uses §2.1's name and says so rather than carrying two.
-- ---------------------------------------------------------------------------
create table if not exists order_line (
  id                            uuid primary key default gen_random_uuid(),
  chain_id                      uuid not null references chain (id) on delete cascade,
  outlet_order_id               uuid not null,
  -- Where the line appears on the ticket. Assigned at booking, stable after.
  position                      integer not null default 0,
  article_id                    uuid not null references article (id) on delete restrict,
  -- The version the line was sold under, pinned (§2.1). `on delete restrict`: a version
  -- a booking was priced from may not be deleted out from under the bill.
  article_version_id            uuid not null references article_version (id) on delete restrict,
  -- The exact price window row, pinned. NULL only for a line priced with no price row,
  -- which the domain refuses today — the column is nullable so that a legitimate
  -- zero-priced line (a complimentary item) is a later data decision, not a migration.
  article_price_id              uuid references article_price (id) on delete restrict,
  tax_class_id                  uuid references tax_class (id) on delete restrict,
  tax_rate_id                   uuid references tax_rate (id) on delete restrict,
  tax_rate_pct                  numeric(7,4) not null,
  tax_inclusive                 boolean not null,
  quantity                      integer not null check (quantity > 0),
  -- The menu price of one unit, tax-inclusive, in minor units (the INR paise a guest
  -- sees on the menu). Never a float: `article_price.amount` is numeric(18,4) in major
  -- units and is converted once, here.
  unit_amount_minor             integer not null check (unit_amount_minor >= 0),
  -- unit_amount_minor x quantity: the line as printed on the menu.
  line_amount_minor             integer not null check (line_amount_minor >= 0),
  -- The tax extracted from line_amount_minor when the class is inclusive, or added to it
  -- when the class is exclusive.
  tax_amount_minor              integer not null check (tax_amount_minor >= 0),
  -- line_amount_minor less its tax.
  net_amount_minor              integer not null check (net_amount_minor >= 0),
  service_charge_amount_minor   integer not null default 0 check (service_charge_amount_minor >= 0),
  line_total_minor              integer not null check (line_total_minor >= 0),
  currency_code                 char(3) not null,
  routing_section_id            uuid references outlet_section (id) on delete restrict,
  routing_source                text
                                check (routing_source in ('article_route','category_default','expedite_fallback','unrouted')),
  prep_notes                    text,
  line_state                    text not null default 'placed'
                                check (line_state in ('placed','fired','in_prep','ready','served','voided','held_unavailable')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- The arithmetic, made structural. Three identities, each one a way a bill goes wrong
  -- silently if it is only a habit in the code:
  --   * a line's net value is its unit price times its quantity;
  --   * its amount is its net plus its tax — which is how a tax-inclusive menu price
  --     splits (tax = amount - net) and how an exclusive one adds up (amount = net + tax);
  --   * its total is its amount plus its service charge.
  constraint order_line_arithmetic
    check (
      net_amount_minor = unit_amount_minor * quantity
      and line_amount_minor = net_amount_minor + tax_amount_minor
      and line_total_minor = line_amount_minor + service_charge_amount_minor
    ),
  -- The line belongs to an outlet order **in its own chain** ...
  constraint order_line_order_fk
    foreign key (chain_id, outlet_order_id) references outlet_order (chain_id, id) on delete cascade,
  -- ... and **in its own currency**. Money carries one currency per outlet order; a line
  -- in another currency is a mixed-currency bill, which the platform does not model.
  -- Declared here rather than checked in code so no path — including a future import —
  -- can write one.
  constraint order_line_currency_fk
    foreign key (currency_code, outlet_order_id) references outlet_order (currency_code, id) on delete cascade
);
comment on table order_line is
  'One priced line of an outlet order, pinned to the article version, the price window row, the tax class and the tax rate it was sold under, so a historical bill reproduces after a version is superseded. Amounts are integers in minor units and the arithmetic between them is a check constraint.';
comment on column order_line.unit_amount_minor is
  'The menu price of one unit in minor units, converted once from article_price.amount (numeric(18,4), major units) at booking. Tax-inclusive when tax_inclusive is true — the Indian menu convention.';
comment on column order_line.routing_section_id is
  'Resolved once at fire and never recomputed (D4). NULL until S-B/2 fires the order. §1.4''s prose calls this column routed_section_id; this is the same column under §2.1''s name.';
create index if not exists order_line_order_idx on order_line (outlet_order_id, position);
create index if not exists order_line_article_idx on order_line (chain_id, article_id);
create index if not exists order_line_route_idx on order_line (routing_section_id) where routing_section_id is not null;
