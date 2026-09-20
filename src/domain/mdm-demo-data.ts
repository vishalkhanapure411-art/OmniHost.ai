/**
 * The authored Phase 1 master-data dataset (owner direction, Sept 2026: *"use any 50
 * articles for FNB"*).
 *
 * This is **demo data, not client data**. It is a generic Indian F&B menu — no brand is
 * named anywhere in it, and nothing in it states or implies a relationship with any real
 * business. `DECISIONS.md` #3 keeps the pilot-chain decision as a *modelling reference
 * only*, and this file is written to that rule.
 *
 * Two properties the spec (§16) requires of it, and how they are met here:
 *
 *   1. **It loads through the same path a real chain's data would.** `src/domain/mdm-seed.ts`
 *      is the loader; it upserts on business code and is re-runnable, exactly as an import
 *      of a real extract must be. Nothing about the dataset is special-cased in the loader,
 *      and the spec's load order (jurisdictions → regimes/classes → UOMs + conversions →
 *      categories → allergens/nutrients → vendors → raw materials → sites/outlets →
 *      articles) is the order that loader follows.
 *   2. **Real data can replace it without a redesign.** Every record carries its business
 *      `code`, which is what an import matches on; a record the chain supplies overwrites
 *      the demo row of the same code, and demo rows that are not in the real extract are
 *      deactivated with reason `demo_data` rather than deleted (§16 item 6 — the audit log
 *      has to be able to explain the disappearance).
 *
 * Prices are in INR and tax-inclusive, because an Indian menu price normally is (spec
 * §11.1, `inclusive`) — the itemised bill edges the tax out of the price rather than
 * adding it on. HSN/SAC codes follow the PRD's GST anchor: `996331` is the SAC for
 * restaurant service, and the packaged items carry a goods heading. **These are a chain's
 * tax advisor's call, not ours** — flagged in the Phase 1 report.
 *
 * Figures are plausible rather than measured: a real chain's menu spreadsheet replaces
 * them wholesale. Where a number is a convention rather than a measurement (a `CUP`
 * conversion, a standard bottle size) the `source` field says so, because a costing
 * dispute ends with that question (§10.2).
 */

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export interface DemoJurisdiction {
  code: string;
  countryCode: string;
  subdivisionCode: string | null;
  defaultCurrency: string;
  defaultTimeZone: string;
  defaultLocale: string;
  defaultTaxRegime: string | null;
}

/**
 * **India only, deliberately.** §14: the `IN` profile's content comes from the PRD's
 * FSSAI research, and "every other profile is a *shape*, not a claim" — seeding `DE` or
 * `AE` would be inventing another market's law, which the spec forbids and this slab does
 * not do. The state-level codes exist because the demo chain trades in two states, which
 * is what makes a jurisdiction-scoped rule (and later an inter-state GST supply type)
 * demonstrable at all.
 */
export const MDM_JURISDICTIONS: DemoJurisdiction[] = [
  {
    code: "IN",
    countryCode: "IN",
    subdivisionCode: null,
    defaultCurrency: "INR",
    defaultTimeZone: "Asia/Kolkata",
    defaultLocale: "en-IN",
    defaultTaxRegime: "IN_GST",
  },
  {
    code: "IN-KA",
    countryCode: "IN",
    subdivisionCode: "KA",
    defaultCurrency: "INR",
    defaultTimeZone: "Asia/Kolkata",
    defaultLocale: "en-IN",
    defaultTaxRegime: "IN_GST",
  },
  {
    code: "IN-MH",
    countryCode: "IN",
    subdivisionCode: "MH",
    defaultCurrency: "INR",
    defaultTimeZone: "Asia/Kolkata",
    defaultLocale: "en-IN",
    defaultTaxRegime: "IN_GST",
  },
];

export interface DemoTaxRegime {
  code: string;
  labelKey: string;
  jurisdiction: string;
  level: "national" | "subnational" | "local";
  inclusiveDefault: boolean;
  priceDisplayConvention: "additive" | "inclusive" | "either";
}

export const MDM_TAX_REGIMES: DemoTaxRegime[] = [
  {
    code: "IN_GST",
    labelKey: "mdm.taxClass.regime.IN_GST",
    jurisdiction: "IN",
    level: "national",
    // An Indian menu price is normally tax-inclusive, so menu display and the itemised
    // bill edge the tax *out* of the price (§11.1).
    inclusiveDefault: true,
    priceDisplayConvention: "inclusive",
  },
];

export interface DemoTaxRateComponent {
  labelKey: string;
  ratePct: number;
  level: "central" | "state" | "local";
}

export interface DemoTaxRate {
  supplyType: "intra_state" | "inter_state" | "export" | "zero_rated" | "exempt" | "standard" | "reduced";
  ratePct: number;
  components: DemoTaxRateComponent[];
}

export interface DemoTaxClass {
  chainCode: string;
  code: string;
  name: string;
  jurisdiction: string;
  rateBasis: "ad_valorem" | "specific";
  inclusive: boolean;
  rates: DemoTaxRate[];
}

/**
 * Tax classes are **chain data** (the chain's own codes) whose *rates* mirror the law.
 * `intra_state` is CGST + SGST at half each and `inter_state` is a single IGST at the
 * full rate — which is why `supplyType` exists and why a rate is not one number (§11.1).
 * A rate is never edited in place; the loader closes the open row and opens a new one
 * (§11.2), and this dataset only ever supplies the first row.
 */
export const MDM_TAX_CLASSES: DemoTaxClass[] = [
  {
    chainCode: "saffron-table",
    code: "GST5-REST",
    name: "GST 5% — restaurant service",
    jurisdiction: "IN-KA",
    rateBasis: "ad_valorem",
    inclusive: true,
    rates: [
      {
        supplyType: "intra_state",
        ratePct: 5,
        components: [
          { labelKey: "mdm.taxClass.component.cgst", ratePct: 2.5, level: "central" },
          { labelKey: "mdm.taxClass.component.sgst", ratePct: 2.5, level: "state" },
        ],
      },
      {
        supplyType: "inter_state",
        ratePct: 5,
        components: [{ labelKey: "mdm.taxClass.component.igst", ratePct: 5, level: "central" }],
      },
      { supplyType: "exempt", ratePct: 0, components: [] },
    ],
  },
  {
    chainCode: "saffron-table",
    code: "GST12-PACK",
    name: "GST 12% — packaged food and bottled beverages",
    jurisdiction: "IN-KA",
    rateBasis: "ad_valorem",
    inclusive: true,
    rates: [
      {
        supplyType: "intra_state",
        ratePct: 12,
        components: [
          { labelKey: "mdm.taxClass.component.cgst", ratePct: 6, level: "central" },
          { labelKey: "mdm.taxClass.component.sgst", ratePct: 6, level: "state" },
        ],
      },
      {
        supplyType: "inter_state",
        ratePct: 12,
        components: [{ labelKey: "mdm.taxClass.component.igst", ratePct: 12, level: "central" }],
      },
    ],
  },
  {
    chainCode: "saffron-table",
    code: "GST18-RETAIL",
    name: "GST 18% — packaged retail merchandise",
    jurisdiction: "IN-KA",
    rateBasis: "ad_valorem",
    inclusive: true,
    rates: [
      {
        supplyType: "intra_state",
        ratePct: 18,
        components: [
          { labelKey: "mdm.taxClass.component.cgst", ratePct: 9, level: "central" },
          { labelKey: "mdm.taxClass.component.sgst", ratePct: 9, level: "state" },
        ],
      },
      {
        supplyType: "inter_state",
        ratePct: 18,
        components: [{ labelKey: "mdm.taxClass.component.igst", ratePct: 18, level: "central" }],
      },
    ],
  },
  {
    chainCode: "coastal-catch",
    code: "GST5-REST",
    name: "GST 5% — restaurant service",
    jurisdiction: "IN-MH",
    rateBasis: "ad_valorem",
    inclusive: true,
    rates: [
      {
        supplyType: "intra_state",
        ratePct: 5,
        components: [
          { labelKey: "mdm.taxClass.component.cgst", ratePct: 2.5, level: "central" },
          { labelKey: "mdm.taxClass.component.sgst", ratePct: 2.5, level: "state" },
        ],
      },
      {
        supplyType: "inter_state",
        ratePct: 5,
        components: [{ labelKey: "mdm.taxClass.component.igst", ratePct: 5, level: "central" }],
      },
    ],
  },
];

