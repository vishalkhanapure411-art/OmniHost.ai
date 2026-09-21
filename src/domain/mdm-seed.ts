import "@tanstack/react-start/server-only";

import type { Queryable } from "~/db";
import {
  MDM_ALLERGENS,
  MDM_ARTICLES,
  MDM_ARTICLE_CATEGORIES,
  MDM_CONVERSIONS,
  MDM_ERP_MIRROR,
  MDM_ERP_SYSTEM,
  MDM_IN_DISPLAY_RULES,
  MDM_IN_FIELD_RULES,
  MDM_IN_MANDATORY_ALLERGENS,
  MDM_JURISDICTIONS,
  MDM_NUTRIENTS,
  MDM_OUTLET_SECTIONS,
  MDM_RAW_MATERIALS,
  MDM_RAW_MATERIAL_CATEGORIES,
  MDM_SITE_OPERATING_HOURS,
  MDM_TAX_CLASSES,
  MDM_TAX_REGIMES,
  MDM_UOMS,
  MDM_VENDORS,
} from "~/domain/mdm-demo-data";

/**
 * The Phase 1 master-data loader.
 *
 * This is the path a chain's *real* extract comes through, and it is deliberately nothing
 * more clever than that: every row is upserted on its business `code` (or on the reference
 * row's natural key), so running it twice changes nothing the second time, and a real
 * dataset with the same codes overwrites the demo rows instead of duplicating them
 * (spec §16). The spec's own load order is the order of this function, because each step
 * validates against the previous one and a broken file is then found at its own step:
 *
 *   jurisdictions → tax regimes/classes/rates → UOMs + conversions → categories →
 *   allergens/nutrients + the jurisdiction profile → vendors → raw materials → sites and
 *   outlets → articles.
 *
 * Three rules the spec states and this loader keeps:
 *   * **A rate or a cost is never edited in place.** The open row is closed the day before
 *     the new window opens and a new row is opened (§11.2, §8.2). Here the first row is
 *     simply opened; re-running does not close and reopen it, because the value has not
 *     changed.
 *   * **Codes are never translated** — the label is resolved from the code at render time.
 *   * **Nothing is invented about a market we have not been told about.** Only the `IN`
 *     and its two state profiles are seeded (§14).
 */

const PLATFORM_LOCALE = "en-IN";

/** Per-locale names for a handful of well-known dishes, so the `untranslated` marker has
 * something real to sit beside rather than being a claim nobody can see. */
const HINDI_ARTICLE_NAMES: Record<string, string> = {
  "ART-1001": "पनीर टिक्का",
  "ART-1015": "पनीर बटर मसाला",
  "ART-1021": "बटर चिकन",
  "ART-1031": "हैदराबादी चिकन बिरयानी",
  "ART-1032": "मसाला डोसा",
  "ART-1036": "गुलाब जामुन",
  "ART-1040": "फ़िल्टर कॉफ़ी",
  "ART-1041": "मसाला चाय",
};

interface Ctx {
  chainIdByCode: Map<string, string>;
  siteIdByCode: Map<string, { id: string; chainId: string; currency: string }>;
  outletIdByCode: Map<string, { id: string; siteId: string; chainId: string; currency: string }>;
  taxClassIdByKey: Map<string, string>;
  uomIdByKey: Map<string, string>;
  allergenIdByCode: Map<string, string>;
  nutrientIdByCode: Map<string, string>;
  articleCategoryIdByKey: Map<string, string>;
  rawMaterialCategoryIdByKey: Map<string, string>;
  rawMaterialIdByCode: Map<string, string>;
  vendorIdByCode: Map<string, string>;
}

export async function seedMdm(tx: Queryable): Promise<void> {
  const ctx: Ctx = {
    chainIdByCode: new Map(),
    siteIdByCode: new Map(),
    outletIdByCode: new Map(),
    taxClassIdByKey: new Map(),
    uomIdByKey: new Map(),
    allergenIdByCode: new Map(),
    nutrientIdByCode: new Map(),
    articleCategoryIdByKey: new Map(),
    rawMaterialCategoryIdByKey: new Map(),
    rawMaterialIdByCode: new Map(),
    vendorIdByCode: new Map(),
  };

  await loadChainsAndSites(tx, ctx);
  await loadJurisdictions(tx);
  // After the jurisdictions exist: the site's jurisdiction is now a real reference, and a
  // reference cannot be written before the row it points at.
  await loadSiteTradingDefaults(tx, ctx);
  await loadTaxRegimes(tx);
  await loadUoms(tx, ctx);
  await loadAllergensAndNutrients(tx, ctx);
  await loadJurisdictionProfile(tx, ctx);
  await loadCategories(tx, ctx);
  await loadTaxClasses(tx, ctx);
  await loadConversions(tx, ctx);
  await loadVendors(tx, ctx);
  await loadRawMaterials(tx, ctx);
  await loadSections(tx, ctx);
  await loadArticles(tx, ctx);
  // Last, because it decorates records the steps above created: the ERP mirror is a
  // layer over the article master, never a source of it.
  await loadErpMirror(tx, ctx);
}

// ---------------------------------------------------------------------------
// The ERP mirror — declared, not connected (§25, Part II §21)
// ---------------------------------------------------------------------------
/**
 * Upserts the chain's declared ERP system and the mirror values the record screen renders
 * read-only. Idempotent on the same keys as everything else, so a chain's real extract
 * replaces the demo rows rather than duplicating them.
 *
 * Nothing here implies a connector exists: `status` is `not_configured`, and the screen
 * says so. What it demonstrates is the *treatment* — a value the ERP owns is shown as a
 * DescriptionList value with a provenance chip, never as a disabled input (§25.3).
 */
