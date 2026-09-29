/**
 * The code → word maps more than one screen needs, in one place.
 *
 * These maps existed twice and were drifting: the article record carried the worded
 * allergen, diet, nutrient, basis, source and channel labels, and the approvals queue —
 * which renders the same codes — had none of them, so it printed `non_veg` and
 * `celery, milk, tree_nuts` where the record a click away said "Non-vegetarian" and
 * "Celery, Milk, Tree nuts" (`FINDINGS-label-fallback-sweep.md` §C2, §C4). A word for a
 * code belongs beside the other words for that code, not inside the screen that happened
 * to need it first.
 *
 * **Every resolver here falls back to the code itself and never to another label**
 * (DECISIONS "Copy and label mechanism", rule 1). `codeLabel` (`~/i18n/labels`) is the
 * shape: an enum that grows shows its new value's own code — visibly our gap — instead of
 * a confident wrong word. That rule is why this module exports maps rather than a single
 * `labelFor(prefix, code)` helper: a key built from data fails *open* (rule 2).
 *
 * Client-safe by construction: a type, some object literals and `t()` calls.
 */
import type { MessageKey } from "~/i18n/catalog-en";
import { codeLabel } from "~/i18n/labels";

/** The translator a screen already holds: `t` from `useI18n()`. */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * An article's or a version's lifecycle status.
 *
 * Shared because a version's own status and its article's status are the same vocabulary
 * (`mdm.article.status.*`, with `superseded` living in the version block), and the
 * Versions card, the article header and the approval dialog must say one word for one
 * status.
 */
export const ARTICLE_STATUS_LABEL: Record<string, MessageKey> = {
  draft: "mdm.article.status.draft",
  pending_review: "mdm.article.status.pending_review",
  active: "mdm.article.status.active",
  superseded: "mdm.article.version.status.superseded",
  seasonal: "mdm.article.status.seasonal",
  discontinued: "mdm.article.status.discontinued",
};

/** The veg/non-veg mark. A legal display duty in India, and a word to a guest. */
export const DIET_LABEL: Record<string, MessageKey> = {
  veg: "mdm.article.diet.veg",
  non_veg: "mdm.article.diet.non_veg",
  egg: "mdm.article.diet.egg",
  vegan: "mdm.article.diet.vegan",
  none: "mdm.article.diet.none",
};

/** The fourteen declared allergens. The code is a data key; this is its word. */
export const ALLERGEN_LABEL: Record<string, MessageKey> = {
  celery: "mdm.allergen.label.celery",
  cereals_gluten: "mdm.allergen.label.cereals_gluten",
  crustaceans: "mdm.allergen.label.crustaceans",
  eggs: "mdm.allergen.label.eggs",
  fish: "mdm.allergen.label.fish",
  lupin: "mdm.allergen.label.lupin",
  milk: "mdm.allergen.label.milk",
  molluscs: "mdm.allergen.label.molluscs",
  mustard: "mdm.allergen.label.mustard",
  peanuts: "mdm.allergen.label.peanuts",
  sesame: "mdm.allergen.label.sesame",
  soybeans: "mdm.allergen.label.soybeans",
  sulphites: "mdm.allergen.label.sulphites",
  tree_nuts: "mdm.allergen.label.tree_nuts",
};

export const NUTRIENT_LABEL: Record<string, MessageKey> = {
  energy_kcal: "mdm.nutrient.label.energy_kcal",
  protein: "mdm.nutrient.label.protein",
  carbohydrate: "mdm.nutrient.label.carbohydrate",
  total_fat: "mdm.nutrient.label.total_fat",
  saturated_fat: "mdm.nutrient.label.saturated_fat",
  trans_fat: "mdm.nutrient.label.trans_fat",
  sugars: "mdm.nutrient.label.sugars",
  sodium: "mdm.nutrient.label.sodium",
  cholesterol: "mdm.nutrient.label.cholesterol",
  dietary_fibre: "mdm.nutrient.label.dietary_fibre",
};

/** What a nutrient figure is *per*. Two bases are two different measurements. */
export const BASIS_LABEL: Record<string, MessageKey> = {
  per_serving: "mdm.article.nutrition.basis.per_serving",
  per_100g: "mdm.article.nutrition.basis.per_100g",
  per_100ml: "mdm.article.nutrition.basis.per_100ml",
};

/** Whether an allergen was declared by a person or derived from the recipe. */
export const ALLERGEN_SOURCE_LABEL: Record<string, MessageKey> = {
  declared: "mdm.article.allergen.source.declared",
  derived: "mdm.article.allergen.source.derived",
};

/** "Contains" / "May contain" — the containment enum, which is not a boolean. */
export const CONTAINMENT_LABEL: Record<string, MessageKey> = {
  contains: "mdm.article.allergen.contains",
  mayContain: "mdm.article.allergen.mayContain",
};

/** Where a dish is sold. `kds`/`cds` are display surfaces; the rest are ordering ones. */
export const CHANNEL_LABEL: Record<string, MessageKey> = {
  pos: "mdm.article.channel.pos",
  tab: "mdm.article.channel.tab",
  kiosk: "mdm.article.channel.kiosk",
  app: "mdm.article.channel.app",
  cds: "mdm.article.channel.cds",
  aggregator: "mdm.article.channel.aggregator",
};

export function articleStatusLabel(t: Translate, status: string): string {
  return codeLabel(t, ARTICLE_STATUS_LABEL[status], status);
}

export function dietLabel(t: Translate, code: string): string {
  return codeLabel(t, DIET_LABEL[code], code);
}

export function allergenLabel(t: Translate, code: string): string {
  return codeLabel(t, ALLERGEN_LABEL[code], code);
}

export function nutrientLabel(t: Translate, code: string): string {
  return codeLabel(t, NUTRIENT_LABEL[code], code);
}

export function basisLabel(t: Translate, code: string): string {
  return codeLabel(t, BASIS_LABEL[code], code);
}

export function allergenSourceLabel(t: Translate, code: string): string {
  return codeLabel(t, ALLERGEN_SOURCE_LABEL[code], code);
}

export function containmentLabel(t: Translate, code: string): string {
  return codeLabel(t, CONTAINMENT_LABEL[code], code);
}

export function channelLabel(t: Translate, code: string): string {
  return codeLabel(t, CHANNEL_LABEL[code], code);
}
