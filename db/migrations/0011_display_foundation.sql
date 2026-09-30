-- OmniHost.ai — migration 0011: the display foundation (KDS/CDS/KOT slice S-A)
-- ---------------------------------------------------------------------------
-- The schema `DESIGN-kds-and-ticket-routing.md` §1.3 proposes, and nothing more. The
-- migration is **additive**: no table is dropped or renamed, no existing row changes
-- meaning, and the only change to a live table is three new nullable columns on
-- `outlet_section`. Every `create table` uses `if not exists`, so re-running it is a
-- no-op, and every constraint is named so it can be found again.
--
-- **What this migration deliberately does not create.** `order`/`outlet_order`/
-- `order_line` (S-B), `ticket`/`ticket_line`/`ticket_transition` (S-B), `print_job`
-- (S-E) — each is its own slice and a half-built version of any of them would be
-- migrated away. And no `bill`, `payment`, `settlement`, `allocation` or `refund` row
-- of any kind: no payment provider is connected and no money has moved (D24).
--
-- **No external key** on `display`, `article_route` or `route_default` (D23, §1.5).
-- A ticket is an event, not a stored field two systems maintain; an ERP work-centre
-- mapping attaches to `outlet_section` through `erp_code_map` when a connector exists.
-- Adding a key to a table nothing reads is ERP theatre.
--
-- **Per-chain isolation has no RLS policy behind it** (DECISIONS.md:8, D22). Every new
-- table carries `chain_id`, and where a boundary can be enforced *by the database* it
-- is enforced here as well as in code — a `display` cannot point at another outlet's
-- section, a route cannot target a station in a different outlet, and a device
-- credential cannot belong to a display in another chain. That is defence in depth,
-- not a substitute: §1.6's four code points are the boundary, and they live in
-- `src/server/display-device.ts` (see its header for where each one is).

-- ---------------------------------------------------------------------------
-- (a) Extend `outlet_section` — the station. D1: a station IS an `outlet_section`
--     row, and its own comment asks for this table to be extended rather than
--     replaced (`0008_mdm_masters.sql:676-683`).
--
--     Deliberately NOT added: `default_routing_kind`. O9 (lead-ratified 29 Sept) chose
--     the `route_default` table of (d) instead, because a single column per section
--     cannot say *which* category it claims. One of the two shapes is needed and this
--     is the one the team took.
-- ---------------------------------------------------------------------------
alter table outlet_section
  add column if not exists display_locale text;

comment on column outlet_section.display_locale is
  'The language this station''s screen renders and prints in, resolved display.locale -> section.display_locale -> site.locale. Separate from site.locale because a station''s screen is routinely in a different language from HQ (O7: the site sets it).';