async function loadErpMirror(tx: Queryable, ctx: Ctx): Promise<void> {
  const chainId = ctx.chainIdByCode.get("saffron-table");
  if (!chainId) return;

  const systemRows = await tx.query<{ id: string }>(
    `insert into erp_system (chain_id, code, vendor, display_name, exchange_mode, direction_default, status)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (chain_id, code) do update
       set vendor = excluded.vendor, display_name = excluded.display_name,
           exchange_mode = excluded.exchange_mode, direction_default = excluded.direction_default,
           status = excluded.status, updated_at = now()
     returning id`,
    [
      chainId,
      MDM_ERP_SYSTEM.code,
      MDM_ERP_SYSTEM.vendor,
      MDM_ERP_SYSTEM.displayName,
      MDM_ERP_SYSTEM.exchangeMode,
      MDM_ERP_SYSTEM.directionDefault,
      MDM_ERP_SYSTEM.status,
    ]
  );
  const systemId = systemRows[0]?.id;
  if (!systemId) return;

  for (const mirror of MDM_ERP_MIRROR) {
    const articleRows = await tx.query<{ id: string; version_id: string | null }>(
      `select a.id, a.current_version_id as version_id from article a where a.chain_id = $1 and a.code = $2`,
      [chainId, mirror.articleCode]
    );
    const article = articleRows[0];
    if (!article) continue;

    const syncedAt = new Date(Date.now() - mirror.lastSyncedMinutesAgo * 60_000);
    await tx.query(
      `update article
          set source_system = $2, external_ref = $3, material_type_code = $4,
              erp_lifecycle_state_code = $5, erp_blocked = $6,
              valuation_class_code = $7, price_control = $8,
              standard_price_amount = $9, standard_price_currency = $10,
              moving_average_price_amount = $11, moving_average_price_currency = $12,
              net_weight_value = $13, net_weight_uom_id = $14,
              gross_weight_value = $15, gross_weight_uom_id = $16,
              storage_condition_code = $17, temperature_condition = $18, shelf_life_days = $19,
              batch_management = $20, serial_profile_code = $21,
              receipt_inspection_required = coalesce($22, receipt_inspection_required),
              certificate_required = coalesce($23, certificate_required),
              erp_tax_classification_code = $24, erp_tax_group = $25,
              country_of_origin = $26, customs_tariff_number = $27, export_control_class = $28,
              manufacturer_name = $29, manufacturer_part_number = $30, revision_level = $31,
              erp_source_version = $32, erp_last_sync_at = $33, updated_at = now()
        where id = $1`,
      [
        article.id,
        MDM_ERP_SYSTEM.vendor,
        mirror.materialNumber,
        mirror.materialType,
        mirror.lifecycleState,
        mirror.blocked ?? false,
        mirror.valuationClass ?? null,
        mirror.priceControl ?? null,
        mirror.standardPrice?.amount ?? null,
        mirror.standardPrice?.currency ?? null,
        mirror.movingAveragePrice?.amount ?? null,
        mirror.movingAveragePrice?.currency ?? null,
        mirror.netWeight?.value ?? null,
        uomId(ctx, "saffron-table", mirror.netWeight?.uom ?? ""),
        mirror.grossWeight?.value ?? null,
        uomId(ctx, "saffron-table", mirror.grossWeight?.uom ?? ""),
        mirror.storageCondition ?? null,
        mirror.temperatureCondition ?? null,
        mirror.shelfLifeDays ?? null,
        mirror.batchManagement ?? null,
        mirror.serialProfile ?? null,
        mirror.receiptInspectionRequired ?? null,
        mirror.certificateRequired ?? null,
        mirror.taxClassification ?? null,
        mirror.taxGroup ?? null,
        mirror.countryOfOrigin ?? null,
        mirror.customsTariffNumber ?? null,
        mirror.exportControlClass ?? null,
        mirror.manufacturerName ?? null,
        mirror.manufacturerPartNumber ?? null,
        mirror.revisionLevel ?? null,
        mirror.sourceVersion,
        syncedAt,
      ]
    );

    await tx.query(
      `insert into external_key (chain_id, entity_type, entity_id, system_id, key_type, value,
                                 is_primary, last_seen_at)
       values ($1, 'article', $2, $3, 'material_number', $4, true, $5)
       on conflict (chain_id, system_id, key_type, value) do update
         set last_seen_at = excluded.last_seen_at, status = 'active'`,
      [chainId, article.id, systemId, mirror.materialNumber, syncedAt]
    );
  }
}

