import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";

/**
 * Jurisdiction profiles — how a market's rules resolve, and whether a record satisfies them.
 *
 * ## Why this module exists (and why the resolution is an inheritance)
 *
 * `jurisdiction_field_rule` was read with `where jurisdiction_code = $1`, an **exact** match.
 * The seeded profile is `IN`: FSSAI's menu-display and labelling rules, and the CGST
 * classification rule, are *national* law. The pilot chain's sites are `IN-KA` and `IN-MH`,
 * because a state code is what a tax jurisdiction is (§7.1: the selling site's market decides
 * the tax class). So the exact match found nothing, `requiredFields('IN-KA', 'article')`
 * returned `[]`, every compliance gap came back empty, `landingStatus` could only ever answer
 * `pending_review` or `active`, the import's "required in this market" warning never fired,
 * and a row with a missing FSSAI-required field entered the approval queue as approvable.
 * A national rule set that states cannot inherit is a rule set that never applies.
 *
 * The honest fix is therefore **resolution, not seeding**: `IN-KA` resolves its own rows first
 * and then `IN`'s, with the state winning per field. Seeding `IN-KA` and `IN-MH` copies of the
 * national rules would leave a real chain's compliance resting on every state having been
 * remembered separately, and the first amendment to national law would have to be replicated
 * state by state — the drift is the defect. Moving the sites to `IN` would be worse: the
 * jurisdiction code is the tax jurisdiction, and collapsing Karnataka into India loses the
 * state-level tax distinction the model needs. `IN-KA` is the correct data; the lookup was
 * wrong. A market whose own law differs from its country's now carries a `IN-KA` row for just
 * that field, and it overrides by construction — which is exactly the override room the
 * jurisdiction-profile design needs, without a second mechanism.
 *
 * ## Two readers, one answer
 *
 * The rule resolution here has three callers that must not drift: the create/import path
 * (through `~/domain/mdm`), the masters that print a per-market requirement (vendor, site) and
 * **the approve transition** (`~/domain/mdm-approvals`). The last one is why the article
 * presence test lives here rather than in `~/domain/mdm`: `~/domain/mdm` imports the approvals
 * module at runtime, so the approvals module may not import it back. A shared leaf module with
 * no imports of its own is the only shape that lets both sides ask the same question.
 */

/**
 * The profile codes a jurisdiction's rules resolve through, most specific first.
 *
 * `IN-KA` → `['IN-KA', 'IN']`. A country code resolves to itself. A code that is not a
 * `country-region` pair resolves to itself too, so an unforeseen shape degrades to the
 * previous exact-match behaviour rather than to no rules at all.
 */
export function jurisdictionProfileChain(code: string): string[] {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return [];
  const separator = trimmed.indexOf("-");
  if (separator <= 0) return [trimmed];
  const country = trimmed.slice(0, separator);
  return country === trimmed ? [trimmed] : [trimmed, country];
}

export interface JurisdictionFieldRule {
  /** The market being evaluated — the code the caller asked about (`IN-KA`). */
  jurisdiction: string;
  /** The profile the requirement is actually written on (`IN-KA`'s own row, or `IN`'s). The
   *  difference is what lets a refusal say which law is being applied. */
  declaredFor: string;
  field: string;
  requirement: string;
  legalRef: string | null;
}

/**
 * A market's rules for an entity, as they apply in that market, effective today.
 *
 * Effective-dated: within a profile the rule in force is the newest row at or before today,
 * which is what keeps a change to a market's law from rewriting history. Across the
 * inheritance chain the most specific profile wins per field.
 */
