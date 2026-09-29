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

/**
 * A code's word from an enum's label map, or **the code itself** when the map has none.
 *
 * This is the shape the rule asks for, and the shape the screens did not have: `t(MAP[code]
 * ?? "some.other.label")` makes an unmapped value read as a *wrong* label — "Active" for a
 * status nobody mapped — which is worse than a raw code because it looks right. An enum that
 * grows shows the new value's own code instead: visibly our gap, never a lie to the reader.
 */
export function codeLabel(t: Translate, labelKey: MessageKey | undefined, code: string): string {
  return labelKey ? t(labelKey) : code;
}

/**
 * A value's name when the *name itself* is a catalog key stored in the database.
 *
 * `setting_definition.label_key` is data (`mdm.site.setting.serviceRadiusKm`), and so is a
 * provenance `note_key`: a row can name a key that this catalog does not carry — a
 * definition a later migration added, a key someone edited by hand, a locale that has not
 * caught up — and `t(labelKey as MessageKey)` then prints the key itself on the screen. A
 * catalog key that came from a row is never rendered as a key: the failure is worded here
 * instead, and the cell that calls this keeps the setting's own machine key beside the word,
 * so the reader can still see *which* row has no name.
 */
export function settingLabel(t: Translate, labelKey: string): string {
  const key = labelKey as MessageKey;
  const words = t(key);
  return words === key ? t("labels.unrecognised") : words;
}

/**
 * An audit row's `reason`, in words when the catalog has words for it.
 *
 * `audit_log.reason` holds one of three kinds of text: a sentence the domain wrote
 * (`registration verified`, `native sign-in for …`), a *policy* code for a refusal
 * (`mdm.approve.self`, which the screens render as `permission.mdm.approve.self`), or the
 * guard's own sentence, which names the capabilities it refused on. Only the middle one is a
 * machine name in a column people read, so only the middle one is looked up — and a code the
 * catalog does not carry stays visible as itself rather than becoming a confident wrong
 * sentence.
 */
export function auditReasonLabel(t: Translate, reason: string): string {
  const prefixed = `permission.${reason}` as MessageKey;
  const policy = t(prefixed);
  if (policy !== prefixed) return policy;
  const direct = t(reason as MessageKey);
  return direct === reason ? reason : direct;
}

/** The catalog's word for `value` under `prefix`, or `value` itself when the catalog has none. */
function labelled(t: Translate, prefix: string, value: string): string {
  const key = `${prefix}${value}` as MessageKey;
  const translated = t(key);
  return translated === key ? value : translated;
}

/**
 * A licence tier in words: `gold` → "Gold" — and never a *different* real tier.
 *
 * The mechanism this replaces was `asTier` in the domain, which coerced **any** unrecognised
 * value to `silver`: a chain with a tier nobody recorded read as the cheapest tier, and the
 * feature gate compared ranks through the same coercion, so an unrecognised `min_tier`
 * lowered to silver and a Gold- or Platinum-gated capability could be switched ON
 * (`FINDINGS-label-fallback-sweep.md` §G1.0). The domain no longer coerces (it returns the
 * stored value and fails the gate closed — `parseTier`/`tierSatisfies`); the word comes from
 * here, and a tier this catalog does not carry reads as unrecognised **with the stored code
 * beside it**, so the tier a reader acts on is never a guess.
 */
export function tierLabel(t: Translate, tier: string): string {
  const key = `chains.tier.${tier}` as MessageKey;
  const words = t(key);
  return words === key ? t("labels.unrecognised.named", { code: tier }) : words;
}

/**
 * A message whose **key came from data** — an error code off a domain `ValidationError`, a
 * report-line code — resolved in words, or worded as unrecognised.
 *
 * `t(code as MessageKey)` fails *open*: the translator returns the key when neither catalog
 * carries it, so an operator read `validation.something` inside an English sentence, or a
 * raw `mdm.import.error.…` where a reason belongs (DECISIONS rule 3). The code stays visible
 * so the gap can be chased, but it is named as a gap rather than dressed as a sentence.
 */
export function codedMessage(
  t: Translate,
  code: string,
  params?: Record<string, string | number>
): string {
  const key = code as MessageKey;
  const words = t(key, params);
  return words === key ? t("labels.unrecognised.named", { code }) : words;
}

/** `caloriesKcal` → "Energy per serving". A name the catalog does not carry is left alone. */
export function complianceFieldLabel(t: Translate, field: string): string {
  return labelled(t, "mdm.article.compliance.field.", field);
}

/**
 * A *site's* compliance field name: `jurisdiction` → "Tax jurisdiction".
 *
 * A site's rules are about different fields from an article's (`address`, `currency`,
 * `jurisdiction` — see `MDM_IN_FIELD_RULES`), and they are named on the site screens. The
 * sentences that list them used to print the machine name instead, which is the same defect
 * the article labels fixed, one entity over.
 */
export function siteFieldLabel(t: Translate, field: string): string {
  return labelled(t, "mdm.site.field.", field);
}

/** A *vendor's* compliance field name: `taxRegistrations` → "Tax registrations". */
export function vendorFieldLabel(t: Translate, field: string): string {
  return labelled(t, "mdm.vendor.field.", field);
}

/**
 * What a market's rule says about a field: `required` → "Required".
 *
 * Four values exist (`required`, `recommended`, `optional`, `forbidden`), all four are
 * catalogued for the article screens, and a rule row may hold any of them whichever entity it
 * is written on — so this shares that one set of words rather than inventing a second.
 */
export function complianceRequirementLabel(t: Translate, requirement: string): string {
  return labelled(t, "mdm.article.compliance.requirement.", requirement);
}

/** `pending_review` → "Pending review": how a report names the state a record landed in. */
export function importLandingLabel(t: Translate, state: string): string {
  const landing = labelled(t, "mdm.import.landing.", state);
  // A record's lifecycle state is the article status enum, which the article screens already
  // name in one place. Falling back to those words means a status added to that enum reads as
  // a word wherever it lands rather than as the raw value the database holds.
  return landing === state ? labelled(t, "mdm.article.status.", state) : landing;
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
  if (typeof params.requirement === "string") {
    out.requirement = complianceRequirementLabel(t, params.requirement);
  }
  const market =
    typeof params.declaredFor === "string"
      ? params.declaredFor
      : typeof params.jurisdiction === "string"
        ? params.jurisdiction
        : null;
  if (market) out.jurisdiction = marketName(locale, market);
  return out;
}