export interface DemoUom {
  code: string;
  dimension: "mass" | "volume" | "count" | "length" | "time" | "energy" | "other";
  system: "metric" | "imperial" | "count" | "none";
  precision: number;
  rounding: "half_up" | "half_even" | "floor" | "ceiling";
  baseUnitOfDimension: boolean;
  /** null = the platform-curated set; a chain code = that chain added it (§10.1). */
  chainCode: string | null;
  unitCategory: "order" | "issue" | "stockkeeping" | "price" | "none";
  searchAliases: string[];
}

/**
 * `code` is the contract (the ledger, the invoice and a vendor's price list carry it) and
 * is never translated; the label is resolved from the code. The first block is the
 * UN/CEFACT-recognised set the spec prefers; the small chain block holds the service
 * units a restaurant actually sells in (`POR`, `GLS`, `PLT`) — a guest buys a portion,
 * not a kilogram.
 */
export const MDM_UOMS: DemoUom[] = [
  mk("G", "mass", "metric", 3, true, "stockkeeping"),
  mk("KG", "mass", "metric", 3, false, "order"),
  mk("MG", "mass", "metric", 3, false, "issue"),
  mk("OZ", "mass", "imperial", 3, false, "issue"),
  mk("LB", "mass", "imperial", 3, false, "order"),
  mk("ML", "volume", "metric", 3, true, "issue"),
  mk("L", "volume", "metric", 3, false, "order"),
  mk("CUP", "volume", "none", 3, false, "issue"),
  mk("TBSP", "volume", "none", 3, false, "issue"),
  mk("TSP", "volume", "none", 3, false, "issue"),
  mk("QT", "volume", "imperial", 3, false, "issue"),
  mk("GAL", "volume", "imperial", 3, false, "order"),
  mk("BT", "volume", "none", 0, false, "price"),
  mk("CAN", "volume", "none", 0, false, "issue"),
  mk("PC", "count", "count", 0, true, "stockkeeping"),
  mk("DZ", "count", "count", 0, false, "order"),
  mk("CS", "count", "count", 0, false, "order"),
  mk("PK", "count", "count", 0, false, "order"),
  mk("BAG", "mass", "metric", 0, false, "order"),
  {
    code: "POR",
    dimension: "count",
    system: "count",
    precision: 0,
    rounding: "half_up",
    baseUnitOfDimension: false,
    chainCode: "saffron-table",
    unitCategory: "price",
    searchAliases: ["portion", "plate"],
  },
  {
    code: "GLS",
    dimension: "count",
    system: "count",
    precision: 0,
    rounding: "half_up",
    baseUnitOfDimension: false,
    chainCode: "saffron-table",
    unitCategory: "price",
    searchAliases: ["glass"],
  },
  {
    code: "PLT",
    dimension: "count",
    system: "count",
    precision: 0,
    rounding: "half_up",
    baseUnitOfDimension: false,
    chainCode: "coastal-catch",
    unitCategory: "price",
    searchAliases: ["plate"],
  },
  // The same code, the same chain-scoped scope, for the other chain: `scope` is chain-wide
  // by design, so two chains that both plate a dosa each hold their own row rather than one
  // chain reaching into another's unit list.
  {
    code: "PLT",
    dimension: "count",
    system: "count",
    precision: 0,
    rounding: "half_up",
    baseUnitOfDimension: false,
    chainCode: "saffron-table",
    unitCategory: "price",
    searchAliases: ["plate"],
  },
];

function mk(
  code: string,
  dimension: DemoUom["dimension"],
  system: DemoUom["system"],
  precision: number,
  baseUnitOfDimension: boolean,
  unitCategory: DemoUom["unitCategory"]
): DemoUom {
  return {
    code,
    dimension,
    system,
    precision,
    rounding: "half_up",
    baseUnitOfDimension,
    chainCode: null,
    unitCategory,
    searchAliases: [],
  };
}

export interface DemoConversion {
  fromUom: string;
  toUom: string;
  factor: number;
  /** NULL = universal; a value = this market's rule. This is the international field. */
  jurisdiction: string | null;
  source: string;
  chainCode: string | null;
}

/**
 * Every factor below is exact where an exact value exists (an inch is defined in metres,
 * a pound in kilograms) and is stored as an exact decimal so a thousand recipe
 * multiplications cannot drift it.
 *
 * `CUP` carries **two rows on purpose**: the metric cup is 250 ml universally, and the
 * Indian recipe convention is the 240 ml cup — the same code with two answers, resolved by
 * the market the recipe is costed in (§10.2). That is the whole reason `jurisdiction`
 * exists on this table, and it is the one row here a chain should confirm rather than
 * assume.
 */
export const MDM_CONVERSIONS: DemoConversion[] = [
  { fromUom: "KG", toUom: "G", factor: 1000, jurisdiction: null, source: "SI (exact)", chainCode: null },
  { fromUom: "MG", toUom: "G", factor: 0.001, jurisdiction: null, source: "SI (exact)", chainCode: null },
  { fromUom: "LB", toUom: "G", factor: 453.59237, jurisdiction: null, source: "international avoirdupois pound (exact)", chainCode: null },
  { fromUom: "OZ", toUom: "G", factor: 28.349523125, jurisdiction: null, source: "international avoirdupois ounce (exact)", chainCode: null },
  { fromUom: "L", toUom: "ML", factor: 1000, jurisdiction: null, source: "SI (exact)", chainCode: null },
  { fromUom: "CUP", toUom: "ML", factor: 250, jurisdiction: null, source: "metric cup", chainCode: null },
  { fromUom: "CUP", toUom: "ML", factor: 240, jurisdiction: "IN", source: "Indian recipe convention (240 ml cup) — confirm with the chain", chainCode: "saffron-table" },
  { fromUom: "TBSP", toUom: "ML", factor: 15, jurisdiction: null, source: "metric tablespoon", chainCode: null },
  { fromUom: "TSP", toUom: "ML", factor: 5, jurisdiction: null, source: "metric teaspoon", chainCode: null },
  { fromUom: "QT", toUom: "ML", factor: 1136.5225, jurisdiction: null, source: "imperial quart = 2 imperial pints (exact)", chainCode: null },
  { fromUom: "GAL", toUom: "ML", factor: 4546.09, jurisdiction: null, source: "imperial gallon (exact)", chainCode: null },
  { fromUom: "BT", toUom: "ML", factor: 750, jurisdiction: null, source: "chain standard bottle size (750 ml)", chainCode: "saffron-table" },
  { fromUom: "CAN", toUom: "ML", factor: 330, jurisdiction: null, source: "chain standard can size (330 ml)", chainCode: "saffron-table" },
  { fromUom: "DZ", toUom: "PC", factor: 12, jurisdiction: null, source: "dozen", chainCode: null },
  { fromUom: "CS", toUom: "PC", factor: 24, jurisdiction: null, source: "chain standard case (24) — confirm per vendor", chainCode: "saffron-table" },
  { fromUom: "BAG", toUom: "G", factor: 25000, jurisdiction: null, source: "chain standard bag (25 kg) — confirm per vendor", chainCode: "saffron-table" },
];

// ---------------------------------------------------------------------------
// Allergens, nutrients and the jurisdiction profile
// ---------------------------------------------------------------------------

export interface DemoAllergen {
  code: string;
  aliases: string[];
}

/**
 * The union across markets (§13.1), so a market's set is a query rather than a migration.
 * The first nine are the PRD's mandatory Indian set; the last five are the rest of the
 * internationally recognised group and are declarable in India without being mandated.
 */
export const MDM_ALLERGENS: DemoAllergen[] = [
  { code: "cereals_gluten", aliases: ["gluten", "wheat", "maida", "atta", "rava", "semolina"] },
  { code: "crustaceans", aliases: ["prawn", "shrimp", "crab", "lobster"] },
  { code: "eggs", aliases: ["egg", "anda"] },
  { code: "fish", aliases: ["fish", "machli", "seer", "pomfret"] },
  { code: "peanuts", aliases: ["peanut", "groundnut", "moongphali", "shengdana"] },
  { code: "soybeans", aliases: ["soy", "soya", "soybean"] },
  { code: "milk", aliases: ["milk", "doodh", "dairy", "ghee", "butter", "cream", "paneer", "curd", "yoghurt", "khoya"] },
  { code: "tree_nuts", aliases: ["nuts", "almond", "badam", "cashew", "kaju", "pista", "walnut"] },
  { code: "sulphites", aliases: ["sulphite", "sulfite", "preservative"] },
  { code: "sesame", aliases: ["sesame", "til", "gingelly"] },
  { code: "celery", aliases: ["celery"] },
  { code: "mustard", aliases: ["mustard", "rai", "sarson"] },
  { code: "lupin", aliases: ["lupin"] },
  { code: "molluscs", aliases: ["mollusc", "squid", "octopus", "clam", "oyster"] },
];

