import "@tanstack/react-start/server-only";

import { getCookie } from "@tanstack/react-start/server";

import { sql } from "~/db";
import {
  catalogCoverage,
  currencyForJurisdiction,
  localeDefinition,
  localeForJurisdiction,
  resolveLocale,
} from "~/i18n/locales";
import {
  DENSITY_COOKIE,
  LOCALE_COOKIE,
  type Density,
  type LocalePayload,
} from "~/i18n";
import { currentPrincipal } from "~/server/context";

/**
 * Server-side locale and display resolution.
 *
 * This runs on the request that paints the page, which is the point: the shell renders
 * in the right language and direction the first time, with no flash of English and no
 * hydration mismatch from a string that only exists on the client.
 *
 * The four hops of the owner-set order, and where each one is read from:
 *
 *   1. user preference — the `omnihost.locale` cookie set by the language switcher,
 *      falling back to `user.locale` on the account.
 *   2. site default — derived from the site's tax jurisdiction, in the absence of a
 *      `site.locale` column (interim; see the note in src/i18n/locales.ts).
 *   3. chain default — derived from the chain's tax jurisdiction, same reason.
 *   4. platform default — `OMNIHOST_DEFAULT_LOCALE`, default `en-IN`. Indian English is
 *      the first interface locale, not the only one.
 *
 * The timezone follows the same shape but only has three real hops: site timezone →
 * the zone implied by the chain's jurisdiction → the platform zone. It is resolved
 * server-side too, deliberately: a viewer-zone taken from the browser would render one
 * timestamp in the HTML and a *different* one after hydration. `Asia/Kolkata` is the
 * platform default while India is the only market.
 */

const PLATFORM_DEFAULT_LOCALE = process.env.OMNIHOST_DEFAULT_LOCALE ?? "en-IN";
const PLATFORM_DEFAULT_TIME_ZONE = process.env.OMNIHOST_DEFAULT_TIME_ZONE ?? "Asia/Kolkata";

const DENSITIES: Density[] = ["compact", "cozy", "roomy"];

function readCookieValue(name: string): string | null {
  try {
    return getCookie(name) ?? null;
  } catch {
    // Outside a request context (a build, a test) there is no cookie to read.
    return null;
  }
}

interface HintRow {
  site_jurisdiction: string | null;
  site_timezone: string | null;
  chain_jurisdiction: string | null;
}

/**
 * The site and chain hops. Two single-row reads, only for the tenant the session is
 * actually attached to — an App-layer identity has neither, and gets the platform
 * defaults, which is correct rather than a fallback.
 */
async function tenantHints(chainId: string | null, siteId: string | null): Promise<HintRow> {
  const empty: HintRow = {
    site_jurisdiction: null,
    site_timezone: null,
    chain_jurisdiction: null,
  };
  try {
    const rows = await sql()<HintRow>`
      select
        (select s.tax_jurisdiction from site s where s.id = ${siteId}::uuid) as site_jurisdiction,
        (select s.timezone from site s where s.id = ${siteId}::uuid) as site_timezone,
        (select c.tax_jurisdiction from chain c where c.id = ${chainId}::uuid) as chain_jurisdiction
    `;
    return rows[0] ?? empty;
  } catch {
    // A display preference must never be the reason a screen fails to load.
    return empty;
  }
}

export async function resolveDisplayPreferences(): Promise<LocalePayload> {
  const principal = await currentPrincipal();
  const hints = principal
    ? await tenantHints(principal.chainId, principal.siteId)
    : { site_jurisdiction: null, site_timezone: null, chain_jurisdiction: null };

  const resolution = resolveLocale(
    {
      userPreference: principal?.locale ?? null,
      siteDefault: localeForJurisdiction(hints.site_jurisdiction),
      siteTimeZone: hints.site_timezone,
      chainDefault: localeForJurisdiction(hints.chain_jurisdiction),
      chainCurrency: currencyForJurisdiction(hints.chain_jurisdiction),
      platformDefault: PLATFORM_DEFAULT_LOCALE,
      platformTimeZone: PLATFORM_DEFAULT_TIME_ZONE,
    },
    readCookieValue(LOCALE_COOKIE)
  );

  const densityCookie = readCookieValue(DENSITY_COOKIE) as Density | null;

  return {
    locale: resolution.locale,
    source: resolution.source,
    direction: resolution.direction,
    timeZone: resolution.timeZone,
    timeZoneSource: resolution.timeZoneSource,
    currency: resolution.currency,
    hints: resolution.hints,
    density: densityCookie && DENSITIES.includes(densityCookie) ? densityCookie : "cozy",
    coverage: catalogCoverage(localeDefinition(resolution.locale).catalog),
  };
}
