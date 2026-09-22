import "@tanstack/react-start/server-only";

import { poolQueryable, withTransaction, type Queryable } from "~/db";
import { auditedMutation, guard, writeAudit, type MutationOutcome } from "~/server/audit";
import { raiseArticleReviewTask } from "~/domain/mdm-approvals";
import { can } from "~/server/permissions";
import { NotFound, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";

/**
 * Phase 1 master data — the article master's domain API.
 *
 * This is the surface the screens call, and it is deliberately the *same* surface the
 * chatbot gateway will call later (spec: "the chatbot calls the identical domain API"),
 * so every function starts with `guard(...)` and every write goes through
 * `auditedMutation(...)` with the audit row in the same transaction as the write.
 *
 * Two rules from the spec that shape the code rather than the comments:
 *
 *   1. **The compliance matrix is computed, never stored** (§7.1, §7.4). It is derived
 *      from `jurisdiction_field_rule` for the jurisdictions the chain trades in, so a
 *      market whose rules change applies to old records with no data migration — and a
 *      market that requires nothing simply produces no column.
 *   2. **Money is always `{ amount, currencyCode }`** (§8.4). A price row carries the
 *      currency of the site it is sold at, and no code path produces a bare number.
 */

export interface Money {
  amount: number;
  currencyCode: string;
}

export interface ArticleListItem {
  id: string;
  code: string;
  name: string;
  /** The locale the name was read from; a row with no name in the viewer's locale is
   * shown with an `untranslated` marker rather than silently falling back in the data. */
  nameLocale: string;
  untranslated: boolean;
  /** The current version's short name. The list filter matches it as well as the code and
   * the name — the screen's own placeholder promises "code, name or short name". */
  shortName: string | null;
  categoryCode: string;
  categoryName: string;
  articleType: string;
  dietaryMark: string | null;
  taxClassCode: string | null;
  taxClassJurisdiction: string | null;
  status: string;
  version: number;
  /** Per §7.5: `ok`, or the count of required fields the market profile says are missing. */
  complianceMissing: number;
  complianceChecked: number;
  allergenCount: number;
  outletCount: number;
  lastChange: string;
}

export interface ArticleListFilters {
  chainId?: string | null;
  query?: string | null;
  status?: string | null;
  categoryCode?: string | null;
  taxClassCode?: string | null;
  jurisdiction?: string | null;
  outletCode?: string | null;
  incompleteOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ArticleListResult {
  items: ArticleListItem[];
  total: number;
  limit: number;
  offset: number;
  /** Whether this page is short of the rows that match the filters, said outright rather
   * than left for the caller to infer from `total` (review S6). */
  hasMore: boolean;
  nextOffset: number | null;
  /** The market the compliance column was evaluated against, and the required field list
   * it used — shown on screen so the number is explainable rather than mysterious. */
  jurisdiction: string;
  requiredFields: string[];
}

const MAX_LIMIT = 200;

/**
 * How a required field is judged present. Data-driven: the *list* of required fields comes
 * from `jurisdiction_field_rule`, and this map only says how to look at the record.
 *
 * A rule naming a field with no predicate here is reported as *unchecked* rather than as
 * satisfied — a compliance column that silently passes a field it cannot see would be
 * worse than no column at all.
 */
const FIELD_PREDICATES: Record<string, (row: ArticleRow) => boolean> = {
  name: (row) => Boolean(row.name),
  dietaryMark: (row) => Boolean(row.dietary_mark),
  taxClass: (row) => Boolean(row.tax_class_id),
  hsnSacCode: (row) => Boolean(row.hsn_sac_code),
  servingSize: (row) => row.serving_size_qty !== null,
  caloriesKcal: (row) => row.calories_kcal !== null,
  allergens: (row) => Number(row.allergen_count) > 0,
  nutrition: (row) => Number(row.nutrient_count) > 0,
};

interface ArticleRow {
  id: string;
  code: string;
  name: string | null;
  short_name: string | null;
  name_locale: string | null;
  category_code: string;
  category_name: string | null;
  article_type: string;
  status: string;
  version: number;
  version_id: string;
  dietary_mark: string | null;
  tax_class_id: string | null;
  tax_class_code: string | null;
  tax_class_jurisdiction: string | null;
  hsn_sac_code: string | null;
  serving_size_qty: string | number | null;
  calories_kcal: string | number | null;
  allergen_count: string | number;
  nutrient_count: string | number;
  outlet_count: string | number;
  updated_at: Date;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

/**
 * The chain an MDM read or write acts on. A Central identity carries its own chain; an
 * App-layer identity must name one, and the permission check then decides whether its
 * delegation covers it. Nothing here trusts the caller's word for *permission* — only for
 * *which* chain it is asking about, which the guard then validates.
 */
function resolveChainId(principal: Principal, requested?: string | null): string {
  const chainId = requested?.trim() || principal.chainId;
  if (!chainId) {
    throw new ValidationError("a chain context is required (chainId)");
  }
  return chainId;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/**
 * The jurisdictions a chain actually trades in: its own `tax_jurisdiction` plus the
 * distinct jurisdictions of its sites (§14 — "there is no separate list to maintain").
 */
export async function tradedJurisdictions(chainId: string): Promise<string[]> {
  const rows = await poolQueryable().query<{ code: string }>(
    `select distinct code from (
       select c.tax_jurisdiction as code from chain c where c.id = $1 and c.tax_jurisdiction is not null
       union
       select coalesce(s.jurisdiction_code, s.tax_jurisdiction) as code
         from site s
        where s.chain_id = $1
          and coalesce(s.jurisdiction_code, s.tax_jurisdiction) is not null
     ) t
     order by code`,
    [chainId]
  );
  return rows.map((row) => row.code);
}

/**
 * The required fields a market's profile states for an entity, today. Effective-dated:
 * the rule in force is the newest row at or before today, which is what keeps a change to
 * a market's law from rewriting history.
 */
async function requiredFields(
  tx: Queryable,
  jurisdiction: string,
  entity: string
): Promise<string[]> {
  const rows = await tx.query<{ field: string }>(
    `select distinct on (field) field
       from jurisdiction_field_rule
      where jurisdiction_code = $1 and entity = $2 and requirement = 'required'
        and effective_from <= current_date
      order by field, effective_from desc`,
    [jurisdiction, entity]
  );
  return rows.map((row) => row.field);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export async function listArticles(
  principal: Principal,
  filters: ArticleListFilters = {}
): Promise<ArticleListResult> {
  const chainId = resolveChainId(principal, filters.chainId);
  await guard({
    principal,
    action: filters.query ? "mdm.article.search" : "mdm.article.view",
    entityType: "article",
    chainId,
    target: `chain ${chainId}`,
  });

  const db = poolQueryable();
  const jurisdictions = await tradedJurisdictions(chainId);
  // The compliance column is evaluated against the first traded jurisdiction; a chain
  // trading in several sees the per-market matrix on the record instead (§7.4).
  const jurisdiction = filters.jurisdiction?.trim() || jurisdictions[0] || "IN";
  const required = await requiredFields(db, jurisdiction, "article");

  const where: string[] = ["a.chain_id = $1"];
  const values: unknown[] = [chainId];
  /** Registers a parameter and returns its placeholder, so a value and its `$n` cannot
   * drift apart as the filter list grows. */
  const p = (value: unknown): string => {
    values.push(value);
    // Built by concatenation on purpose: a `$${n}` literal inside a template string is
    // easy to mangle in transit, and this line decides every placeholder below it.
    return "$" + String(values.length);
  };
  const add = (clause: (placeholder: string) => string, value: unknown): void => {
    where.push(clause(p(value)));
  };

  const text = filters.query?.trim() ?? "";
  if (text) {
    const code = p(`%${text}%`);
    const name = p(`%${text}%`);
    const shortName = p(`%${text}%`);
    where.push(
      `(a.code ilike ${code} or t.name ilike ${name} or t.short_name ilike ${shortName})`
    );
  }
  if (filters.status?.trim()) add((placeholder) => `a.status = ${placeholder}`, filters.status.trim());
  if (filters.categoryCode?.trim()) add((placeholder) => `cat.code = ${placeholder}`, filters.categoryCode.trim());
  if (filters.taxClassCode?.trim()) add((placeholder) => `tc.code = ${placeholder}`, filters.taxClassCode.trim());
  if (filters.outletCode?.trim()) {
    add(
      (placeholder) =>
        `exists (select 1 from article_price p join outlet o on o.id = p.outlet_id
                  where p.article_version_id = v.id and p.effective_to is null and o.code = ${placeholder})`,
      filters.outletCode.trim()
    );
  }

  // "Incomplete only" is a *predicate*, not a post-filter. Applied to the page after the
  // LIMIT it returned a short page while further matching rows sat beyond it — the same
  // silent truncation this endpoint is being fixed for. With no requirements configured
  // the expression is `false`, which is the honest answer for that market: nothing there
  // can be incomplete. A rule naming a field this build cannot check also reads as
  // missing, exactly as the row-level column does.
  if (filters.incompleteOnly) {
    where.push(incompleteExpression(required));
  }

  // The default page *is* the maximum page. A default of 50 quietly dropped the last two
  // of 52 articles for any caller that passed no parameters (review S6); a caller that
  // wants a smaller page asks for one, and one that wants to know whether it saw
  // everything reads `hasMore`/`nextOffset` in the result. A non-numeric limit falls back
  // instead of reaching SQL as `limit NaN`.
  const limit = Math.min(
    Math.max(Number.isFinite(filters.limit) ? Math.trunc(filters.limit as number) : MAX_LIMIT, 1),
    MAX_LIMIT
  );
  const offset = Math.max(
    Number.isFinite(filters.offset) ? Math.trunc(filters.offset as number) : 0,
    0
  );

  // The viewer's locale wins, then the platform default — the full user → site → chain →
  // platform order is the shell's business, and this read only needs the winner.
  const preferredLocale = principal.locale ?? "en-IN";
  const localeParam = p(preferredLocale);

  const rows = await db.query<ArticleRow>(
    `select a.id, a.code, a.article_type, a.status, a.updated_at,
            v.id as version_id, v.version, v.dietary_mark, v.tax_class_id, v.hsn_sac_code,
            v.serving_size_qty, v.calories_kcal,
            t.name, t.short_name, t.locale as name_locale,
            cat.code as category_code,
            cat_t.name as category_name,
            tc.code as tax_class_code, tc.jurisdiction_code as tax_class_jurisdiction,
            (select count(*) from article_version_allergen aa where aa.article_version_id = v.id) as allergen_count,
            (select count(*) from article_version_nutrient an where an.article_version_id = v.id) as nutrient_count,
            (select count(*) from article_price pp where pp.article_version_id = v.id and pp.effective_to is null) as outlet_count
       from article a
       join article_version v on v.id = a.current_version_id
       left join article_version_text t on t.article_version_id = v.id and t.locale = ${localeParam}
       left join article_category cat on cat.id = a.category_id
       left join article_category_text cat_t on cat_t.category_id = cat.id and cat_t.locale = t.locale
       left join tax_class tc on tc.id = v.tax_class_id
      where ${where.join(" and ")}
      order by a.code asc
      limit ${p(limit)} offset ${p(offset)}`,
    values
  );

  const items: ArticleListItem[] = [];
  for (const row of rows) {
    const missing = required.filter((field) => {
      const predicate = FIELD_PREDICATES[field];
      return predicate ? !predicate(row) : false;
    });
    items.push({
      id: row.id,
      code: row.code,
      name: row.name ?? row.code,
      nameLocale: row.name_locale ?? preferredLocale,
      untranslated: row.name_locale === null || row.name_locale !== preferredLocale,
      shortName: row.short_name,
      categoryCode: row.category_code,
      categoryName: row.category_name ?? row.category_code,
      articleType: row.article_type,
      dietaryMark: row.dietary_mark,
      taxClassCode: row.tax_class_code,
      taxClassJurisdiction: row.tax_class_jurisdiction,
      status: row.status,
      version: row.version,
      complianceMissing: missing.length,
      complianceChecked: required.filter((field) => FIELD_PREDICATES[field] !== undefined).length,
      allergenCount: Number(row.allergen_count),
      outletCount: Number(row.outlet_count),
      lastChange: asIso(row.updated_at),
    });
  }

  // The total is counted with the same predicates, so "12 of 52 incomplete" on screen is
  // the same statement the row-level column makes.
  const totalsWhere = where.join(" and ");
  const totalsValues = values.slice(0, values.length - 2); // drop limit/offset
  const totals = await db.query<{ total: string; incomplete: string }>(
    `select count(*) as total,
            count(*) filter (where ${incompleteExpression(required)}) as incomplete
       from article a
       join article_version v on v.id = a.current_version_id
       left join article_version_text t on t.article_version_id = v.id and t.locale = ${localeParam}
       left join article_category cat on cat.id = a.category_id
       left join tax_class tc on tc.id = v.tax_class_id
      where ${totalsWhere}`,
    totalsValues
  );

  const total = Number(totals[0]?.total ?? 0);
  const hasMore = offset + items.length < total;
  return {
    items,
    total,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + items.length : null,
    jurisdiction,
    requiredFields: required,
  };
}

/**
 * The same "is this field present" question as SQL, for the total count. It is written out
 * rather than generated from FIELD_PREDICATES because the columns are already in scope in
 * the query — and a generated expression would be the one place a rule could quietly stop
 * matching the row-level check above.
 */
function incompleteExpression(required: string[]): string {
  const clauses = required
    .filter((field) => FIELD_PREDICATES[field] !== undefined)
    .map((field) => {
      switch (field) {
        case "name":
          return "t.name is null";
        case "dietaryMark":
          return "v.dietary_mark is null";
        case "taxClass":
          return "v.tax_class_id is null";
        case "hsnSacCode":
          return "v.hsn_sac_code is null";
        case "servingSize":
          return "v.serving_size_qty is null";
        case "caloriesKcal":
          return "v.calories_kcal is null";
        case "allergens":
          return "not exists (select 1 from article_version_allergen aa where aa.article_version_id = v.id)";
        case "nutrition":
          return "not exists (select 1 from article_version_nutrient an where an.article_version_id = v.id)";
        default:
          return "false";
      }
    });
  return clauses.length > 0 ? `(${clauses.join(" or ")})` : "false";
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
export interface ArticleComplianceCell {
  jurisdiction: string;
  field: string;
  requirement: string;
  satisfied: boolean;
  /** False when this build has no predicate for the field: reported, never assumed. */
  checked: boolean;
  legalRef: string | null;
}

/** One ERP-maintained value, rendered read-only with provenance and never as a
 * disabled input (§25.3). `kind` is what the screen formats on: money is always
 * amount + ISO code, a quantity always carries its UOM code. */
export interface ErpOwnedField {
  group: string;
  field: string;
  kind: "text" | "code" | "money" | "quantity" | "number" | "boolean";
  text: string | null;
  amount: number | null;
  currencyCode: string | null;
  uomCode: string | null;
}

/** The declared ownership row in force for a field group (§22.4). Absent rows mean the
 * platform default applies, and the screen says so rather than inventing one. */
export interface ErpOwnershipRow {
  fieldGroup: string;
  field: string | null;
  owner: string;
  inboundAction: string;
  outboundAction: string;
  overrideAllowed: boolean;
  noteKey: string | null;
}

/** The chain's declared ERP connection. `status` is `not_configured` until a connector
 * has actually run — declaring which ERP a chain runs is not claiming a live link. */
export interface ErpSystemView {
  code: string;
  displayName: string;
  vendor: string;
  status: string;
  lastSyncAt: string | null;
}

export interface ArticleErpMirror {
  system: ErpSystemView | null;
  fields: ErpOwnedField[];
  ownership: ErpOwnershipRow[];
  lastSyncAt: string | null;
}

export interface ArticleDetail {
  id: string;
  code: string;
  status: string;
  articleType: string;
  category: { code: string; name: string };
  baseUomCode: string;
  externalRef: string | null;
  sourceSystem: string | null;
  currentVersion: {
    id: string;
    version: number;
    status: string;
    name: string;
    shortName: string | null;
    nameLocale: string;
    untranslated: boolean;
    translations: { locale: string; name: string }[];
    dietaryMark: string | null;
    taxClassCode: string | null;
    taxClassJurisdiction: string | null;
    hsnSacCode: string | null;
    servingSizeQty: number | null;
    servingSizeUomCode: string | null;
    caloriesKcal: number | null;
    channelFlags: string[];
    effectiveFrom: string | null;
    approvedAt: string | null;
  };
  /** The *open* price window per outlet (`effective_to is null`). `effectiveFrom` is the
   * day this price started: without it the grid showed a figure with no starting date
   * while its own caption promised effective-dated windows (review S10). A closed window
   * is history and lives in the audit trail, not here. */
  prices: {
    outletId: string;
    outletCode: string;
    outletName: string;
    siteCode: string;
    effectiveFrom: string | null;
    money: Money;
  }[];
  /** Every active outlet of the chain with the currency its site trades in. The price
   * dialog needs the currency *before* a price row exists, and a price in the wrong
   * currency is something the domain refuses — so the screen must know it, not guess it. */
  outlets: { code: string; name: string; siteCode: string; currency: string }[];
  availability: { outletCode: string; availability: string; reason: string | null }[];
  allergens: { code: string; mayContain: boolean; source: string; mandatoryHere: boolean }[];
  nutrition: { code: string; value: number; basis: string; unit: string }[];
  compliance: ArticleComplianceCell[];
  versions: { version: number; status: string; effectiveFrom: string | null; approvedAt: string | null }[];
  /** The ERP mirror, rendered as a provenance chip and never as an editable field (§25.3). */
  provenance: { externalKeyKind: string; externalKeyValue: string; lastSyncAt: string | null }[];
  /** The ERP-maintained section (§25.1): last, collapsed, with a count — and only the
   * field groups that actually hold a value, so a dish never shows a box dimension. */
  erp: ArticleErpMirror;
}

/**
 * Turns the ERP's own columns into the read-only list the record screen shows.
 *
 * Two rules from §25 rule this function rather than the component:
 *   * **A group with no value does not appear.** A plated dish has no box dimension and a
 *     service item has no batch control; an empty input the operator wonders about is the
 *     thing §25.2 exists to prevent. The exception is the groups §25.2 makes visible by
 *     type alone (`retail` shows dimensions and manufacturer even when they are empty,
 *     because that is what a retail record is for) — and there the group appears with a
 *     stated empty value rather than a fabricated one.
 *   * **Static typing lives here, not in a component.** `pg` hands back `numeric` as a
 *     string and `boolean` as a boolean; the screen must not have to guess.
 *
 * SPEC-GAP, flagged rather than hidden: §25.2 specifies the visibility table as
 * `erp_visibility_rule` rows. That table does not exist in `0008_mdm_masters.sql`, so the
 * rule is implemented here as the "visible when it holds a value, or when the article
 * type makes it real" subset, which is the part of the table that is data-driven today.
 * A spec owner should reconcile the document to the implementation, as was done for
 * `erp_unmapped_code`.
 */
interface ErpColumnRow {
  article_type: string;
  source_system: string | null;
  external_ref: string | null;
  material_type_code: string | null;
  lifecycle_state_code: string | null;
  erp_blocked: boolean | null;
  valuation_class_code: string | null;
  price_control: string | null;
  standard_price_amount: string | number | null;
  standard_price_currency: string | null;
  moving_average_price_amount: string | number | null;
  moving_average_price_currency: string | null;
  erp_tax_classification_code: string | null;
  erp_tax_group: string | null;
  country_of_origin: string | null;
  customs_tariff_number: string | null;
  export_control_class: string | null;
  manufacturer_name: string | null;
  manufacturer_part_number: string | null;
  revision_level: string | null;
  net_weight_value: string | number | null;
  net_weight_uom_code: string | null;
  gross_weight_value: string | number | null;
  gross_weight_uom_code: string | null;
  storage_condition_code: string | null;
  temperature_condition: string | null;
  shelf_life_days: number | null;
  batch_management: string | null;
  serial_profile_code: string | null;
  receipt_inspection_required: boolean | null;
  certificate_required: boolean | null;
  source_version: string | null;
  last_sync_at: Date | null;
}

function buildErpFields(row: ErpColumnRow): ErpOwnedField[] {
  const fields: ErpOwnedField[] = [];
  const text = (value: unknown, group: string, field: string, kind: ErpOwnedField["kind"]): void => {
    if (value === null || value === undefined || value === "") return;
    fields.push({ group, field, kind, text: String(value), amount: null, currencyCode: null, uomCode: null });
  };
  const number = (value: unknown, group: string, field: string): void => {
    if (value === null || value === undefined) return;
    fields.push({ group, field, kind: "number", text: null, amount: Number(value), currencyCode: null, uomCode: null });
  };
  const money = (amount: unknown, currency: unknown, group: string, field: string): void => {
    if (amount === null || amount === undefined || currency === null || currency === undefined) return;
    fields.push({
      group,
      field,
      kind: "money",
      text: null,
      amount: Number(amount),
      currencyCode: String(currency).trim(),
      uomCode: null,
    });
  };
  const quantity = (value: unknown, uom: unknown, group: string, field: string): void => {
    if (value === null || value === undefined) return;
    fields.push({
      group,
      field,
      kind: "quantity",
      text: null,
      amount: Number(value),
      currencyCode: null,
      uomCode: uom === null || uom === undefined || uom === "" ? null : String(uom),
    });
  };
  const flag = (value: unknown, group: string, field: string): void => {
    if (value !== true && value !== false) return;
    fields.push({
      group,
      field,
      kind: "boolean",
      text: value ? "true" : "false",
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  };

  // Identity and sync: always shown, because a record mirrored from an ERP is not a
  // record until you can say which ERP and which revision of it.
  text(row.source_system, "erpIdentity", "sourceSystem", "code");
  text(row.external_ref, "erpIdentity", "externalRef", "code");
  text(row.material_type_code, "erpIdentity", "materialType", "code");
  text(row.lifecycle_state_code, "erpIdentity", "lifecycleState", "code");
  flag(row.erp_blocked, "erpIdentity", "blocked");
  text(row.source_version, "erpSync", "sourceVersion", "text");

  // Dimensions: retail always, otherwise only when the ERP actually sent a measurement.
  if (row.article_type === "retail" || row.net_weight_value !== null || row.gross_weight_value !== null) {
    quantity(row.net_weight_value, row.net_weight_uom_code, "dimensions", "netWeight");
    quantity(row.gross_weight_value, row.gross_weight_uom_code, "dimensions", "grossWeight");
  }
  text(row.storage_condition_code, "storage", "storageCondition", "code");
  text(row.temperature_condition, "storage", "temperatureCondition", "code");
  number(row.shelf_life_days, "storage", "shelfLifeDays");
  text(row.batch_management, "batch", "batchManagement", "code");
  text(row.serial_profile_code, "batch", "serialProfile", "code");
  flag(row.receipt_inspection_required, "quality", "receiptInspectionRequired");
  flag(row.certificate_required, "quality", "certificateRequired");
  text(row.valuation_class_code, "valuation", "valuationClass", "code");
  text(row.price_control, "valuation", "priceControl", "code");
  money(row.standard_price_amount, row.standard_price_currency, "valuation", "standardPrice");
  money(row.moving_average_price_amount, row.moving_average_price_currency, "valuation", "movingAveragePrice");
  text(row.erp_tax_classification_code, "erpTax", "taxClassification", "code");
  text(row.erp_tax_group, "erpTax", "taxGroup", "code");
  text(row.country_of_origin, "customs", "countryOfOrigin", "code");
  text(row.customs_tariff_number, "customs", "customsTariffNumber", "code");
  text(row.export_control_class, "customs", "exportControlClass", "code");
  if (row.article_type === "retail") {
    text(row.manufacturer_name, "manufacturer", "manufacturerName", "text");
    text(row.manufacturer_part_number, "manufacturer", "partNumber", "code");
  } else {
    text(row.manufacturer_name, "manufacturer", "manufacturerName", "text");
    text(row.manufacturer_part_number, "manufacturer", "partNumber", "code");
  }
  text(row.revision_level, "revision", "revisionLevel", "text");
  return fields;
}

export async function getArticle(principal: Principal, code: string): Promise<ArticleDetail> {
  const trimmed = code?.trim();
  if (!trimmed) throw new ValidationError("article code is required");
  const chainId = resolveChainId(principal);
  await guard({
    principal,
    action: "mdm.article.view",
    entityType: "article",
    chainId,
    target: `article ${trimmed}`,
  });

  const db = poolQueryable();
  const preferredLocale = principal.locale ?? "en-IN";

  const head = await db.query<{
    id: string;
    code: string;
    status: string;
    article_type: string;
    external_ref: string | null;
    source_system: string | null;
    category_code: string;
    category_name: string | null;
    base_uom_code: string;
    version_id: string;
    version: number;
    version_status: string;
    dietary_mark: string | null;
    tax_class_id: string | null;
    tax_class_code: string | null;
    tax_class_jurisdiction: string | null;
    hsn_sac_code: string | null;
    serving_size_qty: string | number | null;
    serving_size_uom_code: string | null;
    calories_kcal: string | number | null;
    channel_flags: string[] | null;
    effective_from: Date | null;
    approved_at: Date | null;
    name: string | null;
    short_name: string | null;
    name_locale: string | null;
  }>(
    `select a.id, a.code, a.status, a.article_type, a.external_ref, a.source_system,
            cat.code as category_code, cat_t.name as category_name,
            u.code as base_uom_code,
            v.id as version_id, v.version, v.status as version_status, v.dietary_mark,
            v.tax_class_id, tc.code as tax_class_code, tc.jurisdiction_code as tax_class_jurisdiction,
            v.hsn_sac_code, v.serving_size_qty, su.code as serving_size_uom_code, v.calories_kcal,
            v.channel_flags, v.effective_from, v.approved_at,
            t.name, t.short_name, t.locale as name_locale
       from article a
       join article_version v on v.id = a.current_version_id
       join article_category cat on cat.id = a.category_id
       left join article_category_text cat_t on cat_t.category_id = cat.id and cat_t.locale = $3
       join uom u on u.id = a.base_uom_id
       left join uom su on su.id = v.serving_size_uom_id
       left join tax_class tc on tc.id = v.tax_class_id
       left join article_version_text t on t.article_version_id = v.id and t.locale = $3
      where a.chain_id = $1 and a.code = $2
      limit 1`,
    [chainId, trimmed, preferredLocale]
  );
  const row = head[0];
  if (!row) throw new NotFound("Article", trimmed);

  // The markets the chain trades in (§14). Read once, before the parallel reads, because
  // the allergen list is annotated with "mandatory here" from the first of them.
  const jurisdictions = await tradedJurisdictions(chainId);
  const primaryJurisdiction = jurisdictions[0] ?? "IN";

  const [
    translations,
    priceRows,
    availabilityRows,
    outletRows,
    allergenRows,
    nutritionRows,
    versionRows,
    keyRows,
  ] = await Promise.all([
      db.query<{ locale: string; name: string }>(
        `select locale, name from article_version_text where article_version_id = $1 order by locale`,
        [row.version_id]
      ),
      db.query<{
        outlet_id: string;
        outlet_code: string;
        outlet_name: string;
        site_code: string;
        amount: string;
        currency_code: string;
        effective_from: Date | string | null;
      }>(
        `select o.id as outlet_id, o.code as outlet_code, o.name as outlet_name, s.code as site_code,
                p.amount, p.currency_code, p.effective_from
           from article_price p
           join outlet o on o.id = p.outlet_id
           join site s on s.id = o.site_id
          where p.article_version_id = $1 and p.effective_to is null
          order by s.code, o.name`,
        [row.version_id]
      ),
      db.query<{ outlet_code: string; availability: string; reason: string | null }>(
        `select o.code as outlet_code, av.availability, av.reason
           from article_availability av
           join outlet o on o.id = av.outlet_id
          where av.article_id = $1
          order by o.code`,
        [row.id]
      ),
      db.query<{ code: string; name: string; site_code: string; currency: string }>(
        `select o.code, o.name, s.code as site_code, coalesce(s.currency, 'INR') as currency
           from outlet o join site s on s.id = o.site_id
          where o.chain_id = $1 and o.status = 'active'
          order by s.code, o.name`,
        [chainId]
      ),
      db.query<{ code: string; may_contain: boolean; source: string; mandatory: boolean }>(
        `select al.code, aa.may_contain, aa.source,
                coalesce(ja.requirement = 'mandatory', false) as mandatory
           from article_version_allergen aa
           join allergen al on al.id = aa.allergen_id
           left join jurisdiction_allergen ja
                  on ja.allergen_id = al.id and ja.jurisdiction_code = $2
          where aa.article_version_id = $1
          order by aa.may_contain, al.code`,
        [row.version_id, primaryJurisdiction]
      ),
      db.query<{ code: string; value: string; basis: string; unit: string }>(
        `select n.code, an.value, an.basis, n.unit
           from article_version_nutrient an
           join nutrient n on n.id = an.nutrient_id
          where an.article_version_id = $1
          order by n.code, an.basis`,
        [row.version_id]
      ),
      db.query<{ version: number; status: string; effective_from: Date | null; approved_at: Date | null }>(
        `select version, status, effective_from, approved_at
           from article_version where article_id = $1 order by version desc`,
        [row.id]
      ),
      db.query<{ key_type: string; value: string; last_seen_at: Date | null }>(
        `select key_type, value, last_seen_at
           from external_key
          where chain_id = $1 and entity_type = 'article' and entity_id = $2
          order by is_primary desc, key_type`,
        [chainId, row.id]
      ),
    ]);

  // The ERP-maintained values and the chain's declared connection (§25). Read after the
  // panels above because nothing here is on the common path — the section is last,
  // collapsed, and present only when it holds something.
  const [erpColumnRows, erpSystemRows, ownershipRows] = await Promise.all([
    db.query<ErpColumnRow>(
      `select a.article_type, a.source_system, a.external_ref,
              a.material_type_code, a.erp_lifecycle_state_code as lifecycle_state_code,
              a.erp_blocked, a.valuation_class_code,
              a.price_control, a.standard_price_amount, a.standard_price_currency,
              a.moving_average_price_amount, a.moving_average_price_currency,
              a.erp_tax_classification_code, a.erp_tax_group,
              a.country_of_origin, a.customs_tariff_number, a.export_control_class,
              a.manufacturer_name, a.manufacturer_part_number, a.revision_level,
              a.net_weight_value, nu.code as net_weight_uom_code,
              a.gross_weight_value, gu.code as gross_weight_uom_code,
              a.storage_condition_code, a.temperature_condition, a.shelf_life_days,
              a.batch_management, a.serial_profile_code,
              a.receipt_inspection_required, a.certificate_required,
              a.erp_source_version as source_version, a.erp_last_sync_at as last_sync_at
         from article a
         left join uom nu on nu.id = a.net_weight_uom_id
         left join uom gu on gu.id = a.gross_weight_uom_id
        where a.id = $1
        limit 1`,
      [row.id]
    ),
    db.query<{
      code: string;
      display_name: string;
      vendor: string;
      status: string;
      last_run_at: Date | null;
    }>(
      `select code, display_name, vendor, status, last_run_at
         from erp_system
        where chain_id = $1
        order by created_at
        limit 1`,
      [chainId]
    ),
    db.query<{
      field_group: string;
      field: string | null;
      owner: string;
      inbound_action: string;
      outbound_action: string;
      override_allowed: boolean;
      note_key: string | null;
    }>(
      `select field_group, field, owner, inbound_action, outbound_action, override_allowed, note_key
         from erp_field_ownership
        where chain_id = $1 and entity = 'article'
        order by field_group, field nulls first`,
      [chainId]
    ),
  ]);
  const erpColumns = erpColumnRows[0];
  const erpSystem = erpSystemRows[0];
  const erp: ArticleErpMirror = {
    system: erpSystem
      ? {
          code: erpSystem.code,
          displayName: erpSystem.display_name,
          vendor: erpSystem.vendor,
          status: erpSystem.status,
          lastSyncAt: erpSystem.last_run_at ? asIso(erpSystem.last_run_at) : null,
        }
      : null,
    fields: erpColumns ? buildErpFields(erpColumns) : [],
    ownership: ownershipRows.map((ownership) => ({
      fieldGroup: ownership.field_group,
      field: ownership.field,
      owner: ownership.owner,
      inboundAction: ownership.inbound_action,
      outboundAction: ownership.outbound_action,
      overrideAllowed: ownership.override_allowed,
      noteKey: ownership.note_key,
    })),
    lastSyncAt: erpColumns?.last_sync_at ? asIso(erpColumns.last_sync_at) : null,
  };

  // The compliance matrix, generated per traded jurisdiction from the profile's own rows
  // (§7.4). A market that requires nothing contributes nothing; a market whose rules
  // change re-evaluates every record the next time it is read, with no data migration.
  const compliance: ArticleComplianceCell[] = [];
  for (const jurisdiction of jurisdictions) {
    const rules = await db.query<{ field: string; requirement: string; legal_ref: string | null }>(
      `select distinct on (field) field, requirement, legal_ref
         from jurisdiction_field_rule
        where jurisdiction_code = $1 and entity = 'article'
          and effective_from <= current_date
        order by field, effective_from desc`,
      [jurisdiction]
    );
    for (const rule of rules) {
      const predicate = FIELD_PREDICATES[rule.field];
      const checked = rule.requirement !== "optional" && rule.requirement !== "forbidden";
      const satisfied = checked
        ? Boolean(
            predicate?.({
              ...(row as unknown as ArticleRow),
              allergen_count: allergenRows.length,
              nutrient_count: nutritionRows.length,
              name: row.name,
            })
          )
        : true;
      compliance.push({
        jurisdiction,
        field: rule.field,
        requirement: rule.requirement,
        satisfied,
        checked: predicate !== undefined,
        legalRef: rule.legal_ref,
      });
    }
  }

  return {
    id: row.id,
    code: row.code,
    status: row.status,
    articleType: row.article_type,
    category: { code: row.category_code, name: row.category_name ?? row.category_code },
    baseUomCode: row.base_uom_code,
    externalRef: row.external_ref,
    sourceSystem: row.source_system,
    currentVersion: {
      id: row.version_id,
      version: row.version,
      status: row.version_status,
      name: row.name ?? row.code,
      shortName: row.short_name,
      nameLocale: row.name_locale ?? preferredLocale,
      untranslated: row.name_locale === null,
      translations: translations.map((translation) => ({
        locale: translation.locale,
        name: translation.name,
      })),
      dietaryMark: row.dietary_mark,
      taxClassCode: row.tax_class_code,
      taxClassJurisdiction: row.tax_class_jurisdiction,
      hsnSacCode: row.hsn_sac_code,
      servingSizeQty: row.serving_size_qty === null ? null : Number(row.serving_size_qty),
      servingSizeUomCode: row.serving_size_uom_code,
      caloriesKcal: row.calories_kcal === null ? null : Number(row.calories_kcal),
      channelFlags: row.channel_flags ?? [],
      effectiveFrom: row.effective_from ? asIso(row.effective_from).slice(0, 10) : null,
      approvedAt: row.approved_at ? asIso(row.approved_at) : null,
    },
    prices: priceRows.map((price) => ({
      outletId: price.outlet_id,
      outletCode: price.outlet_code,
      outletName: price.outlet_name,
      siteCode: price.site_code,
      effectiveFrom: price.effective_from ? asIso(price.effective_from).slice(0, 10) : null,
      money: { amount: Number(price.amount), currencyCode: price.currency_code },
    })),
    outlets: outletRows.map((outlet) => ({
      code: outlet.code,
      name: outlet.name,
      siteCode: outlet.site_code,
      currency: outlet.currency,
    })),
    availability: availabilityRows.map((availability) => ({
      outletCode: availability.outlet_code,
      availability: availability.availability,
      reason: availability.reason,
    })),
    allergens: allergenRows.map((allergen) => ({
      code: allergen.code,
      mayContain: allergen.may_contain,
      source: allergen.source,
      mandatoryHere: allergen.mandatory,
    })),
    nutrition: nutritionRows.map((nutrient) => ({
      code: nutrient.code,
      value: Number(nutrient.value),
      basis: nutrient.basis,
      unit: nutrient.unit,
    })),
    compliance,
    versions: versionRows.map((version) => ({
      version: version.version,
      status: version.status,
      effectiveFrom: version.effective_from ? asIso(version.effective_from).slice(0, 10) : null,
      approvedAt: version.approved_at ? asIso(version.approved_at) : null,
    })),
    provenance: keyRows.map((key) => ({
      externalKeyKind: key.key_type,
      externalKeyValue: key.value,
      // `last_seen_at` is when the connector last confirmed this key; the mirror's own
      // `erp_last_sync_at` is on the record and shown beside it as the record-level date.
      lastSyncAt: key.last_seen_at ? asIso(key.last_seen_at) : null,
    })),
    erp,
  };
}

// ---------------------------------------------------------------------------
// Filter options for the list screen
// ---------------------------------------------------------------------------
export interface MdmFilterOptions {
  categories: { code: string; name: string; count: number }[];
  taxClasses: { code: string; name: string; jurisdiction: string }[];
  outlets: { code: string; name: string; siteCode: string }[];
  /** Every state of the shared article lifecycle, in lifecycle order, with how many
   * articles of this chain are in it — so a state the seed does not use is still
   * filterable and visibly empty rather than invisible (review S4). */
  statuses: { code: string; count: number }[];
  jurisdictions: string[];
}

/**
 * The article lifecycle (§6's shared state machine), in the order an operator reads it.
 * It mirrors the `article.status` check constraint in `0008_mdm_masters.sql`, because a
 * filter that only offered the states present in the data could not be used to *find* a
 * draft — the one thing a reviewer opens this screen for.
 */
const ARTICLE_STATUS_ORDER = ["draft", "pending_review", "active", "seasonal", "discontinued"];

export async function getArticleFilterOptions(principal: Principal): Promise<MdmFilterOptions> {
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.article.view",
    entityType: "article",
    chainId,
    target: `chain ${chainId}`,
  });
  const db = poolQueryable();
  const locale = principal.locale ?? "en-IN";

  const [categories, taxClasses, outlets, statuses] = await Promise.all([
    db.query<{ code: string; name: string | null; count: string }>(
      `select cat.code, cat_t.name,
              (select count(*) from article a2 where a2.category_id = cat.id) as count
         from article_category cat
         left join article_category_text cat_t on cat_t.category_id = cat.id and cat_t.locale = $2
        where cat.chain_id = $1 and cat.status = 'active'
        order by cat.sort_order, cat.code`,
      [chainId, locale]
    ),
    db.query<{ code: string; name: string | null; jurisdiction_code: string }>(
      `select tc.code, tct.name, tc.jurisdiction_code
         from tax_class tc
         left join tax_class_text tct on tct.tax_class_id = tc.id and tct.locale = $2
        where tc.chain_id = $1 and tc.status = 'active'
        order by tc.code`,
      [chainId, locale]
    ),
    db.query<{ code: string; name: string; site_code: string }>(
      `select o.code, o.name, s.code as site_code
         from outlet o join site s on s.id = o.site_id
        where o.chain_id = $1 and o.status = 'active'
        order by s.code, o.name`,
      [chainId]
    ),
    db.query<{ status: string; count: string }>(
      `select status, count(*) as count from article where chain_id = $1 group by status`,
      [chainId]
    ),
  ]);

  return {
    categories: categories.map((category) => ({
      code: category.code,
      name: category.name ?? category.code,
      count: Number(category.count),
    })),
    taxClasses: taxClasses.map((taxClass) => ({
      code: taxClass.code,
      name: taxClass.name ?? taxClass.code,
      jurisdiction: taxClass.jurisdiction_code,
    })),
    outlets: outlets.map((outlet) => ({
      code: outlet.code,
      name: outlet.name,
      siteCode: outlet.site_code,
    })),
    // The state machine first, in lifecycle order, then any status the database holds that
    // this build has no label for — an unknown state shows up rather than disappearing.
    statuses: [
      ...ARTICLE_STATUS_ORDER,
      ...statuses.map((row) => row.status).filter((code) => !ARTICLE_STATUS_ORDER.includes(code)),
    ].map((code) => ({
      code,
      count: Number(statuses.find((row) => row.status === code)?.count ?? 0),
    })),
    jurisdictions: await tradedJurisdictions(chainId),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export interface MutationMeta {
  source?: "screen" | "chatbot" | "api" | "import";
  /** The import batch, when an import applied this write (spec §5 `batchId`). */
  batchId?: string | null;
  /** The locale a per-locale content row is written for. The chain default unless stated. */
  locale?: string | null;
  /**
   * A caller-owned transaction. Supplied by the bulk-import pipeline, which must apply a
   * whole file or none of it (§16, and the brief's rule): each write then joins *that*
   * transaction instead of opening one of its own, so one failing row rolls the entire file
   * back. The caller is responsible for committing; the audit row is still written inside
   * the same transaction, so the "commit the write and its audit row together" rule holds
   * whichever way the function was called.
   */
  tx?: Queryable | null;
  intent?: string | null;
}

/**
 * Changes a per-outlet price.
 *
 * This is a **financial** action, which is why it is its own permission
 * (`mdm.article.price.update`) rather than a field on the general update. The open price
 * row is closed the day before the new window opens and a new row is opened: the audit row
 * records both, so a historical bill's price stays reproducible (§11.2's discipline,
 * applied to a price for the same reason).
 *
 * SPEC-GAP, flagged rather than hidden: §7.2 item 5 says a price change on an active
 * article should create version N+1 in `draft` while version N stays sellable, and approving
 * N+1 pins the effective date. That flow needs the maker-checker review screens, which this
 * slab does not build (they are explicitly out of scope). Until they exist, this function
 * closes and opens price windows *inside the current version* — the effective-dated row
 * discipline holds either way, and switching to version creation later is a change inside
 * this one function.
 */
export async function updateArticlePrice(
  principal: Principal,
  input: { code: string; outletCode: string; amount: number; currencyCode: string; effectiveFrom?: string | null },
  meta: MutationMeta = {}
): Promise<{ code: string; outletCode: string; before: Money | null; after: Money }> {
  const code = input.code?.trim();
  const outletCode = input.outletCode?.trim();
  if (!code) throw new ValidationError("article code is required");
  if (!outletCode) throw new ValidationError("outletCode is required");
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new ValidationError("amount must be a number of zero or more");
  }
  const currencyCode = (input.currencyCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new ValidationError("currencyCode must be a three-letter ISO 4217 code — money is never a bare number");
  }

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.article.price.update",
    entityType: "article_price",
    chainId,
    target: `article ${code} at outlet ${outletCode}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const run = async (tx: Queryable): Promise<MutationOutcome> => {
      const rows = await tx.query<{
        article_id: string;
        version_id: string;
        outlet_id: string;
        site_currency: string;
        price_id: string | null;
        amount: string | null;
        currency_code: string | null;
      }>(
        `select a.id as article_id, a.current_version_id as version_id, o.id as outlet_id,
                coalesce(s.currency, 'INR') as site_currency,
                p.id as price_id, p.amount, p.currency_code
           from article a
           join outlet o on o.chain_id = a.chain_id and o.code = $3
           join site s on s.id = o.site_id
           left join article_price p
                  on p.article_version_id = a.current_version_id
                 and p.outlet_id = o.id and p.effective_to is null
          where a.chain_id = $1 and a.code = $2`,
        [chainId, code, outletCode]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Article or outlet", `${code} / ${outletCode}`);
      if (!row.version_id) throw new ValidationError(`${code} has no current version`);

      // The price's currency is the outlet's site currency (§7.1). A caller that sends a
      // different code is asking for something the model does not offer, so it is refused
      // rather than silently stored.
      if (row.site_currency !== currencyCode) {
        throw new ValidationError(
          `${outletCode} trades in ${row.site_currency}; a price in ${currencyCode} needs its own site`
        );
      }

      const effectiveFrom = input.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10);
      const before: Money | null = row.price_id
        ? { amount: Number(row.amount), currencyCode: row.currency_code ?? row.site_currency }
        : null;

      if (row.price_id) {
        // Close the open window the day before the new one opens — never an in-place edit.
        await tx.query(
          `update article_price
              set effective_to = greatest($2::date - 1, effective_from)
            where id = $1`,
          [row.price_id, effectiveFrom]
        );
      }

      const inserted = await tx.query<{ id: string }>(
        `insert into article_price (chain_id, article_id, article_version_id, outlet_id, amount,
                                    currency_code, effective_from, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8)
         returning id`,
        [
          chainId,
          row.article_id,
          row.version_id,
          row.outlet_id,
          input.amount,
          currencyCode,
          effectiveFrom,
          principal.userId,
        ]
      );

      await tx.query(`update article set updated_at = now() where id = $1`, [row.article_id]);

    return {
      entityId: inserted[0]?.id ?? null,
      // The audit row carries both windows: what was closed and what was opened.
      before: before ? { ...before, priceId: row.price_id, effectiveTo: effectiveFrom } : null,
      after: { amount: input.amount, currencyCode, outletCode, effectiveFrom },
    };
  };

  let outcome: MutationOutcome;
  if (meta.tx) {
    outcome = await run(meta.tx);
    await writeAudit(meta.tx, {
      principal,
      action: "mdm.article.price.update",
      entityType: "article_price",
      entityId: outcome.entityId ?? null,
      chainId,
      beforeState: outcome.before ?? null,
      afterState: outcome.after ?? null,
      outcome: "success",
      source: meta.source ?? "api",
      intent: meta.intent ?? null,
      batchId: meta.batchId ?? null,
    });
  } else {
    outcome = await auditedMutation({
      principal,
      action: "mdm.article.price.update",
      entityType: "article_price",
      chainId,
      source: meta.source ?? "api",
      intent: meta.intent ?? null,
      batchId: meta.batchId ?? null,
      run,
    });
  }

  const before = outcome.before as (Money & { priceId?: string }) | null;
  return {
    code,
    outletCode,
    before: before ? { amount: before.amount, currencyCode: before.currencyCode } : null,
    after: { amount: input.amount, currencyCode },
  };
}

/**
 * Marks an article available / seasonal / unavailable at one outlet.
 *
 * Not a version: §7.2 item 6 is explicit that this takes effect immediately, is audited and
 * is reversible. The same surface is where Phase 3's automatic stock-out will write with
 * `source: system`.
 */
export async function setArticleAvailability(
  principal: Principal,
  input: {
    code: string;
    outletCode: string;
    availability: "available" | "seasonal" | "unavailable";
    reason?: string | null;
  },
  meta: MutationMeta = {}
): Promise<{ code: string; outletCode: string; before: string; after: string }> {
  const code = input.code?.trim();
  const outletCode = input.outletCode?.trim();
  if (!code) throw new ValidationError("article code is required");
  if (!outletCode) throw new ValidationError("outletCode is required");
  if (!["available", "seasonal", "unavailable"].includes(input.availability)) {
    throw new ValidationError("availability must be available, seasonal or unavailable");
  }
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.article.update",
    entityType: "article_availability",
    chainId,
    target: `article ${code} at outlet ${outletCode}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "mdm.article.update",
    entityType: "article_availability",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{ article_id: string; outlet_id: string; availability: string | null }>(
        `select a.id as article_id, o.id as outlet_id, av.availability
           from article a
           join outlet o on o.chain_id = a.chain_id and o.code = $3
           left join article_availability av on av.article_id = a.id and av.outlet_id = o.id
          where a.chain_id = $1 and a.code = $2`,
        [chainId, code, outletCode]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Article or outlet", `${code} / ${outletCode}`);

      try {
        await tx.query(
          `insert into article_availability (chain_id, article_id, outlet_id, availability, reason,
                                             source, updated_by_user_id)
           values ($1, $2, $3, $4, $5, 'user', $6)
           on conflict (article_id, outlet_id) do update
             set availability = excluded.availability, reason = excluded.reason,
                 source = excluded.source, updated_by_user_id = excluded.updated_by_user_id,
                 updated_at = now()`,
          [
            chainId,
            row.article_id,
            row.outlet_id,
            input.availability,
            input.reason ?? null,
            principal.userId,
          ]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new ValidationError("that outlet is already listed");
        throw error;
      }

      return {
        entityId: `${row.article_id}:${row.outlet_id}`,
        before: { availability: row.availability ?? "available" },
        after: { availability: input.availability, reason: input.reason ?? null, outletCode },
      };
    },
  });

  return {
    code,
    outletCode,
    before: String((outcome.before as { availability: string }).availability),
    after: input.availability,
  };
}

// ---------------------------------------------------------------------------
// The create/edit path (§7.2, §7.3, §16)
// ---------------------------------------------------------------------------
/**
 * Why these two functions exist, and why they are here rather than inside the import
 * module: **an import is not a second way to write an article.** The bulk-import pipeline
 * (§16, §23) calls exactly the functions a create screen or a chatbot intent calls, so the
 * capability checks, the reference resolution, the jurisdiction rules, the effective-dating
 * behaviour and the audit shape are the same code path — and a rule the UI enforces cannot
 * be walked around by uploading a spreadsheet.
 *
 * Two conventions the import depends on and a screen gets for free:
 *
 *   1. **A refusal carries a code, not only prose.** `invalid(code, column, params)` builds a
 *      `ValidationError` whose `details` name the message and the field. The screen would
 *      render the message; the import report renders the same code against the line number
 *      in the operator's own file. Neither invents wording for the other.
 *   2. **A no-op is not a write.** `updateArticle` diffs first and only opens a transaction
 *      when something actually differs, which is what makes re-importing a file idempotent
 *      rather than a stream of audit rows saying nothing changed (§23.3 layer 2).
 */
export type ArticleType = "food" | "beverage" | "retail" | "service";
export type DietaryMark = "veg" | "non_veg" | "egg" | "vegan" | "none";
export type OutletAvailability = "available" | "seasonal" | "unavailable";

export interface ArticlePriceInput {
  outletCode: string;
  amount: number;
  currencyCode: string;
  /** ISO 8601 (YYYY-MM-DD); defaults to today, and the default is reported (§16 item 3). */
  effectiveFrom?: string | null;
}

export interface ArticleWriteInput {
  code: string;
  name: string;
  shortName?: string | null;
  categoryCode: string;
  articleType: ArticleType;
  dietaryMark?: DietaryMark | null;
  taxClassCode?: string | null;
  hsnSacCode?: string | null;
  baseUomCode: string;
  servingSizeQty?: number | null;
  servingSizeUomCode?: string | null;
  caloriesKcal?: number | null;
  channels?: string[];
  allergens?: { code: string; mayContain: boolean }[];
  nutrients?: { code: string; value: number; basis: string }[];
  prices?: ArticlePriceInput[];
  availability?: OutletAvailability | null;
  externalRef?: string | null;
  sourceSystem?: string | null;
}

export interface ArticleWriteResult {
  id: string;
  code: string;
  /** The record's lifecycle state after the call (§6). */
  status: string;
  version: number;
  outcome: "created" | "updated" | "unchanged";
  /** Field-level names of what changed (empty for a create or a no-op). */
  changed: string[];
  pricesWritten: number;
  /** Required-in-jurisdiction fields the row did not carry; non-empty means the record
   * could not reach `active` and landed lower, which the report says out loud. */
  missingRequired: string[];
}

/** A coded validation refusal. `column` is the field the operator must look at. */
export function invalid(
  code: string,
  column: string,
  params: Record<string, string | number> = {}
): ValidationError {
  return new ValidationError(`${code}:${column}`, { code, column, params });
}

interface ArticleRefs {
  categoryId: string;
  taxClassId: string | null;
  baseUomId: string;
  servingUomId: string | null;
  /** The code travels with the id: the audit diff and the "unchanged" comparison are about
   * what a person reads, and an id is not that. */
  allergens: { id: string; code: string; mayContain: boolean }[];
  nutrients: { id: string; code: string; value: number; basis: string }[];
  outlets: { id: string; code: string; currency: string }[];
}

/**
 * Resolves every reference an article row names, or refuses with the code and the column.
 *
 * Nothing here writes. It is deliberately *all* the resolution in one place because the
 * import's dry run needs the same answers as its commit: a dry run that resolved references
 * differently from the commit would be a report nobody could trust.
 */
async function resolveArticleRefs(
  tx: Queryable,
  chainId: string,
  input: ArticleWriteInput
): Promise<ArticleRefs> {
  const category = await tx.query<{ id: string }>(
    `select id from article_category where chain_id = $1 and lower(code) = lower($2)`,
    [chainId, input.categoryCode]
  );
  if (!category[0]) {
    throw invalid("validation.unknownReference", "category", {
      kind: "category",
      code: input.categoryCode,
    });
  }

  // A tax class must resolve in a jurisdiction the chain actually trades in (§7.1): a
  // class from another market is not a class this article can be sold under.
  const jurisdictions = await tradedJurisdictions(chainId);
  let taxClassId: string | null = null;
  if (input.taxClassCode) {
    const rows = await tx.query<{ id: string; jurisdiction_code: string }>(
      `select id, jurisdiction_code from tax_class
        where chain_id = $1 and lower(code) = lower($2)`,
      [chainId, input.taxClassCode]
    );
    const match = rows.find((row) => jurisdictions.includes(row.jurisdiction_code)) ?? rows[0];
    if (!match) {
      throw invalid("validation.unknownReference", "taxClass", {
        kind: "tax class",
        code: input.taxClassCode,
      });
    }
    if (!jurisdictions.includes(match.jurisdiction_code)) {
      throw invalid("validation.jurisdiction.required", "taxClass", {
        field: "tax class",
        jurisdiction: match.jurisdiction_code,
      });
    }
    taxClassId = match.id;
  }

  const uom = async (code: string, column: string): Promise<string> => {
    const rows = await tx.query<{ id: string }>(
      `select id from uom
        where lower(code) = lower($1) and (chain_id is null or chain_id = $2)
        order by chain_id nulls last
        limit 1`,
      [code, chainId]
    );
    if (!rows[0]) throw invalid("validation.unknownReference", column, { kind: "unit", code });
    return rows[0].id;
  };
  const baseUomId = await uom(input.baseUomCode, "baseUom");
  const servingUomId = input.servingSizeUomCode
    ? await uom(input.servingSizeUomCode, "servingUom")
    : null;

  const allergens: { id: string; code: string; mayContain: boolean }[] = [];
  for (const entry of input.allergens ?? []) {
    const rows = await tx.query<{ id: string }>(
      `select id from allergen
        where lower(code) = lower($1) and (chain_id is null or chain_id = $2)
        order by chain_id nulls last limit 1`,
      [entry.code, chainId]
    );
    if (!rows[0]) {
      throw invalid("validation.unknownReference", "allergens", {
        kind: "allergen",
        code: entry.code,
      });
    }
    allergens.push({ id: rows[0].id, code: entry.code, mayContain: entry.mayContain });
  }

  const nutrients: { id: string; code: string; value: number; basis: string }[] = [];
  for (const entry of input.nutrients ?? []) {
    const rows = await tx.query<{ id: string }>(
      `select id from nutrient
        where lower(code) = lower($1) and (chain_id is null or chain_id = $2)
        order by chain_id nulls last limit 1`,
      [entry.code, chainId]
    );
    if (!rows[0]) {
      throw invalid("validation.unknownReference", "nutrition", {
        kind: "nutrient",
        code: entry.code,
      });
    }
    nutrients.push({ id: rows[0].id, code: entry.code, value: entry.value, basis: entry.basis });
  }

  const outlets: { id: string; code: string; currency: string }[] = [];
  for (const price of input.prices ?? []) {
    const rows = await tx.query<{ id: string; currency: string }>(
      `select o.id, coalesce(s.currency, 'INR') as currency
         from outlet o join site s on s.id = o.site_id
        where o.chain_id = $1 and lower(o.code) = lower($2)`,
      [chainId, price.outletCode]
    );
    if (!rows[0]) {
      throw invalid("validation.unknownOutlet", "prices", { code: price.outletCode });
    }
    if (rows[0].currency !== price.currencyCode) {
      // The same rule `updateArticlePrice` enforces for a hand edit (§7.1): a price is in
      // the currency of the site it is sold at, and a file cannot talk us into another.
      throw invalid("validation.money.currencyMismatch", "prices", {
        outlet: price.outletCode,
        currency: rows[0].currency,
        given: price.currencyCode,
      });
    }
    outlets.push({ id: rows[0].id, code: price.outletCode, currency: rows[0].currency });
  }

  return { categoryId: category[0].id, taxClassId, baseUomId, servingUomId, allergens, nutrients, outlets };
}

/** The fields a market's profile requires for an article, and which of them are missing. */
async function complianceGaps(
  tx: Queryable,
  chainId: string,
  input: ArticleWriteInput
): Promise<string[]> {
  const jurisdictions = await tradedJurisdictions(chainId);
  const missing = new Set<string>();
  for (const jurisdiction of jurisdictions) {
    const required = await requiredFields(tx, jurisdiction, "article");
    for (const field of required) {
      const present = (() => {
        switch (field) {
          case "dietaryMark":
            return Boolean(input.dietaryMark);
          case "hsnSacCode":
            return Boolean(input.hsnSacCode);
          case "caloriesKcal":
            return input.caloriesKcal !== null && input.caloriesKcal !== undefined;
          case "servingSize":
            return input.servingSizeQty !== null && input.servingSizeQty !== undefined;
          case "taxClass":
            return Boolean(input.taxClassCode);
          case "allergens":
            // Declaring "none" is a positive statement (§7.1): the field is present when the
            // row says so explicitly, which is what an empty cell cannot express.
            return input.allergens !== undefined;
          default:
            return true;
        }
      })();
      if (!present) missing.add(field);
    }
  }
  return [...missing];
}

/** Whether the chain holds the approval-gated golden-record feature (§6). */
async function approvalGated(tx: Queryable, chainId: string): Promise<boolean> {
  const rows = await tx.query<{ enabled: boolean }>(
    `select cf.enabled
       from chain_feature cf join feature f on f.code = cf.feature_code
      where cf.chain_id = $1 and f.code = 'mdm_approval_gated'`,
    [chainId]
  );
  return Boolean(rows[0]?.enabled);
}

/**
 * Creates an article and its first version, plus the content, compliance and price rows a
 * hand-entered article would carry.
 *
 * `mdm.article.create` is the gate, exactly as §3 says — a role holding only
 * `mdm.article.import` gets no further than the batch, and the import reports that refusal
 * per row rather than pretending the column was wrong.
 */
export async function createArticle(
  principal: Principal,
  input: ArticleWriteInput,
  meta: MutationMeta = {}
): Promise<ArticleWriteResult> {
  const code = input.code?.trim();
  if (!code) throw invalid("validation.required", "code", { field: "code" });
  if (!input.name?.trim()) throw invalid("validation.required", "name", { field: "name" });
  if (!input.categoryCode?.trim()) {
    throw invalid("validation.required", "category", { field: "category" });
  }
  if (!input.baseUomCode?.trim()) {
    throw invalid("validation.required", "baseUom", { field: "baseUom" });
  }
  if (!["food", "beverage", "retail", "service"].includes(input.articleType)) {
    throw invalid("validation.invalidEnum", "articleType", { values: "food, beverage, retail, service" });
  }

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.article.create",
    entityType: "article",
    chainId,
    target: `article ${code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const run = async (tx: Queryable): Promise<ArticleWriteResult> => {
    const refs = await resolveArticleRefs(tx, chainId, input);
    const gaps = await complianceGaps(tx, chainId, input);

    // Landing state (§6): the chain's approval switch decides, and where it is off only a
    // holder of `*.approve` can take a record straight to `active`. Anything else lands as
    // a draft, which is a fact the report states rather than an error it invents.
    const gated = await approvalGated(tx, chainId);
    const mayApprove = await can(principal, "mdm.article.approve", { chainId });
    // One answer to "where does a brand-new record land": `landingStatus`, the same
    // function the import's dry run calls. The two used to disagree — the dry run promised
    // `pending_review` on an approval-gated chain while this inline rule could only ever
    // produce `draft` or `active`, so the same file reported two different landings.
    const status = landingStatus(gated, mayApprove, gaps);
    const versionStatus: string = status;

    const inserted = await tx.query<{ id: string }>(
      `insert into article (chain_id, code, category_id, article_type, status, base_uom_id,
                            external_ref, source_system)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        chainId,
        code,
        refs.categoryId,
        input.articleType,
        status,
        refs.baseUomId,
        input.externalRef ?? null,
        input.sourceSystem ?? null,
      ]
    );
    const articleId = inserted[0]?.id;
    if (!articleId) throw new ValidationError("article insert returned no id");

    const version = await tx.query<{ id: string }>(
      `insert into article_version (chain_id, article_id, version, status, dietary_mark,
                                    tax_class_id, hsn_sac_code, serving_size_qty,
                                    serving_size_uom_id, calories_kcal, channel_flags,
                                    effective_from, approved_at, approved_by_user_id,
                                    created_by_user_id)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10::text[],
               $11::date, $12, $13, $14)
       returning id`,
      [
        chainId,
        articleId,
        versionStatus,
        input.dietaryMark ?? null,
        refs.taxClassId,
        input.hsnSacCode ?? null,
        input.servingSizeQty ?? null,
        refs.servingUomId,
        input.caloriesKcal ?? null,
        input.channels ?? [],
        dayOrNull(input.prices?.[0]?.effectiveFrom),
        status === "active" ? new Date() : null,
        status === "active" ? principal.userId : null,
        principal.userId,
      ]
    );
    const versionId = version[0]?.id;
    if (!versionId) throw new ValidationError("article version insert returned no id");

    await tx.query(`update article set current_version_id = $2 where id = $1`, [articleId, versionId]);
    if (status === "pending_review") {
      // A gated chain's new record lands *in review*, which is only a real state if the
      // queue has an item in it: status alone would be a dead end nobody can act on. The
      // task joins this transaction, so a create either lands with its review task or
      // does not land at all.
      await raiseArticleReviewTask(tx, {
        chainId,
        principal,
        code,
        articleId,
        versionId,
        version: 1,
      });
    }
    await tx.query(
      `insert into article_version_text (chain_id, article_version_id, locale, name, short_name)
       values ($1, $2, $3, $4, $5)`,
      [chainId, versionId, meta.locale ?? "en-IN", input.name.trim(), input.shortName?.trim() || null]
    );

    for (const jurisdiction of await tradedJurisdictions(chainId)) {
      await tx.query(
        `insert into article_version_jurisdiction (chain_id, article_version_id, jurisdiction_code,
                                                   tax_class_id, hsn_sac_code, calories_kcal,
                                                   serving_size_qty, serving_size_uom_id, overrides)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[])
         on conflict (article_version_id, jurisdiction_code) do nothing`,
        [
          chainId,
          versionId,
          jurisdiction,
          refs.taxClassId,
          input.hsnSacCode ?? null,
          input.caloriesKcal ?? null,
          input.servingSizeQty ?? null,
          refs.servingUomId,
          refs.taxClassId ? ["taxClass"] : [],
        ]
      );
    }

    for (const allergen of refs.allergens) {
      await tx.query(
        `insert into article_version_allergen (chain_id, article_version_id, allergen_id, may_contain, source)
         values ($1, $2, $3, $4, 'declared')
         on conflict (article_version_id, allergen_id) do update set may_contain = excluded.may_contain`,
        [chainId, versionId, allergen.id, allergen.mayContain]
      );
    }
    for (const nutrient of refs.nutrients) {
      await tx.query(
        `insert into article_version_nutrient (chain_id, article_version_id, nutrient_id, value, basis)
         values ($1, $2, $3, $4, $5)
         on conflict (article_version_id, nutrient_id, basis) do update set value = excluded.value`,
        [chainId, versionId, nutrient.id, nutrient.value, nutrient.basis]
      );
    }

    let pricesWritten = 0;
    const prices = input.prices ?? [];
    for (const [index, price] of prices.entries()) {
      const outlet = refs.outlets[index];
      if (!outlet) continue;
      await tx.query(
        `insert into article_price (chain_id, article_id, article_version_id, outlet_id, amount,
                                    currency_code, effective_from, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
        [
          chainId,
          articleId,
          versionId,
          outlet.id,
          price.amount,
          price.currencyCode,
          price.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
          principal.userId,
        ]
      );
      if (input.availability) {
        await tx.query(
          `insert into article_availability (chain_id, article_id, outlet_id, availability, source, updated_by_user_id)
           values ($1, $2, $3, $4, 'user', $5)
           on conflict (article_id, outlet_id) do update
             set availability = excluded.availability, updated_at = now()`,
          [chainId, articleId, outlet.id, input.availability, principal.userId]
        );
      }
      pricesWritten += 1;
    }

    await writeAudit(tx, {
      principal,
      action: "mdm.article.create",
      entityType: "article",
      entityId: articleId,
      chainId,
      beforeState: null,
      afterState: {
        code,
        version: 1,
        versionId,
        status,
        // The audit row a support query starts from: what the create actually wrote.
        category: input.categoryCode,
        articleType: input.articleType,
        prices: prices.map((price) => ({
          outletCode: price.outletCode,
          amount: price.amount,
          currencyCode: price.currencyCode,
          effectiveFrom: price.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
        })),
        externalRef: input.externalRef ?? null,
        sourceSystem: input.sourceSystem ?? null,
      },
      outcome: "success",
      source: meta.source ?? "api",
      intent: meta.intent ?? null,
      batchId: meta.batchId ?? null,
    });

    return {
      id: articleId,
      code,
      status,
      version: 1,
      outcome: "created" as const,
      changed: ["article", "version", "prices"],
      pricesWritten,
      missingRequired: gaps,
    };
  };

  if (meta.tx) return run(meta.tx);
  return withTransaction(run);
}

/** A `YYYY-MM-DD` date or null — never a silent `Invalid Date`. */
function dayOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Edits the current version's content: the non-financial half of the record.
 *
 * Prices are deliberately **not** here — a price change is `mdm.article.price.update` with
 * its own audit trail and its own effective-dated window (`updateArticlePrice`), and folding
 * it into a general update is exactly the merge §3 forbids.
 *
 * A call that changes nothing writes nothing and audits nothing, which is what makes a
 * re-import idempotent (§23.3 layer 2) instead of a wall of no-op audit rows.
 */
export async function updateArticle(
  principal: Principal,
  input: ArticleWriteInput,
  meta: MutationMeta = {}
): Promise<ArticleWriteResult> {
  const code = input.code?.trim();
  if (!code) throw invalid("validation.required", "code", { field: "code" });

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.article.update",
    entityType: "article",
    chainId,
    target: `article ${code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const run = async (tx: Queryable): Promise<ArticleWriteResult> => {
    const current = await loadArticleSnapshot(tx, chainId, code, meta.locale ?? "en-IN");
    if (!current) throw new NotFound("Article", code);
    if (current.status === "pending_review") {
      // A version under review is immutable to its author as well as to everyone else:
      // editing it in place would mean the approver approved something that no longer
      // exists. The send-back is what unlocks it, and it leaves a coded reason behind.
      throw invalid("validation.articleVersionLocked", "status", { status: current.status });
    }
    const refs = await resolveArticleRefs(tx, chainId, input);
    const gaps = await complianceGaps(tx, chainId, input);
    const changed = diffArticleContent(current, input, refs);

    if (changed.length === 0) {
      return {
        id: current.id,
        code,
        status: current.status,
        version: current.version,
        outcome: "unchanged" as const,
        changed: [],
        pricesWritten: 0,
        missingRequired: gaps,
      };
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of changed) {
      before[field] = auditValue(current, field);
      after[field] = auditValue(
        {
          name: input.name?.trim() ?? null,
          short_name: input.shortName?.trim() ?? null,
          dietary_mark: input.dietaryMark ?? null,
          tax_class_code: input.taxClassCode ?? current.taxClassCode ?? null,
          hsn_sac_code: input.hsnSacCode ?? null,
          serving_size_qty: input.servingSizeQty ?? null,
          calories_kcal: input.caloriesKcal ?? null,
          article_type: input.articleType ?? null,
          external_ref: input.externalRef ?? null,
          source_system: input.sourceSystem ?? null,
          channel_flags: input.channels ?? null,
          allergen_codes: refs.allergens.filter((entry) => !entry.mayContain).map((e) => e.code),
          nutrition: refs.nutrients.map((n) => n.code),
        },
        field
      );
    }

    await tx.query(
      `update article
          set category_id = $2, article_type = $3, external_ref = $4, source_system = $5,
              updated_at = now()
        where id = $1`,
      [
        current.id,
        refs.categoryId,
        input.articleType || current.articleType,
        input.externalRef ?? current.externalRef,
        input.sourceSystem ?? current.sourceSystem,
      ]
    );
    await tx.query(
      `update article_version
          set dietary_mark = $2, tax_class_id = $3, hsn_sac_code = $4, serving_size_qty = $5,
              serving_size_uom_id = $6, calories_kcal = $7,
              channel_flags = coalesce($8::text[], channel_flags),
              updated_at = now()
        where id = $1`,
      [
        current.versionId,
        input.dietaryMark ?? current.dietaryMark,
        refs.taxClassId ?? current.taxClassId,
        input.hsnSacCode ?? current.hsnSacCode,
        input.servingSizeQty ?? current.servingSizeQty,
        refs.servingUomId ?? current.servingSizeUomId,
        input.caloriesKcal ?? current.caloriesKcal,
        input.channels ?? null,
      ]
    );
    if (changed.includes("name") || changed.includes("shortName")) {
      await tx.query(
        `insert into article_version_text (chain_id, article_version_id, locale, name, short_name)
         values ($1, $2, $3, $4, $5)
         on conflict (article_version_id, locale) do update
           set name = excluded.name, short_name = excluded.short_name, updated_at = now()`,
        [
          chainId,
          current.versionId,
          meta.locale ?? "en-IN",
          input.name?.trim() || current.name || code,
          input.shortName?.trim() ?? current.shortName,
        ]
      );
    }
    if (input.allergens) {
      // A declared set is replaced wholesale: "none declared" is a positive statement (§7.1),
      // so a merged set would be a lie about what the row said.
      await tx.query(`delete from article_version_allergen where article_version_id = $1`, [
        current.versionId,
      ]);
      for (const allergen of refs.allergens) {
        await tx.query(
          `insert into article_version_allergen (chain_id, article_version_id, allergen_id, may_contain, source)
           values ($1, $2, $3, $4, 'declared')`,
          [chainId, current.versionId, allergen.id, allergen.mayContain]
        );
      }
    }
    if (input.nutrients) {
      await tx.query(`delete from article_version_nutrient where article_version_id = $1`, [
        current.versionId,
      ]);
      for (const nutrient of refs.nutrients) {
        await tx.query(
          `insert into article_version_nutrient (chain_id, article_version_id, nutrient_id, value, basis)
           values ($1, $2, $3, $4, $5)`,
          [chainId, current.versionId, nutrient.id, nutrient.value, nutrient.basis]
        );
      }
    }
    if (input.availability && refs.outlets.length > 0) {
      for (const outlet of refs.outlets) {
        await tx.query(
          `insert into article_availability (chain_id, article_id, outlet_id, availability, source, updated_by_user_id)
           values ($1, $2, $3, $4, 'user', $5)
           on conflict (article_id, outlet_id) do update
             set availability = excluded.availability, updated_at = now()`,
          [chainId, current.id, outlet.id, input.availability, principal.userId]
        );
      }
    }

    await writeAudit(tx, {
      principal,
      action: "mdm.article.update",
      entityType: "article",
      entityId: current.id,
      chainId,
      beforeState: before,
      afterState: { ...after, versionId: current.versionId, version: current.version },
      outcome: "success",
      source: meta.source ?? "api",
      intent: meta.intent ?? null,
      batchId: meta.batchId ?? null,
    });

    return {
      id: current.id,
      code,
      status: current.status,
      version: current.version,
      outcome: "updated" as const,
      changed,
      pricesWritten: 0,
      missingRequired: gaps,
    };
  };

  if (meta.tx) return run(meta.tx);
  return withTransaction(run);
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function auditValue(source: object, field: string): unknown {
  const row = source as Record<string, unknown>;
  switch (field) {
    case "name":
      return row.name ?? null;
    case "shortName":
      return row.short_name ?? null;
    case "dietaryMark":
      return row.dietary_mark ?? null;
    case "taxClass":
      return row.tax_class_code ?? null;
    case "hsnSacCode":
      return row.hsn_sac_code ?? null;
    case "servingSize":
      return row.serving_size_qty ?? null;
    case "caloriesKcal":
      return row.calories_kcal ?? null;
    case "articleType":
      return row.article_type ?? null;
    case "externalRef":
      return row.external_ref ?? null;
    case "sourceSystem":
      return row.source_system ?? null;
    case "channels":
      return row.channel_flags ?? null;
    default:
      return row[field] ?? null;
  }
}

// ---------------------------------------------------------------------------
// The write *plan* — one decision point shared by the write path and a dry run
// ---------------------------------------------------------------------------
/**
 * A dry run has to answer "what would happen to this row" without writing it, and the
 * answer has to be the one the write would actually produce. The way this file keeps the
 * two honest is not a second validator: it is these three functions, which the dry run and
 * the write path both call.
 *
 *   * `loadArticleSnapshot` — the record as it stands (content, declared set, open prices).
 *   * `diffArticleContent`  — field-level difference between the file's row and that record;
 *     the write path applies exactly the fields this reports as changed.
 *   * `landingStatus`       — the lifecycle state a brand-new record lands in (§6).
 *
 * What this does *not* claim: the commit's report is built from what the domain functions
 * actually returned, not from the plan. If the two ever disagreed, the commit's own numbers
 * are what the operator sees — a dry run that can lie about a write is worse than no dry run.
 */
export interface ArticleSnapshot {
  id: string;
  versionId: string;
  version: number;
  status: string;
  name: string | null;
  shortName: string | null;
  categoryId: string;
  articleType: string;
  dietaryMark: string | null;
  taxClassId: string | null;
  taxClassCode: string | null;
  hsnSacCode: string | null;
  servingSizeQty: number | null;
  servingSizeUomId: string | null;
  caloriesKcal: number | null;
  channelFlags: string[];
  externalRef: string | null;
  sourceSystem: string | null;
  allergens: { code: string; mayContain: boolean }[];
  nutrients: { code: string; value: number; basis: string }[];
  prices: { outletCode: string; amount: number; currencyCode: string; effectiveFrom: string }[];
}

export async function loadArticleSnapshot(
  tx: Queryable,
  chainId: string,
  code: string,
  locale: string
): Promise<ArticleSnapshot | null> {
  const found = await tx.query<{
    id: string;
    version_id: string | null;
    version: number | null;
    status: string;
    name: string | null;
    short_name: string | null;
    category_id: string;
    article_type: string;
    dietary_mark: string | null;
    tax_class_id: string | null;
    tax_class_code: string | null;
    hsn_sac_code: string | null;
    serving_size_qty: string | null;
    serving_size_uom_id: string | null;
    calories_kcal: string | null;
    channel_flags: string[];
    external_ref: string | null;
    source_system: string | null;
    allergens: { code: string; may_contain: boolean }[] | null;
    nutrients: { code: string; value: string; basis: string }[] | null;
    prices: { outlet_code: string; amount: string; currency_code: string; effective_from: string }[] | null;
  }>(
    `select a.id, a.current_version_id as version_id, v.version, a.status, a.category_id,
            a.article_type, a.external_ref, a.source_system,
            v.dietary_mark, v.tax_class_id, tc.code as tax_class_code, v.hsn_sac_code,
            v.serving_size_qty, v.serving_size_uom_id, v.calories_kcal, v.channel_flags,
            t.name, t.short_name,
            (select jsonb_agg(jsonb_build_object('code', al.code, 'may_contain', aa.may_contain)
                              order by al.code)
               from article_version_allergen aa join allergen al on al.id = aa.allergen_id
              where aa.article_version_id = v.id) as allergens,
            (select jsonb_agg(jsonb_build_object('code', n.code, 'value', an.value, 'basis', an.basis)
                              order by n.code, an.basis)
               from article_version_nutrient an join nutrient n on n.id = an.nutrient_id
              where an.article_version_id = v.id) as nutrients,
            (select jsonb_agg(jsonb_build_object('outlet_code', o.code, 'amount', p.amount,
                                                 'currency_code', p.currency_code,
                                                 'effective_from', to_char(p.effective_from, 'YYYY-MM-DD'))
                              order by o.code)
               from article_price p join outlet o on o.id = p.outlet_id
              where p.article_version_id = v.id and p.effective_to is null) as prices
       from article a
       left join article_version v on v.id = a.current_version_id
       left join tax_class tc on tc.id = v.tax_class_id
       left join article_version_text t on t.article_version_id = v.id and t.locale = $3
      where a.chain_id = $1 and lower(a.code) = lower($2)`,
    [chainId, code, locale]
  );
  const row = found[0];
  if (!row || !row.version_id) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    version: row.version ?? 1,
    status: row.status,
    name: row.name,
    shortName: row.short_name,
    categoryId: row.category_id,
    articleType: row.article_type,
    dietaryMark: row.dietary_mark,
    taxClassId: row.tax_class_id,
    taxClassCode: row.tax_class_code,
    hsnSacCode: row.hsn_sac_code,
    servingSizeQty: num(row.serving_size_qty),
    servingSizeUomId: row.serving_size_uom_id,
    caloriesKcal: num(row.calories_kcal),
    channelFlags: row.channel_flags ?? [],
    externalRef: row.external_ref,
    sourceSystem: row.source_system,
    allergens: (row.allergens ?? []).map((entry) => ({
      code: entry.code,
      mayContain: entry.may_contain,
    })),
    nutrients: (row.nutrients ?? []).map((entry) => ({
      code: entry.code,
      value: Number(entry.value),
      basis: entry.basis,
    })),
    prices: (row.prices ?? []).map((entry) => ({
      outletCode: entry.outlet_code,
      amount: Number(entry.amount),
      currencyCode: entry.currency_code,
      effectiveFrom: entry.effective_from,
    })),
  };
}

/** The fields this row would change, by name. Empty means the row is a no-op. */
export function diffArticleContent(
  current: ArticleSnapshot,
  input: ArticleWriteInput,
  refs: ArticleRefs
): string[] {
  const changed: string[] = [];
  if (input.name?.trim() && input.name.trim() !== current.name) changed.push("name");
  if ((input.shortName?.trim() ?? null) !== (current.shortName ?? null)) changed.push("shortName");
  if ((input.dietaryMark ?? null) !== (current.dietaryMark ?? null)) changed.push("dietaryMark");
  if ((input.hsnSacCode ?? null) !== (current.hsnSacCode ?? null)) changed.push("hsnSacCode");
  if (refs.taxClassId !== null && refs.taxClassId !== current.taxClassId) changed.push("taxClass");
  if (num(input.servingSizeQty) !== current.servingSizeQty) changed.push("servingSize");
  if (num(input.caloriesKcal) !== current.caloriesKcal) changed.push("caloriesKcal");
  if (refs.categoryId !== current.categoryId) changed.push("category");
  if (input.articleType && input.articleType !== current.articleType) changed.push("articleType");
  if (input.externalRef !== undefined && (input.externalRef ?? null) !== current.externalRef) {
    changed.push("externalRef");
  }
  if (input.sourceSystem !== undefined && (input.sourceSystem ?? null) !== current.sourceSystem) {
    changed.push("sourceSystem");
  }
  if (input.channels) {
    const before = [...current.channelFlags].sort().join(",");
    const after = [...input.channels].sort().join(",");
    if (before !== after) changed.push("channels");
  }
  if (input.allergens) {
    const before = current.allergens
      .filter((entry) => !entry.mayContain)
      .map((entry) => entry.code)
      .sort()
      .join(",");
    const after = refs.allergens
      .filter((entry) => !entry.mayContain)
      .map((entry) => entry.code)
      .sort()
      .join(",");
    if (before !== after) changed.push("allergens");
    const beforeMay = current.allergens
      .filter((entry) => entry.mayContain)
      .map((entry) => entry.code)
      .sort()
      .join(",");
    const afterMay = refs.allergens
      .filter((entry) => entry.mayContain)
      .map((entry) => entry.code)
      .sort()
      .join(",");
    if (beforeMay !== afterMay) changed.push("mayContain");
  }
  if (input.nutrients) {
    const before = current.nutrients
      .map((row) => `${row.code}=${row.value}@${row.basis}`)
      .sort()
      .join("|");
    const after = refs.nutrients
      .map((row) => `${row.code}=${row.value}@${row.basis}`)
      .sort()
      .join("|");
    if (before !== after) changed.push("nutrition");
  }
  return changed;
}

/**
 * Where a brand-new record lands (§6).
 *
 * Three answers, all of them the spec's own: an approval-gated chain (Gold's
 * `mdm_approval_gated`) needs a named approver, so the row lands `pending_review`; where the
 * switch is off, a holder of `*.approve` may take it straight to `active`; anyone else lands
 * `draft`. A record that is missing a field its market requires cannot reach `active` at all
 * — that is the compliance gate working, not an error.
 */
export function landingStatus(
  approvalGated: boolean,
  mayApprove: boolean,
  gaps: string[]
): "draft" | "pending_review" | "active" {
  if (gaps.length > 0) return "draft";
  if (approvalGated) return "pending_review";
  return mayApprove ? "active" : "draft";
}

export interface ArticlePricePlan {
  outletCode: string;
  amount: number;
  currencyCode: string;
  /** The open row this would close, when there is one. */
  from: { amount: number; currencyCode: string } | null;
  effectiveFrom: string;
}

export interface ArticleWritePlan {
  existing: boolean;
  outcome: "created" | "updated" | "unchanged";
  gaps: string[];
  approvalGated: boolean;
  mayApprove: boolean;
  landing: "draft" | "pending_review" | "active";
  /** Capability codes the caller does not hold, and would therefore be refused on. */
  missingCapabilities: string[];
  contentChanged: string[];
  /** The article's id when the row matches an existing record — the report links to it even
   * for an `unchanged` row, which is the row an operator most wants to look at. */
  existingId: string | null;
  priceChanges: ArticlePricePlan[];
  priceUnchanged: string[];
  /** Values the row did not state and the platform filled in, so a wrong default is visible
   *  rather than silent (§16 item 3). */
  defaulted: string[];
}

/**
 * What a row would do, without doing any of it. Reads only — every write this plan implies
 * goes through `createArticle` / `updateArticle` / `updateArticlePrice`, which is what makes
 * a dry run a preview of the real path rather than a second opinion about it.
 */
export async function planArticleWrite(
  tx: Queryable,
  principal: Principal,
  chainId: string,
  input: ArticleWriteInput,
  options: { locale?: string | null; today?: string } = {}
): Promise<ArticleWritePlan> {
  const refs = await resolveArticleRefs(tx, chainId, input);
  const gaps = await complianceGaps(tx, chainId, input);
  const gated = await approvalGated(tx, chainId);
  const mayApprove = await can(principal, "mdm.article.approve", { chainId });
  const current = await loadArticleSnapshot(tx, chainId, input.code, options.locale ?? "en-IN");
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const missingCapabilities: string[] = [];
  const requires = current ? ["mdm.article.update"] : ["mdm.article.create"];
  for (const code of requires) {
    if (!(await can(principal, code, { chainId }))) missingCapabilities.push(code);
  }

  const priceChanges: ArticlePricePlan[] = [];
  const priceUnchanged: string[] = [];
  for (const [index, price] of (input.prices ?? []).entries()) {
    const outlet = refs.outlets[index];
    if (!outlet) continue;
    const open = current?.prices.find((row) => row.outletCode === outlet.code) ?? null;
    if (open && open.amount === price.amount && open.currencyCode === price.currencyCode) {
      priceUnchanged.push(outlet.code);
      continue;
    }
    if (!(await can(principal, "mdm.article.price.update", { chainId }))) {
      if (!missingCapabilities.includes("mdm.article.price.update")) {
        missingCapabilities.push("mdm.article.price.update");
      }
    }
    priceChanges.push({
      outletCode: outlet.code,
      amount: price.amount,
      currencyCode: price.currencyCode,
      from: open ? { amount: open.amount, currencyCode: open.currencyCode } : null,
      effectiveFrom: price.effectiveFrom?.trim() || today,
    });
  }

  const contentChanged = current ? diffArticleContent(current, input, refs) : [];
  const outcome: ArticleWritePlan["outcome"] = !current
    ? "created"
    : contentChanged.length > 0 || priceChanges.length > 0
      ? "updated"
      : "unchanged";

  const defaulted: string[] = [];
  if ((input.prices ?? []).some((price) => !price.effectiveFrom?.trim())) {
    defaulted.push("priceEffectiveFrom");
  }

  return {
    existing: Boolean(current),
    outcome,
    gaps,
    approvalGated: gated,
    mayApprove,
    landing: landingStatus(gated, mayApprove, gaps),
    missingCapabilities,
    contentChanged,
    existingId: current?.id ?? null,
    priceChanges,
    priceUnchanged,
    defaulted,
  };
}