/** The PRD's mandatory Indian set, and the extras that are declarable but not required. */
export const MDM_IN_MANDATORY_ALLERGENS = [
  "cereals_gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "soybeans",
  "milk",
  "tree_nuts",
  "sulphites",
];

export interface DemoNutrient {
  code: string;
  unit: string;
  defaultBasis: string;
  precision: number;
}

export const MDM_NUTRIENTS: DemoNutrient[] = [
  { code: "energy_kcal", unit: "kcal", defaultBasis: "per_serving", precision: 0 },
  { code: "protein", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "carbohydrate", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "total_fat", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "saturated_fat", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "trans_fat", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "sugars", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "sodium", unit: "mg", defaultBasis: "per_100g", precision: 1 },
  { code: "dietary_fibre", unit: "g", defaultBasis: "per_100g", precision: 2 },
  { code: "cholesterol", unit: "mg", defaultBasis: "per_100g", precision: 1 },
];

export interface DemoFieldRule {
  entity: string;
  field: string;
  requirement: "required" | "recommended" | "forbidden" | "optional";
  validator: string | null;
  noteKey: string | null;
  legalRef: string;
}

/**
 * The `IN` profile (§14). Every rule here is traceable to the PRD's own FSSAI and GST
 * research; nothing in this list is an invention about another market's law. `legalRef` is
 * text on purpose — a reviewer audits the profile rather than trusting it.
 */