// ---------------------------------------------------------------------------
// Tenants, sites and outlets — read, never created here. The Phase 0 seed owns them.
// ---------------------------------------------------------------------------
async function loadChainsAndSites(tx: Queryable, ctx: Ctx): Promise<void> {
  const chains = await tx.query<{ id: string; code: string }>(`select id, code from chain`);
  for (const chain of chains) ctx.chainIdByCode.set(chain.code, chain.id);

  const sites = await tx.query<{ id: string; code: string; chain_id: string }>(
    `select id, code, chain_id from site`
  );
  const chainCodeById = new Map([...ctx.chainIdByCode].map(([code, id]) => [id, code]));
  for (const site of sites) {
    const chainCode = chainCodeById.get(site.chain_id);
    if (!chainCode) continue;
    ctx.siteIdByCode.set(site.code, { id: site.id, chainId: site.chain_id, currency: "INR" });
  }

  const outlets = await tx.query<{ id: string; code: string; site_id: string; chain_id: string }>(
    `select id, code, site_id, chain_id from outlet`
  );
  for (const outlet of outlets) {
    const site = [...ctx.siteIdByCode.values()].find((candidate) => candidate.id === outlet.site_id);
    ctx.outletIdByCode.set(outlet.code, {
      id: outlet.id,
      siteId: outlet.site_id,
      chainId: outlet.chain_id,
      currency: site?.currency ?? "INR",
    });
  }
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
/**
 * The site master's jurisdiction and trading currency (§12.1). Before Phase 1 the site's
 * jurisdiction was only a free-text string on the record; it is now a reference, and the
 * currency is the code every site-local amount carries (§8.4 — there is no chain-wide
 * "assumed currency"). Both are set from the chain the site belongs to, which is the
 * honest demo shape: the chain's states are what its sites trade in.
 */
async function loadSiteTradingDefaults(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const [chainCode, chainId] of ctx.chainIdByCode) {
    const jurisdiction = chainCode === "coastal-catch" ? "IN-MH" : "IN-KA";
    await tx.query(
      `update site
          set jurisdiction_code = coalesce(jurisdiction_code, $2),
              currency = coalesce(currency, 'INR'),
              updated_at = now()
        where chain_id = $1`,
      [chainId, jurisdiction]
    );
  }
}

async function loadJurisdictions(tx: Queryable): Promise<void> {
  for (const jurisdiction of MDM_JURISDICTIONS) {
    await tx.query(
      `insert into jurisdiction (code, country_code, subdivision_code, default_currency,
                                default_time_zone, default_locale, default_tax_regime)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (code) do update
         set country_code = excluded.country_code,
             subdivision_code = excluded.subdivision_code,
             default_currency = excluded.default_currency,
             default_time_zone = excluded.default_time_zone,
             default_locale = excluded.default_locale,
             default_tax_regime = excluded.default_tax_regime,
             updated_at = now()`,
      [
        jurisdiction.code,
        jurisdiction.countryCode,
        jurisdiction.subdivisionCode,
        jurisdiction.defaultCurrency,
        jurisdiction.defaultTimeZone,
        jurisdiction.defaultLocale,
        jurisdiction.defaultTaxRegime,
      ]
    );
  }
}

async function loadTaxRegimes(tx: Queryable): Promise<void> {
  for (const regime of MDM_TAX_REGIMES) {
    await tx.query(
      `insert into tax_regime (code, label_key, jurisdiction_code, level, inclusive_default,
                               price_display_convention, status, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'active', current_date)
       on conflict (code) do update
         set label_key = excluded.label_key,
             jurisdiction_code = excluded.jurisdiction_code,
             level = excluded.level,
             inclusive_default = excluded.inclusive_default,
             price_display_convention = excluded.price_display_convention`,
      [
        regime.code,
        regime.labelKey,
        regime.jurisdiction,
        regime.level,
        regime.inclusiveDefault,
        regime.priceDisplayConvention,
      ]
    );
  }

  // The registration scheme a market's tax number uses (§11.1). Used by the vendor form
  // and by the tax registrations the vendors below actually carry.
  await tx.query(
    `insert into tax_registration_scheme (jurisdiction_code, scheme_code, label_key, pattern, applies_to)
     values ('IN', 'GSTIN', 'mdm.vendor.scheme.GSTIN', '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$',
             array['vendor']::text[])
     on conflict (jurisdiction_code, scheme_code) do update
       set label_key = excluded.label_key, pattern = excluded.pattern, applies_to = excluded.applies_to`
  );
}

async function loadUoms(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const uom of MDM_UOMS) {
    const chainId = uom.chainCode ? (ctx.chainIdByCode.get(uom.chainCode) ?? null) : null;
    if (uom.chainCode && !chainId) continue;
    // Two partial unique indexes, so the conflict target names the one this row belongs to.
    const conflict = chainId
      ? `on conflict (chain_id, code) where chain_id is not null`
      : `on conflict (code) where chain_id is null`;
    const rows = await tx.query<{ id: string }>(
      `insert into uom (chain_id, code, dimension, system, precision, rounding,
                        base_unit_of_dimension, scope, unit_category)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ${conflict} do update
         set dimension = excluded.dimension, system = excluded.system,
             precision = excluded.precision, rounding = excluded.rounding,
             base_unit_of_dimension = excluded.base_unit_of_dimension,
             unit_category = excluded.unit_category, updated_at = now()
       returning id`,
      [
        chainId,
        uom.code,
        uom.dimension,
        uom.system,
        uom.precision,
        uom.rounding,
        uom.baseUnitOfDimension,
        chainId ? "chain" : "platform",
        uom.unitCategory,
      ]
    );
    const id = rows[0]?.id;
    if (id) ctx.uomIdByKey.set(cacheKey(chainId, uom.code), id);
  }
}

function cacheKey(chainId: string | null, code: string): string {
  return `${chainId ?? "-"}|${code}`;
}

function uomId(ctx: Ctx, chainCode: string | null, code: string): string | null {
  const chainId = chainCode ? (ctx.chainIdByCode.get(chainCode) ?? null) : null;
  return ctx.uomIdByKey.get(cacheKey(chainId, code)) ?? ctx.uomIdByKey.get(cacheKey(null, code)) ?? null;
}