export async function jurisdictionFieldRules(
  tx: Queryable,
  jurisdiction: string,
  entity: string
): Promise<JurisdictionFieldRule[]> {
  const chain = jurisdictionProfileChain(jurisdiction);
  if (chain.length === 0) return [];
  const rows = await tx.query<{
    jurisdiction_code: string;
    field: string;
    requirement: string;
    legal_ref: string | null;
  }>(
    `select distinct on (jurisdiction_code, field) jurisdiction_code, field, requirement, legal_ref
       from jurisdiction_field_rule
      where jurisdiction_code = any($1::text[]) and entity = $2
        and effective_from <= current_date
      order by jurisdiction_code, field, effective_from desc`,
    [chain, entity]
  );

  const rank = new Map(chain.map((code, index) => [code, index]));
  const byField = new Map<string, JurisdictionFieldRule>();
  for (const row of rows) {
    const existing = byField.get(row.field);
    const declaredFor = row.jurisdiction_code;
    const better = existing
      ? (rank.get(declaredFor) ?? Number.MAX_SAFE_INTEGER) <
        (rank.get(existing.declaredFor) ?? Number.MAX_SAFE_INTEGER)
      : true;
    if (!better) continue;
    byField.set(row.field, {
      jurisdiction,
      declaredFor,
      field: row.field,
      requirement: row.requirement,
      legalRef: row.legal_ref,
    });
  }
  return [...byField.values()].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/** The fields a market's profile requires of an entity, today, inherited rules included. */
export async function requiredFieldsFor(
  tx: Queryable,
  jurisdiction: string,
  entity: string
): Promise<string[]> {
  const rules = await jurisdictionFieldRules(tx, jurisdiction, entity);
  return rules.filter((rule) => rule.requirement === "required").map((rule) => rule.field);
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

// ---------------------------------------------------------------------------
// Does an article satisfy a market's profile?
// ---------------------------------------------------------------------------

/**
 * The article values a rule can be tested against. Keys are the rule `field` names, so a rule
 * and its presence test cannot be renamed apart in one place only.
 *
 * Two callers fill this in and they are deliberately the *same* shape: a create/import from
 * what the operator stated (`allergensDeclared`, because §7.1 makes declaring "none" a positive
 * statement), and an approval from what the version row actually holds (`allergenCount`).
 */
export interface ArticleComplianceValues {
  /** The stated name (a create), or `nameCount` below when read back from a stored version. */
  name?: string | null;
  /** Rows in `article_version_text` with a name — how a stored version carries its name. */
  nameCount?: number | string | null;
  dietaryMark?: string | null;
  /** The tax class code *or* its id: presence is the question, never which code. */
  taxClass?: string | null;
  hsnSacCode?: string | null;
  servingSize?: number | string | null;
  caloriesKcal?: number | string | null;
  /** Rows in `article_version_allergen` — what a stored version can be asked. */
  allergenCount?: number | string | null;
  /** A create that said "none" out loud. Not storable today; see the note on approval. */
  allergensDeclared?: boolean;
  nutrientCount?: number | string | null;
}

const isNumber = (value: number | string | null | undefined): boolean =>
  value !== null && value !== undefined && value !== "";

/**
 * Whether one field of a market's profile is present on the record.
 *
 * A field this function does not know is treated as present: a profile may state a requirement
 * for something the article model does not carry yet, and inventing a gap for it would refuse
 * records the platform has no way to complete. `false` for an unknown field would be the one
 * answer here that produces an unfixable refusal.
 */
export function articleFieldPresent(field: string, values: ArticleComplianceValues): boolean {
  switch (field) {
    case "name":
      return Boolean(values.name?.trim()) || Number(values.nameCount ?? 0) > 0;
    case "dietaryMark":
      return Boolean(values.dietaryMark);
    case "taxClass":
      return Boolean(values.taxClass);
    case "hsnSacCode":
      return Boolean(values.hsnSacCode);
    case "servingSize":
      return isNumber(values.servingSize);
    case "caloriesKcal":
      return isNumber(values.caloriesKcal);
    case "allergens":
      return values.allergensDeclared === true || Number(values.allergenCount ?? 0) > 0;
    case "nutrition":
      return Number(values.nutrientCount ?? 0) > 0;
    default:
      return true;
  }
}

/** A required field a market states and the record does not carry. */
export interface ArticleComplianceGap {
  field: string;
  /** The traded market whose profile is unmet — what a refusal has to name. */
  jurisdiction: string;
  /** The profile the requirement is written on (`IN` for a rule an `IN-KA` site inherits). */
  declaredFor: string;
  legalRef: string | null;
  requirement: string;
}

/**
 * The gaps between what a chain's markets require of an article and what a stored version
 * holds — read by version id, so it does not depend on `article.current_version_id` and can
 * answer for a version that is not sellable, which is every version under review.
 *
 * One asymmetry worth stating rather than hiding: a version with no `article_version_allergen`
 * rows is a gap here, because the table records the allergens a version *has* and has no way
 * to record "the author declared none". The create path can tell the difference (the operator
 * sent an empty list on purpose) and this read cannot, so a version whose author declared
 * "none" is refused at approval with `allergens` named. It fails safe, it matches the
 * `incomplete` predicate the list already applies to a stored version, and closing it properly
 * needs an `article_version.allergen_declared` marker — a schema change, reported rather than
 * half-built here.
 */
export async function articleVersionComplianceGaps(
  tx: Queryable,
  chainId: string,
  versionId: string
): Promise<ArticleComplianceGap[]> {
  const rows = await tx.query<{
    name_count: string;
    dietary_mark: string | null;
    tax_class_id: string | null;
    hsn_sac_code: string | null;
    serving_size_qty: string | null;
    calories_kcal: string | null;
    allergen_count: string;
    nutrient_count: string;
  }>(
    `select v.dietary_mark, v.tax_class_id, v.hsn_sac_code, v.serving_size_qty, v.calories_kcal,
            (select count(*) from article_version_text t
              where t.article_version_id = v.id and btrim(t.name) <> '') as name_count,
            (select count(*) from article_version_allergen aa
              where aa.article_version_id = v.id) as allergen_count,
            (select count(*) from article_version_nutrient an
              where an.article_version_id = v.id) as nutrient_count
       from article_version v
      where v.id = $1 and v.chain_id = $2`,
    [versionId, chainId]
  );
  const row = rows[0];
  if (!row) return [];

  const values: ArticleComplianceValues = {
    // The name is a row in `article_version_text`, so presence is a count, not a column.
    nameCount: row.name_count,
    dietaryMark: row.dietary_mark,
    taxClass: row.tax_class_id,
    hsnSacCode: row.hsn_sac_code,
    servingSize: row.serving_size_qty,
    caloriesKcal: row.calories_kcal,
    allergenCount: row.allergen_count,
    nutrientCount: row.nutrient_count,
  };

  const gaps = new Map<string, ArticleComplianceGap>();
  for (const jurisdiction of await tradedJurisdictions(chainId)) {
    const rules = await jurisdictionFieldRules(tx, jurisdiction, "article");
    for (const rule of rules) {
      if (rule.requirement !== "required") continue;
      if (articleFieldPresent(rule.field, values)) continue;
      // Keyed by field *and* market: two markets can require the same field, and an approver
      // being told which law they would be waiving is the whole point of the refusal.
      gaps.set(`${rule.field}|${jurisdiction}`, {
        field: rule.field,
        jurisdiction,
        declaredFor: rule.declaredFor,
        legalRef: rule.legalRef,
        requirement: rule.requirement,
      });
    }
  }
  return [...gaps.values()].sort((a, b) =>
    a.field < b.field ? -1 : a.field > b.field ? 1 : a.jurisdiction < b.jurisdiction ? -1 : 1
  );
}
