import "@tanstack/react-start/server-only";

import { poolQueryable, withTransaction, type Queryable } from "~/db";
import { auditedMutation, guard, writeAudit, type MutationOutcome } from "~/server/audit";
import { raiseArticleReviewTask } from "~/domain/mdm-approvals";
// The version transitions the draft-version rule needs: a price change opens N+1 by cloning
// N, and an approval supersedes N. They live in `~/domain/mdm-approvals` because that module
// owns the version lifecycle the review path decides, and this module may call it at runtime
// (the reverse direction is types-only, so there is no cycle).
import {
  cloneArticleVersion,
  openArticleVersion,
  openArticleVersionLocked,
  supersedeArticleVersion,
} from "~/domain/mdm-approvals";
import {
  articleFieldPresent,
  articleVersionComplianceGaps,
  jurisdictionFieldRules,
  requiredFieldsFor,
  tradedJurisdictions,
} from "~/domain/jurisdiction";
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
 * Where the jurisdictions a chain trades in, and what each market's profile requires, are
 * resolved: `~/domain/jurisdiction`. Both moved there in the slab 3c-1 fix pass, because the
 * approve transition has to ask the same question and this module imports the approvals module
 * at runtime — a shared leaf module is the only shape both sides can import.
 *
 * The resolution is an inheritance now (`IN-KA` → `IN`). The old read matched the jurisdiction
 * code exactly, so the seeded national (`IN`) rules were invisible to a chain whose sites are
 * `IN-KA`/`IN-MH`: every gap came back empty, `landingStatus` could not answer `draft`, and the
 * compliance gate never fired. See that module's header for why this is a resolution fix rather
 * than a seeding fix.
 */
export { tradedJurisdictions };

