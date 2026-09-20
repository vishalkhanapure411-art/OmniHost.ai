-- OmniHost.ai — migration 0008: Phase 1 master data, part 2 — the masters
-- ---------------------------------------------------------------------------
-- Authority: docs/design/phase-1-mdm-spec.md Part I §7–§9, §12 and Part II §21.
-- Everything in Part II is *additive*: no Part I field changes type or meaning. The ERP
-- columns exist as real columns from day one because that is cheap now and a data
-- migration later, and because it is what makes "the integration is configurable" true
-- rather than aspirational. No connector, no sync runtime, no ERP admin screen is built
-- here — a chain with no ERP is the normal case, not a degraded one.
--
-- Three modelling decisions are stated here because they are where a reader will look:
--
--   1. **`measureUnit` is stored as value + unit, not value + unit + dimension.** §21's
--      type is `{ value, uomCode, dimension }`. The dimension is a property of the unit,
--      so carrying it a second time on the record would create two sources of truth for
--      one fact — the exact failure mode §22.4 is written to prevent. The column pairs
--      below therefore hold (value, uom_id) and the dimension is read from `uom`.
--
--   2. **A version is a row, and only the identity is not versioned.** §7.3: a version is
--      immutable once active or superseded, editing an active article opens a new draft
--      version, and an order line pins `articleVersionId` so a historical bill keeps the
--      figures it was sold under. `article` therefore holds the stable identity (chain,
--      code, category, the mirror bookkeeping) and `article_version` holds everything a
--      change can touch. `article.status` is the record's current lifecycle state;
--      `article_version.status` is that version's.
--
--   3. **`variantOf` / `variantAxes` (§21.1) is deliberately NOT built.** §26.3 item 3
--      says it is proposed rather than specified, that it changes the article's identity
--      model (a variant is a record that inherits) and that it needs a design pass before
--      an engineer builds it. Implementing a half-designed identity model now would be
--      the expensive mistake, so it is left out and flagged in the Phase 1 report.

-- ===========================================================================
-- ARTICLE (§7.1, §7.3, §21.1)
-- ===========================================================================
create table if not exists article (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  code          text not null,                     -- business key: chain-unique, the key a URL, an import and an audit row use
  category_id   uuid not null references article_category (id) on delete restrict,
  article_type  text not null check (article_type in ('food', 'beverage', 'retail', 'service')),
  -- The record's lifecycle (§7.1 / §6). `seasonal` replaces the PRD's "marked unavailable"
  -- at the *record* level; the immediate per-outlet availability change is a row in
  -- article_availability and does not create a version (§7.2 item 6).
  status        text not null default 'draft'
                check (status in ('draft', 'pending_review', 'active', 'seasonal', 'discontinued')),
  current_version_id uuid,                         -- FK added after article_version exists (circular by design)
  base_uom_id   uuid not null references uom (id) on delete restrict,
  external_ref  text,                              -- §16 item 2: the chain's own id from whatever system they migrated off
  source_system text,

  -- §21.1 — the ERP's own attributes, mirrored. Never merged into our status (§22.5).
  material_type_code  text,
  material_group_id   uuid references erp_code_map (id) on delete set null,
  erp_lifecycle_state_code text,
  erp_lifecycle_state_label_key text,
  erp_blocked         boolean not null default false,
  erp_blocked_reason  text,
  net_weight_value    numeric(18,6), net_weight_uom_id   uuid references uom (id) on delete restrict,
  gross_weight_value  numeric(18,6), gross_weight_uom_id uuid references uom (id) on delete restrict,
  tare_weight_value   numeric(18,6), tare_weight_uom_id  uuid references uom (id) on delete restrict,
  volume_value        numeric(18,6), volume_uom_id       uuid references uom (id) on delete restrict,
  length_value        numeric(18,6), length_uom_id       uuid references uom (id) on delete restrict,
  width_value         numeric(18,6), width_uom_id        uuid references uom (id) on delete restrict,
  height_value        numeric(18,6), height_uom_id       uuid references uom (id) on delete restrict,
  storage_condition_code text,
  temperature_condition text check (temperature_condition in
                        ('unregulated', 'ambient', 'chilled', 'frozen', 'deep_frozen')),
  -- Three different figures with three different meanings; the UI labels each and never
  -- sums them (§21.1).
  shelf_life_days               integer,
  total_shelf_life_days         integer,
  min_remaining_shelf_life_days integer,
  batch_management    text check (batch_management in ('none', 'optional', 'required')),
  serial_profile_code text,
  receipt_inspection_required boolean, certificate_required boolean, shelf_life_check boolean,
  authorisation_group_code    text,
  valuation_class_code        text,
  price_control       text check (price_control in ('standard', 'moving_average')),
  -- The ERP's valuation prices. NOT our standardCost (§21.1): read-only here, and a
  -- divergence is a report rather than a silent overwrite.
  standard_price_amount        numeric(18,4), standard_price_currency        char(3),
  moving_average_price_amount  numeric(18,4), moving_average_price_currency  char(3),
  erp_tax_classification_code  text, erp_tax_group text, erp_tax_jurisdiction_code text,
  country_of_origin   char(2),                     -- ISO 3166-1 alpha-2; not the HSN/SAC code
  customs_tariff_number text, export_control_class text,
  manufacturer_name   text, manufacturer_part_number text,
  revision_level      text, change_notice_id uuid references erp_change_notice (id) on delete set null,

  -- erpAdmin (§21.1, §22.2) — the mirror bookkeeping, rendered as the provenance chip,
  -- never as an editable field. These three columns plus the external_key rows are the
  -- whole of it; there is no JSONB blob (§26.2 D1).
  erp_source_version  text,
  erp_last_sync_at    timestamptz,
  erp_mirror_hash     text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (chain_id, code)
);
create index if not exists article_chain_status_idx on article (chain_id, status);
create index if not exists article_category_idx on article (category_id);
create index if not exists article_code_lower_idx on article (chain_id, lower(code));

