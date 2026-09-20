import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";

import { enIN, type MessageKey } from "~/i18n/catalog-en";
import {
  createFormatters,
  type Formatters,
  type Money,
  NO_VALUE,
} from "~/i18n/format";
import {
  catalogCoverage,
  localeDefinition,
  resolveLocale,
  type Direction,
  type LocaleCode,
  type LocaleHints,
  type LocaleSource,
} from "~/i18n/locales";

/**
 * The i18n runtime: a catalog, a `t()`, the formatters, and the direction.
 *
 * The locale is resolved **on the server** (see `src/server/locale.ts`) and arrives
 * here as loader data, so the first painted HTML is already in the right language and
 * the right direction. Resolving it in a browser-only effect instead is what produces
 * the familiar flash of English followed by the real language — and a hydration
 * mismatch on any prepended string.
 *
 * Switching language writes a cookie and invalidates the router: the server resolves
 * again, the shell re-renders, and the HTML `lang`/`dir` attributes move with it. No
 * client state holds the language, so no screen can disagree with another about it.
 */

export const LOCALE_COOKIE = "omnihost.locale";
export const DENSITY_COOKIE = "omnihost.density";

export type Density = "compact" | "cozy" | "roomy";

/** Everything the server resolved, in a shape that survives serialisation. */
export interface LocalePayload {
  locale: LocaleCode;
  source: LocaleSource;
  direction: Direction;
  timeZone: string;
  timeZoneSource: LocaleSource;
  currency: string;
  hints: LocaleHints;
  density: Density;
  coverage: { translated: number; total: number; percent: number };
}

export interface I18nValue {
  locale: LocaleCode;
  direction: Direction;
  source: LocaleSource;
  timeZone: string;
  timeZoneSource: LocaleSource;
  currency: string;
  hints: LocaleHints;
  coverage: { translated: number; total: number; percent: number };
  format: Formatters;
  /** The resolved string for a message ID. Missing keys fall back to English. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  /** Plural-aware lookup: resolves `key.one` / `key.other` from the count. */
  tCount: (key: string, count: number, params?: Record<string, string | number>) => string;
  /** True when the active locale is a layout-test pseudo-locale. */
  isPseudo: boolean;
  /** A resolved money string; convenience for one-off display. */
  money: (money: Money) => string;
  setLocale: (code: LocaleCode) => void;
  isSwitching: boolean;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Catalog lookup with an English fallback.
 *
 * A missing key renders the English string, not the key and not an empty box: a
 * half-translated screen is a normal state of a product in translation, and the
 * coverage figure in the switcher says how far along it is. A key missing from English
 * too renders the key itself — that is a developer error and should look like one.
 */
export function translate(
  locale: LocaleCode,
  key: string,
  params?: Record<string, string | number>
): string {
  const catalog = localeDefinition(locale).catalog as Record<string, string | undefined>;
  const source = enIN as unknown as Record<string, string>;
  const value = catalog[key] ?? source[key] ?? key;
  return interpolate(value, params);
}

function pluralKey(key: string, count: number): string {
  return `${key}.${count === 1 ? "one" : "other"}`;
}

export function I18nProvider({ payload, children }: { payload: LocalePayload; children: ReactNode }) {
  const router = useRouter();

  const format = useMemo(
    () => createFormatters(payload.locale, payload.timeZone),
    [payload.locale, payload.timeZone]
  );

  const setLocale = useCallback(
    (code: LocaleCode) => {
      if (typeof document === "undefined") return;
      // The switcher is a user preference — hop 1 of the resolution order — so it is
      // kept with the user, not with the render. A year, `path=/`, Lax: it is a
      // display preference, not a credential.
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=31536000; SameSite=Lax`;
      void router.invalidate();
    },
    [router]
  );

  const value = useMemo<I18nValue>(() => {
    const definition = localeDefinition(payload.locale);
    return {
      locale: payload.locale,
      direction: payload.direction,
      source: payload.source,
      timeZone: payload.timeZone,
      timeZoneSource: payload.timeZoneSource,
      currency: payload.currency,
      hints: payload.hints,
      coverage: payload.coverage,
      format,
      t: (key, params) => translate(payload.locale, key, params),
      tCount: (key, count, params) =>
        translate(payload.locale, pluralKey(key, count), { count, ...(params ?? {}) }),
      isPseudo: definition.pseudo,
      money: (money) => (money.amount === null ? NO_VALUE : format.money(money)),
      setLocale,
      isSwitching: false,
    };
  }, [payload, format, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider (mounted in the root route).");
  }
  return value;
}

/** The common case: a component that needs strings only. */
export function useT(): I18nValue["t"] {
  return useI18n().t;
}

export function useFormatters(): Formatters {
  return useI18n().format;
}

/**
 * A fallback for the window before the root loader's payload is available — used only
 * by `notFound` / error boundaries that render outside the provider. Never used by a
 * screen.
 */
export function standaloneLocalePayload(): LocalePayload {
  const resolution = resolveLocale({
    userPreference: null,
    siteDefault: null,
    siteTimeZone: null,
    chainDefault: null,
    chainCurrency: null,
    platformDefault: "en-IN",
    platformTimeZone: "Asia/Kolkata",
  });
  return {
    locale: resolution.locale,
    source: resolution.source,
    direction: resolution.direction,
    timeZone: resolution.timeZone,
    timeZoneSource: resolution.timeZoneSource,
    currency: resolution.currency,
    hints: resolution.hints,
    density: "cozy",
    coverage: catalogCoverage(resolution.definition.catalog),
  };
}