export const MDM_IN_FIELD_RULES: DemoFieldRule[] = [
  { entity: "article", field: "name", requirement: "required", validator: null, noteKey: "mdm.jurisdiction.note.menuName", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — menu display" },
  { entity: "article", field: "dietaryMark", requirement: "required", validator: "dietary_mark", noteKey: "mdm.jurisdiction.note.vegMark", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — veg/non-veg symbol" },
  { entity: "article", field: "taxClass", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — rate notification" },
  { entity: "article", field: "hsnSacCode", requirement: "required", validator: "hsn_sac", noteKey: "mdm.jurisdiction.note.hsnSac", legalRef: "CGST Act, 2017 — HSN/SAC classification" },
  { entity: "article", field: "servingSize", requirement: "required", validator: null, noteKey: "mdm.jurisdiction.note.servingSize", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — calorie display alongside serving size" },
  { entity: "article", field: "caloriesKcal", requirement: "required", validator: "non_negative", noteKey: "mdm.jurisdiction.note.calories", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — calorie display" },
  { entity: "article", field: "allergens", requirement: "required", validator: null, noteKey: "mdm.jurisdiction.note.allergens", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — allergen declaration" },
  { entity: "article", field: "ingredientDeclaration", requirement: "recommended", validator: null, noteKey: null, legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — ingredient information on request" },
  { entity: "article", field: "nutrition", requirement: "optional", validator: null, noteKey: "mdm.jurisdiction.note.nutritionOnRequest", legalRef: "PRD: detailed nutrition and organic-ingredient information available on request" },
  { entity: "raw_material", field: "allergens", requirement: "required", validator: null, noteKey: "mdm.jurisdiction.note.allergens", legalRef: "FSSAI (Labelling and Display) Regulations, 2020 — allergen declaration" },
  { entity: "vendor", field: "taxRegistrations", requirement: "required", validator: "gstin_shape", noteKey: "mdm.jurisdiction.note.gstin", legalRef: "CGST Act, 2017 — registration" },
  { entity: "vendor", field: "address", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — tax invoice particulars" },
  { entity: "vendor", field: "billingCurrency", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — invoice currency" },
  { entity: "site", field: "jurisdiction", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — place of supply" },
  { entity: "site", field: "address", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — tax invoice particulars" },
  { entity: "site", field: "currency", requirement: "required", validator: null, noteKey: null, legalRef: "CGST Act, 2017 — invoice currency" },
];

export interface DemoDisplayRule {
  surface: "menu" | "cds" | "app" | "label";
  field: string;
  presentation: string;
}

export const MDM_IN_DISPLAY_RULES: DemoDisplayRule[] = [
  { surface: "menu", field: "caloriesKcal", presentation: "adjacent_to_item" },
  { surface: "menu", field: "dietaryMark", presentation: "symbol_adjacent" },
  { surface: "menu", field: "allergens", presentation: "declared_or_on_request" },
  { surface: "app", field: "caloriesKcal", presentation: "adjacent_to_item" },
  { surface: "app", field: "dietaryMark", presentation: "symbol_adjacent" },
];

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const MDM_ARTICLE_CATEGORIES: { chainCode: string; code: string; name: string; sortOrder: number }[] = [
  { chainCode: "saffron-table", code: "STARTERS-VEG", name: "Starters — Vegetarian", sortOrder: 10 },
  { chainCode: "saffron-table", code: "STARTERS-NONVEG", name: "Starters — Non-vegetarian", sortOrder: 20 },
  { chainCode: "saffron-table", code: "SOUPS-SALADS", name: "Soups & Salads", sortOrder: 30 },
  { chainCode: "saffron-table", code: "MAINS-VEG", name: "Main Course — Vegetarian", sortOrder: 40 },
  { chainCode: "saffron-table", code: "MAINS-NONVEG", name: "Main Course — Non-vegetarian", sortOrder: 50 },
  { chainCode: "saffron-table", code: "BREADS-RICE", name: "Breads & Rice", sortOrder: 60 },
  { chainCode: "saffron-table", code: "SOUTH-INDIAN", name: "South Indian", sortOrder: 70 },
  { chainCode: "saffron-table", code: "DESSERTS", name: "Desserts", sortOrder: 80 },
  { chainCode: "saffron-table", code: "HOT-BEVERAGES", name: "Hot Beverages", sortOrder: 90 },
  { chainCode: "saffron-table", code: "COLD-BEVERAGES", name: "Cold Beverages", sortOrder: 100 },
  { chainCode: "saffron-table", code: "BAR-MOCKTAILS", name: "Bar & Mocktails", sortOrder: 110 },
  { chainCode: "saffron-table", code: "PACKAGED-RETAIL", name: "Packaged & Retail", sortOrder: 120 },
  { chainCode: "coastal-catch", code: "CC-STARTERS", name: "Coastal Starters", sortOrder: 10 },
  { chainCode: "coastal-catch", code: "CC-MAINS", name: "Coastal Mains", sortOrder: 20 },
  { chainCode: "coastal-catch", code: "CC-RICE-BREADS", name: "Rice & Breads", sortOrder: 30 },
  { chainCode: "coastal-catch", code: "CC-DESSERTS", name: "Desserts", sortOrder: 40 },
  { chainCode: "coastal-catch", code: "CC-BEVERAGES", name: "Beverages", sortOrder: 50 },
];

export const MDM_RAW_MATERIAL_CATEGORIES: { chainCode: string; code: string; name: string; sortOrder: number }[] = [
  { chainCode: "saffron-table", code: "VEG", name: "Vegetables", sortOrder: 10 },
  { chainCode: "saffron-table", code: "FRUIT", name: "Fruit", sortOrder: 20 },
  { chainCode: "saffron-table", code: "MEAT", name: "Meat & Poultry", sortOrder: 30 },
  { chainCode: "saffron-table", code: "SEAFOOD", name: "Seafood", sortOrder: 40 },
  { chainCode: "saffron-table", code: "DAIRY", name: "Dairy", sortOrder: 50 },
  { chainCode: "saffron-table", code: "GRAIN", name: "Grains & Flour", sortOrder: 60 },
  { chainCode: "saffron-table", code: "SPICE", name: "Spices & Condiments", sortOrder: 70 },
  { chainCode: "saffron-table", code: "OIL", name: "Oils & Fats", sortOrder: 80 },
  { chainCode: "saffron-table", code: "BEVERAGE", name: "Beverages & Mixers", sortOrder: 90 },
  { chainCode: "saffron-table", code: "PACK", name: "Packaging & Disposables", sortOrder: 100 },
  { chainCode: "coastal-catch", code: "CC-SEAFOOD", name: "Seafood", sortOrder: 10 },
  { chainCode: "coastal-catch", code: "CC-PRODUCE", name: "Vegetables & Fruit", sortOrder: 20 },
  { chainCode: "coastal-catch", code: "CC-PANTRY", name: "Pantry & Spices", sortOrder: 30 },
];

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export interface DemoVendor {
  chainCode: string;
  code: string;
  legalName: string;
  tradeName: string;
  vendorType: "manufacturer" | "distributor" | "wholesaler" | "importer" | "service" | "logistics";
  jurisdiction: string;
  gstin: string;
  address: {
    line1: string;
    locality: string;
    region: string;
    postalCode: string;
    countryCode: string;
  };
  contact: { kind: "ordering" | "accounts"; name: string; email: string; phone: string };
  paymentTerms: { kind: "net_days" | "eom" | "cod" | "prepaid"; days: number | null };
  creditLimit: number;
  categories: string[];
  leadTimeDays: number;
  documents: { kind: string; reference: string; expiresInDays: number }[];
}

/**
 * Generic suppliers, invented for the demo and deliberately not resembling any real
 * business. GSTINs use the real 15-character shape (state code, PAN, entity code, `Z`,
 * checksum) with invented values — the shape matters because the jurisdiction profile
 * validates it, and the values are obviously demo (`AAAAA0000A`) so nobody mistakes one
 * for a live registration.
 */
export const MDM_VENDORS: DemoVendor[] = [
  {
    chainCode: "saffron-table",
    code: "VEN-0001",
    legalName: "Deccan Fresh Produce LLP",
    tradeName: "Deccan Fresh",
    vendorType: "distributor",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A1Z5",
    address: { line1: "12, Market Yard Road", locality: "Bengaluru", region: "Karnataka", postalCode: "560034", countryCode: "IN" },
    contact: { kind: "ordering", name: "Ravi Kumar", email: "orders@deccanfresh.example", phone: "+91 80 4000 1001" },
    paymentTerms: { kind: "net_days", days: 15 },
    creditLimit: 250000,
    categories: ["VEG", "FRUIT"],
    leadTimeDays: 1,
    documents: [
      { kind: "fssai_licence", reference: "11223344556677", expiresInDays: 420 },
      { kind: "gst_certificate", reference: "29AAAAA0000A1Z5", expiresInDays: 900 },
    ],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0002",
    legalName: "Sahyadri Dairy Supplies Pvt Ltd",
    tradeName: "Sahyadri Dairy",
    vendorType: "distributor",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A2Z4",
    address: { line1: "44, Industrial Suburb", locality: "Bengaluru", region: "Karnataka", postalCode: "560022", countryCode: "IN" },
    contact: { kind: "ordering", name: "Meena Shetty", email: "supply@sahyadridairy.example", phone: "+91 80 4000 1002" },
    paymentTerms: { kind: "net_days", days: 7 },
    creditLimit: 150000,
    categories: ["DAIRY"],
    leadTimeDays: 1,
    documents: [{ kind: "fssai_licence", reference: "22334455667788", expiresInDays: 260 }],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0003",
    legalName: "Godavari Grain Traders",
    tradeName: "Godavari Grains",
    vendorType: "wholesaler",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A3Z3",
    address: { line1: "8, APMC Yard", locality: "Bengaluru", region: "Karnataka", postalCode: "560079", countryCode: "IN" },
    contact: { kind: "ordering", name: "Suresh Reddy", email: "sales@godavarigrain.example", phone: "+91 80 4000 1003" },
    paymentTerms: { kind: "net_days", days: 30 },
    creditLimit: 400000,
    categories: ["GRAIN", "OIL"],
    leadTimeDays: 2,
    documents: [{ kind: "gst_certificate", reference: "29AAAAA0000A3Z3", expiresInDays: 800 }],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0004",
    legalName: "Malabar Spice Depot",
    tradeName: "Malabar Spices",
    vendorType: "wholesaler",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A4Z2",
    address: { line1: "5, Spice Market Lane", locality: "Bengaluru", region: "Karnataka", postalCode: "560053", countryCode: "IN" },
    contact: { kind: "ordering", name: "Anita Rao", email: "orders@malabarspice.example", phone: "+91 80 4000 1004" },
    paymentTerms: { kind: "net_days", days: 21 },
    creditLimit: 200000,
    categories: ["SPICE"],
    leadTimeDays: 2,
    documents: [{ kind: "fssai_licence", reference: "33445566778899", expiresInDays: 45 }],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0005",
    legalName: "Chandragiri Poultry & Meats",
    tradeName: "Chandragiri Meats",
    vendorType: "distributor",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A5Z1",
    address: { line1: "77, Slaughterhouse Road", locality: "Bengaluru", region: "Karnataka", postalCode: "560032", countryCode: "IN" },
    contact: { kind: "ordering", name: "Imran Pasha", email: "orders@chandragirimeats.example", phone: "+91 80 4000 1005" },
    paymentTerms: { kind: "cod", days: null },
    creditLimit: 100000,
    categories: ["MEAT"],
    leadTimeDays: 1,
    documents: [
      { kind: "fssai_licence", reference: "44556677889900", expiresInDays: 180 },
      { kind: "insurance", reference: "POL-2026-8811", expiresInDays: 120 },
    ],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0006",
    legalName: "Konkan Coast Seafoods LLP",
    tradeName: "Konkan Seafoods",
    vendorType: "distributor",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A6Z0",
    address: { line1: "3, Fishery Harbour Road", locality: "Mangaluru", region: "Karnataka", postalCode: "575001", countryCode: "IN" },
    contact: { kind: "ordering", name: "Latha Poojary", email: "orders@konkanseafood.example", phone: "+91 824 400 1006" },
    paymentTerms: { kind: "net_days", days: 7 },
    creditLimit: 120000,
    categories: ["SEAFOOD"],
    leadTimeDays: 2,
    documents: [{ kind: "fssai_licence", reference: "55667788990011", expiresInDays: 300 }],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0007",
    legalName: "Southline Beverage Distributors",
    tradeName: "Southline Beverages",
    vendorType: "distributor",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A7Z9",
    address: { line1: "21, Warehouse Block", locality: "Bengaluru", region: "Karnataka", postalCode: "560068", countryCode: "IN" },
    contact: { kind: "ordering", name: "Prakash Naidu", email: "orders@southlinebev.example", phone: "+91 80 4000 1007" },
    paymentTerms: { kind: "net_days", days: 15 },
    creditLimit: 180000,
    categories: ["BEVERAGE"],
    leadTimeDays: 2,
    documents: [{ kind: "fssai_licence", reference: "66778899001122", expiresInDays: 500 }],
  },
  {
    chainCode: "saffron-table",
    code: "VEN-0008",
    legalName: "Vindhya Packaging Supplies",
    tradeName: "Vindhya Packaging",
    vendorType: "manufacturer",
    jurisdiction: "IN-KA",
    gstin: "29AAAAA0000A8Z8",
    address: { line1: "9, Peenya Industrial Area", locality: "Bengaluru", region: "Karnataka", postalCode: "560058", countryCode: "IN" },
    contact: { kind: "ordering", name: "Divya Menon", email: "sales@vindhyapack.example", phone: "+91 80 4000 1008" },
    paymentTerms: { kind: "eom", days: null },
    creditLimit: 90000,
    categories: ["PACK"],
    leadTimeDays: 4,
    documents: [{ kind: "gst_certificate", reference: "29AAAAA0000A8Z8", expiresInDays: 700 }],
  },
  {
    chainCode: "coastal-catch",
    code: "VEN-1001",
    legalName: "Sahyadri Coastal Supply Co.",
    tradeName: "Sahyadri Coastal",
    vendorType: "distributor",
    jurisdiction: "IN-MH",
    gstin: "27AAAAA0000B1Z4",
    address: { line1: "14, Sassoon Dock", locality: "Mumbai", region: "Maharashtra", postalCode: "400005", countryCode: "IN" },
    contact: { kind: "ordering", name: "Nitin Sawant", email: "orders@sahyadricoastal.example", phone: "+91 22 4000 2001" },
    paymentTerms: { kind: "net_days", days: 10 },
    creditLimit: 160000,
    categories: ["CC-SEAFOOD", "CC-PRODUCE"],
    leadTimeDays: 1,
    documents: [{ kind: "fssai_licence", reference: "77889900112233", expiresInDays: 210 }],
  },
  {
    chainCode: "coastal-catch",
    code: "VEN-1002",
    legalName: "Konkan Pantry Wholesale",
    tradeName: "Konkan Pantry",
    vendorType: "wholesaler",
    jurisdiction: "IN-MH",
    gstin: "27AAAAA0000B2Z3",
    address: { line1: "6, Vashi Market", locality: "Navi Mumbai", region: "Maharashtra", postalCode: "400703", countryCode: "IN" },
    contact: { kind: "ordering", name: "Sneha Deshpande", email: "sales@konkanpantry.example", phone: "+91 22 4000 2002" },
    paymentTerms: { kind: "net_days", days: 20 },
    creditLimit: 220000,
    categories: ["CC-PANTRY"],
    leadTimeDays: 3,
    documents: [{ kind: "gst_certificate", reference: "27AAAAA0000B2Z3", expiresInDays: 640 }],
  },
];

// ---------------------------------------------------------------------------
// Raw materials
// ---------------------------------------------------------------------------

export interface DemoRawMaterial {
  chainCode: string;
  code: string;
  name: string;
  category: string;
  baseUom: string;
  packUom: string | null;
  packQty: number | null;
  /** Standard cost: amount in INR, per `costPer` of `costUom`. */
  cost: number;
  costPer: number;
  costUom: string;
  costSource: "vendor_item" | "quote" | "manual";
  storageType: "ambient" | "chilled" | "frozen" | "deep_frozen" | "dry" | "bar";
  shelfLifeDays: number | null;
  shelfLifeBasis: "ambient" | "chilled" | "frozen" | "dry" | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  trimYieldPct: number | null;
  allergens: string[];
  trackStock: boolean;
  /** Approved suppliers: vendor code → the vendor's own item code and lead time. */
  vendors: { vendor: string; vendorItemCode: string; leadTimeDays: number; preferred: boolean }[];
}

/**
 * ~50 raw materials covering the dishes in this dataset. Costs are demo figures in INR
 * per the stated unit; `trimYieldPct` is a default prep loss a recipe line may override.
 * Allergens are declared here as the *component* truth — an article's allergens roll up
 * from these in Phase 2, and a derived entry is read-only so nobody can "fix" a roll-up
 * by hand (§7.1).
 */
export const MDM_RAW_MATERIALS: DemoRawMaterial[] = [
  rm("RM-0001", "Tomato (local)", "VEG", "KG", "PK", 10, 34, 1, "KG", "vendor_item", "chilled", 5, "chilled", 8, 12, 4, [], "VEN-0001"),
  rm("RM-0002", "Onion", "VEG", "KG", "BAG", 25, 28, 1, "KG", "vendor_item", "dry", 30, "dry", null, null, 8, [], "VEN-0001"),
  rm("RM-0003", "Potato", "VEG", "KG", "BAG", 25, 30, 1, "KG", "vendor_item", "dry", 21, "dry", null, null, 12, [], "VEN-0001"),
  rm("RM-0004", "Green Peas (shelled)", "VEG", "KG", "PK", 1, 96, 1, "KG", "vendor_item", "frozen", 90, "frozen", -18, -15, 0, [], "VEN-0001"),
  rm("RM-0005", "Spinach", "VEG", "KG", "PK", 5, 42, 1, "KG", "vendor_item", "chilled", 3, "chilled", 2, 6, 22, [], "VEN-0001"),
  rm("RM-0006", "Capsicum (green)", "VEG", "KG", "PK", 5, 78, 1, "KG", "vendor_item", "chilled", 6, "chilled", 8, 12, 10, [], "VEN-0001"),
  rm("RM-0007", "Green Chilli", "VEG", "KG", "PK", 2, 62, 1, "KG", "vendor_item", "chilled", 8, "chilled", 8, 12, 5, [], "VEN-0001"),
  rm("RM-0008", "Coriander Leaves", "VEG", "KG", "PK", 1, 55, 1, "KG", "vendor_item", "chilled", 3, "chilled", 4, 8, 18, [], "VEN-0001"),
  rm("RM-0009", "Ginger (fresh)", "VEG", "KG", "PK", 5, 145, 1, "KG", "vendor_item", "chilled", 14, "chilled", 10, 15, 12, [], "VEN-0001"),
  rm("RM-0010", "Garlic (peeled)", "VEG", "KG", "PK", 5, 165, 1, "KG", "vendor_item", "chilled", 14, "chilled", 8, 12, 5, [], "VEN-0001"),
  rm("RM-0011", "Lemon", "FRUIT", "KG", "PK", 5, 88, 1, "KG", "vendor_item", "chilled", 12, "chilled", 10, 14, 8, [], "VEN-0001"),
  rm("RM-0012", "Banana (ripe)", "FRUIT", "KG", "DZ", 1, 58, 1, "KG", "vendor_item", "ambient", 4, "ambient", 18, 24, 15, [], "VEN-0001"),
  rm("RM-0013", "Watermelon", "FRUIT", "KG", "PC", 1, 32, 1, "KG", "vendor_item", "chilled", 7, "chilled", 8, 12, 30, [], "VEN-0001"),
  rm("RM-0014", "Mango Pulp (tinned)", "FRUIT", "KG", "CAN", 1, 210, 1, "KG", "vendor_item", "ambient", 240, "ambient", 10, 30, 0, [], "VEN-0007"),
  rm("RM-0015", "Chicken (boneless)", "MEAT", "KG", "PK", 5, 268, 1, "KG", "vendor_item", "chilled", 2, "chilled", 0, 4, 6, [], "VEN-0005"),
  rm("RM-0016", "Chicken (curry cut, bone-in)", "MEAT", "KG", "PK", 5, 218, 1, "KG", "vendor_item", "chilled", 2, "chilled", 0, 4, 10, [], "VEN-0005"),
  rm("RM-0017", "Mutton (curry cut)", "MEAT", "KG", "PK", 2, 745, 1, "KG", "vendor_item", "chilled", 2, "chilled", 0, 4, 14, [], "VEN-0005"),
  rm("RM-0018", "Eggs", "MEAT", "PC", "CS", 1, 7.2, 1, "PC", "vendor_item", "chilled", 21, "chilled", 4, 8, 0, ["eggs"], "VEN-0005"),
  rm("RM-0019", "Prawns (medium, peeled)", "SEAFOOD", "KG", "PK", 1, 615, 1, "KG", "vendor_item", "frozen", 120, "frozen", -18, -15, 5, ["crustaceans"], "VEN-0006"),
  rm("RM-0020", "Seer Fish (surmai) fillet", "SEAFOOD", "KG", "PK", 1, 780, 1, "KG", "vendor_item", "frozen", 90, "frozen", -18, -15, 8, ["fish"], "VEN-0006"),
  rm("RM-0021", "Pomfret (whole, cleaned)", "SEAFOOD", "KG", "PK", 1, 890, 1, "KG", "vendor_item", "frozen", 90, "frozen", -18, -15, 12, ["fish"], "VEN-0006"),
  rm("RM-0022", "Full Cream Milk", "DAIRY", "L", "PK", 1, 68, 1, "L", "vendor_item", "chilled", 2, "chilled", 2, 6, 0, ["milk"], "VEN-0002"),
  rm("RM-0023", "Fresh Cream", "DAIRY", "L", "PK", 1, 285, 1, "L", "vendor_item", "chilled", 14, "chilled", 2, 6, 0, ["milk"], "VEN-0002"),
  rm("RM-0024", "Butter (unsalted)", "DAIRY", "KG", "PK", 1, 545, 1, "KG", "vendor_item", "chilled", 60, "chilled", 2, 6, 0, ["milk"], "VEN-0002"),
  rm("RM-0025", "Ghee", "DAIRY", "KG", "PK", 1, 690, 1, "KG", "vendor_item", "ambient", 180, "ambient", 15, 25, 0, ["milk"], "VEN-0002"),
  rm("RM-0026", "Paneer", "DAIRY", "KG", "PK", 1, 385, 1, "KG", "vendor_item", "chilled", 7, "chilled", 2, 6, 0, ["milk"], "VEN-0002"),
  rm("RM-0027", "Curd (yoghurt)", "DAIRY", "KG", "PK", 1, 82, 1, "KG", "vendor_item", "chilled", 5, "chilled", 2, 6, 0, ["milk"], "VEN-0002"),
  rm("RM-0028", "Basmati Rice", "GRAIN", "KG", "BAG", 25, 128, 1, "KG", "vendor_item", "dry", 365, "dry", null, null, 0, [], "VEN-0003"),
  rm("RM-0029", "Sona Masoori Rice", "GRAIN", "KG", "BAG", 25, 62, 1, "KG", "vendor_item", "dry", 365, "dry", null, null, 0, [], "VEN-0003"),
  rm("RM-0030", "Refined Wheat Flour (maida)", "GRAIN", "KG", "BAG", 25, 48, 1, "KG", "vendor_item", "dry", 180, "dry", null, null, 0, ["cereals_gluten"], "VEN-0003"),
  rm("RM-0031", "Whole Wheat Flour (atta)", "GRAIN", "KG", "BAG", 25, 52, 1, "KG", "vendor_item", "dry", 120, "dry", null, null, 0, ["cereals_gluten"], "VEN-0003"),
  rm("RM-0032", "Rava (semolina)", "GRAIN", "KG", "BAG", 10, 58, 1, "KG", "vendor_item", "dry", 180, "dry", null, null, 0, ["cereals_gluten"], "VEN-0003"),
  rm("RM-0033", "Gram Flour (besan)", "GRAIN", "KG", "BAG", 10, 92, 1, "KG", "vendor_item", "dry", 150, "dry", null, null, 0, [], "VEN-0003"),
  rm("RM-0034", "Rice Flour", "GRAIN", "KG", "BAG", 10, 56, 1, "KG", "vendor_item", "dry", 180, "dry", null, null, 0, [], "VEN-0003"),
  rm("RM-0035", "Turmeric Powder", "SPICE", "KG", "PK", 1, 285, 1, "KG", "vendor_item", "dry", 365, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0036", "Red Chilli Powder", "SPICE", "KG", "PK", 1, 420, 1, "KG", "vendor_item", "dry", 300, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0037", "Coriander Powder", "SPICE", "KG", "PK", 1, 265, 1, "KG", "vendor_item", "dry", 300, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0038", "Garam Masala", "SPICE", "KG", "PK", 1, 640, 1, "KG", "vendor_item", "dry", 240, "dry", null, null, 0, ["mustard"], "VEN-0004"),
  rm("RM-0039", "Cumin Seeds", "SPICE", "KG", "PK", 1, 720, 1, "KG", "vendor_item", "dry", 300, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0040", "Salt (iodised)", "SPICE", "KG", "PK", 1, 22, 1, "KG", "vendor_item", "dry", 730, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0041", "Sugar", "SPICE", "KG", "BAG", 50, 46, 1, "KG", "vendor_item", "dry", 730, "dry", null, null, 0, [], "VEN-0003"),
  rm("RM-0042", "Tamarind Paste", "SPICE", "KG", "PK", 1, 165, 1, "KG", "vendor_item", "ambient", 180, "ambient", 10, 30, 0, ["sulphites"], "VEN-0004"),
  rm("RM-0043", "Tomato Ketchup", "SPICE", "KG", "BT", 1, 145, 1, "KG", "vendor_item", "ambient", 240, "ambient", 10, 30, 0, ["sulphites"], "VEN-0004"),
  rm("RM-0044", "Soy Sauce", "SPICE", "L", "BT", 1, 210, 1, "L", "vendor_item", "ambient", 365, "ambient", 10, 30, 0, ["soybeans", "cereals_gluten"], "VEN-0004"),
  rm("RM-0045", "Cashew Nuts", "SPICE", "KG", "PK", 1, 985, 1, "KG", "vendor_item", "dry", 180, "dry", null, null, 0, ["tree_nuts"], "VEN-0004"),
  rm("RM-0046", "Raisins", "SPICE", "KG", "PK", 1, 320, 1, "KG", "vendor_item", "dry", 180, "dry", null, null, 0, ["sulphites"], "VEN-0004"),
  rm("RM-0047", "Green Cardamom", "SPICE", "KG", "PK", 1, 3200, 1, "KG", "vendor_item", "dry", 365, "dry", null, null, 0, [], "VEN-0004"),
  rm("RM-0048", "Refined Sunflower Oil", "OIL", "L", "CAN", 15, 132, 1, "L", "vendor_item", "ambient", 270, "ambient", 10, 30, 0, [], "VEN-0003"),
  rm("RM-0049", "Coconut Oil", "OIL", "L", "PK", 1, 235, 1, "L", "vendor_item", "ambient", 300, "ambient", 15, 30, 0, [], "VEN-0003"),
  rm("RM-0050", "Tea Dust (Assam blend)", "BEVERAGE", "KG", "PK", 1, 385, 1, "KG", "vendor_item", "dry", 365, "dry", null, null, 0, [], "VEN-0007"),
  rm("RM-0051", "Coffee Powder (filter blend)", "BEVERAGE", "KG", "PK", 1, 520, 1, "KG", "vendor_item", "dry", 240, "dry", null, null, 0, [], "VEN-0007"),
  rm("RM-0052", "Soda Water (bottled)", "BEVERAGE", "ML", "CS", 24, 0.045, 1, "ML", "vendor_item", "ambient", 180, "ambient", 10, 30, 0, [], "VEN-0007"),
  rm("RM-0053", "Lime Cordial", "BEVERAGE", "L", "BT", 1, 185, 1, "L", "vendor_item", "ambient", 240, "ambient", 10, 30, 0, ["sulphites"], "VEN-0007"),
  rm("RM-0054", "Mineral Water (1 L bottle)", "BEVERAGE", "PC", "CS", 12, 11, 1, "PC", "vendor_item", "ambient", 365, "ambient", 10, 30, 0, [], "VEN-0007"),
  rm("RM-0055", "Takeaway Container (750 ml)", "PACK", "PC", "CS", 100, 6.4, 1, "PC", "vendor_item", "dry", null, null, null, null, 0, [], "VEN-0008"),
  rm("RM-0056", "Paper Cup (200 ml)", "PACK", "PC", "CS", 1000, 1.9, 1, "PC", "vendor_item", "dry", null, null, null, null, 0, [], "VEN-0008"),
  rm("RM-0057", "Aluminium Foil Roll", "PACK", "PC", "CS", 6, 210, 1, "PC", "vendor_item", "dry", null, null, null, null, 0, [], "VEN-0008"),
];

function rm(
  code: string,
  name: string,
  category: string,
  baseUom: string,
  packUom: string | null,
  packQty: number | null,
  cost: number,
  costPer: number,
  costUom: string,
  costSource: DemoRawMaterial["costSource"],
  storageType: DemoRawMaterial["storageType"],
  shelfLifeDays: number | null,
  shelfLifeBasis: DemoRawMaterial["shelfLifeBasis"],
  tempMinC: number | null,
  tempMaxC: number | null,
  trimYieldPct: number | null,
  allergens: string[],
  vendor: string
): DemoRawMaterial {
  return {
    chainCode: "saffron-table",
    code,
    name,
    category,
    baseUom,
    packUom,
    packQty,
    cost,
    costPer,
    costUom,
    costSource,
    storageType,
    shelfLifeDays,
    shelfLifeBasis,
    tempMinC,
    tempMaxC,
    trimYieldPct,
    allergens,
    trackStock: category !== "PACK",
    vendors: [{ vendor, vendorItemCode: `${vendor}-${code.slice(-4)}`, leadTimeDays: 2, preferred: true }],
  };
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export interface DemoArticle {
  code: string;
  name: string;
  shortName: string;
  category: string;
  type: "food" | "beverage" | "retail" | "service";
  dietary: "veg" | "non_veg" | "egg" | "vegan" | "none";
  taxClass: string;
  /** HSN for a good, SAC for a service; see the file header. */
  hsnSac: string;
  uom: string;
  servingQty: number;
  calories: number;
  /** INR, tax-inclusive, at the primary outlet. */
  price: number;
  /** Outlet codes the article is sold at. */
  outlets: string[];
  /** Outlet code → INR, where the outlet prices it differently. */
  priceOverrides?: Record<string, number>;
  allergens: string[];
  mayContain?: string[];
  /** Per-serving nutrition, where the chain publishes it. Optional in India (§14). */
  nutrition?: { protein: number; carbohydrate: number; totalFat: number; sugars?: number; sodium?: number };
  channels: string[];
  availability?: "available" | "seasonal" | "unavailable";
}

const ALL_CHANNELS = ["pos", "kiosk", "app", "aggregator"];
const DINE_ALL = ["pos", "app"];

/**
 * Fifty articles across a credible Indian menu. `price` is the restaurant price and any
 * outlet that prices differently is listed in `priceOverrides` — a bar prices a mocktail
 * above a dining room, and a QSR in the same chain prices it below. The loader writes one
 * explicit price row per (article, outlet); the base-plus-override shape exists only to
 * keep an authored dataset readable, and a chain's real import writes the rows directly.
 */
export const MDM_ARTICLES: DemoArticle[] = [
  // --- Starters, vegetarian ---
  art("ART-1001", "Paneer Tikka", "Paneer Tikka", "STARTERS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 412, 345, ["koramangala-restaurant", "koramangala-bar"], { "koramangala-bar": 385 }, ["milk"], [], { protein: 18.4, carbohydrate: 12.1, totalFat: 22.6, sodium: 640 }, DINE_ALL),
  art("ART-1002", "Vegetable Manchurian (dry)", "Veg Manchurian", "STARTERS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 386, 295, ["koramangala-restaurant"], undefined, ["cereals_gluten", "soybeans"], [], { protein: 8.2, carbohydrate: 41.5, totalFat: 16.8, sodium: 890 }, DINE_ALL),
  art("ART-1003", "Crispy Corn Chilli", "Crispy Corn", "STARTERS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 298, 265, ["koramangala-restaurant"], undefined, ["cereals_gluten"], [], { protein: 6.1, carbohydrate: 38.2, totalFat: 12.4 }, DINE_ALL),
  art("ART-1004", "Hara Bhara Kebab", "Hara Bhara Kebab", "STARTERS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 274, 285, ["koramangala-restaurant"], undefined, ["milk"], [], { protein: 9.6, carbohydrate: 24.8, totalFat: 13.2 }, DINE_ALL),
  art("ART-1005", "Gobi 65", "Gobi 65", "STARTERS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 312, 275, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["cereals_gluten"], [], undefined, DINE_ALL),

  // --- Starters, non-vegetarian ---
  art("ART-1006", "Chicken Tikka", "Chicken Tikka", "STARTERS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 364, 415, ["koramangala-restaurant", "koramangala-bar"], { "koramangala-bar": 455 }, ["milk"], [], { protein: 31.2, carbohydrate: 6.4, totalFat: 22.1, sodium: 720 }, DINE_ALL),
  art("ART-1007", "Chicken 65", "Chicken 65", "STARTERS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 398, 395, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["cereals_gluten", "eggs"], [], { protein: 29.8, carbohydrate: 14.2, totalFat: 24.6 }, DINE_ALL),
  art("ART-1008", "Mutton Seekh Kebab", "Seekh Kebab", "STARTERS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 442, 465, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1009", "Fish Amritsari", "Fish Amritsari", "STARTERS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 386, 445, ["koramangala-restaurant"], undefined, ["fish", "cereals_gluten"], [], undefined, DINE_ALL),

  // --- Soups & salads ---
  art("ART-1010", "Sweet Corn Soup", "Sweet Corn Soup", "SOUPS-SALADS", "food", "veg", "GST5-REST", "996331", "POR", 1, 168, 195, ["koramangala-restaurant"], undefined, ["cereals_gluten"], [], undefined, DINE_ALL),
  art("ART-1011", "Hot & Sour Vegetable Soup", "Hot & Sour Soup", "SOUPS-SALADS", "food", "veg", "GST5-REST", "996331", "POR", 1, 162, 205, ["koramangala-restaurant"], undefined, ["soybeans", "cereals_gluten"], [], undefined, DINE_ALL),
  art("ART-1012", "Chicken Clear Soup", "Chicken Soup", "SOUPS-SALADS", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 148, 215, ["koramangala-restaurant"], undefined, [], [], undefined, DINE_ALL),
  art("ART-1013", "Garden Green Salad", "Green Salad", "SOUPS-SALADS", "food", "veg", "GST5-REST", "996331", "POR", 1, 86, 175, ["koramangala-restaurant", "koramangala-bar"], undefined, [], [], undefined, DINE_ALL),
  art("ART-1014", "Sprouted Moong Salad", "Moong Salad", "SOUPS-SALADS", "food", "veg", "GST5-REST", "996331", "POR", 1, 112, 185, ["koramangala-restaurant"], undefined, [], [], undefined, ["pos", "app", "cds"]),

  // --- Main course, vegetarian ---
  art("ART-1015", "Paneer Butter Masala", "Paneer Butter Masala", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 468, 395, ["koramangala-restaurant", "indiranagar-qsr"], { "indiranagar-qsr": 365 }, ["milk", "tree_nuts"], [], { protein: 16.8, carbohydrate: 18.4, totalFat: 32.6, sodium: 810 }, DINE_ALL),
  art("ART-1016", "Dal Makhani", "Dal Makhani", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 386, 335, ["koramangala-restaurant"], undefined, ["milk"], [], { protein: 13.2, carbohydrate: 26.4, totalFat: 22.8 }, DINE_ALL),
  art("ART-1017", "Kadai Vegetable", "Kadai Veg", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 324, 315, ["koramangala-restaurant"], undefined, [], [], undefined, DINE_ALL),
  art("ART-1018", "Palak Paneer", "Palak Paneer", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 392, 355, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1019", "Mushroom Masala", "Mushroom Masala", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 286, 325, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1020", "Dal Tadka", "Dal Tadka", "MAINS-VEG", "food", "veg", "GST5-REST", "996331", "POR", 1, 268, 265, ["koramangala-restaurant", "indiranagar-qsr"], { "indiranagar-qsr": 245 }, ["milk"], [], undefined, DINE_ALL),

  // --- Main course, non-vegetarian ---
  art("ART-1021", "Butter Chicken", "Butter Chicken", "MAINS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 572, 495, ["koramangala-restaurant", "koramangala-bar"], { "koramangala-bar": 545 }, ["milk", "tree_nuts"], [], { protein: 28.6, carbohydrate: 14.2, totalFat: 38.4, sodium: 940 }, DINE_ALL),
  art("ART-1022", "Chicken Chettinad", "Chicken Chettinad", "MAINS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 494, 445, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1023", "Mutton Rogan Josh", "Mutton Rogan Josh", "MAINS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 612, 565, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1024", "Coastal Fish Curry", "Fish Curry", "MAINS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 428, 485, ["koramangala-restaurant"], undefined, ["fish", "mustard"], [], undefined, DINE_ALL),
  art("ART-1025", "Prawn Ghee Roast", "Prawn Ghee Roast", "MAINS-NONVEG", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 452, 525, ["koramangala-restaurant"], undefined, ["crustaceans", "milk"], [], undefined, DINE_ALL),
  art("ART-1026", "Egg Curry (Andhra style)", "Egg Curry", "MAINS-NONVEG", "food", "egg", "GST5-REST", "996331", "POR", 1, 348, 315, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["eggs"], [], undefined, DINE_ALL),

  // --- Breads & rice ---
  art("ART-1027", "Butter Naan", "Butter Naan", "BREADS-RICE", "food", "veg", "GST5-REST", "996331", "PC", 1, 268, 95, ["koramangala-restaurant", "koramangala-bar"], undefined, ["cereals_gluten", "milk"], [], undefined, DINE_ALL),
  art("ART-1028", "Tandoori Roti", "Tandoori Roti", "BREADS-RICE", "food", "veg", "GST5-REST", "996331", "PC", 1, 186, 65, ["koramangala-restaurant"], undefined, ["cereals_gluten"], [], undefined, DINE_ALL),
  art("ART-1029", "Laccha Paratha", "Laccha Paratha", "BREADS-RICE", "food", "veg", "GST5-REST", "996331", "PC", 1, 296, 105, ["koramangala-restaurant"], undefined, ["cereals_gluten", "milk"], [], undefined, DINE_ALL),
  art("ART-1030", "Jeera Rice", "Jeera Rice", "BREADS-RICE", "food", "veg", "GST5-REST", "996331", "POR", 1, 288, 225, ["koramangala-restaurant"], undefined, [], [], undefined, DINE_ALL),
  art("ART-1031", "Hyderabadi Chicken Biryani", "Chicken Biryani", "BREADS-RICE", "food", "non_veg", "GST5-REST", "996331", "POR", 1, 682, 495, ["koramangala-restaurant", "indiranagar-qsr"], { "indiranagar-qsr": 465 }, ["milk", "tree_nuts"], [], { protein: 32.4, carbohydrate: 62.8, totalFat: 24.2, sodium: 1180 }, DINE_ALL),

  // --- South Indian ---
  art("ART-1032", "Masala Dosa", "Masala Dosa", "SOUTH-INDIAN", "food", "veg", "GST5-REST", "996331", "PLT", 1, 387, 235, ["koramangala-restaurant", "indiranagar-qsr"], { "indiranagar-qsr": 215 }, ["cereals_gluten", "milk"], [], undefined, DINE_ALL),
  art("ART-1033", "Idli Vada Combo", "Idli Vada", "SOUTH-INDIAN", "food", "veg", "GST5-REST", "996331", "PLT", 1, 342, 195, ["koramangala-restaurant", "indiranagar-qsr"], { "indiranagar-qsr": 175 }, [], [], undefined, DINE_ALL),
  art("ART-1034", "Ghee Podi Dosa", "Podi Dosa", "SOUTH-INDIAN", "food", "veg", "GST5-REST", "996331", "PLT", 1, 421, 265, ["koramangala-restaurant"], undefined, ["cereals_gluten", "milk"], [], undefined, DINE_ALL),
  art("ART-1035", "Bisi Bele Bath", "Bisi Bele Bath", "SOUTH-INDIAN", "food", "veg", "GST5-REST", "996331", "PLT", 1, 356, 215, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["tree_nuts", "milk"], [], undefined, DINE_ALL),

  // --- Desserts ---
  art("ART-1036", "Gulab Jamun (2 pc)", "Gulab Jamun", "DESSERTS", "food", "veg", "GST5-REST", "996331", "POR", 1, 368, 195, ["koramangala-restaurant", "koramangala-bar", "indiranagar-qsr"], undefined, ["milk", "cereals_gluten"], [], undefined, DINE_ALL),
  art("ART-1037", "Gajar Ka Halwa", "Gajar Halwa", "DESSERTS", "food", "veg", "GST5-REST", "996331", "POR", 1, 392, 225, ["koramangala-restaurant"], undefined, ["milk", "tree_nuts"], [], undefined, ["pos", "app", "cds"]),
  art("ART-1038", "Rasmalai (2 pc)", "Rasmalai", "DESSERTS", "food", "veg", "GST5-REST", "996331", "POR", 1, 312, 245, ["koramangala-restaurant"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1039", "Tender Coconut Payasam", "Payasam", "DESSERTS", "food", "veg", "GST5-REST", "996331", "POR", 1, 288, 215, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["milk", "tree_nuts"], [], undefined, DINE_ALL),

  // --- Hot beverages ---
  art("ART-1040", "Filter Coffee", "Filter Coffee", "HOT-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 96, 95, ["koramangala-restaurant", "koramangala-bar", "indiranagar-qsr"], undefined, ["milk"], [], undefined, ALL_CHANNELS),
  art("ART-1041", "Masala Chai", "Masala Chai", "HOT-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 112, 85, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["milk"], [], undefined, ALL_CHANNELS),
  art("ART-1042", "Hot Chocolate", "Hot Chocolate", "HOT-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 246, 185, ["koramangala-restaurant", "koramangala-bar"], undefined, ["milk", "soybeans"], [], undefined, DINE_ALL),

  // --- Cold beverages ---
  art("ART-1043", "Fresh Lime Soda", "Lime Soda", "COLD-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 68, 145, ["koramangala-restaurant", "koramangala-bar", "indiranagar-qsr"], { "koramangala-bar": 165 }, ["sulphites"], [], undefined, ALL_CHANNELS),
  art("ART-1044", "Sweet Lassi", "Sweet Lassi", "COLD-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 218, 165, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["milk"], [], undefined, DINE_ALL),
  art("ART-1045", "Mango Milkshake", "Mango Shake", "COLD-BEVERAGES", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 286, 195, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["milk", "sulphites"], [], undefined, DINE_ALL),
  art("ART-1046", "Mineral Water 1 L (bottled)", "Water 1 L", "COLD-BEVERAGES", "beverage", "veg", "GST12-PACK", "2201", "PC", 1, 0, 40, ["koramangala-restaurant", "koramangala-bar", "indiranagar-qsr"], undefined, [], [], undefined, ALL_CHANNELS),

  // --- Bar & mocktails ---
  art("ART-1047", "Virgin Mojito", "Virgin Mojito", "BAR-MOCKTAILS", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 142, 325, ["koramangala-restaurant", "koramangala-bar"], { "koramangala-bar": 355 }, [], [], undefined, DINE_ALL),
  art("ART-1048", "Blue Lagoon Mocktail", "Blue Lagoon", "BAR-MOCKTAILS", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 168, 345, ["koramangala-bar"], undefined, ["sulphites"], [], undefined, DINE_ALL),
  art("ART-1049", "Cold Coffee Frappe", "Frappe", "BAR-MOCKTAILS", "beverage", "veg", "GST5-REST", "996331", "GLS", 1, 324, 285, ["koramangala-restaurant", "koramangala-bar"], undefined, ["milk"], [], undefined, DINE_ALL),

  // --- Packaged & retail ---
  art("ART-1050", "Packaged Potato Chips 90 g", "Chips 90 g", "PACKAGED-RETAIL", "retail", "veg", "GST12-PACK", "2005", "PC", 1, 486, 90, ["koramangala-restaurant", "indiranagar-qsr"], undefined, [], [], undefined, ALL_CHANNELS),
  art("ART-1051", "Packaged Roasted Cashews 200 g", "Cashews 200 g", "PACKAGED-RETAIL", "retail", "veg", "GST12-PACK", "2008", "PC", 1, 1120, 495, ["koramangala-restaurant"], undefined, ["tree_nuts"], [], undefined, ALL_CHANNELS),
  art("ART-1052", "Packaged Soft Drink 300 ml", "Soft Drink 300 ml", "PACKAGED-RETAIL", "beverage", "veg", "GST12-PACK", "2202", "PC", 1, 138, 60, ["koramangala-restaurant", "indiranagar-qsr"], undefined, ["sulphites"], [], undefined, ALL_CHANNELS, "seasonal"),
];

function art(
  code: string,
  name: string,
  shortName: string,
  category: string,
  type: DemoArticle["type"],
  dietary: DemoArticle["dietary"],
  taxClass: string,
  hsnSac: string,
  uom: string,
  servingQty: number,
  calories: number,
  price: number,
  outlets: string[],
  priceOverrides: Record<string, number> | undefined,
  allergens: string[],
  mayContain: string[],
  nutrition: DemoArticle["nutrition"],
  channels: string[],
  availability?: DemoArticle["availability"]
): DemoArticle {
  return {
    code,
    name,
    shortName,
    category,
    type,
    dietary,
    taxClass,
    hsnSac,
    uom,
    servingQty,
    calories,
    price,
    outlets,
    ...(priceOverrides ? { priceOverrides } : {}),
    allergens,
    mayContain,
    ...(nutrition ? { nutrition } : {}),
    channels,
    ...(availability ? { availability } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outlets and sections
// ---------------------------------------------------------------------------

/** Site/outlet codes come from the Phase 0 demo tenant so nothing here invents a site. */
export const MDM_OUTLET_SECTIONS: {
  chainCode: string;
  siteCode: string;
  outletCode: string;
  code: string;
  name: string;
  kind: "kitchen" | "bar" | "grill" | "cold" | "bakery" | "dessert" | "beverage" | "expedite" | "other";
  sortOrder: number;
}[] = [
  { chainCode: "saffron-table", siteCode: "saffron-koramangala", outletCode: "koramangala-restaurant", code: "KOR-HOT", name: "Hot Kitchen", kind: "kitchen", sortOrder: 10 },
  { chainCode: "saffron-table", siteCode: "saffron-koramangala", outletCode: "koramangala-restaurant", code: "KOR-GRILL", name: "Tandoor & Grill", kind: "grill", sortOrder: 20 },
  { chainCode: "saffron-table", siteCode: "saffron-koramangala", outletCode: "koramangala-restaurant", code: "KOR-COLD", name: "Cold Kitchen", kind: "cold", sortOrder: 30 },
  { chainCode: "saffron-table", siteCode: "saffron-koramangala", outletCode: "koramangala-restaurant", code: "KOR-DESSERT", name: "Dessert Station", kind: "dessert", sortOrder: 40 },
  { chainCode: "saffron-table", siteCode: "saffron-koramangala", outletCode: "koramangala-bar", code: "KOR-BAR-MAIN", name: "Main Bar", kind: "bar", sortOrder: 10 },
  { chainCode: "saffron-table", siteCode: "saffron-indiranagar", outletCode: "indiranagar-qsr", code: "IND-QSR-KITCHEN", name: "QSR Kitchen", kind: "kitchen", sortOrder: 10 },
  { chainCode: "saffron-table", siteCode: "saffron-indiranagar", outletCode: "indiranagar-qsr", code: "IND-QSR-BEV", name: "Beverage Counter", kind: "beverage", sortOrder: 20 },
  { chainCode: "coastal-catch", siteCode: "coastal-bandra", outletCode: "bandra-restaurant", code: "BAN-KITCHEN", name: "Coastal Kitchen", kind: "kitchen", sortOrder: 10 },
  { chainCode: "coastal-catch", siteCode: "coastal-bandra", outletCode: "bandra-restaurant", code: "BAN-GRILL", name: "Grill Station", kind: "grill", sortOrder: 20 },
];

/** Per-outlet opening hours for the two saffron-table sites (0 = Sunday). */
export const MDM_SITE_OPERATING_HOURS: {
  chainCode: string;
  siteCode: string;
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
}[] = [
  ...[0, 1, 2, 3, 4, 5, 6].map((day) => ({ chainCode: "saffron-table", siteCode: "saffron-koramangala", dayOfWeek: day, opensAt: "11:30", closesAt: "23:30", closed: false })),
  // The QSR is shut on Monday, which is what makes "closed on a day" more than a claim.
  ...[0, 2, 3, 4, 5, 6].map((day) => ({ chainCode: "saffron-table", siteCode: "saffron-indiranagar", dayOfWeek: day, opensAt: "08:00", closesAt: "22:30", closed: false })),
  { chainCode: "saffron-table", siteCode: "saffron-indiranagar", dayOfWeek: 1, opensAt: null, closesAt: null, closed: true },
];