-- The versioned half. `(article_id, version)` is the version identity (§7.3).
create table if not exists article_version (
  id                  uuid primary key default gen_random_uuid(),
  chain_id            uuid not null references chain (id) on delete cascade,
  article_id          uuid not null references article (id) on delete cascade,
  version             integer not null check (version >= 1),
  status              text not null default 'draft'
                      check (status in ('draft', 'pending_review', 'active', 'superseded', 'discontinued')),
  -- The default (chain default-locale) values. The per-locale set is article_version_text.
  dietary_mark        text check (dietary_mark in ('veg', 'non_veg', 'egg', 'vegan', 'none')),
  tax_class_id        uuid references tax_class (id) on delete restrict,
  hsn_sac_code        text,
  serving_size_qty    numeric(18,6),
  serving_size_uom_id uuid references uom (id) on delete restrict,
  calories_kcal       numeric(9,2),                -- per serving
  -- A set, so it is an array rather than a child table: channels carry no attributes.
  channel_flags       text[] not null default array[]::text[],
  -- §7.1: the recipe reference exists in Phase 1 so Phase 2 fills it. No FK yet — there
  -- is no recipe table, and inventing a stub one would be worse than an honest gap.
  recipe_id           uuid,
  recipe_version_pin  integer,
  effective_from      date,                        -- the selling date claimed
  approved_at         timestamptz,                 -- when it was actually approved: the difference is what an audit asks
  approved_by_user_id uuid references "user" (id) on delete set null,
  -- §14: an article that became incomplete after a profile change can reach `active` only
  -- by an explicit, audited override with a reason.
  compliance_override boolean not null default false,
  compliance_override_reason text,
  created_by_user_id  uuid references "user" (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (article_id, version),
  constraint article_version_override_reason
    check (not compliance_override or length(btrim(coalesce(compliance_override_reason, ''))) > 0)
);
create index if not exists article_version_article_idx on article_version (article_id, version desc);
create index if not exists article_version_status_idx on article_version (chain_id, status);

alter table article
  drop constraint if exists article_current_version_fk;
alter table article
  add constraint article_current_version_fk
  foreign key (current_version_id) references article_version (id) on delete set null;

-- Per-locale content (§7.1: name / shortName / description / ingredientDeclaration).
-- One row per locale; the chain's default locale is required, and a missing locale is
-- rendered with an `untranslated` marker rather than silently falling back in the data.
create table if not exists article_version_text (
  chain_id       uuid not null references chain (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  locale         text not null,
  name           text not null,
  short_name     text,
  description    text,
  ingredient_declaration text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (article_version_id, locale)
);
create index if not exists article_version_text_name_idx on article_version_text (chain_id, lower(name));

-- The per-jurisdiction sub-grid (§7.4). A row that does not override shows `inherited`,
-- which is why `overrides` records which fields the row actually sets instead of leaving
-- a reviewer to infer it from a NULL.
create table if not exists article_version_jurisdiction (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  jurisdiction_code  text not null references jurisdiction (code) on delete restrict,
  tax_class_id       uuid references tax_class (id) on delete restrict,
  hsn_sac_code       text,
  calories_kcal      numeric(9,2),
  serving_size_qty   numeric(18,6),
  serving_size_uom_id uuid references uom (id) on delete restrict,
  nutrition_basis    text,
  overrides          text[] not null default array[]::text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (article_version_id, jurisdiction_code)
);

-- Per-outlet price (§7.1). A price change is a *financial* action
-- (mdm.article.price.update) and creates a new version, so these rows hang off the
-- version: a version's prices are immutable, which is what keeps a historical bill
-- reproducible. Currency is the outlet's site currency and is stored with the amount.
create table if not exists article_price (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  article_id         uuid not null references article (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  outlet_id          uuid not null references outlet (id) on delete cascade,
  amount             numeric(18,4) not null,
  currency_code      char(3) not null,
  effective_from     date not null default current_date,
  effective_to       date,
  created_by_user_id uuid references "user" (id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint article_price_window check (effective_to is null or effective_to >= effective_from)
);
create index if not exists article_price_version_idx on article_price (article_version_id, outlet_id);
create index if not exists article_price_article_idx on article_price (chain_id, article_id);
-- One open price per (version, outlet): two open prices is two answers to one question.
create unique index if not exists article_price_open_key
  on article_price (article_version_id, outlet_id) where effective_to is null;

-- Per-outlet availability (§7.1). NOT versioned: marking a dish unavailable takes effect
-- immediately, is audited, and is reversible (§7.2 item 6).
create table if not exists article_availability (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  article_id    uuid not null references article (id) on delete cascade,
  outlet_id     uuid not null references outlet (id) on delete cascade,
  availability  text not null default 'available'
                check (availability in ('available', 'seasonal', 'unavailable')),
  reason        text,
  -- 'user' today; Phase 3's automatic stock-out writes 'system' into the same surface.
  source        text not null default 'user' check (source in ('user', 'system')),
  updated_by_user_id uuid references "user" (id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (article_id, outlet_id)
);

-- Declared versus derived (§7.1). A derived entry is read-only and points at what it was
-- derived from, so nobody can "fix" a roll-up by hand.
create table if not exists article_version_allergen (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  allergen_id        uuid not null references allergen (id) on delete restrict,
  may_contain        boolean not null default false,
  source             text not null default 'declared' check (source in ('declared', 'derived')),
  -- FK declared at the end of this file: raw_material is created below, and PostgreSQL
  -- requires the referenced table to exist when the constraint is written.
  derived_from_raw_material_id uuid,
  created_at         timestamptz not null default now(),
  unique (article_version_id, allergen_id)
);

create table if not exists article_version_nutrient (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  nutrient_id        uuid not null references nutrient (id) on delete restrict,
  value              numeric(12,4) not null,
  basis              text not null,                -- 'per_100g' | 'per_100ml' | 'per_serving'
  created_at         timestamptz not null default now(),
  unique (article_version_id, nutrient_id, basis)
);

create table if not exists article_version_image (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chain (id) on delete cascade,
  article_version_id uuid not null references article_version (id) on delete cascade,
  asset_id           uuid not null references asset (id) on delete cascade,
  position           integer not null default 0,
  is_primary         boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (article_version_id, asset_id)
);
create unique index if not exists article_version_image_primary_key
  on article_version_image (article_version_id) where is_primary;

-- A barcode is a set, one primary (§21.1): a single `barcode` column would have to be
-- migrated the first time a second packaging level appears.
create table if not exists article_barcode (
  id         uuid primary key default gen_random_uuid(),
  chain_id   uuid not null references chain (id) on delete cascade,
  article_id uuid not null references article (id) on delete cascade,
  scheme     text not null check (scheme in ('gtin', 'ean', 'upc', 'internal')),
  value      text not null,
  uom_id     uuid references uom (id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (chain_id, scheme, value)
);

-- ===========================================================================
-- RAW MATERIAL (§8.1, §21.2) — the base figures every recipe costs against
-- ===========================================================================
create table if not exists raw_material (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  code          text not null,
  category_id   uuid not null references raw_material_category (id) on delete restrict,
  base_uom_id   uuid not null references uom (id) on delete restrict,   -- canonical unit for stock and recipes
  pack_uom_id   uuid references uom (id) on delete restrict,            -- how it is bought (a 25 kg sack); a vendor item may differ
  pack_qty      numeric(18,6),
  trim_yield_pct numeric(7,4),                                          -- prep loss; a recipe line may override it
  shelf_life_days integer,
  shelf_life_basis text check (shelf_life_basis in ('ambient', 'chilled', 'frozen', 'dry')),
  storage_type  text not null
                check (storage_type in ('ambient', 'chilled', 'frozen', 'deep_frozen', 'dry', 'bar')),
  -- Stored in Celsius as canon; the DISPLAY unit is a chain/locale preference, because a
  -- UK site reads °F for a chiller and the same record must not change value when a
  -- screen does (§8.1).
  storage_temp_min_c numeric(5,2), storage_temp_max_c numeric(5,2),
  track_stock   boolean not null default true,
  status        text not null default 'draft'
                check (status in ('draft', 'pending_review', 'active', 'inactive')),
  external_ref  text, source_system text,

  -- §21.2
  material_type_code text,
  material_group_id  uuid references erp_code_map (id) on delete set null,
  storage_condition_code text,
  temperature_condition text check (temperature_condition in
                        ('unregulated', 'ambient', 'chilled', 'frozen', 'deep_frozen')),
  storage_bin_code   text,
  total_shelf_life_days integer, min_remaining_shelf_life_days integer,
  batch_management   text check (batch_management in ('none', 'optional', 'required')),
  serial_profile_code text,
  receipt_inspection_required boolean, certificate_required boolean, shelf_life_check boolean,
  authorisation_group_code text,
  valuation_class_code text,
  price_control      text check (price_control in ('standard', 'moving_average')),
  standard_price_amount       numeric(18,4), standard_price_currency       char(3),
  moving_average_price_amount numeric(18,4), moving_average_price_currency char(3),
  erp_tax_classification_code text, erp_tax_group text, erp_tax_jurisdiction_code text,
  country_of_origin  char(2), customs_tariff_number text, export_control_class text,
  manufacturer_name  text, manufacturer_part_number text,
  hazard_class_code  text, transport_notes text,        -- never shown to a guest surface
  revision_level     text, change_notice_id uuid references erp_change_notice (id) on delete set null,
  erp_blocked        boolean not null default false, erp_blocked_reason text,
  net_weight_value   numeric(18,6), net_weight_uom_id   uuid references uom (id) on delete restrict,
  gross_weight_value numeric(18,6), gross_weight_uom_id uuid references uom (id) on delete restrict,
  volume_value       numeric(18,6), volume_uom_id       uuid references uom (id) on delete restrict,
  length_value       numeric(18,6), length_uom_id       uuid references uom (id) on delete restrict,
  width_value        numeric(18,6), width_uom_id        uuid references uom (id) on delete restrict,
  height_value       numeric(18,6), height_uom_id       uuid references uom (id) on delete restrict,
  -- Purchasing defaults (§21.2). Phase 3 reads them; the vendor item's own moq/lead time
  -- override, and the UI says which won.
  purchasing_order_uom_id      uuid references uom (id) on delete restrict,
  purchasing_order_to_base_factor numeric(24,12),
  purchasing_rounding_value    numeric(18,6),
  purchasing_min_order_qty     numeric(18,6),
  over_delivery_pct            numeric(7,4),
  under_delivery_pct           numeric(7,4),
  planned_delivery_days        integer, gr_processing_days integer,
  reorder_point_qty numeric(18,6), reorder_point_uom_id uuid references uom (id) on delete restrict,
  safety_stock_qty  numeric(18,6), safety_stock_uom_id  uuid references uom (id) on delete restrict,
  erp_source_version text, erp_last_sync_at timestamptz, erp_mirror_hash text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (chain_id, code)
);
-- Forward reference resolved here: article_version_allergen above points at raw_material,
-- which is created after it in this file, so the FK is added now that both exist.
create index if not exists raw_material_chain_status_idx on raw_material (chain_id, status);
create index if not exists raw_material_code_lower_idx on raw_material (chain_id, lower(code));

create table if not exists raw_material_text (
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  locale          text not null,
  name            text not null,
  organic_declaration text,                        -- on-request in India, label-mandatory in the EU (§8.1)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (raw_material_id, locale)
);

-- Standard cost, effective-dated (§8.2): the previous row is closed and a new one opens,
-- so COGS history stays reproducible.
create table if not exists raw_material_cost (
  id               uuid primary key default gen_random_uuid(),
  chain_id         uuid not null references chain (id) on delete cascade,
  raw_material_id  uuid not null references raw_material (id) on delete cascade,
  amount           numeric(18,4) not null,
  currency_code    char(3) not null,               -- the cost currency, recorded explicitly (§8.4)
  cost_source      text not null
                   check (cost_source in ('vendor_item', 'quote', 'manual', 'last_grn')),
  per_qty          numeric(18,6) not null default 1,
  per_uom_id       uuid not null references uom (id) on delete restrict,
  effective_from   date not null default current_date,
  effective_to     date,
  created_by_user_id uuid references "user" (id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint raw_material_cost_window check (effective_to is null or effective_to >= effective_from)
);
create unique index if not exists raw_material_cost_open_key
  on raw_material_cost (raw_material_id) where effective_to is null;
create index if not exists raw_material_cost_material_idx on raw_material_cost (raw_material_id, effective_from desc);

-- The approved-vendor sub-grid (§8.1). `last_price` is money with its OWN currency and
-- date, and it never silently becomes the standard cost.
create table if not exists raw_material_supplier (
  id               uuid primary key default gen_random_uuid(),
  chain_id         uuid not null references chain (id) on delete cascade,
  raw_material_id  uuid not null references raw_material (id) on delete cascade,
  vendor_id        uuid not null,                  -- FK to vendor declared at the end of this file
  vendor_item_code text,
  vendor_uom_id    uuid references uom (id) on delete restrict,
  vendor_pack_qty  numeric(18,6),
  last_price_amount   numeric(18,4), last_price_currency char(3), last_price_on date,
  lead_time_days   integer,
  moq_qty          numeric(18,6), moq_uom_id uuid references uom (id) on delete restrict,
  preferred        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (raw_material_id, vendor_id)
);
create unique index if not exists raw_material_supplier_preferred_key
  on raw_material_supplier (raw_material_id) where preferred;

create table if not exists raw_material_allergen (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  allergen_id     uuid not null references allergen (id) on delete restrict,
  may_contain     boolean not null default false,
  source          text not null default 'declared' check (source in ('declared', 'derived')),
  created_at      timestamptz not null default now(),
  unique (raw_material_id, allergen_id)
);

create table if not exists raw_material_nutrient (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  nutrient_id     uuid not null references nutrient (id) on delete restrict,
  value           numeric(12,4) not null,
  basis           text not null,
  created_at      timestamptz not null default now(),
  unique (raw_material_id, nutrient_id, basis)
);

-- Phase 1 stores the value so Phase 3's indenting has an input; nothing posts from here.
create table if not exists raw_material_par_level (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  site_id         uuid not null references site (id) on delete cascade,
  qty             numeric(18,6) not null,
  uom_id          uuid not null references uom (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  unique (raw_material_id, site_id)
);

-- §21.2: alternativeUoms IMPORT INTO §10.2's conversion model — one conversion table in
-- the system, not two. The extra columns here are what an export needs to rebuild the
-- ERP's own view of which unit is the order unit.
create table if not exists raw_material_alternative_uom (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  uom_id          uuid not null references uom (id) on delete restrict,
  numerator       numeric(24,12),
  denominator     numeric(24,12),
  base_qty_equivalent numeric(18,6),
  category        text check (category in ('order', 'issue', 'stockkeeping', 'price')),
  ean_upc         text,
  valid_from      date,
  valid_to        date,
  created_at      timestamptz not null default now()
);
create index if not exists raw_material_alternative_uom_idx
  on raw_material_alternative_uom (raw_material_id, uom_id, valid_from desc);

create table if not exists raw_material_barcode (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  raw_material_id uuid not null references raw_material (id) on delete cascade,
  scheme          text not null check (scheme in ('gtin', 'ean', 'upc', 'internal')),
  value           text not null,
  uom_id          uuid references uom (id) on delete restrict,
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (chain_id, scheme, value)
);

-- ===========================================================================
-- VENDOR (§9.1, §21.3)
-- ===========================================================================
create table if not exists vendor (
  id              uuid primary key default gen_random_uuid(),
  chain_id        uuid not null references chain (id) on delete cascade,
  code            text not null,
  legal_name      text not null,                   -- the invoicing party; never translated
  vendor_type     text not null
                  check (vendor_type in ('manufacturer', 'distributor', 'wholesaler', 'importer', 'service', 'logistics')),
  status          text not null default 'proposed'
                  check (status in ('proposed', 'active', 'suspended', 'inactive')),
  -- Structured, not a free-text blob: an invoice address has to print per market and be
  -- validated, which a blob cannot be (§9.1).
  address_line1   text, address_line2 text, address_locality text,
  address_region  text, address_postal_code text, address_country_code char(2),
  billing_currency char(3) not null,
  payment_terms_kind text check (payment_terms_kind in ('net_days', 'eom', 'cod', 'prepaid')),
  payment_terms_days integer,
  credit_limit_amount numeric(18,4), credit_limit_currency char(3),
  -- Masked in every read; the full value requires mdm.vendor.bank.view, audited per reveal.
  remittance_method        text,
  remittance_bank_name     text,
  remittance_account_name  text,
  remittance_account_masked text,
  remittance_ifsc_swift    text,
  remittance_iban          text,
  remittance_upi_id        text,
  lead_time_days  integer,
  moq_qty         numeric(18,6), moq_uom_id uuid references uom (id) on delete restrict,
  -- Set when MDM merges a duplicate: the merged record is deactivated with reason
  -- `merged` and links forward, so an old PO still resolves (§9.1).
  duplicate_of_vendor_id uuid references vendor (id) on delete set null,
  deactivation_reason text,
  external_ref text, source_system text,

  -- §21.3
  erp_account_group_code text,                     -- mapped to our vendor_type in config; both are shown, ours is editable
  erp_tax_classification text, erp_withholding_tax_type text,
  erp_withholding_tax_code text, erp_tax_jurisdiction_code text,
  erp_blocked boolean not null default false, erp_deletion_flag boolean not null default false,
  erp_blocked_reason text,                         -- raises erpBlockedUpstream, never a silent suspension
  incoterms_code text, incoterms_location text,
  erp_source_version text, erp_last_sync_at timestamptz, erp_mirror_hash text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (chain_id, code)
);
create index if not exists vendor_chain_status_idx on vendor (chain_id, status);
create index if not exists vendor_legal_name_lower_idx on vendor (chain_id, lower(legal_name));

create table if not exists vendor_text (
  chain_id  uuid not null references chain (id) on delete cascade,
  vendor_id uuid not null references vendor (id) on delete cascade,
  locale    text not null,
  trade_name text not null,                        -- the name the kitchen uses
  primary key (vendor_id, locale)
);

-- THIS is the international design point (§9.1): India needs one GSTIN, the UAE a TRN,
-- Germany a USt-IdNr./Steuernummer, and a chain may hold a vendor registered in two. A
-- single `gstin` column would have to be migrated the first time a non-India chain is
-- onboarded — so the scheme is a reference row and the value hangs off it, with its own
-- verification date and who verified it.
create table if not exists vendor_tax_registration (
  id               uuid primary key default gen_random_uuid(),
  chain_id         uuid not null references chain (id) on delete cascade,
  vendor_id        uuid not null references vendor (id) on delete cascade,
  jurisdiction_code text not null references jurisdiction (code) on delete restrict,
  scheme_code      text not null,
  value            text not null,
  verified_at      timestamptz,
  verified_by_user_id uuid references "user" (id) on delete set null,
  status           text not null default 'active' check (status in ('active', 'retired')),
  created_at       timestamptz not null default now(),
  unique (vendor_id, jurisdiction_code, scheme_code, value)
);
create index if not exists vendor_tax_registration_value_idx
  on vendor_tax_registration (chain_id, scheme_code, upper(btrim(value)));

create table if not exists vendor_contact (
  id        uuid primary key default gen_random_uuid(),
  chain_id  uuid not null references chain (id) on delete cascade,
  vendor_id uuid not null references vendor (id) on delete cascade,
  kind      text not null check (kind in ('ordering', 'accounts', 'escalation', 'general')),
  name      text not null,
  email     text, phone text,
  locale    text,                                  -- the contact's language for generated documents
  preferred boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists vendor_contact_vendor_idx on vendor_contact (vendor_id);

-- An expiry is surfaced on the list as "expiring in {days}": a compliance date that
-- lapses silently is the failure this table exists to prevent (§9.1).
create table if not exists vendor_document (
  id        uuid primary key default gen_random_uuid(),
  chain_id  uuid not null references chain (id) on delete cascade,
  vendor_id uuid not null references vendor (id) on delete cascade,
  kind      text not null,                         -- 'fssai_licence' | 'gst_certificate' | 'insurance' | ...
  reference text,
  issued_on date, expires_on date,
  asset_id  uuid references asset (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists vendor_document_expiry_idx on vendor_document (chain_id, expires_on);

create table if not exists vendor_category (
  chain_id    uuid not null references chain (id) on delete cascade,
  vendor_id   uuid not null references vendor (id) on delete cascade,
  category_id uuid not null references raw_material_category (id) on delete cascade,
  primary key (vendor_id, category_id)
);

-- Which ERP company codes this vendor is extended to. Empty means "not yet extended",
-- stated as such rather than as "all" (§21.3).
create table if not exists vendor_legal_entity (
  chain_id  uuid not null references chain (id) on delete cascade,
  vendor_id uuid not null references vendor (id) on delete cascade,
  code      text not null,
  primary key (vendor_id, code)
);

-- ===========================================================================
-- SITE and OUTLET masters (§12.1, §12.2, §21.6) — extending what exists
-- ===========================================================================
-- The PRD's "assigned license tier" on the site record contradicts the owner's locked
-- decision that licence tier is per chain. The plan wins: there is NO tier column here,
-- no per-site feature gating anywhere, and the site screen displays the chain's tier
-- read-only with a link to the chain record. That is the deviation the lead asked to be
-- flagged, and it is flagged again in the Phase 1 report.
alter table site add column if not exists jurisdiction_code       text references jurisdiction (code) on delete restrict;
alter table site add column if not exists currency                char(3);
alter table site add column if not exists service_modes           text[] not null default array['dine_in']::text[];
alter table site add column if not exists external_ref            text;
alter table site add column if not exists source_system           text;
alter table site add column if not exists closure_reason          text;
-- §21.6
alter table site add column if not exists erp_tax_jurisdiction_code text;
alter table site add column if not exists erp_company_code          text;
alter table site add column if not exists erp_source_version        text;
alter table site add column if not exists erp_last_sync_at          timestamptz;
alter table site add column if not exists erp_mirror_hash           text;

-- `onboarding` and `suspended` are added to the existing active/closed pair; `closed` is
-- the terminal state and there is no delete (§12.1).
alter table site drop constraint if exists site_status_check;
alter table site add constraint site_status_check
  check (status in ('onboarding', 'active', 'suspended', 'closed'));

-- §12.2's outlet kinds. `kitchen` is kept because migration 0001 allowed it and a chain
-- may already hold one; the list is additive, never a rename.
alter table outlet drop constraint if exists outlet_kind_check;
alter table outlet add constraint outlet_kind_check
  check (kind in ('restaurant', 'bar', 'qsr', 'kiosk', 'cloud_kitchen', 'hotel_outlet',
                  'banquet', 'room_service', 'kitchen'));
alter table outlet add column if not exists service_modes   text[] not null default array['dine_in']::text[];
alter table outlet add column if not exists external_ref    text;
alter table outlet add column if not exists source_system   text;
alter table outlet add column if not exists closure_reason  text;
alter table outlet add column if not exists erp_source_version text;
alter table outlet add column if not exists erp_last_sync_at   timestamptz;
alter table outlet drop constraint if exists outlet_status_check;
alter table outlet add constraint outlet_status_check
  check (status in ('onboarding', 'active', 'suspended', 'closed'));

-- The site holds the opening-hours pattern; an outlet overrides it (§12.1). Rendered in
-- the site's zone with the zone named, which is why the zone is not stored here.
create table if not exists site_operating_hours (
  id         uuid primary key default gen_random_uuid(),
  chain_id   uuid not null references chain (id) on delete cascade,
  site_id    uuid not null references site (id) on delete cascade,
  outlet_id  uuid references outlet (id) on delete cascade,   -- NULL = the site's own pattern
  day_of_week integer not null check (day_of_week between 0 and 6),
  opens_at   time, closes_at time,
  closed     boolean not null default false,
  note       text,
  created_at timestamptz not null default now(),
  unique (site_id, outlet_id, day_of_week)
);
create index if not exists site_operating_hours_site_idx on site_operating_hours (site_id);

-- §21.6: the many-to-many site↔plant map lives here, not as a single `plant` column. A
-- site with a bar and a kitchen maps to two plants and says which one is primary.
create table if not exists site_erp_org_unit (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  site_id       uuid not null references site (id) on delete cascade,
  outlet_id     uuid references outlet (id) on delete cascade,   -- set where the ERP is outlet-granular
  system_id     uuid not null references erp_system (id) on delete cascade,
  org_unit_type text not null check (org_unit_type in
                ('company_code', 'plant', 'storage_location', 'warehouse', 'sales_org', 'channel')),
  erp_code      text not null,
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (chain_id, system_id, org_unit_type, erp_code)
);
create index if not exists site_erp_org_unit_site_idx on site_erp_org_unit (site_id);

-- ---------------------------------------------------------------------------
-- outlet_section — a production/station area inside an outlet.
-- SPEC-GAP, and flagged as one: the display topology (KDS/CDS/KOT routing, "routing is
-- decided per product line, not per order") is its own spec, scheduled after this slab,
-- and it is where sections become first-class. This slab needs sections only because the
-- demo dataset has to hang the outlets on something the kitchen recognises, so the table
-- is deliberately minimal — code, name and kind — and the display spec extends it rather
-- than replacing it. Nothing else in the schema references it yet.
-- ---------------------------------------------------------------------------
create table if not exists outlet_section (
  id         uuid primary key default gen_random_uuid(),
  chain_id   uuid not null references chain (id) on delete cascade,
  site_id    uuid not null references site (id) on delete cascade,
  outlet_id  uuid not null references outlet (id) on delete cascade,
  code       text not null,
  name       text not null,
  kind       text not null
             check (kind in ('kitchen', 'bar', 'grill', 'cold', 'bakery', 'dessert', 'beverage', 'expedite', 'other')),
  sort_order integer not null default 0,
  status     text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, code)
);
create index if not exists outlet_section_outlet_idx on outlet_section (outlet_id);

-- ---------------------------------------------------------------------------
-- The two forward references this file cannot declare inline, because the referenced
-- table is created later in the same file. Declared here so the constraints exist rather
-- than being quietly dropped.
-- ---------------------------------------------------------------------------
alter table article_version_allergen drop constraint if exists article_version_allergen_raw_material_fk;
alter table article_version_allergen
  add constraint article_version_allergen_raw_material_fk
  foreign key (derived_from_raw_material_id) references raw_material (id) on delete set null;

alter table raw_material_supplier drop constraint if exists raw_material_supplier_vendor_fk;
alter table raw_material_supplier
  add constraint raw_material_supplier_vendor_fk
  foreign key (vendor_id) references vendor (id) on delete cascade;
