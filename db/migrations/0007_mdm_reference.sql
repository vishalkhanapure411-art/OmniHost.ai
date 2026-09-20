-- OmniHost.ai — migration 0007: Phase 1 master data, part 1 — reference data + ERP identity
-- ---------------------------------------------------------------------------
-- Authority: docs/design/phase-1-mdm-spec.md Part I §10–§14 and Part II §22.
-- Field names, types and the scope of each reference list follow that document; where a
-- judgement was needed it is stated in a comment at the point of the decision.
--
-- Two shapes recur below and are worth naming once:
--
--   * **Platform rows are chain-less.** A jurisdiction, a tax regime, an allergen or the
--     curated UOM set is the *platform's* vocabulary (a market's law, or a unit the
--     platform recognises), not a tenant's data — the same reasoning migration 0002 uses
--     for `role`/`permission` and 0004 for `feature`. Where a chain may also add its own
--     entry (a chain UOM, a chain-only allergen, a tax class) the table carries a
--     nullable `chain_id`: NULL = platform row, set = that chain's row. Two partial
--     unique indexes then enforce "unique per chain" without making the platform rows
--     collide with each other.
--
--   * **Effective-dating is rows, never an edit in place.** A tax rate, a UOM conversion
--     factor, a raw-material cost and an ERP code map all close their current row
--     (`effective_to` = day before the new `effective_from`) and open a new one. The
--     spec's reason is one sentence and it is the reason this is not negotiable: a
--     historical bill and its COGS have to stay reproducible.
--
-- Tenant isolation follows the existing convention: every tenant-scoped table carries
-- `chain_id`, and every query is scoped server-side in src/domain/. Row-level security is
-- deliberately NOT switched on for these tables — the Phase 0 tables do not use it either,
-- and a policy that only some tables carry is a worse guarantee than the consistent
-- application-layer scoping this codebase actually enforces. Raised as an open item in the
-- Phase 1 report.
--
-- Money is always amount + ISO currency code, never a bare number (§8.4). Quantity is
-- numeric(18,6) and never travels without its unit (§22.6). Percentages are numeric(7,4)
-- *per cent*, not a fraction.

