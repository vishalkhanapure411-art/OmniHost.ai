import { arXB, enXA, hiIN, type Catalog } from "~/i18n/catalog-other";
import { enIN } from "~/i18n/catalog-en";

/**
 * Locale metadata, the catalogs, and the resolution order.
 *
 * Resolution order is owner-set (DECISIONS.md, "International exposure &
 * localisation"): **user preference → site default → chain default → platform
 * default**. It is implemented in `resolveLocale` below as one pure function so that
 * every surface — the shell, a server-rendered page, a chatbot card — resolves the
 * same way, and so that the winner is always reportable (`LocaleResolution.source`)
 * rather than a mystery a support ticket has to unpick.
 *
 * Where each hop currently comes from, and what is still a stand-in:
 *
 * | hop | source | state |
 * |---|---|---|
 * | user preference | `user.locale` column, via the session principal; the in-app switcher overrides it for the session and persists to a cookie | real; `user.locale` is nullable, and NULL means "no preference — follow my site". Writing it back from the switcher needs a profile route (Phase 1) |
 * | site default | `site.locale` (migration 0005) | **real** — a stored column, set per site by AppConfig or a chain admin, every change audit-logged as `site.locale.update`. Its jurisdiction-derived default remains the fallback for a site that has no language yet |
 * | chain default | derived from `chain.tax_jurisdiction` | interim — there is no chain-level language column yet, and a chain operating in one country rarely needs one |
 * | platform default | `PLATFORM_DEFAULT_LOCALE` in server config | real |
 *
 * The two interim hops are deliberately sourced from *jurisdiction* rather than
 * hardcoded to India: when a chain is onboarded in the UAE or Germany the country code
 * already drives tax and menu-display rules, so it is the natural place for the
 * language default to hang until a chain can override it explicitly.
 */

export type LocaleCode = "en-IN" | "hi-IN" | "ar-XB" | "en-XA";
export type Direction = "ltr" | "rtl";

export interface LocaleDefinition {
  code: LocaleCode;
  /** Name in the language itself — how a language switcher should list it. */
  label: string;
  /** English name, for a support engineer reading a log line. */
  englishLabel: string;
  direction: Direction;
  /**
   * Kept on Latin digits on purpose. A Gulf ops team reading PO numbers, GRNs and
   * variance figures in Eastern Arabic numerals is a real configuration choice, but it
   * is the *chain's* choice, not a side effect of the locale — so the numeral system is
   * an explicit per-locale setting here rather than ICU's default. The PRD does not
   * settle this; raised in the PR.
   */
  numberingSystem: "latn" | "arab";
  /** Fallback currency for money that arrives without a code. Never assumed elsewhere. */
  defaultCurrency: string;
  defaultTimeZone: string;
  /** True for layout-test locales. Labelled as such everywhere they are offered. */
  pseudo: boolean;
  /** Present when the locale is offered as a UI language (all four are). */
  catalog: Catalog;
}

export const LOCALES: LocaleDefinition[] = [
  {
    code: "en-IN",
    label: "English (India)",
    englishLabel: "English (India)",
    direction: "ltr",
    numberingSystem: "latn",
    defaultCurrency: "INR",
    defaultTimeZone: "Asia/Kolkata",
    pseudo: false,
    catalog: enIN,
  },
  {
    code: "hi-IN",
    label: "हिन्दी (भारत)",
    englishLabel: "Hindi (India)",
    direction: "ltr",
    numberingSystem: "latn",
    defaultCurrency: "INR",
    defaultTimeZone: "Asia/Kolkata",
    pseudo: false,
    catalog: hiIN,
  },
  {
    code: "ar-XB",
    label: "‏العربية (تجريبي — RTL)",
    englishLabel: "Arabic pseudo-locale (RTL layout test)",
    direction: "rtl",
    numberingSystem: "latn",
    defaultCurrency: "AED",
    defaultTimeZone: "Asia/Dubai",
    pseudo: true,
    catalog: arXB,
  },
  {
    code: "en-XA",
    label: "English (pseudo — expansion test)",
    englishLabel: "English pseudo-locale (40% text expansion test)",
    direction: "ltr",
    numberingSystem: "latn",
    defaultCurrency: "EUR",
    defaultTimeZone: "Europe/Berlin",
    pseudo: true,
    catalog: enXA,
  },
];

const BY_CODE = new Map(LOCALES.map((locale) => [locale.code, locale]));

/** The catalog every other catalog falls back to. */
export const SOURCE_LOCALE: LocaleCode = "en-IN";

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && BY_CODE.has(value as LocaleCode);
}

/** Never throws: an unknown code resolves to the source locale's definition. */
export function localeDefinition(code: string | null | undefined): LocaleDefinition {
  return (isLocaleCode(code) ? BY_CODE.get(code) : undefined) ?? (BY_CODE.get(SOURCE_LOCALE) as LocaleDefinition);
}

/**
 * Country of a tax jurisdiction. `IN-KA` → `IN`, `AE` → `AE`. Also accepts a locale
 * tag, so a value that is already `hi-IN` behaves predictably.
 */