// The required-fields read that used to live here is `requiredFieldsFor` in
// `~/domain/jurisdiction`: it resolves the market's own profile and then its country's, which
// is the difference between a rule set that applies and one that never fired (see that
// module's header). One definition, because the approve transition asks the same question.

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
  const required = await requiredFieldsFor(db, jurisdiction, "article");

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
  /**
   * The article's **open** version (slab 3c-2): a proposal a price change opened, or one an
   * approver sent back. `null` when nothing is waiting for a decision.
   *
   * The record needs it to say what is true rather than what one version's status implies:
   * version N is on sale, version N+1 is proposed, and nothing on the menu changes until
   * someone approves. `isCurrent` separates a first version (never approved, still the
   * article's own) from a proposal that deliberately sits beside the sellable one.
   */
  proposedVersion: {
    id: string;
    version: number;
    status: string;
    isCurrent: boolean;
    effectiveFrom: string | null;
    /** The outlets this proposal prices — the grid as it would be if it were approved. */
    prices: {
      outletCode: string;
      amount: number;
      currencyCode: string;
      effectiveFrom: string | null;
    }[];
    /** The fields this proposal changes against the version it replaces, by name. */
    changedFields: string[];
    /** The outlets whose price this proposal changes. */
    changedOutlets: string[];
    /** The version this proposal replaces, when it replaces one. */
    baseVersion: number | null;
  } | null;
  versions: {
    id: string;
    version: number;
    status: string;
    effectiveFrom: string | null;
    approvedAt: string | null;
    /**
     * When this version stopped being the one on sale.
     *
     * Derived, never stored: the end of a version's window is the moment the *next* version
     * was approved, and no column holds that date. Deriving it is honest for a list — the
     * card's subtitle says where the date comes from — and `superseded_at` would be the
     * column to add if an exact stored answer is ever needed.
     */
    effectiveTo: string | null;
    createdBy: string | null;
    approvedBy: string | null;
  }[];
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
    proposalRows,
    proposalPriceRows,
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
      // A version's window end is derived, not stored: the next version's approval is when
      // this one stopped being on sale. `lead()` over the ascending order gives every row its
      // successor's approval, and the screen's header says that is where the date comes from.
      db.query<{
        id: string;
        version: number;
        status: string;
        effective_from: Date | null;
        approved_at: Date | null;
        next_approved_at: Date | null;
        created_by: string | null;
        approved_by: string | null;
      }>(
        `select v.id, v.version, v.status, v.effective_from, v.approved_at,
                lead(v.approved_at) over (order by v.version) as next_approved_at,
                cu.display_name as created_by, au.display_name as approved_by
           from article_version v
           left join "user" cu on cu.id = v.created_by_user_id
           left join "user" au on au.id = v.approved_by_user_id
          where v.article_id = $1
          order by v.version desc`,
        [row.id]
      ),
      db.query<{ key_type: string; value: string; last_seen_at: Date | null }>(
        `select key_type, value, last_seen_at
           from external_key
          where chain_id = $1 and entity_type = 'article' and entity_id = $2
          order by is_primary desc, key_type`,
        [chainId, row.id]
      ),
      // The open version, if the article has one (slab 3c-2), and what it changes against the
      // version it replaces. Read here rather than as a second function so the record screen
      // makes one round trip; the comparison is done in SQL because `is distinct from` on each
      // column is exactly the "did this field change" question, and it handles NULLs correctly
      // without nine lines of JS per field.
      db.query<{
        id: string;
        version: number;
        status: string;
        effective_from: Date | null;
        base_version: number | null;
        changed_name: boolean;
        changed_dietary_mark: boolean;
        changed_tax_class: boolean;
        changed_hsn: boolean;
        changed_serving: boolean;
        changed_calories: boolean;
        changed_channels: boolean;
        changed_allergens: boolean;
        changed_nutrition: boolean;
      }>(
        `select ov.id, ov.version, ov.status, ov.effective_from, b.version as base_version,
                (coalesce(bt.name, '') is distinct from coalesce(ot.name, '')) as changed_name,
                (coalesce(base.dietary_mark, '') is distinct from coalesce(ov.dietary_mark, '')) as changed_dietary_mark,
                (base.tax_class_id is distinct from ov.tax_class_id) as changed_tax_class,
                (coalesce(base.hsn_sac_code, '') is distinct from coalesce(ov.hsn_sac_code, '')) as changed_hsn,
                (base.serving_size_qty is distinct from ov.serving_size_qty) as changed_serving,
                (base.calories_kcal is distinct from ov.calories_kcal) as changed_calories,
                (base.channel_flags is distinct from ov.channel_flags) as changed_channels,
                (select count(*) from article_version_allergen a where a.article_version_id = ov.id)
                  <> (select count(*) from article_version_allergen a where a.article_version_id = base.id) as changed_allergens,
                (select count(*) from article_version_nutrient n where n.article_version_id = ov.id)
                  <> (select count(*) from article_version_nutrient n where n.article_version_id = base.id) as changed_nutrition
           from article_version ov
           left join article_version cv on cv.id = $2
           left join article_version b on b.id = ov.supersedes_version_id
           left join lateral (select * from article_version where id = coalesce(b.id, cv.id)) base on true
           left join article_version_text ot on ot.article_version_id = ov.id and ot.locale = $3
           left join article_version_text bt on bt.article_version_id = base.id and bt.locale = $3
          where ov.chain_id = $1 and ov.article_id = $4
            and ov.status in ('draft', 'pending_review')
          order by ov.version desc
          limit 1`,
        [chainId, row.version_id, preferredLocale, row.id]
      ),
      db.query<{
        outlet_code: string;
        amount: string;
        currency_code: string;
        effective_from: Date | string | null;
      }>(
        `select o.code as outlet_code, p.amount, p.currency_code, p.effective_from
           from article_price p
           join outlet o on o.id = p.outlet_id
          where p.article_version_id = (
                  select v.id from article_version v
                   where v.article_id = $1 and v.status in ('draft', 'pending_review')
                   order by v.version desc
                   limit 1)
            and p.effective_to is null
          order by o.code`,
        [row.id]
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
    // Resolved with inheritance (`IN-KA` → `IN`), so a market column shows the rules that
    // actually apply there rather than only the rows written under that exact code.
    const rules = await jurisdictionFieldRules(db, jurisdiction, "article");
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
        legalRef: rule.legalRef,
      });
    }
  }

  // What the open version would change, stated as facts rather than left for the reader to
  // find by comparing two grids (§16's review surface asks for the diff, not the pair).
  const proposal = proposalRows[0] ?? null;
  const isProposal = proposal !== null && proposal.id !== row.version_id;
  const currentPriceByOutlet = new Map(
    priceRows.map((price) => [
      price.outlet_code,
      { amount: Number(price.amount), currencyCode: price.currency_code },
    ])
  );
  const proposalPrices = proposalPriceRows.map((price) => ({
    outletCode: price.outlet_code,
    amount: Number(price.amount),
    currencyCode: price.currency_code,
    effectiveFrom: price.effective_from ? asIso(price.effective_from).slice(0, 10) : null,
  }));
  const changedOutlets = isProposal
    ? proposalPrices
        .filter((price) => {
          const base = currentPriceByOutlet.get(price.outletCode);
          return !base || base.amount !== price.amount || base.currencyCode !== price.currencyCode;
        })
        .map((price) => price.outletCode)
    : [];
  const changedFields: string[] = [];
  if (isProposal && proposal) {
    if (proposal.changed_name) changedFields.push("name");
    if (proposal.changed_dietary_mark) changedFields.push("dietaryMark");
    if (proposal.changed_tax_class) changedFields.push("taxClass");
    if (proposal.changed_hsn) changedFields.push("hsnSacCode");
    if (proposal.changed_serving) changedFields.push("servingSize");
    if (proposal.changed_calories) changedFields.push("caloriesKcal");
    if (proposal.changed_channels) changedFields.push("channels");
    if (proposal.changed_allergens) changedFields.push("allergens");
    if (proposal.changed_nutrition) changedFields.push("nutrition");
  }
  const proposedVersion: ArticleDetail["proposedVersion"] = proposal
    ? {
        id: proposal.id,
        version: proposal.version,
        status: proposal.status,
        isCurrent: proposal.id === row.version_id,
        effectiveFrom: proposal.effective_from ? asIso(proposal.effective_from).slice(0, 10) : null,
        prices: proposalPrices,
        changedFields,
        changedOutlets,
        baseVersion: proposal.base_version,
      }
    : null;

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
    proposedVersion,
    versions: versionRows.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      effectiveFrom: version.effective_from ? asIso(version.effective_from).slice(0, 10) : null,
      approvedAt: version.approved_at ? asIso(version.approved_at) : null,
      effectiveTo: version.next_approved_at ? asIso(version.next_approved_at).slice(0, 10) : null,
      createdBy: version.created_by,
      approvedBy: version.approved_by,
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
 * (`mdm.article.price.update`) rather than a field on the general update.
 *
 * **A price change is a version** (§7.2 item 5; PRD: "Price or recipe changes create a new
 * version rather than overwriting the old one, so a historical order keeps the figures it
 * was actually sold under"). The rule, in full:
 *
 *   * If the article has an **open draft** — a proposal an earlier price change opened, or
 *     one an approver sent back — the write lands on *that* version. That is the flow's only
 *     correction path: a returned draft that could not be edited could never be resubmitted.
 *   * If the open version is `pending_review` the write is refused outright
 *     (`validation.articleVersionLocked`). Moving a figure while an approver is looking at
 *     it is the exact failure maker-checker exists to prevent, whether that version is the
 *     article's current one or a proposal sitting beside it.
 *   * Otherwise — a version is on sale and nothing is open — this opens **N+1 as a `draft`**
 *     by cloning N: content, allergens, nutrition, the per-jurisdiction grid and every
 *     outlet's open price window, with the changed price written onto the new version. **N
 *     stays `active` and sellable**: `article.current_version_id` does not move, so every
 *     price read in this codebase keeps resolving to N and billing is unaffected with no new
 *     enforcement anywhere.
 *   * Where the chain is **not** approval-gated and the caller may approve, N+1 is approved
 *     and N superseded inside this same transaction. Without that branch a one-person Silver
 *     chain could never reprice, having nobody to be the second pair of eyes. Where the chain
 *     *is* gated, N+1 goes to the approver's queue with a task and the price is frozen.
 *
 * The window discipline is unchanged, and applies to whichever version was written: the open
 * row is closed the day before the new window opens and a new row is opened, never edited in
 * place, so a historical bill's price stays reproducible (§11.2's discipline, applied to a
 * price for the same reason).
 */
