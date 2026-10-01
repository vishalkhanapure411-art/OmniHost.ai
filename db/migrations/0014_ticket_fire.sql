-- OmniHost.ai — migration 0014: the ticket tables (KDS/CDS/KOT slice S-B, part 2a of 3)
-- ---------------------------------------------------------------------------
-- `ticket`, `ticket_line` and `ticket_transition` — DESIGN-kds-and-ticket-routing.md
-- §2.2 and §1.3(f), and nothing else. Additive: no table is dropped or renamed, no
-- existing row changes meaning, and the only change to a live table is one unique index
-- on `outlet_order` so a composite foreign key can point at a real parent (the same
-- pattern 0011 and 0012 used).
--
-- **What this migration deliberately does not create.** `print_job` (S-E), and no
-- `bill`, `payment`, `settlement`, `allocation` or `refund` row of any kind — no payment
-- provider is connected and no money has moved (D24). A ticket prints nothing in this
-- slice and carries no price: **no money on a ticket, ever** (D14).
--
-- **A ticket is the work at one station for one outlet order** (§2.2). It belongs to a
-- *station* and not to a screen (D5): `unique (outlet_order_id, section_id)` is what makes
-- a second ticket for the same station and the same booking unrepresentable, so a station
-- with two screens cannot double-fire and two screens cannot hold two copies of one
-- ticket that then disagree. `ticket_line` is the lines routed there.
--
-- **Routing is recorded, never recomputed** (D4). `ticket.routing_source` and
-- `order_line.routing_source` are written once at fire from §1.4's resolution; changing
-- the routing map afterwards changes the next ticket and never this one.
--
-- **One service day per station, and the number a human says out loud.** `service_date` is
-- the SITE's calendar date at fire (the pilot's site is Asia/Kolkata, 5h30 ahead of UTC, so
-- a fire at 01:00 IST belongs to the new day and not to the previous one) and `ticket_no`
-- restarts at 1 for each station on each of those days.
--
-- **SPEC DEFECT, found while writing this file and stated here rather than papered over:**
-- §2.2's DDL keys the number as `unique (outlet_id, section_id, ticket_no)` — without the
-- date — while the same paragraph and D3's surrounding prose say the number is *per station
-- per service day*. The two cannot both hold: a number that restarts daily collides with
-- yesterday's row on the second day of trading, so a pilot that fired ticket 1 today could
-- not fire ticket 1 tomorrow. The uniqueness below therefore carries `service_date`, which
-- is the key the prose describes and the one the acceptance criterion names ("`ticket_no`
-- unique per (outlet, section, service day)"). The spec's literal key is a defect to be
-- corrected in the spec, not worked around in the schema; storing a never-restarting number
-- instead would have made the kitchen's own number meaningless.
--
-- **`ticket_transition` is an index, not a second source of truth.** §2.8 says the ticket's
-- history is the `audit_log` rows (state columns are updated in place; every change has a
-- before/after row) and that there is no separate history table in this slice. This table is
-- the per-ticket *journal* §1.3(f) and §2.2 name, and every row it will hold in S-B/2b
-- carries `audit_id` — the id of the audit row written in the same transaction — so the
-- ledger stays the record and this is what makes "this ticket's own story" one query instead
-- of a scan. Nothing writes to it in this slice except Fire (T1).
--
-- **Per-chain isolation has no RLS policy behind it** (DECISIONS.md:8, D22). Every new table
-- carries `chain_id`, and where the boundary can be enforced *by the database* it is: a
-- ticket cannot name a section or an outlet order that belongs to another outlet or chain,
-- and `ticket_line` cannot hang off another chain's ticket.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- (a) `outlet_order` gains one unique key so a composite foreign key can name it.
--     `unique (outlet_id, id)` is trivially satisfied by every existing row (`id` is the
--     primary key) and is what makes "a ticket's outlet really is the outlet of the outlet
--     order it was fired from" a database invariant rather than a code habit.
-- ---------------------------------------------------------------------------
create unique index if not exists outlet_order_outlet_id_key on outlet_order (outlet_id, id);
comment on index outlet_order_outlet_id_key is
  'Parent key for ticket_outlet_order_fk: the outlet named by a ticket must be the outlet of the outlet_order it belongs to. Satisfied by every existing row.';
-- ---------------------------------------------------------------------------
-- (b) `ticket` — the work at one station for one outlet order (§2.2, D5).
--
--     The state check is the lifecycle's alphabet, not the whole state machine: §2.3's
--     transitions and their capabilities are S-B/2b's, and the optimistic-concurrency
--     WHERE-clause that every one of them carries is written by that code, not here.
-- ---------------------------------------------------------------------------
create table if not exists ticket (
  id               uuid primary key default gen_random_uuid(),
  chain_id         uuid not null references chain (id) on delete restrict,
  site_id          uuid not null references site (id) on delete restrict,
  outlet_id        uuid not null references outlet (id) on delete restrict,
  outlet_order_id  uuid not null,
  -- The station that produces this work. A ticket with no station is not representable:
  -- §2.2 makes it NOT NULL, and an unrouted line goes to a real section (the pass, D3)
  -- rather than to a made-up one.
  section_id       uuid not null references outlet_section (id) on delete restrict,
  -- The SITE's calendar date at fire. See the header: it is what makes the number below
  -- "per station per service day" a fact rather than an intention.
  service_date     date not null,
  -- The number a human says out loud. Per station, per service day, starting at 1.
  ticket_no        integer not null check (ticket_no > 0),
  state            text not null default 'queued'
                   check (state in ('queued','acknowledged','in_prep','ready','served','voided','held_unavailable')),
  -- §1.4's resolution, recorded at fire and never recomputed (D4). The same four values
  -- `order_line.routing_source` permits, so a line and its ticket cannot disagree about the
  -- vocabulary.
  routing_source   text not null
                   check (routing_source in ('article_route','category_default','expedite_fallback','unrouted')),
  fired_at         timestamptz not null default now(),
  -- Captured at fire from the site's `guest.prep_time_sla_minutes` and never recomputed
  -- (§2.5, D10): a deadline that moves after it was breached is a lie in the one place a
  -- kitchen looks.
  prep_deadline_at timestamptz not null,
  ready_at         timestamptz,
  served_at        timestamptz,
  voided_at        timestamptz,
  void_reason_code text,
  held_at          timestamptz,
  hold_reason_code text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- One ticket per station per outlet order (D5): a station with two screens renders one
  -- ticket, and the second fire of the same booking is refused by the database as well as
  -- by the order's own state.
  unique (outlet_order_id, section_id),
  -- The kitchen's own numbering, per station per service day. See the header for why the
  -- date is here and not in §2.2's literal key.
  unique (outlet_id, section_id, service_date, ticket_no),
  -- Parent key for ticket_line's composite foreign key: a line cannot hang off another
  -- chain's ticket.
  unique (chain_id, id),
  -- A deadline before the moment it was fired for is not a deadline.
  constraint ticket_deadline_after_fire check (prep_deadline_at >= fired_at),
  -- §2.3 T7 voids with a reason code and §2.6 holds with one, so the two states that carry
  -- a reason cannot be stored without it — the same shape `order.cancel_reason_code` uses.
  constraint ticket_void_reason
    check (state <> 'voided' or length(btrim(coalesce(void_reason_code, ''))) > 0),
  constraint ticket_hold_reason
    check (state <> 'held_unavailable' or length(btrim(coalesce(hold_reason_code, ''))) > 0),
  -- The booking this work came from, in this chain ... (on delete cascade: removing a
  -- booking removes the work that was raised for it, which is what D24's demo teardown and
  -- any future order purge need).
  constraint ticket_outlet_order_fk
    foreign key (chain_id, outlet_order_id) references outlet_order (chain_id, id) on delete cascade,
  -- ... a booking of *this outlet* (so a crafted (outlet, outlet_order) pair cannot be
  -- written) ...
  constraint ticket_outlet_fk
    foreign key (outlet_id, outlet_order_id) references outlet_order (outlet_id, id) on delete cascade,
  -- ... an outlet inside the site named ...
  constraint ticket_site_outlet_fk
    foreign key (site_id, outlet_id) references outlet (site_id, id) on delete restrict,
  -- ... and a station of that same outlet. Four keys, each one a pair the code cannot cross.
  constraint ticket_section_outlet_fk
    foreign key (outlet_id, section_id) references outlet_section (outlet_id, id) on delete restrict
);
comment on table ticket is
  'The work at one station for one outlet order (§2.2). Belongs to a station, never to a display (D5): unique (outlet_order_id, section_id) makes a double-fire unrepresentable. routing_source is recorded at fire and never recomputed (D4).';
comment on column ticket.service_date is
  'The SITE''s calendar date at fire (Asia/Kolkata for the pilot, not UTC). ticket_no is per station per service day, so this column is part of the unique key — §2.2''s DDL omits it and would collide on the second day of trading (see the migration header).';
comment on column ticket.prep_deadline_at is
  'fired_at plus the site''s guest.prep_time_sla_minutes, captured at fire and never recomputed (§2.5, D10).';
create index if not exists ticket_tenant_idx on ticket (chain_id, outlet_id, state);
create index if not exists ticket_station_queue_idx on ticket (outlet_id, section_id, state, fired_at);
create index if not exists ticket_order_idx on ticket (outlet_order_id);
create index if not exists ticket_service_day_idx on ticket (outlet_id, section_id, service_date);
-- ---------------------------------------------------------------------------
-- (c) `ticket_line` — the lines routed to one ticket (§2.2).
--
--     `state` is the line's own state and exists so that a partial-ready ticket is a later
--     change rather than a rewrite; in the pilot it is derivable from the ticket's and the
--     fire writes it beside it. `unique (ticket_id, order_line_id)` is the spec's "a line
--     appears once on a ticket", and it is why a qty-2 line is one row and not two: quantity
--     lives on `order_line` and is never copied or split here.
-- ---------------------------------------------------------------------------
create table if not exists ticket_line (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  ticket_id     uuid not null,
  order_line_id uuid not null references order_line (id) on delete cascade,
  -- Where the line appears on the ticket. Stable after fire.
  position      integer not null default 0,
  state         text not null default 'queued'
                check (state in ('queued','acknowledged','in_prep','ready','served','voided','held_unavailable')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A line appears once on a ticket (§2.2).
  unique (ticket_id, order_line_id),
  -- ... and only on a ticket of its own chain.
  constraint ticket_line_ticket_fk
    foreign key (chain_id, ticket_id) references ticket (chain_id, id) on delete cascade
);
comment on table ticket_line is
  'One order line as it appears on one station''s ticket (§2.2). A qty-2 line is ONE row: quantity lives on order_line and is never copied, split or reinterpreted here.';
create index if not exists ticket_line_ticket_idx on ticket_line (ticket_id, position);
create index if not exists ticket_line_order_line_idx on ticket_line (order_line_id);
-- ---------------------------------------------------------------------------
-- (d) `ticket_transition` — the per-ticket journal of §2.3's lifecycle (§1.3(f), §2.2).
--
--     Written in the SAME transaction as the state change it records, always with the audit
--     row's own id (§2.3's first rule). `from_state` is nullable for exactly one case: T1
--     (fire) creates the ticket, so there is no state before it — and writing the string
--     'none' there would be a code pretending to be a state.
-- ---------------------------------------------------------------------------
create table if not exists ticket_transition (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  ticket_id       uuid not null,
  -- §2.3's row label: 'T1' fire, 'T2' acknowledge … 'T11' close. The code is the subject, so
  -- it stays a code (the owner's rule) — a screen words it from the catalogue.
  transition_code text not null,
  from_state      text,
  to_state        text not null,
  -- Who moved it: a person, or a device with no person behind it (D26 — the device rows
  -- carry actor_user_id NULL, the station's operating role code and the terminal's code).
  actor_user_id   uuid references "user" (id) on delete set null,
  actor_role_code text not null,
  actor_scope     text not null check (actor_scope in ('app','central','site')),
  display_code    text,
  reason_code     text,
  -- The audit_log row written in the same transaction. The ledger is the record (§2.8); this
  -- is the index into it, which is what makes one ticket's story a query.
  audit_id        bigint,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  -- A ticket's state change can name the state it moved to and not a state that does not
  -- exist: the alphabet is the same seven §2.2 lists for `ticket.state`.
  constraint ticket_transition_to_state
    check (to_state in ('queued','acknowledged','in_prep','ready','served','voided','held_unavailable')),
  constraint ticket_transition_from_state
    check (from_state is null or from_state in ('queued','acknowledged','in_prep','ready','served','voided','held_unavailable')),
  constraint ticket_transition_ticket_fk
    foreign key (chain_id, ticket_id) references ticket (chain_id, id) on delete cascade
);
comment on table ticket_transition is
  'One row per §2.3 transition, written in the same transaction as the state change and carrying that transaction''s audit_log id. The ledger is the record (§2.8); this is the per-ticket index into it. T1 is written by the fire path; T2–T11 are S-B/2b''s.';
create index if not exists ticket_transition_ticket_idx on ticket_transition (ticket_id, occurred_at);
create index if not exists ticket_transition_code_idx on ticket_transition (chain_id, transition_code, occurred_at desc);
