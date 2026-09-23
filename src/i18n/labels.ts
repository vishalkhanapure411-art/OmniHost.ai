/**
 * Words for the values a sentence has to carry.
 *
 * A refusal or a report line must name the thing the reader has to act on — a compliance field,
 * the market whose law requires it, the state a record landed in — and the value the server holds
 * is a machine name (`caloriesKcal`, `IN-KA`, `pending_review`). The catalog already names those
 * things on the screens that edit them, so a sentence the domain wrote (it has no locale, and
 * must not invent one) is filled in here, through the same keys, instead of being printed at a
 * person as `caloriesKcal required in IN-KA`.
 *
 * Client-safe by construction: string work and a type, nothing else.
 */
import type { MessageKey } from "~/i18n/catalog-en";

/** The translator a screen already holds: `t` from `useI18n()`. */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The parameter values a sentence can carry, as the domain sends them. */
export type SentenceParams = Record<string, string | number> | null | undefined;

/** The catalog's word for `value` under `prefix`, or `value` itself when the catalog has none. */
function labelled(t: Translate, prefix: string, value: string): string {
  const key = `${prefix}${value}` as MessageKey;
  const translated = t(key);
  return translated === key ? value : translated;
}

/** `caloriesKcal` → "Energy per serving". A name the catalog does not carry is left alone. */
export function complianceFieldLabel(t: Translate, field: string): string {
  return labelled(t, "mdm.article.compliance.field.", field);
}

/** `pending_review` → "Pending review": how a report names the state a record landed in. */
export function importLandingLabel(t: Translate, state: string): string {
  return labelled(t, "mdm.import.landing.", state);
}

/**
 * A market in words: `IN` → "India".
 *
 * The database stores a market's code and never its name — `db/migrations/0007_mdm_reference.sql`
 * says the name comes from `Intl.DisplayNames` on the country, because a catalog cannot carry the
 * market a chain onboards next quarter. A sub-national market keeps its code beside the name:
 * `IN-KA` and `IN-MH` are different tax jurisdictions, and the country's name alone would hide
 * which one is being applied.
 */
export function marketName(locale: string, code: string): string {
  const country = code.split("-")[0];
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([locale], { type: "region" }).of(country);
  } catch {
    return code;
  }
  if (!name || name === country) return code;
  return code.includes("-") ? `${name} (${code})` : name;
}

/**
 * A sentence's parameter values, in words.
 *
 * Two of the names the domain sends already mean something the catalog says: a compliance field,
 * and a market — `declaredFor` is the profile the requirement is written on (`IN` for a rule an
 * `IN-KA` site inherits), which is the market a requirement is a fact about. Everything else is
 * passed through untouched: a column name from the operator's own file, an amount, a count.
 */
export function sentenceParams(
  t: Translate,
  locale: string,
  params: SentenceParams
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number> = { ...params };
  if (typeof params.field === "string") out.field = complianceFieldLabel(t, params.field);
  if (typeof params.state === "string") out.state = importLandingLabel(t, params.state);
  const market =
    typeof params.declaredFor === "string"
      ? params.declaredFor
      : typeof params.jurisdiction === "string"
        ? params.jurisdiction
        : null;
  if (market) out.jurisdiction = marketName(locale, market);
  return out;
}