export function jurisdictionCountry(jurisdiction: string | null | undefined): string | null {
  const value = (jurisdiction ?? "").trim().toUpperCase();
  if (!value) return null;
  const country = value.split("-")[0];
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

/**
 * Jurisdiction → default locale. Deliberately sparse: a hop only names a locale we
 * actually ship a catalog for. Adding German means adding the catalog and one row
 * here — no screen changes anywhere.
 */
const JURISDICTION_LOCALE: Record<string, LocaleCode> = {
  IN: "en-IN",
};

/** Jurisdiction → currency. Money is amount + ISO code; this only supplies the default. */
const JURISDICTION_CURRENCY: Record<string, string> = {
  IN: "INR",
  AE: "AED",
  SA: "SAR",
  GB: "GBP",
  US: "USD",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  SG: "SGD",
  AU: "AUD",
  MY: "MYR",
  LK: "LKR",
  BD: "BDT",
  NP: "NPR",
};

/** Jurisdiction → the zone that jurisdiction's sites are normally run in. */
const JURISDICTION_TIME_ZONE: Record<string, string> = {
  IN: "Asia/Kolkata",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  GB: "Europe/London",
  US: "America/New_York",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  SG: "Asia/Singapore",
  AU: "Australia/Sydney",
};

export function currencyForJurisdiction(jurisdiction: string | null | undefined): string | null {
  const country = jurisdictionCountry(jurisdiction);
  return country ? (JURISDICTION_CURRENCY[country] ?? null) : null;
}

export function timeZoneForJurisdiction(jurisdiction: string | null | undefined): string | null {
  const country = jurisdictionCountry(jurisdiction);
  return country ? (JURISDICTION_TIME_ZONE[country] ?? null) : null;
}

export function localeForJurisdiction(jurisdiction: string | null | undefined): LocaleCode | null {
  const country = jurisdictionCountry(jurisdiction);
  return country ? (JURISDICTION_LOCALE[country] ?? null) : null;
}

/**
 * The hints the server can supply for the site and chain hops. All four are nullable:
 * an App-layer identity has no chain and no site, and a chain that has not been given a
 * jurisdiction yet has no default.
 */
export interface LocaleHints {
  userPreference: string | null;
  siteDefault: string | null;
  siteTimeZone: string | null;
  chainDefault: string | null;
  chainCurrency: string | null;
  platformDefault: string;
  platformTimeZone: string;
}

export type LocaleSource = "user" | "site" | "chain" | "platform";

export interface LocaleResolution {
  locale: LocaleCode;
  definition: LocaleDefinition;
  direction: Direction;
  /** The hop that decided the language — surfaced in the UI, not just in logs. */
  source: LocaleSource;
  timeZone: string;
  timeZoneSource: LocaleSource;
  /** Default currency for balances in this scope; a row's own currency always wins. */
  currency: string;
  hints: LocaleHints;
}

/**
 * The resolution order, as one function. `override` is the in-app language switcher:
 * a user explicitly choosing a language outranks anything stored, but it is still a
 * *user* preference, so `source` stays `user`.
 */
export function resolveLocale(hints: LocaleHints, override?: string | null): LocaleResolution {
  const candidates: { value: string | null | undefined; source: LocaleSource }[] = [
    { value: override, source: "user" },
    { value: hints.userPreference, source: "user" },
    { value: hints.siteDefault, source: "site" },
    { value: hints.chainDefault, source: "chain" },
    { value: hints.platformDefault, source: "platform" },
  ];
  const winner = candidates.find((candidate) => isLocaleCode(candidate.value));
  const locale = (winner?.value ?? SOURCE_LOCALE) as LocaleCode;

  const zoneCandidates: { value: string | null | undefined; source: LocaleSource }[] = [
    { value: hints.siteTimeZone, source: "site" },
    { value: hints.chainDefault ? timeZoneForJurisdiction(hints.chainDefault) : null, source: "chain" },
    { value: hints.platformTimeZone, source: "platform" },
  ];
  const zoneWinner = zoneCandidates.find((candidate) => Boolean(candidate.value));

  return {
    locale,
    definition: localeDefinition(locale),
    direction: localeDefinition(locale).direction,
    source: winner?.source ?? "platform",
    timeZone: zoneWinner?.value ?? localeDefinition(locale).defaultTimeZone,
    timeZoneSource: zoneWinner?.source ?? "platform",
    currency:
      hints.chainCurrency ?? localeDefinition(locale).defaultCurrency,
    hints,
  };
}

export function platformHints(platformDefault: string, platformTimeZone: string): LocaleHints {
  return {
    userPreference: null,
    siteDefault: null,
    siteTimeZone: null,
    chainDefault: null,
    chainCurrency: null,
    platformDefault: isLocaleCode(platformDefault) ? platformDefault : SOURCE_LOCALE,
    platformTimeZone,
  };
}

/** Share of the source catalog a catalog covers. Reported, never hidden. */
export function catalogCoverage(catalog: Catalog): { translated: number; total: number; percent: number } {
  const keys = Object.keys(enIN) as (keyof typeof enIN)[];
  const translated = keys.filter((key) => typeof catalog[key] === "string" && catalog[key] !== "").length;
  return { translated, total: keys.length, percent: Math.round((translated / keys.length) * 100) };
}