async function loadConversions(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const conversion of MDM_CONVERSIONS) {
    const chainId = conversion.chainCode ? (ctx.chainIdByCode.get(conversion.chainCode) ?? null) : null;
    const fromId = uomId(ctx, conversion.chainCode, conversion.fromUom);
    const toId = uomId(ctx, conversion.chainCode, conversion.toUom);
    if (!fromId || !toId) continue;
    // No unique index on this table (a conversion's identity is its whole window), so the
    // guard is an explicit existence check — which is also what makes re-running a no-op.
    await tx.query(
      `insert into uom_conversion (chain_id, from_uom_id, to_uom_id, factor, jurisdiction_code,
                                   effective_from, source, status)
       select $1, $2, $3, $4, $5, current_date, $6, 'active'
        where not exists (
          select 1 from uom_conversion c
           where c.from_uom_id = $2 and c.to_uom_id = $3
             and c.jurisdiction_code is not distinct from $5
             and c.chain_id is not distinct from $1
        )`,
      [chainId, fromId, toId, conversion.factor, conversion.jurisdiction, conversion.source]
    );
  }
}

async function loadAllergensAndNutrients(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const allergen of MDM_ALLERGENS) {
    const rows = await tx.query<{ id: string }>(
      `insert into allergen (chain_id, code, label_key, scope, status, effective_from)
       values (null, $1, $2, 'platform', 'active', current_date)
       on conflict (code) where chain_id is null do update
         set label_key = excluded.label_key, status = 'active'
       returning id`,
      [allergen.code, `mdm.allergen.label.${allergen.code}`]
    );
    const id = rows[0]?.id;
    if (!id) continue;
    ctx.allergenIdByCode.set(allergen.code, id);
    for (const alias of allergen.aliases) {
      await tx.query(
        `insert into allergen_alias (chain_id, allergen_id, locale, alias)
         select null, $1, 'en-IN', $2
          where not exists (
            select 1 from allergen_alias a
             where a.allergen_id = $1 and a.locale = 'en-IN' and lower(a.alias) = lower($2)
          )`,
        [id, alias]
      );
    }
  }

  for (const nutrient of MDM_NUTRIENTS) {
    const rows = await tx.query<{ id: string }>(
      `insert into nutrient (chain_id, code, label_key, unit, default_basis, precision, scope, status, effective_from)
       values (null, $1, $2, $3, $4, $5, 'platform', 'active', current_date)
       on conflict (code) where chain_id is null do update
         set label_key = excluded.label_key, unit = excluded.unit, default_basis = excluded.default_basis,
             precision = excluded.precision, status = 'active'
       returning id`,
      [
        nutrient.code,
        `mdm.nutrient.label.${nutrient.code}`,
        nutrient.unit,
        nutrient.defaultBasis,
        nutrient.precision,
      ]
    );
    const id = rows[0]?.id;
    if (id) ctx.nutrientIdByCode.set(nutrient.code, id);
  }
}

/**
 * The `IN` profile and the reference rows that make it legal rather than decorative
 * (§13.2). Nothing here is a claim about another market: the EU-14 extras are declarable
 * in India without being mandated, which is exactly why `jurisdiction_allergen` carries a
 * `requirement` rather than a boolean.
 */
async function loadJurisdictionProfile(tx: Queryable, ctx: Ctx): Promise<void> {
  let order = 0;
  for (const allergen of MDM_ALLERGENS) {
    const allergenId = ctx.allergenIdByCode.get(allergen.code);
    if (!allergenId) continue;
    order += 10;
    const mandatory = MDM_IN_MANDATORY_ALLERGENS.includes(allergen.code);
    await tx.query(
      `insert into jurisdiction_allergen (jurisdiction_code, allergen_id, requirement, display_order, symbol_key)
       values ('IN', $1, $2, $3, null)
       on conflict (jurisdiction_code, allergen_id) do update
         set requirement = excluded.requirement, display_order = excluded.display_order`,
      [allergenId, mandatory ? "mandatory" : "informational", order]
    );
  }

  // India's veg / non-veg marks are one market's convention, held as rows — the preview on
  // the article form renders the mark the selling site's market expects, so nothing about
  // a mark is hardcoded in a component (§13.2).
  for (const mark of [
    { kind: "dietary", shapeCode: "veg_dot", labelKey: "mdm.allergen.mark.veg" },
    { kind: "dietary", shapeCode: "non_veg_triangle", labelKey: "mdm.allergen.mark.nonVeg" },
    { kind: "dietary", shapeCode: "egg_dot", labelKey: "mdm.allergen.mark.egg" },
  ]) {
    await tx.query(
      `insert into jurisdiction_display_mark (jurisdiction_code, kind, shape_code, asset_key, label_key)
       values ('IN', $1, $2, null, $3)
       on conflict (jurisdiction_code, kind, shape_code) do update
         set label_key = excluded.label_key`,
      [mark.kind, mark.shapeCode, mark.labelKey]
    );
  }

  for (const nutrient of MDM_NUTRIENTS) {
    const nutrientId = ctx.nutrientIdByCode.get(nutrient.code);
    if (!nutrientId) continue;
    const isEnergy = nutrient.code === "energy_kcal";
    await tx.query(
      `insert into jurisdiction_nutrient (jurisdiction_code, nutrient_id, basis, requirement)
       values ('IN', $1, $2, $3)
       on conflict (jurisdiction_code, nutrient_id, basis) do update
         set requirement = excluded.requirement`,
      [nutrientId, nutrient.defaultBasis, isEnergy ? "mandatory" : "informational"]
    );
  }

  for (const rule of MDM_IN_FIELD_RULES) {
    await tx.query(
      `insert into jurisdiction_field_rule (jurisdiction_code, entity, field, requirement,
                                            validator, effective_from, note_key, legal_ref, profile_version)
       select 'IN', $1, $2, $3, $4, current_date, $5, $6, 1
        where not exists (
          select 1 from jurisdiction_field_rule r
           where r.jurisdiction_code = 'IN' and r.entity = $1 and r.field = $2
             and r.profile_version = 1 and r.requirement = $3
        )`,
      [rule.entity, rule.field, rule.requirement, rule.validator, rule.noteKey, rule.legalRef]
    );
  }

  for (const rule of MDM_IN_DISPLAY_RULES) {
    await tx.query(
      `insert into jurisdiction_display_rule (jurisdiction_code, surface, field, presentation)
       select 'IN', $1, $2, $3
        where not exists (
          select 1 from jurisdiction_display_rule r
           where r.jurisdiction_code = 'IN' and r.surface = $1 and r.field = $2
        )`,
      [rule.surface, rule.field, rule.presentation]
    );
  }
}