-- ---------------------------------------------------------------------------
-- jurisdiction — a market. The *name* is never stored: it comes from
-- Intl.DisplayNames on country_code, because a catalog will not carry the market that
-- gets onboarded next quarter (§4).
-- ---------------------------------------------------------------------------
create table if not exists jurisdiction (
  code                text primary key,            -- 'IN', 'IN-KA', 'AE', 'DE', 'GB', 'US'
  country_code        char(2) not null,            -- ISO 3166-1 alpha-2
  subdivision_code    text,                        -- ISO 3166-2 subdivision, when the market is sub-national
  default_currency    char(3) not null,            -- ISO 4217
  default_time_zone   text not null,               -- IANA zone
  default_locale      text not null,
  default_tax_regime  text,                        -- soft reference to tax_regime.code
  status              text not null default 'active' check (status in ('active', 'retired')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tax_regime — a market's *system* of taxation (§11.1). Curated at the app layer: a
-- chain selects a regime, it does not write a market's law. GST is the first row, not
-- the shape of the table.
-- ---------------------------------------------------------------------------
create table if not exists tax_regime (
  code                     text primary key,       -- 'IN_GST', 'AE_VAT', 'EU_VAT', 'GB_VAT', 'US_SALES_TAX', 'NONE'
  label_key                text not null,          -- catalog key; the regime code itself is never translated
  jurisdiction_code        text not null references jurisdiction (code) on delete restrict,
  level                    text not null check (level in ('national', 'subnational', 'local')),
  inclusive_default        boolean not null default false,
  price_display_convention text not null default 'additive'
                           check (price_display_convention in ('additive', 'inclusive', 'either')),
  status                   text not null default 'active' check (status in ('active', 'retired')),
  effective_from           date not null default current_date,
  effective_to             date,
  created_at               timestamptz not null default now(),
  constraint tax_regime_window check (effective_to is null or effective_to >= effective_from)
);
create index if not exists tax_regime_jurisdiction_idx on tax_regime (jurisdiction_code);

-- ---------------------------------------------------------------------------
-- tax_registration_scheme — the registration number shape a market uses (§11.1).
-- Used by vendors (§9.1) and, where a market requires it, by a chain's own
-- registration on the chain record (Phase 0 territory; not re-specified here).
-- ---------------------------------------------------------------------------
create table if not exists tax_registration_scheme (
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  scheme_code       text not null,                 -- 'GSTIN', 'TRN', 'VAT_NO', 'UST_ID', 'EIN'
  label_key         text not null,
  pattern           text,                          -- a display/validation hint, not a substitute for a server check
  applies_to        text[] not null default array['vendor']::text[],
  status            text not null default 'active' check (status in ('active', 'retired')),
  created_at        timestamptz not null default now(),
  primary key (jurisdiction_code, scheme_code)
);

-- ---------------------------------------------------------------------------
-- tax_class — what an article or a vendor item points at (§11.1).
-- `inclusive` is the field that lets one model serve India (menu price includes GST)
-- and a market where shelf price excludes tax, without special-casing either.
-- ---------------------------------------------------------------------------
create table if not exists tax_class (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid references chain (id) on delete cascade,
  code           text not null,
  regime_code    text not null references tax_regime (code) on delete restrict,
  jurisdiction_code text not null references jurisdiction (code) on delete restrict,
  rate_basis     text not null default 'ad_valorem' check (rate_basis in ('ad_valorem', 'specific')),
  inclusive      boolean not null,
  rounding       text not null default 'half_up' check (rounding in ('half_up', 'half_even', 'floor', 'ceiling')),
  status         text not null default 'active'
                 check (status in ('active', 'inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint tax_class_scope check (chain_id is not null)
);
create unique index if not exists tax_class_chain_code_key on tax_class (chain_id, code) where chain_id is not null;
create index if not exists tax_class_chain_idx on tax_class (chain_id);

-- A per-locale display name for a tax class. Same shape as every other per-locale
-- content table in this migration set: one row per locale, the chain's default-locale
-- row required (enforced by the loader, not by a trigger — the loader is the only
-- write path in Phase 1).
create table if not exists tax_class_text (
  chain_id      uuid not null references chain (id) on delete cascade,
  tax_class_id  uuid not null references tax_class (id) on delete cascade,
  locale        text not null,
  name          text not null,
  created_at    timestamptz not null default now(),
  primary key (tax_class_id, locale)
);

-- ---------------------------------------------------------------------------
-- tax_rate — the effective-dated rate (§11.2). A rate is NEVER edited in place:
-- changing a rate closes this row and opens a new one.
-- `supply_type` exists because GST's rate is not one number — an intra-state sale is
-- CGST+SGST and an inter-state one is IGST — and the same shape serves a US
-- state/local split and an EU reduced/normal/zero rate.
-- ---------------------------------------------------------------------------
create table if not exists tax_rate (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  tax_class_id  uuid not null references tax_class (id) on delete cascade,
  supply_type   text not null
                check (supply_type in ('intra_state', 'inter_state', 'export', 'zero_rated', 'exempt', 'standard', 'reduced')),
  rate_pct      numeric(7,4) not null,             -- per cent, not a fraction
  effective_from date not null,
  effective_to   date,
  note           text,
  created_by_user_id uuid references "user" (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint tax_rate_window check (effective_to is null or effective_to >= effective_from)
);
-- Overlapping windows for one (class, supply type) are refused by the server with
-- validation.effectiveWindowOverlap; this index makes the non-overlapping case the
-- only one the database can hold open at a time, which is the same statement made
-- twice on purpose (the API can name the field, the index cannot be bypassed).
create unique index if not exists tax_rate_open_window_key
  on tax_rate (tax_class_id, supply_type) where effective_to is null;
create index if not exists tax_rate_class_idx on tax_rate (tax_class_id, supply_type, effective_from desc);

-- So `5%` can honestly render as `5% GST (CGST 2.5% + SGST 2.5%)` on the bill (§11.1).
create table if not exists tax_rate_component (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid not null references chain (id) on delete cascade,
  tax_rate_id    uuid not null references tax_rate (id) on delete cascade,
  label_key      text not null,
  rate_pct       numeric(7,4) not null,
  level          text not null check (level in ('central', 'state', 'local')),
  display_order  integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists tax_rate_component_rate_idx on tax_rate_component (tax_rate_id);

-- ---------------------------------------------------------------------------
-- uom — the unit reference (§10.1). `code` is the contract: it is what the ledger,
-- the invoice and a vendor's price list carry, so it is never translated.
-- `precision` and `rounding` are *domain* rules, not presentation: a locale must not
-- turn 0.5 kg into 0.500 kg, and a unit with 0 decimals refuses 1.5 pc.
-- ---------------------------------------------------------------------------
create table if not exists uom (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid references chain (id) on delete cascade,   -- NULL = platform-curated
  code          text not null,
  dimension     text not null
                check (dimension in ('mass', 'volume', 'count', 'length', 'time', 'energy', 'other')),
  system        text not null check (system in ('metric', 'imperial', 'count', 'none')),
  precision     integer not null default 3 check (precision between 0 and 6),
  rounding      text not null default 'half_up' check (rounding in ('half_up', 'half_even', 'floor', 'ceiling')),
  base_unit_of_dimension boolean not null default false,
  scope         text not null check (scope in ('platform', 'chain')),
  -- §21.4: the ERP's unit category, carried so an export can rebuild its view.
  unit_category text check (unit_category in ('order', 'issue', 'stockkeeping', 'price', 'none')),
  status        text not null default 'active' check (status in ('active', 'inactive')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uom_scope_chain check ((scope = 'platform' and chain_id is null) or (scope = 'chain' and chain_id is not null))
);
create unique index if not exists uom_platform_code_key on uom (code) where chain_id is null;
create unique index if not exists uom_chain_code_key on uom (chain_id, code) where chain_id is not null;

-- ---------------------------------------------------------------------------
-- uom_conversion — the jurisdiction dimension of a conversion (§10.2).
-- `jurisdiction` NULL means "universal"; a value means "this market's rule". That is
-- the field that keeps a CUP (240 ml US customary, 250 ml metric) honest, and it is
-- why UOM conversion must not assume Indian units or any other market's.
-- Resolution order when costing: chain row for the site's jurisdiction → platform row
-- for that jurisdiction → chain universal row → platform universal row.
-- ---------------------------------------------------------------------------
create table if not exists uom_conversion (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid references chain (id) on delete cascade,   -- NULL = platform-curated
  from_uom_id    uuid not null references uom (id) on delete restrict,
  to_uom_id      uuid not null references uom (id) on delete restrict,
  factor         numeric(24,12) not null,          -- exact decimal; a float would drift over a thousand recipe multiplications
  factor_numerator   numeric(24,0),                -- the exact rational, where one exists (1 lb = 453.59237 g is exact)
  factor_denominator numeric(24,0),
  jurisdiction_code text references jurisdiction (code) on delete restrict,   -- NULL = universal
  effective_from date not null default current_date,
  effective_to   date,
  source         text,                              -- 'UN/CEFACT', 'chain standard', 'weighed'
  status         text not null default 'active' check (status in ('active', 'inactive')),
  created_at     timestamptz not null default now(),
  constraint uom_conversion_factor_positive check (factor > 0),
  constraint uom_conversion_not_self check (from_uom_id <> to_uom_id),
  constraint uom_conversion_window check (effective_to is null or effective_to >= effective_from)
);
create index if not exists uom_conversion_pair_idx
  on uom_conversion (from_uom_id, to_uom_id, jurisdiction_code, effective_from desc);
create index if not exists uom_conversion_chain_idx on uom_conversion (chain_id);

-- ---------------------------------------------------------------------------
-- allergen / nutrient reference data (§13). Codes are stable, lowercase snake and are
-- never translated — the label is resolved from the code, because the code is what the
-- API, the invoice and a reconciliation column carry.
-- ---------------------------------------------------------------------------
create table if not exists allergen (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid references chain (id) on delete cascade,   -- NULL = platform set
  code           text not null,
  label_key      text not null,                    -- mdm.allergen.label.{code}
  scope          text not null check (scope in ('platform', 'chain')),
  status         text not null default 'active' check (status in ('active', 'inactive')),
  effective_from date not null default current_date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint allergen_scope_chain check ((scope = 'platform' and chain_id is null) or (scope = 'chain' and chain_id is not null))
);
create unique index if not exists allergen_platform_code_key on allergen (code) where chain_id is null;
create unique index if not exists allergen_chain_code_key on allergen (chain_id, code) where chain_id is not null;

-- How a kitchen actually types it ("gluten", "maida", "nut"). Search must match the
-- alias, because the picker is where a wrong allergen gets in (§13.1).
create table if not exists allergen_alias (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid references chain (id) on delete cascade,
  allergen_id uuid not null references allergen (id) on delete cascade,
  locale      text not null,
  alias       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists allergen_alias_allergen_idx on allergen_alias (allergen_id);
create index if not exists allergen_alias_lower_idx on allergen_alias (lower(alias));

create table if not exists nutrient (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid references chain (id) on delete cascade,
  code           text not null,
  label_key      text not null,
  unit           text not null,                    -- 'kcal', 'g', 'mg'
  default_basis  text not null,                    -- 'per_100g' | 'per_100ml' | 'per_serving'
  precision      integer not null default 2,
  scope          text not null check (scope in ('platform', 'chain')),
  status         text not null default 'active' check (status in ('active', 'inactive')),
  effective_from date not null default current_date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint nutrient_scope_chain check ((scope = 'platform' and chain_id is null) or (scope = 'chain' and chain_id is not null))
);
create unique index if not exists nutrient_platform_code_key on nutrient (code) where chain_id is null;
create unique index if not exists nutrient_chain_code_key on nutrient (chain_id, code) where chain_id is not null;

-- A market's allergen set, its mandated display order and the mark to use. These three
-- tables are what make the compliance matrix generated rather than hardcoded: a market
-- that mandates no allergen set simply has no rows here, and the matrix then has no
-- allergen column at all (§13.2).
create table if not exists jurisdiction_allergen (
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  allergen_id       uuid not null references allergen (id) on delete cascade,
  requirement       text not null check (requirement in ('mandatory', 'informational', 'not_required')),
  display_order     integer not null default 0,
  symbol_key        text,
  effective_from    date not null default current_date,
  created_at        timestamptz not null default now(),
  primary key (jurisdiction_code, allergen_id)
);

create table if not exists jurisdiction_display_mark (
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  kind              text not null,                 -- 'dietary'
  shape_code        text not null,                 -- 'veg_dot' | 'non_veg_triangle' | ...
  asset_key         text,
  label_key         text not null,
  effective_from    date not null default current_date,
  created_at        timestamptz not null default now(),
  primary key (jurisdiction_code, kind, shape_code)
);

-- The basis is the real difference: per 100 g/ml (label style) versus per serving
-- (menu style, which is what India's menu rule needs alongside the serving size).
create table if not exists jurisdiction_nutrient (
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  nutrient_id       uuid not null references nutrient (id) on delete cascade,
  basis             text not null,
  requirement       text not null check (requirement in ('mandatory', 'informational', 'not_required')),
  effective_from    date not null default current_date,
  created_at        timestamptz not null default now(),
  primary key (jurisdiction_code, nutrient_id, basis)
);

-- ---------------------------------------------------------------------------
-- jurisdiction profiles (§14). Which fields a market requires, and why —
-- `legal_ref` is a text column for the citation, so a reviewer can audit the profile
-- rather than trust it. A profile is versioned and effective-dated; nothing is edited
-- in place, and the changelog is readable at /mdm/reference/jurisdictions.
-- ---------------------------------------------------------------------------
create table if not exists jurisdiction_field_rule (
  id                uuid primary key default gen_random_uuid(),
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  entity            text not null,                 -- 'article' | 'raw_material' | 'vendor' | ...
  field             text not null,                 -- the field KEY from the spec, never a screen label
  requirement       text not null check (requirement in ('required', 'recommended', 'forbidden', 'optional')),
  validator         text,                          -- e.g. 'hsn_sac', 'gstin_shape'
  effective_from    date not null default current_date,
  note_key          text,
  legal_ref         text,
  profile_version   integer not null default 1,
  created_at        timestamptz not null default now()
);
create index if not exists jurisdiction_field_rule_lookup_idx
  on jurisdiction_field_rule (jurisdiction_code, entity, field, effective_from desc);

create table if not exists jurisdiction_display_rule (
  id                uuid primary key default gen_random_uuid(),
  jurisdiction_code text not null references jurisdiction (code) on delete cascade,
  surface           text not null check (surface in ('menu', 'cds', 'app', 'label')),
  field             text not null,
  presentation      text not null,
  effective_from    date not null default current_date,
  created_at        timestamptz not null default now()
);
create index if not exists jurisdiction_display_rule_lookup_idx
  on jurisdiction_display_rule (jurisdiction_code, surface, field);

-- ---------------------------------------------------------------------------
-- Categories. Chain-defined trees: `category` drives menu grouping and reporting, and
-- the ERP's own group is kept *beside* it (§21.1), never in place of it.
-- ---------------------------------------------------------------------------
create table if not exists article_category (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  parent_id   uuid references article_category (id) on delete restrict,
  code        text not null,
  sort_order  integer not null default 0,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (chain_id, code)
);
create table if not exists article_category_text (
  chain_id    uuid not null references chain (id) on delete cascade,
  category_id uuid not null references article_category (id) on delete cascade,
  locale      text not null,
  name        text not null,
  primary key (category_id, locale)
);

create table if not exists raw_material_category (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  parent_id   uuid references raw_material_category (id) on delete restrict,
  code        text not null,
  sort_order  integer not null default 0,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (chain_id, code)
);
create table if not exists raw_material_category_text (
  chain_id    uuid not null references chain (id) on delete cascade,
  category_id uuid not null references raw_material_category (id) on delete cascade,
  locale      text not null,
  name        text not null,
  primary key (category_id, locale)
);

-- ---------------------------------------------------------------------------
-- asset — the image reference an article's `images` field points at (§7.1). Kept
-- minimal on purpose: Phase 1 holds the reference and the per-locale alt text; the
-- upload pipeline is a later workstream.
-- ---------------------------------------------------------------------------
create table if not exists asset (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  kind        text not null default 'image' check (kind in ('image', 'document')),
  uri         text not null,
  mime_type   text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now()
);
create table if not exists asset_text (
  asset_id  uuid not null references asset (id) on delete cascade,
  locale    text not null,
  alt_text  text not null,
  primary key (asset_id, locale)
);

-- ---------------------------------------------------------------------------
-- ERP identity and mapping (§22). Schema only in this slab: no connector, no sync
-- runtime, no ERP admin screen. What exists here is what makes "configurable" true
-- rather than aspirational — a chain's ERP is connected by configuration later, and
-- the pilot needs none of it.
-- ---------------------------------------------------------------------------
create table if not exists erp_mapping_set (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  code        text not null,
  name        text not null,
  description text,
  status      text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (chain_id, code)
);

create table if not exists erp_system (
  id                  uuid primary key default gen_random_uuid(),
  chain_id            uuid not null references chain (id) on delete cascade,
  code                text not null,               -- 'D365FO', 'S4H', 'BC', 'B1'
  vendor              text not null check (vendor in (
                        'sap_s4hana', 'sap_business_one', 'dynamics_finance_ops',
                        'dynamics_business_central', 'generic_csv', 'rest_odata', 'rest_custom')),
  display_name        text not null,               -- chain data, not a catalog key (§4)
  endpoint            text,
  -- The NAME of a secret, never the secret itself. Nothing in the schema can hold a
  -- credential, which is the only way that promise survives a careless migration.
  auth_secret_ref     text,
  exchange_mode       text not null default 'manual_csv'
                      check (exchange_mode in ('realtime_api', 'scheduled_delta', 'file_drop', 'manual_csv')),
  direction_default   text not null default 'none'
                      check (direction_default in ('inbound', 'outbound', 'bidirectional', 'none')),
  field_mapping_set_id uuid references erp_mapping_set (id) on delete set null,
  status              text not null default 'not_configured'
                      check (status in ('active', 'paused', 'error', 'not_configured')),
  last_run_at         timestamptz,
  last_run_status     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (chain_id, code)
);
create index if not exists erp_system_chain_idx on erp_system (chain_id);

-- erp_code_map — our code lists and the ERP's (§22.3). `our_code` NULL means the ERP
-- code has no counterpart yet; `erp_code` NULL means ours has none. Both directions are
-- therefore expressible, and the seed can record "we know about this ERP code and have
-- not mapped it" without inventing a fake counterpart.
create table if not exists erp_code_map (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  system_id   uuid not null references erp_system (id) on delete cascade,
  code_list   text not null check (code_list in (
                'uom', 'tax_class', 'material_group', 'category', 'article_type',
                'vendor_group', 'plant', 'warehouse', 'currency', 'country',
                'unit_category', 'lifecycle_state', 'reason_code', 'storage_condition')),
  our_code    text,
  erp_code    text,
  valid_from  date not null default current_date,
  valid_to    date,
  note_key    text,
  created_at  timestamptz not null default now(),
  constraint erp_code_map_window check (valid_to is null or valid_to >= valid_from)
);
-- A mapping is never edited in place (§22.3): the open rows are unique per side, and a
-- change closes the old row.
create unique index if not exists erp_code_map_our_key
  on erp_code_map (chain_id, system_id, code_list, our_code) where valid_to is null and our_code is not null;
create unique index if not exists erp_code_map_erp_key
  on erp_code_map (chain_id, system_id, code_list, erp_code) where valid_to is null and erp_code is not null;

-- erp_field_ownership — declared per entity and field group, enforced server-side
-- (§22.4). With a two-way live sync any field with two masters oscillates, so
-- ownership is decided rather than assumed, and the losing value is recorded in the
-- audit trail rather than silently overwritten.
create table if not exists erp_field_ownership (
  id               uuid primary key default gen_random_uuid(),
  chain_id         uuid not null references chain (id) on delete cascade,
  system_id        uuid not null references erp_system (id) on delete cascade,
  entity           text not null check (entity in (
                     'article', 'raw_material', 'vendor', 'uom', 'tax_class', 'site', 'outlet')),
  field_group      text not null check (field_group in (
                     'identity', 'classification', 'units', 'dimensions', 'storage', 'shelflife',
                     'batch_serial', 'quality', 'purchasing', 'valuation', 'tax', 'origin_customs',
                     'manufacturer', 'revision', 'lifecycle', 'terms', 'bank', 'contact', 'address',
                     'org_unit', 'price_compliance_culinary')),
  field            text,                           -- NULL = the whole group
  owner            text not null check (owner in ('erp', 'omnihost', 'erp_with_site_override', 'split')),
  inbound_action   text not null check (inbound_action in ('apply', 'propose', 'ignore')),
  outbound_action  text not null check (outbound_action in ('send', 'skip')),
  override_allowed boolean not null default false,
  note_key         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists erp_field_ownership_group_key
  on erp_field_ownership (chain_id, system_id, entity, field_group, coalesce(field, ''));
create index if not exists erp_field_ownership_lookup_idx
  on erp_field_ownership (chain_id, entity, field);

-- erp_change_notice — the engineering-change reference a revision level points at.
create table if not exists erp_change_notice (
  id             uuid primary key default gen_random_uuid(),
  chain_id       uuid not null references chain (id) on delete cascade,
  system_id      uuid references erp_system (id) on delete set null,
  reference      text not null,
  description    text,
  effective_from date,
  status         text not null default 'active' check (status in ('active', 'closed')),
  created_at     timestamptz not null default now(),
  unique (chain_id, reference)
);

-- external_key — one internal id, many external keys, per system (§22.2).
-- Keys are strings, compared trimmed and case-sensitively: 0000123456 is not 123456,
-- and leading zeros are preserved because a lost one is a real support class.
-- `entity_id` is a plain uuid with a FK per entity_type enforced in the API (the spec
-- says so explicitly): a polymorphic FK is not expressible in PostgreSQL without a
-- trigger, and a trigger here would silently drop the check the API is meant to make.
create table if not exists external_key (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  entity_type   text not null check (entity_type in (
                  'article', 'raw_material', 'vendor', 'uom', 'tax_class', 'site', 'outlet',
                  'article_category', 'raw_material_category', 'erp_change_notice')),
  entity_id     uuid not null,
  system_id     uuid not null references erp_system (id) on delete cascade,
  key_type      text not null check (key_type in (
                  'material_number', 'item_number', 'vendor_account', 'unit_code', 'tax_group',
                  'tax_classification', 'plant', 'storage_location', 'warehouse', 'sales_org',
                  'vendor_item_number', 'manufacturer_part_number', 'external_guid', 'external_code')),
  value         text not null,
  is_primary    boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- A re-pointed key is retired with a pointer to the new one, never deleted: a
  -- historical payload still has to resolve.
  status        text not null default 'active' check (status in ('active', 'retired')),
  retired_to_id uuid references external_key (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint external_key_value_not_blank check (length(btrim(value)) > 0)
);
create unique index if not exists external_key_value_key
  on external_key (chain_id, system_id, key_type, value);
create unique index if not exists external_key_primary_key
  on external_key (chain_id, entity_type, entity_id, system_id, key_type) where is_primary;
create index if not exists external_key_entity_idx on external_key (chain_id, entity_type, entity_id);
create index if not exists external_key_lookup_idx on external_key (chain_id, system_id, key_type, btrim(value));

-- erp_unmapped_code — the raw ERP code that had no counterpart on import (§22.3 says
-- "stored in the record's erpAdmin.unmapped map"). Held as rows rather than a JSONB map
-- on the record, because decision D1 forbids an erp_* blob on a master record: the point
-- of D1 is that ownership stays enforceable and the field set verifiable, and a blob
-- would reintroduce exactly the unenforceable thing it was written to prevent.
create table if not exists erp_unmapped_code (
  id          uuid primary key default gen_random_uuid(),
  chain_id    uuid not null references chain (id) on delete cascade,
  system_id   uuid not null references erp_system (id) on delete cascade,
  entity_type text not null,
  entity_id   uuid,
  code_list   text not null,
  erp_code    text not null,
  field       text,
  seen_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists erp_unmapped_code_entity_idx
  on erp_unmapped_code (chain_id, entity_type, entity_id);