-- ---------------------------------------------------------------------------
-- (b) `display` — the device record. D2: a display is a record separate from a
--     station, so "more than one screen per station" (O6) is an insert and not a
--     redesign, and so "printer optional per station" is configuration, not code.
--     A display of kind `kds`/`cds`/`status` is a screen; `printer` is a printer.
-- ---------------------------------------------------------------------------
create table if not exists display (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  site_id       uuid not null references site (id) on delete cascade,
  outlet_id     uuid not null references outlet (id) on delete cascade,
  -- NULL = outlet scope: the guest display, the status board and the pass screen hang
  -- from the outlet rather than from one station (§1.2). NOT NULL for a screen
  -- attached to a station.
  section_id    uuid references outlet_section (id) on delete cascade,
  -- Identifier position: 'grill-01', 'pass-01', 'cds-counter'. Worded in a mono chip,
  -- never translated (the owner's codes-stay-codes rule).
  code          text not null,
  name          text not null,
  kind          text not null check (kind in ('kds', 'cds', 'status', 'printer')),
  -- Printer-only: how the job leaves the platform (§4.3, S-E). NULL for a screen, which
  -- is what the constraint below enforces rather than merely documenting.
  transport     text check (transport in ('kds_hosted', 'lan_escpos', 'print_agent')),
  -- Host/port, or the print agent's id. **Never a credential** (§1.3(b)): the token
  -- lives hashed in display_credential and nowhere else.
  address       text,
  -- Falls back to outlet_section.display_locale, then site.locale (§7.5).
  locale        text,
  -- Falls back to site.timezone.
  timezone      text,
  -- O2: false in the pilot. The column exists because flipping it on must not be a
  -- migration, and PIN attribution is costed at +1-2 sessions.
  require_operator_pin boolean not null default false,
  status        text not null default 'active' check (status in ('active', 'inactive')),
  -- What the status board's "not reporting since {time}" rests on (§6.5).
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (outlet_id, code),
  -- A printer must be attached to a station (§6.6's own refusal
  -- `display.validation.printerNeedsSection`); it cannot hang off the outlet.
  constraint display_printer_has_section check (kind <> 'printer' or section_id is not null),
  -- `transport` is defined as printer-only, so a CDS row may not carry one.
  constraint display_transport_is_printer_only check (kind = 'printer' or transport is null),
  constraint display_address_needs_transport check (address is null or transport is not null)
);

comment on table display is
  'A display device: a KDS screen, a guest display, a status board or a printer. A ticket belongs to the station, never to a display (D5), so a station with two screens renders one ticket twice and never double-fires.';

-- §1.3(b)'s own index, plus the one the station screen needs to list a station's displays.
create index if not exists display_tenant_idx on display (chain_id, outlet_id, status);
create index if not exists display_section_idx on display (section_id);
-- Referenced by display_credential's composite foreign key, which is how "the credential's
-- issuance chain is the display's chain" (§1.6 item 4) becomes unrepresentable to get wrong.
create unique index if not exists display_chain_id_key on display (chain_id, id);

-- A display's station must be a station **of that same outlet**: the composite key below
-- is `outlet_section (outlet_id, id)`, so a KDS in the Koramangala restaurant cannot be
-- pointed at a section in the bar or at another chain's section. With `section_id` NULL the
-- constraint is satisfied (MATCH SIMPLE) and the display is outlet-scope, as intended.
create unique index if not exists outlet_section_outlet_id_key on outlet_section (outlet_id, id);
alter table display drop constraint if exists display_section_same_outlet_fk;
alter table display
  add constraint display_section_same_outlet_fk
  foreign key (outlet_id, section_id) references outlet_section (outlet_id, id) on delete cascade;

-- The station's printer link (§1.3(a)). Declared after `display` because it points at it.
alter table outlet_section
  add column if not exists printer_display_id uuid;
alter table outlet_section drop constraint if exists outlet_section_printer_display_fk;
alter table outlet_section
  add constraint outlet_section_printer_display_fk
  foreign key (printer_display_id) references display (id) on delete set null;

comment on column outlet_section.printer_display_id is
  'The printer display serving this station, when the station wants paper. Optional per station and never a precondition: a station without a printer works (DECISIONS.md:142).';

-- ---------------------------------------------------------------------------
-- (c) `display_credential` — how a fixed terminal proves who it is.
--
--     The precedent is `app_session` (0001:125-140): the raw token exists only in the
--     client's cookie and the database stores its **SHA-256**, so a database leak does
--     not hand over live terminals. A terminal is provisioned and revoked by a person
--     and never self-registers (O12): a `display.manage` holder issues a **single-use
--     pairing code**, the terminal redeems it once, and from then on it holds a token
--     whose digest is all the platform keeps. Re-pairing revokes the live credential in
--     the same transaction, so a device has exactly one live secret at a time.
--
--     Two columns go beyond §1.3(b)'s four-field sketch, and each is forced by a rule
--     the same spec states elsewhere:
--       * `chain_id` — §1.6 item 4 accepts a credential only when "the display's own row
--         is active and its chain matches the credential's issuance chain". That check
--         cannot be written if the issuance chain is not stored.
--       * `operating_role_code` — §2.4 item 2 says a device's audit rows carry "the
--         station's operating role code ... stored on the display's provisioning
--         record". This is that record, so the code is here and not invented at audit
--         time. It is a real role code (FK to `role.code`), which is what keeps the
--         kitchen hand mapped to Site Culinary Team instead of a new KITCHEN role.
-- ---------------------------------------------------------------------------
create table if not exists display_credential (
  id                  uuid primary key default gen_random_uuid(),
  display_id          uuid not null,
  chain_id            uuid not null references chain (id) on delete cascade,
  -- The single-use code a person reads off the screen to the terminal. Cleared the moment
  -- it is redeemed, so a database row cannot be replayed.
  pairing_code_hash   text,
  pairing_expires_at  timestamptz,
  -- The device's own secret, stored as SHA-256 like app_session.token_hash.
  token_hash          text,
  redeemed_at         timestamptz,
  operating_role_code text not null references role (code) on delete restrict,
  issued_by_user_id   uuid references "user" (id) on delete set null,
  issued_at           timestamptz not null default now(),
  revoked_at          timestamptz,
  revoked_by_user_id  uuid references "user" (id) on delete set null,
  revoke_reason       text,
  -- A provisioning row carries exactly one secret: the pairing code before redemption,
  -- the device token after it. Never both, never neither.
  constraint display_credential_one_secret
    check (num_nonnulls(pairing_code_hash, token_hash) = 1),
  constraint display_credential_pairing_expiry
    check (pairing_expires_at is null or pairing_code_hash is not null),
  constraint display_credential_redeemed
    check (redeemed_at is null or token_hash is not null),
  -- The issuance chain is the display's chain, structurally (§1.6 item 4).
  constraint display_credential_display_fk
    foreign key (chain_id, display_id) references display (chain_id, id) on delete cascade
);

comment on table display_credential is
  'One provisioning record per pairing. Both secrets are stored hashed and never in clear: the raw pairing code is shown once to the person at the terminal, and the raw device token exists only on the terminal.';

create unique index if not exists display_credential_token_key
  on display_credential (token_hash) where token_hash is not null;
create unique index if not exists display_credential_pairing_key
  on display_credential (pairing_code_hash) where pairing_code_hash is not null;
-- One live device token per display: re-pairing must revoke the previous one, not add a second.
create unique index if not exists display_credential_one_live_key
  on display_credential (display_id) where token_hash is not null and revoked_at is null;
create index if not exists display_credential_display_idx on display_credential (display_id);

-- ---------------------------------------------------------------------------
-- (d) `article_route` — the per-line routing map. Deliberately **not versioned**: it
--     carries no money figure and no compliance claim, so D6 audits it on every change
--     through the existing before/after rows instead of adding a second approval path
--     for a configuration change the Site Head owns.
-- ---------------------------------------------------------------------------
create table if not exists article_route (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  outlet_id          uuid not null references outlet (id) on delete cascade,
  article_id         uuid not null references article (id) on delete cascade,
  section_id         uuid not null references outlet_section (id) on delete cascade,
  -- Where the line appears on the ticket.
  position           integer not null default 0,
  -- The station that owns the `ready` transition when several stations make one article.
  -- The pilot uses ONE route per article (§1.4 item 5); the flag is here so a combo is a
  -- data change later rather than a migration.
  is_primary         boolean not null default true,
  created_by_user_id uuid references "user" (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (outlet_id, article_id, section_id),
  -- A route may only target a station of its own outlet.
  constraint article_route_section_same_outlet_fk
    foreign key (outlet_id, section_id) references outlet_section (outlet_id, id) on delete cascade
);

create index if not exists article_route_lookup_idx on article_route (chain_id, outlet_id, article_id);
create index if not exists article_route_section_idx on article_route (section_id);

comment on table article_route is
  'Which station produces which article, at one outlet. Resolution order and the recorded routing_source are DESIGN-kds-and-ticket-routing.md §1.4; the row is read once per line at fire and never re-read for a ticket that already exists (D4).';

-- One primary station per (article, outlet). §1.4 item 5 requires a second one to be
-- refused **with a sentence naming the conflict** (`route.validation.duplicatePrimary`, a
-- validation refusal that writes nothing) — that refusal is the domain layer's, in
-- src/domain/display-routing.ts. This index is the backstop behind it: no code path, and
-- no future bulk import, can produce two primary routes by accident.
create unique index if not exists article_route_one_primary_key
  on article_route (outlet_id, article_id) where is_primary;

-- ---------------------------------------------------------------------------
-- (e) `route_default` — one row means "this category goes there unless an article route
--     says otherwise". O9 chose this table over a column on `outlet_section`, and it is
--     what keeps a 52-article demo from needing 52 route rows, which is what makes the
--     unrouted case rare enough to be treated as the exception it is.
-- ---------------------------------------------------------------------------
create table if not exists route_default (
  id                  uuid primary key default gen_random_uuid(),
  chain_id            uuid not null references chain (id) on delete cascade,
  outlet_id           uuid not null references outlet (id) on delete cascade,
  article_category_id uuid not null references article_category (id) on delete cascade,
  section_id          uuid not null references outlet_section (id) on delete cascade,
  created_at          timestamptz not null default now(),
  unique (outlet_id, article_category_id),
  constraint route_default_section_same_outlet_fk
    foreign key (outlet_id, section_id) references outlet_section (outlet_id, id) on delete cascade
);

-- A category default resolves to exactly one station, so there is no `is_primary` here:
-- the uniqueness above is the whole rule.
create index if not exists route_default_lookup_idx on route_default (chain_id, outlet_id);

comment on table route_default is
  'The category-to-station default used when an article has no route of its own (§1.4 item 2). Empty for an outlet means the resolution has no second step and falls to the pass, flagged unrouted — never guessed.';