async function loadCategories(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const category of MDM_ARTICLE_CATEGORIES) {
    const chainId = ctx.chainIdByCode.get(category.chainCode);
    if (!chainId) continue;
    const rows = await tx.query<{ id: string }>(
      `insert into article_category (chain_id, code, sort_order)
       values ($1, $2, $3)
       on conflict (chain_id, code) do update set sort_order = excluded.sort_order, updated_at = now()
       returning id`,
      [chainId, category.code, category.sortOrder]
    );
    const id = rows[0]?.id;
    if (!id) continue;
    ctx.articleCategoryIdByKey.set(cacheKey(chainId, category.code), id);
    await tx.query(
      `insert into article_category_text (chain_id, category_id, locale, name)
       values ($1, $2, $3, $4)
       on conflict (category_id, locale) do update set name = excluded.name`,
      [chainId, id, PLATFORM_LOCALE, category.name]
    );
  }

  for (const category of MDM_RAW_MATERIAL_CATEGORIES) {
    const chainId = ctx.chainIdByCode.get(category.chainCode);
    if (!chainId) continue;
    const rows = await tx.query<{ id: string }>(
      `insert into raw_material_category (chain_id, code, sort_order)
       values ($1, $2, $3)
       on conflict (chain_id, code) do update set sort_order = excluded.sort_order, updated_at = now()
       returning id`,
      [chainId, category.code, category.sortOrder]
    );
    const id = rows[0]?.id;
    if (!id) continue;
    ctx.rawMaterialCategoryIdByKey.set(cacheKey(chainId, category.code), id);
    await tx.query(
      `insert into raw_material_category_text (chain_id, category_id, locale, name)
       values ($1, $2, $3, $4)
       on conflict (category_id, locale) do update set name = excluded.name`,
      [chainId, id, PLATFORM_LOCALE, category.name]
    );
  }
}

/**
 * Tax classes and the *first* row of each rate window. A later change closes the open row
 * (`effective_to` = the day before the new `effective_from`) and opens a new one — never
 * an in-place edit, which is what keeps a historical bill's tax reproducible (§11.2).
 */