export interface ArticlePriceWriteResult {
  code: string;
  outletCode: string;
  before: Money | null;
  after: Money;
  /**
   * What this write did to the version set — the fact the screen's confirmation and the
   * audit row both turn on, and the one thing an operator cannot infer from the price.
   */
  version: {
    id: string;
    version: number;
    status: string;
    /** `opened` (this write created a proposal) · `proposal` (it wrote to the open draft) ·
     *  `inPlace` (the article has no approved version yet) · `approved` (it opened N+1 and
     *  approved it in the same transaction). */
    landed: "opened" | "proposal" | "inPlace" | "approved";
    /** The version N+1 replaces, when this write opened one. */
    baseVersionId: string | null;
    baseVersion: number | null;
    /** The review task raised for the new version, when the chain is approval-gated. */
    taskId: string | null;
  };
}

export async function updateArticlePrice(
  principal: Principal,
  input: { code: string; outletCode: string; amount: number; currencyCode: string; effectiveFrom?: string | null },
  meta: MutationMeta = {}
): Promise<ArticlePriceWriteResult> {
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

  const effectiveFrom = input.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10);

  const run = async (tx: Queryable): Promise<MutationOutcome> => {
    // The article row is locked before anything is read about its versions: the supersede
    // below moves `current_version_id`, and a decision running on the same article must not
    // be able to move it between this read and this write.
    const articles = await tx.query<{ id: string; status: string; current_version_id: string | null }>(
      `select id, status, current_version_id from article
        where chain_id = $1 and code = $2
        for update`,
      [chainId, code]
    );
    const article = articles[0];
    if (!article) throw new NotFound("Article", code);

    const outletRows = await tx.query<{ outlet_id: string; site_currency: string }>(
      `select o.id as outlet_id, coalesce(s.currency, 'INR') as site_currency
         from outlet o
         join site s on s.id = o.site_id
        where o.chain_id = $1 and o.code = $2`,
      [chainId, outletCode]
    );
    const outlet = outletRows[0];
    if (!outlet) throw new NotFound("Outlet", outletCode);

    // The price's currency is the outlet's site currency (§7.1). A caller that sends a
    // different code is asking for something the model does not offer, so it is refused
    // rather than silently stored.
    if (outlet.site_currency !== currencyCode) {
      throw new ValidationError(
        `${outletCode} trades in ${outlet.site_currency}; a price in ${currencyCode} needs its own site`
      );
    }

    if (article.status === "discontinued") {
      throw invalid("validation.review.articleClosed", "status", { status: article.status });
    }

    const open = await openArticleVersionLocked(tx, article.id);
    const currentRows = article.current_version_id
      ? await tx.query<{ id: string; version: number; status: string }>(
          `select id, version, status from article_version where id = $1 and chain_id = $2 for update`,
          [article.current_version_id, chainId]
        )
      : [];
    const current = currentRows[0] ?? null;

    // Money is frozen while a version is under review (slab 3c-1). The freeze now covers the
    // proposal as well as the current version: a figure must not move while it sits in an
    // approver's queue, or the approval publishes a number they never saw.
    if (open && open.status === "pending_review") {
      throw invalid("validation.articleVersionLocked", "status", { status: open.status });
    }

    let target: { id: string; version: number } | null = open ?? current;
    let landedStatus = open?.status ?? current?.status ?? "draft";
    let landed: ArticlePriceWriteResult["version"]["landed"] = "inPlace";
    let base: { id: string; version: number } | null = null;
    let raisedTaskId: string | null = null;

    if (open && article.current_version_id !== open.id) {
      // A proposal already waits: either a correction of a sent-back draft or a second change
      // to the same draft. Both land on the open version, never on the sellable one.
      landed = "proposal";
      base = current ? { id: current.id, version: current.version } : null;
    } else if (!open) {
      if (!current) throw new ValidationError(`${code} has no current version`);
      if (current.status === "draft") {
        // No approved version yet: the draft *is* the article, so the write lands in place,
        // exactly as it did before this rule existed.
        target = current;
        landed = "inPlace";
      } else {
        // Open N+1 as a draft, carrying N's content and N's whole open price grid.
        const clone = await cloneArticleVersion(tx, {
          chainId,
          articleId: article.id,
          fromVersionId: current.id,
          principalId: principal.userId,
          effectiveFrom,
        });
        target = { id: clone.id, version: clone.version };
        landedStatus = "draft";
        base = { id: current.id, version: current.version };
        landed = "opened";

        // Where a new version lands (§6, applied to a version rather than to a create): a
        // requirement of a market the clone does not meet keeps it a draft; an
        // approval-gated chain puts it in the approver's queue; a chain with no gate, where
        // the caller may approve, needs no second pair of eyes and takes it live here.
        const gaps = await articleVersionComplianceGaps(tx, chainId, clone.id);
        const gated = await approvalGated(tx, chainId);
        const mayApprove = await can(principal, "mdm.article.approve", { chainId });
        const landing = landingStatus(
          gated,
          mayApprove,
          gaps.map((gap) => gap.field)
        );
        if (landing === "pending_review") {
          landedStatus = "pending_review";
        } else if (landing === "active") {
          await supersedeArticleVersion(tx, {
            chainId,
            articleId: article.id,
            versionId: clone.id,
            baseVersionId: current.id,
            principalId: principal.userId,
          });
          landedStatus = "active";
          landed = "approved";
        }
      }
    }
    if (!target) throw new ValidationError(`${code} has no version to price`);

    // The window write, on whichever version this landed on. Close-then-open, never an
    // in-place edit: the closed row is what a historical bill reproduces.
    const openPriceRows = await tx.query<{ id: string; amount: string; currency_code: string }>(
      `select id, amount, currency_code from article_price
        where article_version_id = $1 and outlet_id = $2 and effective_to is null
        for update`,
      [target.id, outlet.outlet_id]
    );
    const openPrice = openPriceRows[0];
    const before: Money | null = openPrice
      ? { amount: Number(openPrice.amount), currencyCode: openPrice.currency_code }
      : null;

    if (openPrice) {
      await tx.query(
        `update article_price
            set effective_to = greatest($2::date - 1, effective_from)
          where id = $1`,
        [openPrice.id, effectiveFrom]
      );
    }

    const inserted = await tx.query<{ id: string }>(
      `insert into article_price (chain_id, article_id, article_version_id, outlet_id, amount,
                                  currency_code, effective_from, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8)
       returning id`,
      [
        chainId,
        article.id,
        target.id,
        outlet.outlet_id,
        input.amount,
        currencyCode,
        effectiveFrom,
        principal.userId,
      ]
    );

    // The version reaches `pending_review` and its task is raised only now, after the price
    // is stored: the approver must be able to read the figure they are being asked to accept,
    // and a version under review refuses price writes by design.
    if (landed === "opened" && landedStatus === "pending_review") {
      await tx.query(
        `update article_version set status = 'pending_review', updated_at = now() where id = $1`,
        [target.id]
      );
      raisedTaskId = await raiseArticleReviewTask(tx, {
        chainId,
        principal,
        code,
        articleId: article.id,
        versionId: target.id,
        version: target.version,
        note: meta.intent ?? null,
      });
    }

    await tx.query(`update article set updated_at = now() where id = $1`, [article.id]);

    return {
      entityId: inserted[0]?.id ?? null,
      // The audit row carries both windows and both versions: what was closed and what was
      // opened, and which version was on sale before and after (§7.3 — a versioned change
      // audits the version, not the row, so "what did N+1 change" is answerable from the
      // ledger and not only by arithmetic over version numbers).
      before: before
        ? {
            ...before,
            priceId: openPrice?.id ?? null,
            effectiveTo: effectiveFrom,
            versionId: base?.id ?? target.id,
            version: base?.version ?? target.version,
          }
        : null,
      after: {
        amount: input.amount,
        currencyCode,
        outletCode,
        effectiveFrom,
        versionId: target.id,
        version: target.version,
        versionStatus: landedStatus,
        openedVersion: landed === "opened" || landed === "approved",
        landed,
        baseVersionId: base?.id ?? null,
        baseVersion: base?.version ?? null,
        taskId: raisedTaskId,
      },
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
  const after = (outcome.after ?? {}) as {
    versionId?: string;
    version?: number;
    versionStatus?: string;
    landed?: ArticlePriceWriteResult["version"]["landed"];
    baseVersionId?: string | null;
    baseVersion?: number | null;
    taskId?: string | null;
  };
  return {
    code,
    outletCode,
    before: before ? { amount: before.amount, currencyCode: before.currencyCode } : null,
    after: { amount: input.amount, currencyCode },
    version: {
      id: after.versionId ?? "",
      version: after.version ?? 0,
      status: after.versionStatus ?? "draft",
      landed: after.landed ?? "inPlace",
      baseVersionId: after.baseVersionId ?? null,
      baseVersion: after.baseVersion ?? null,
      taskId: after.taskId ?? null,
    },
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
  // The values a rule is tested against, keyed by the rule's own field names. The same
  // predicate answers for a create (here, from what the operator stated) and for a stored
  // version (in `~/domain/jurisdiction`, from the columns) — the approve transition reads
  // that one, and the two must not be able to disagree about what "complete" means.
  const values = {
    name: input.name,
    dietaryMark: input.dietaryMark,
    taxClass: input.taxClassCode,
    hsnSacCode: input.hsnSacCode,
    servingSize: input.servingSizeQty,
    caloriesKcal: input.caloriesKcal,
    // Declaring "none" is a positive statement (§7.1): the field is present when the row
    // says so explicitly, which is what an empty cell cannot express.
    allergensDeclared: input.allergens !== undefined,
  };
  const missing = new Set<string>();
  for (const jurisdiction of jurisdictions) {
    for (const field of await requiredFieldsFor(tx, jurisdiction, "article")) {
      if (!articleFieldPresent(field, values)) missing.add(field);
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
    if (current.versionStatus === "pending_review" || current.status === "pending_review") {
      // A version under review is immutable to its author as well as to everyone else:
      // editing it in place would mean the approver approved something that no longer
      // exists. The send-back is what unlocks it, and it leaves a coded reason behind.
      //
      // The check reads the *version's* status as well as the article's, because that is the
      // field the plan reads: two different fields deciding whether this call refuses is how
      // a dry run and a commit end up disagreeing about the same row.
      throw invalid("validation.articleVersionLocked", "status", { status: current.versionStatus });
    }
    // A proposal beside the sellable version is a different refusal (slab 3c-2). This call
    // edits the *current* version's content, but the open draft was cloned from it: editing
    // the sellable version here would leave the proposal carrying the content it was cloned
    // with, and approving that proposal would silently undo this edit. Content drafts are not
    // built yet, so the honest answer is to say the article already has a decision waiting —
    // the price path is the one that writes into an open draft, and it targets that draft
    // rather than this version.
    const proposed = await openArticleVersion(tx, current.id);
    if (proposed && proposed.id !== current.versionId) {
      throw invalid("validation.review.articleOpen", "version", { version: proposed.version });
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
  /** The *article header's* lifecycle state. */
  status: string;
  /**
   * The **version's** own lifecycle state — the field the write path is frozen on.
   *
   * A plan has to know it. While a version is `pending_review` the domain refuses every
   * write to it (`validation.articleVersionLocked`), so a plan that did not read the
   * version's status would report a row as `updated` that the commit then refuses — failing
   * the *entire* file with every row rejected. That disagreement between the two phases is
   * the one thing this pipeline exists to prevent.
   */
  versionStatus: string;
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
    version_status: string | null;
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
    `select a.id, a.current_version_id as version_id, v.version, a.status, v.status as version_status,
            a.category_id,
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
    versionStatus: row.version_status ?? "draft",
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
  /** The current version's lifecycle state, as the database holds it. */
  versionStatus: string | null;
  /**
   * True when the write this row implies would land on a version that is under review, and
   * the row therefore changes something.
   *
   * The write path refuses exactly this case (`updateArticle` and `updateArticlePrice` both
   * throw `validation.articleVersionLocked`), so a caller that reported `updated` here would
   * be promising a write the commit refuses. The import turns it into a row error, which is
   * what keeps the dry run and the commit saying the same thing.
   *
   * Two versions can be under review in the slab 3c-2 world, and they belong to different
   * writes: the *content* path edits the version on sale, while the *price* path writes into
   * the open version (the proposal). So this reads whichever of the two that write would
   * touch — which is why a row carrying both a content and a price change reports the freeze
   * that would stop each half.
   */
  lockedUnderReview: boolean;
  /**
   * The article's *open* version when it is not the version on sale — the proposal a price
   * change opened (slab 3c-2). Null for an article with no open version, and for one whose
   * only open version *is* its current version (a first draft, or a returned one).
   *
   * `article_version` is read here, never read *instead of* `article.current_version_id`: the
   * whole point of the draft-version rule is that the pointer stays on what a guest can order
   * today.
   */
  openVersion: number | null;
  openVersionId: string | null;
  openVersionStatus: string | null;
  /**
   * True when this row would be refused because a version already waits for a decision.
   *
   * `updateArticle` refuses it with `validation.review.articleOpen`: the version beside the
   * one on sale was cloned from it, so editing the sellable version now would leave the
   * proposal carrying content it was never cloned with. A row that changes nothing is not
   * refused (re-importing a file against such an article writes nothing), and a row that
   * changes only a price is the *supported* path — it is written into the open version.
   */
  articleOpen: boolean;
  /**
   * Which version the price comparison read: the proposal when one waits, otherwise the one
   * on sale. A dry run that compared against the sellable price would report a change the
   * commit does not make, and miss the one it does.
   */
  priceAgainst: "openVersion" | "currentVersion" | null;
  /**
   * The lifecycle state an existing record already holds — what it *is*, not what it would
   * land as. `landing` only ever describes a create; reporting it for a record that has one
   * would put a prediction in the "Lands as" column.
   */
  existingStatus: string | null;
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

  // The version waiting for a decision, when it is not the one on sale (slab 3c-2), and the
  // price grid the next write would actually touch. Both are read rather than assumed: the
  // price path writes into the open version when there is one, so a plan that compared
  // against the sellable grid would report a change the commit does not make — and miss the
  // one it does, because a correction of a proposal changes the proposal's figure.
  const openRow = current ? await openArticleVersion(tx, current.id) : null;
  const proposal = current && openRow && openRow.id !== current.versionId ? openRow : null;
  const priceBase: { outletCode: string; amount: number; currencyCode: string }[] = proposal
    ? (
        await tx.query<{ outlet_code: string; amount: string; currency_code: string }>(
          `select o.code as outlet_code, p.amount, p.currency_code
             from article_price p join outlet o on o.id = p.outlet_id
            where p.article_version_id = $1 and p.effective_to is null
            order by o.code`,
          [proposal.id]
        )
      ).map((row) => ({
        outletCode: row.outlet_code,
        amount: Number(row.amount),
        currencyCode: row.currency_code,
      }))
    : (current?.prices ?? []);

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
    const open = priceBase.find((row) => row.outletCode === outlet.code) ?? null;
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

  // The two writes a row can imply, and the version each one touches. Each refusal is
  // reported for the half the row actually asks for: a row that changes nothing is never
  // refused, and a row that only prices while a proposal waits is the *correction* path —
  // it is written into that proposal, which is why this is a flag beside the outcome rather
  // than a disagreement about it.
  const frozen =
    (contentChanged.length > 0 && current?.versionStatus === "pending_review") ||
    (priceChanges.length > 0 &&
      (current?.versionStatus === "pending_review" || proposal?.status === "pending_review"));

  return {
    existing: Boolean(current),
    outcome,
    gaps,
    approvalGated: gated,
    mayApprove,
    landing: landingStatus(gated, mayApprove, gaps),
    versionStatus: current?.versionStatus ?? null,
    // A row that changes nothing is never refused: the write path only reaches its status
    // check when there is something to write, so `unchanged` stays a legal answer for a
    // version under review — re-importing a file for a pending record writes nothing.
    lockedUnderReview: frozen,
    openVersion: proposal?.version ?? null,
    openVersionId: proposal?.id ?? null,
    openVersionStatus: proposal?.status ?? null,
    articleOpen: Boolean(proposal) && contentChanged.length > 0,
    priceAgainst: current ? (proposal ? "openVersion" : "currentVersion") : null,
    existingStatus: current?.status ?? null,
    missingCapabilities,
    contentChanged,
    existingId: current?.id ?? null,
    priceChanges,
    priceUnchanged,
    defaulted,
  };
}