async function loadTaxClasses(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const taxClass of MDM_TAX_CLASSES) {
    const chainId = ctx.chainIdByCode.get(taxClass.chainCode);
    if (!chainId) continue;
    const rows = await tx.query<{ id: string }>(
      `insert into tax_class (chain_id, code, regime_code, jurisdiction_code, rate_basis, inclusive, rounding, status)
       values ($1, $2, 'IN_GST', $3, $4, $5, 'half_up', 'active')
       on conflict (chain_id, code) where chain_id is not null do update
         set jurisdiction_code = excluded.jurisdiction_code, rate_basis = excluded.rate_basis,
             inclusive = excluded.inclusive, updated_at = now()
       returning id`,
      [chainId, taxClass.code, taxClass.jurisdiction, taxClass.rateBasis, taxClass.inclusive]
    );
    const id = rows[0]?.id;
    if (!id) continue;
    ctx.taxClassIdByKey.set(cacheKey(chainId, taxClass.code), id);

    await tx.query(
      `insert into tax_class_text (chain_id, tax_class_id, locale, name)
       values ($1, $2, $3, $4)
       on conflict (tax_class_id, locale) do update set name = excluded.name`,
      [chainId, id, PLATFORM_LOCALE, taxClass.name]
    );

    for (const rate of taxClass.rates) {
      const rateRows = await tx.query<{ id: string }>(
        `insert into tax_rate (chain_id, tax_class_id, supply_type, rate_pct, effective_from, note)
         values ($1, $2, $3, $4, current_date, 'seeded rate window')
         on conflict (tax_class_id, supply_type) where effective_to is null do update
           set rate_pct = excluded.rate_pct
         returning id`,
        [chainId, id, rate.supplyType, rate.ratePct]
      );
      const rateId = rateRows[0]?.id;
      if (!rateId) continue;
      let componentOrder = 0;
      for (const component of rate.components) {
        componentOrder += 10;
        await tx.query(
          `insert into tax_rate_component (chain_id, tax_rate_id, label_key, rate_pct, level, display_order)
           select $1, $2, $3, $4, $5, $6
            where not exists (
              select 1 from tax_rate_component c
               where c.tax_rate_id = $2 and c.level = $5 and c.label_key = $3
            )`,
          [chainId, rateId, component.labelKey, component.ratePct, component.level, componentOrder]
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vendors, raw materials, sections and articles
// ---------------------------------------------------------------------------
async function loadVendors(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const vendor of MDM_VENDORS) {
    const chainId = ctx.chainIdByCode.get(vendor.chainCode);
    if (!chainId) continue;
    const rows = await tx.query<{ id: string }>(
      `insert into vendor (chain_id, code, legal_name, vendor_type, status,
                           address_line1, address_locality, address_region, address_postal_code,
                           address_country_code, billing_currency, payment_terms_kind, payment_terms_days,
                           credit_limit_amount, credit_limit_currency, lead_time_days)
       values ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, 'INR', $10, $11, $12, 'INR', $13)
       on conflict (chain_id, code) do update
         set legal_name = excluded.legal_name, vendor_type = excluded.vendor_type,
             address_line1 = excluded.address_line1, address_locality = excluded.address_locality,
             address_region = excluded.address_region, address_postal_code = excluded.address_postal_code,
             billing_currency = excluded.billing_currency,
             payment_terms_kind = excluded.payment_terms_kind,
             payment_terms_days = excluded.payment_terms_days,
             credit_limit_amount = excluded.credit_limit_amount,
             lead_time_days = excluded.lead_time_days, updated_at = now()
       returning id`,
      [
        chainId,
        vendor.code,
        vendor.legalName,
        vendor.vendorType,
        vendor.address.line1,
        vendor.address.locality,
        vendor.address.region,
        vendor.address.postalCode,
        vendor.address.countryCode,
        vendor.paymentTerms.kind,
        vendor.paymentTerms.days,
        vendor.creditLimit,
        vendor.leadTimeDays,
      ]
    );
    const vendorId = rows[0]?.id;
    if (!vendorId) continue;
    ctx.vendorIdByCode.set(vendor.code, vendorId);

    await tx.query(
      `insert into vendor_text (chain_id, vendor_id, locale, trade_name)
       values ($1, $2, $3, $4)
       on conflict (vendor_id, locale) do update set trade_name = excluded.trade_name`,
      [chainId, vendorId, PLATFORM_LOCALE, vendor.tradeName]
    );

    // Tax registrations are ROWS per jurisdiction, never a single `gstin` column: a chain
    // may hold a vendor registered in two markets, and a single column would have to be
    // migrated the first time that happened (§9.1).
    await tx.query(
      `insert into vendor_tax_registration (chain_id, vendor_id, jurisdiction_code, scheme_code, value)
       values ($1, $2, $3, 'GSTIN', $4)
       on conflict (vendor_id, jurisdiction_code, scheme_code, value) do update
         set status = 'active'`,
      [chainId, vendorId, vendor.jurisdiction, vendor.gstin]
    );

    await tx.query(
      `insert into vendor_contact (chain_id, vendor_id, kind, name, email, phone, locale, preferred)
       select $1, $2, $3, $4, $5, $6, $7, true
        where not exists (
          select 1 from vendor_contact c
           where c.vendor_id = $2 and c.kind = $3 and lower(c.email) = lower($5)
        )`,
      [chainId, vendorId, vendor.contact.kind, vendor.contact.name, vendor.contact.email, vendor.contact.phone, PLATFORM_LOCALE]
    );

    for (const document of vendor.documents) {
      await tx.query(
        `insert into vendor_document (chain_id, vendor_id, kind, reference, issued_on, expires_on)
         select $1, $2, $3, $4, current_date, current_date + ($5 || ' days')::interval
          where not exists (
            select 1 from vendor_document d
             where d.vendor_id = $2 and d.kind = $3 and d.reference is not distinct from $4
          )`,
        [chainId, vendorId, document.kind, document.reference, String(document.expiresInDays)]
      );
    }

    for (const category of vendor.categories) {
      const categoryId = ctx.rawMaterialCategoryIdByKey.get(cacheKey(chainId, category));
      if (!categoryId) continue;
      await tx.query(
        `insert into vendor_category (chain_id, vendor_id, category_id)
         values ($1, $2, $3) on conflict do nothing`,
        [chainId, vendorId, categoryId]
      );
    }
  }
}

async function loadRawMaterials(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const material of MDM_RAW_MATERIALS) {
    const chainId = ctx.chainIdByCode.get(material.chainCode);
    if (!chainId) continue;
    const categoryId = ctx.rawMaterialCategoryIdByKey.get(cacheKey(chainId, material.category));
    const baseUomId = uomId(ctx, material.chainCode, material.baseUom);
    const packUomId = material.packUom ? uomId(ctx, material.chainCode, material.packUom) : null;
    const costUomId = uomId(ctx, material.chainCode, material.costUom);
    if (!categoryId || !baseUomId || !costUomId) continue;

    const rows = await tx.query<{ id: string }>(
      `insert into raw_material (chain_id, code, category_id, base_uom_id, pack_uom_id, pack_qty,
                                 trim_yield_pct, shelf_life_days, shelf_life_basis, storage_type,
                                 storage_temp_min_c, storage_temp_max_c, track_stock, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active')
       on conflict (chain_id, code) do update
         set category_id = excluded.category_id, base_uom_id = excluded.base_uom_id,
             pack_uom_id = excluded.pack_uom_id, pack_qty = excluded.pack_qty,
             trim_yield_pct = excluded.trim_yield_pct, shelf_life_days = excluded.shelf_life_days,
             shelf_life_basis = excluded.shelf_life_basis, storage_type = excluded.storage_type,
             storage_temp_min_c = excluded.storage_temp_min_c,
             storage_temp_max_c = excluded.storage_temp_max_c,
             track_stock = excluded.track_stock, updated_at = now()
       returning id`,
      [
        chainId,
        material.code,
        categoryId,
        baseUomId,
        packUomId,
        material.packQty,
        material.trimYieldPct,
        material.shelfLifeDays,
        material.shelfLifeBasis,
        material.storageType,
        material.tempMinC,
        material.tempMaxC,
        material.trackStock,
      ]
    );
    const materialId = rows[0]?.id;
    if (!materialId) continue;
    ctx.rawMaterialIdByCode.set(material.code, materialId);

    await tx.query(
      `insert into raw_material_text (chain_id, raw_material_id, locale, name)
       values ($1, $2, $3, $4)
       on conflict (raw_material_id, locale) do update set name = excluded.name`,
      [chainId, materialId, PLATFORM_LOCALE, material.name]
    );

    // The open cost row. Re-running updates the value of the row that is open today rather
    // than closing and reopening it; a *change* goes through the API, which closes the old
    // window and opens the new one (§8.2).
    await tx.query(
      `insert into raw_material_cost (chain_id, raw_material_id, amount, currency_code, cost_source,
                                      per_qty, per_uom_id, effective_from)
       values ($1, $2, $3, 'INR', $4, $5, $6, current_date)
       on conflict (raw_material_id) where effective_to is null do update
         set amount = excluded.amount, cost_source = excluded.cost_source,
             per_qty = excluded.per_qty, per_uom_id = excluded.per_uom_id`,
      [chainId, materialId, material.cost, material.costSource, material.costPer, costUomId]
    );

    for (const supplier of material.vendors) {
      const vendorId = ctx.vendorIdByCode.get(supplier.vendor);
      if (!vendorId) continue;
      await tx.query(
        `insert into raw_material_supplier (chain_id, raw_material_id, vendor_id, vendor_item_code,
                                            vendor_uom_id, lead_time_days, preferred)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (raw_material_id, vendor_id) do update
           set vendor_item_code = excluded.vendor_item_code, vendor_uom_id = excluded.vendor_uom_id,
               lead_time_days = excluded.lead_time_days, preferred = excluded.preferred,
               updated_at = now()`,
        [chainId, materialId, vendorId, supplier.vendorItemCode, baseUomId, supplier.leadTimeDays, supplier.preferred]
      );
    }

    for (const allergenCode of material.allergens) {
      const allergenId = ctx.allergenIdByCode.get(allergenCode);
      if (!allergenId) continue;
      await tx.query(
        `insert into raw_material_allergen (chain_id, raw_material_id, allergen_id, source)
         values ($1, $2, $3, 'declared')
         on conflict (raw_material_id, allergen_id) do update set source = 'declared'`,
        [chainId, materialId, allergenId]
      );
    }
  }
}

async function loadSections(tx: Queryable, ctx: Ctx): Promise<void> {
  for (const section of MDM_OUTLET_SECTIONS) {
    const outlet = ctx.outletIdByCode.get(section.outletCode);
    if (!outlet) continue;
    await tx.query(
      `insert into outlet_section (chain_id, site_id, outlet_id, code, name, kind, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (outlet_id, code) do update
         set name = excluded.name, kind = excluded.kind, sort_order = excluded.sort_order,
             updated_at = now()`,
      [outlet.chainId, outlet.siteId, outlet.id, section.code, section.name, section.kind, section.sortOrder]
    );
  }

  for (const hours of MDM_SITE_OPERATING_HOURS) {
    const chainId = ctx.chainIdByCode.get(hours.chainCode);
    const site = ctx.siteIdByCode.get(hours.siteCode);
    if (!chainId || !site) continue;
    await tx.query(
      `insert into site_operating_hours (chain_id, site_id, outlet_id, day_of_week, opens_at, closes_at, closed)
       select $1, $2, null, $3, $4::time, $5::time, $6
        where not exists (
          select 1 from site_operating_hours h
           where h.site_id = $2 and h.outlet_id is null and h.day_of_week = $3
        )`,
      [chainId, site.id, hours.dayOfWeek, hours.opensAt, hours.closesAt, hours.closed]
    );
  }
}

/**
 * The articles. Each one lands as a record plus version 1 in `active`, with its per-outlet
 * prices, its availability, its allergen declaration and its nutrition rows — i.e. the
 * shape a review-and-approve flow produces, minus the review, which is the maker-checker
 * workstream rather than this slab.
 */
async function loadArticles(tx: Queryable, ctx: Ctx): Promise<void> {
  const creator = await tx.query<{ id: string }>(
    `select id from "user" order by created_at asc limit 1`
  );
  const creatorId = creator[0]?.id ?? null;

  for (const article of MDM_ARTICLES) {
    const chainId = ctx.chainIdByCode.get("saffron-table");
    if (!chainId) continue;
    const categoryId = ctx.articleCategoryIdByKey.get(cacheKey(chainId, article.category));
    const baseUomId = uomId(ctx, "saffron-table", article.uom);
    const taxClassId = ctx.taxClassIdByKey.get(cacheKey(chainId, article.taxClass));
    if (!categoryId || !baseUomId) continue;

    const articleRows = await tx.query<{ id: string }>(
      `insert into article (chain_id, code, category_id, article_type, status, base_uom_id)
       values ($1, $2, $3, $4, 'active', $5)
       on conflict (chain_id, code) do update
         set category_id = excluded.category_id, article_type = excluded.article_type,
             base_uom_id = excluded.base_uom_id, status = 'active', updated_at = now()
       returning id`,
      [chainId, article.code, categoryId, article.type, baseUomId]
    );
    const articleId = articleRows[0]?.id;
    if (!articleId) continue;

    const versionRows = await tx.query<{ id: string }>(
      `insert into article_version (chain_id, article_id, version, status, dietary_mark, tax_class_id,
                                    hsn_sac_code, serving_size_qty, serving_size_uom_id, calories_kcal,
                                    channel_flags, effective_from, approved_at, approved_by_user_id,
                                    created_by_user_id)
       values ($1, $2, 1, 'active', $3, $4, $5, $6, $7, $8, $9::text[], current_date, now(), $10, $10)
       on conflict (article_id, version) do update
         set status = 'active', dietary_mark = excluded.dietary_mark, tax_class_id = excluded.tax_class_id,
             hsn_sac_code = excluded.hsn_sac_code, serving_size_qty = excluded.serving_size_qty,
             serving_size_uom_id = excluded.serving_size_uom_id, calories_kcal = excluded.calories_kcal,
             channel_flags = excluded.channel_flags, updated_at = now()
       returning id`,
      [
        chainId,
        articleId,
        article.dietary,
        taxClassId,
        article.hsnSac,
        article.servingQty,
        baseUomId,
        article.calories,
        article.channels,
        creatorId,
      ]
    );
    const versionId = versionRows[0]?.id;
    if (!versionId) continue;

    await tx.query(
      `update article set current_version_id = $2, updated_at = now() where id = $1 and current_version_id is distinct from $2`,
      [articleId, versionId]
    );

    await tx.query(
      `insert into article_version_text (chain_id, article_version_id, locale, name, short_name)
       values ($1, $2, $3, $4, $5)
       on conflict (article_version_id, locale) do update
         set name = excluded.name, short_name = excluded.short_name`,
      [chainId, versionId, PLATFORM_LOCALE, article.name, article.shortName]
    );
    const hindiName = HINDI_ARTICLE_NAMES[article.code];
    if (hindiName) {
      await tx.query(
        `insert into article_version_text (chain_id, article_version_id, locale, name, short_name)
         values ($1, $2, 'hi-IN', $3, $3)
         on conflict (article_version_id, locale) do update set name = excluded.name`,
        [chainId, versionId, hindiName]
      );
    }

    // §7.4: one row per jurisdiction the chain trades in. This chain trades in one
    // (Karnataka), which is exactly the case the spec says must not turn a one-market
    // operator into a matrix-reading exercise — the sub-grid is hidden by the UI and the
    // rule is shown inline instead.
    await tx.query(
      `insert into article_version_jurisdiction (chain_id, article_version_id, jurisdiction_code,
                                                 tax_class_id, overrides)
       values ($1, $2, 'IN-KA', $3, array['taxClass']::text[])
       on conflict (article_version_id, jurisdiction_code) do update
         set tax_class_id = excluded.tax_class_id`,
      [chainId, versionId, taxClassId]
    );

    for (const outletCode of article.outlets) {
      const outlet = ctx.outletIdByCode.get(outletCode);
      if (!outlet) continue;
      const amount = article.priceOverrides?.[outletCode] ?? article.price;
      await tx.query(
        `insert into article_price (chain_id, article_id, article_version_id, outlet_id, amount,
                                    currency_code, effective_from, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, current_date, $7)
         on conflict (article_version_id, outlet_id) where effective_to is null do update
           set amount = excluded.amount, currency_code = excluded.currency_code`,
        [chainId, articleId, versionId, outlet.id, amount, outlet.currency, creatorId]
      );

      await tx.query(
        `insert into article_availability (chain_id, article_id, outlet_id, availability, source, updated_by_user_id)
         values ($1, $2, $3, $4, 'user', $5)
         on conflict (article_id, outlet_id) do update
           set availability = excluded.availability, updated_at = now()`,
        [chainId, articleId, outlet.id, article.availability ?? "available", creatorId]
      );
    }

    for (const allergenCode of article.allergens) {
      const allergenId = ctx.allergenIdByCode.get(allergenCode);
      if (!allergenId) continue;
      await tx.query(
        `insert into article_version_allergen (chain_id, article_version_id, allergen_id, may_contain, source)
         values ($1, $2, $3, false, 'declared')
         on conflict (article_version_id, allergen_id) do update
           set may_contain = false, source = 'declared'`,
        [chainId, versionId, allergenId]
      );
    }
    for (const allergenCode of article.mayContain ?? []) {
      const allergenId = ctx.allergenIdByCode.get(allergenCode);
      if (!allergenId) continue;
      await tx.query(
        `insert into article_version_allergen (chain_id, article_version_id, allergen_id, may_contain, source)
         values ($1, $2, $3, true, 'declared')
         on conflict (article_version_id, allergen_id) do update set may_contain = true`,
        [chainId, versionId, allergenId]
      );
    }

    const nutrition = article.nutrition;
    if (nutrition) {
      const rows: { code: string; value: number }[] = [
        { code: "energy_kcal", value: article.calories },
        { code: "protein", value: nutrition.protein },
        { code: "carbohydrate", value: nutrition.carbohydrate },
        { code: "total_fat", value: nutrition.totalFat },
      ];
      if (nutrition.sugars !== undefined) rows.push({ code: "sugars", value: nutrition.sugars });
      if (nutrition.sodium !== undefined) rows.push({ code: "sodium", value: nutrition.sodium });
      for (const row of rows) {
        const nutrientId = ctx.nutrientIdByCode.get(row.code);
        if (!nutrientId) continue;
        // The basis is per serving on a menu and per 100 g on a label; the same table
        // serves both, which is the whole reason the basis is a column (§13.2).
        const basis = row.code === "energy_kcal" ? "per_serving" : "per_100g";
        await tx.query(
          `insert into article_version_nutrient (chain_id, article_version_id, nutrient_id, value, basis)
           values ($1, $2, $3, $4, $5)
           on conflict (article_version_id, nutrient_id, basis) do update set value = excluded.value`,
          [chainId, versionId, nutrientId, row.value, basis]
        );
      }
    }
  }
}
