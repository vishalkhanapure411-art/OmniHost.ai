import { createServerFn } from "@tanstack/react-start";

import { listChains, getChain, onboardChain, setChainFeature, updateChainTier } from "~/domain/chains";
import type { LicenceTier } from "~/domain/chains";
import {
  getChainAuthConfig,
  getChainSettings,
  updateChainAuthConfig,
  updateChainSetting,
  updateSiteLocale,
  type ChainAuthConfigView,
  type ChainSettingsView,
  type UpdateChainAuthInput,
} from "~/domain/appconfig";
import {
  assignSupportTicket,
  decideSupportAccessRequest,
  listSupportAccess,
  listSupportTickets,
  requestSupportAccess,
  resolveSupportTicket,
  useSupportAccess,
} from "~/domain/support";
import { countOpenApprovals } from "~/domain/auth";
// The nav registry and the browser-safe principal shape are imported from modules that
// import nothing (see `~/domain/nav`). They are re-exported here so a screen can keep
// asking the bridge it already knows for them. Importing them from a *server-only* module
// instead is what put `node:crypto` and `pg` in the client graph and stopped the app
// hydrating; `export type` is erased, so the types cost the browser nothing.
import { navFor } from "~/domain/nav";
import type { NavItem } from "~/domain/nav";
import type { PublicPrincipal } from "~/domain/principal";
export type { NavItem } from "~/domain/nav";
export type { PublicPrincipal } from "~/domain/principal";
import { canReadAudit, listApprovals, listAuditEntries } from "~/domain/inbox";
import { currentPrincipal } from "~/server/context";
import { resolveDisplayPreferences } from "~/server/locale";
import { Unauthenticated, isHttpError, toErrorResponse } from "~/server/errors";
function failure(error: unknown): { ok: false; status: number; error: string; message: string } {
  const { status, body } = toErrorResponse(error);
  return { ok: false, status, error: String(body.error ?? "error"), message: String(body.message ?? "Request failed.") };
}
/**
 * The permission a refusal was about, read from the domain error's own details. A screen
 * that shows "not permitted" without naming the missing capability leaves the operator
 * with nothing to ask for; the code comes from the server's decision, never from the UI.
 */
function deniedPermission(error: unknown): string | null {
  if (!isHttpError(error) || error.status !== 403) return null;
  const action = (error.details as { action?: unknown } | undefined)?.action;
  return typeof action === "string" ? action : null;
}
import type { Principal } from "~/server/session";

/**
 * The bridge between the console's screens and the domain layer.
 *
 * Screens never call a domain function directly and never pass a role, scope or
 * permission — they ask for an operation, and the operation resolves the caller from
 * the session cookie by itself. The permission decision therefore happens on the same
 * side of the wire as the data, which is the whole point.
 *
 * Mutations return an `{ ok }` envelope instead of throwing, so a refusal reaches the
 * screen as a readable message rather than a redacted server error. The refusal is
 * still a real 403-shaped denial produced by `requirePermission` and still written to
 * audit_log.
 *
 * **This file is reachable from the browser.** A screen imports the server function it
 * calls, so this module is in the client graph; TanStack Start replaces every handler body
 * with an RPC stub there, which leaves only the module-scope code. So the rule the whole
 * boundary rests on: *anything evaluated at module scope — a value a client-retained export
 * reads — may import only modules that import nothing server-only.* Everything else
 * (the domain functions, the session, the database, `node:crypto`) is imported for use
 * **inside a handler**, which the client transform drops whole. `~/domain/nav` and
 * `~/domain/principal` hold the two things that genuinely are needed on both sides.
 */

function toPublic(principal: Principal): PublicPrincipal {
  return {
    userId: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
    scope: principal.scope,
    chainId: principal.chainId,
    siteId: principal.siteId,
    roles: principal.roles.map((role) => ({
      code: role.code,
      name: role.name,
      layer: role.layer,
      functionCode: role.functionCode,
      chainId: role.chainId,
      siteId: role.siteId,
    })),
    grants: principal.grants.map((grant) => ({
      reason: grant.reason,
      chainId: grant.chainId,
      expiresAt: grant.expiresAt,
      grantedBy: grant.grantedBy,
      permissions: grant.permissions,
    })),
    permissions: principal.permissions,
    sessionExpiresAt: principal.sessionExpiresAt,
  };
}

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return { principal: null, nav: [] as NavItem[], openApprovals: 0, auditVisible: false };
  const publicPrincipal = toPublic(principal);
  return {
    principal: publicPrincipal,
    nav: navFor(publicPrincipal),
    openApprovals: await countOpenApprovals(principal),
    auditVisible: canReadAudit(principal),
  };
});

/**
 * Display preferences — interface locale, direction, display timezone and row density,
 * resolved on the server for the request that paints the page.
 *
 * Read by the root route's loader, so the first HTML the browser receives is already in
 * the right language, the right direction and the right clock. Deliberately separate
 * from `getSession`: an anonymous visitor on the sign-in screen has no session but still
 * needs a language.
 */
export const getDisplayPrefsFn = createServerFn({ method: "GET" }).handler(async () =>
  resolveDisplayPreferences()
);

export const listChainsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return failure(new Unauthenticated());
  try {
    return { ok: true as const, chains: await listChains(principal) };
  } catch (error) {
    return failure(error);
  }
});

export const getChainFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { chainId: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, chain: await getChain(principal, data.chainId) };
    } catch (error) {
      return failure(error);
    }
  });

export const onboardChainFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as { name: string; code?: string; licenceTier: LicenceTier; taxJurisdiction?: string }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, chain: await onboardChain(principal, data, { source: "screen" }) };
    } catch (error) {
      return failure(error);
    }
  });

export const updateChainTierFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { chainId: string; licenceTier: LicenceTier })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await updateChainTier(principal, data.chainId, data.licenceTier, { source: "screen" }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const setChainFeatureFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { chainId: string; featureCode: string; enabled: boolean })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await setChainFeature(principal, data.chainId, data.featureCode, data.enabled, {
          source: "screen",
        }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const listApprovalsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return failure(new Unauthenticated());
  try {
    return { ok: true as const, inbox: await listApprovals(principal) };
  } catch (error) {
    return failure(error);
  }
});

export const listAuditFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return failure(new Unauthenticated());
  try {
    return { ok: true as const, entries: await listAuditEntries(principal, { limit: 100 }) };
  } catch (error) {
    return failure(error);
  }
});

// ── AppConfig vertical ───────────────────────────────────────────────────────

export const getChainAuthConfigFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { chainId: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, config: await getChainAuthConfig(principal, data.chainId) };
    } catch (error) {
      return failure(error);
    }
  });

export const updateChainAuthConfigFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { chainId: string; config: UpdateChainAuthInput })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await updateChainAuthConfig(principal, data.chainId, data.config, {
          source: "screen",
        }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const getChainSettingsFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { chainId: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, settings: await getChainSettings(principal, data.chainId) };
    } catch (error) {
      return failure(error);
    }
  });

export const updateChainSettingFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as {
        chainId: string;
        key: string;
        value: string | number | boolean;
        siteId?: string | null;
      }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await updateChainSetting(
          principal,
          data.chainId,
          { key: data.key, value: data.value, siteId: data.siteId ?? null },
          { source: "screen" }
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });

/**
 * The AppConfig settings screen's loader, composed server-side.
 *
 * Two reads with two different capabilities: the delegated settings need
 * `chain.settings.read`, the authentication configuration needs `chain.auth.read`. An
 * operator can legitimately hold one and not the other, so a missing `chain.auth.read`
 * withdraws the auth section only, with the capability named — while a missing
 * `chain.settings.read` refuses the screen before anything renders. Both decisions are
 * made by the domain functions from the session, so the screen cannot widen its own
 * reach with a chain id it made up.
 */
export interface ChainConfigScreen {
  settings: ChainSettingsView;
  auth: ChainAuthConfigView | null;
  /** Set when the settings are readable but the authentication configuration is not. */
  authDenied: { permission: string } | null;
}

export const getChainConfigFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { chainId: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return { ...failure(new Unauthenticated()), permission: null };
    try {
      const settings = await getChainSettings(principal, data.chainId);
      let auth: ChainAuthConfigView | null = null;
      let authDenied: { permission: string } | null = null;
      try {
        auth = await getChainAuthConfig(principal, data.chainId);
      } catch (error) {
        const permission = deniedPermission(error);
        if (!permission) throw error;
        authDenied = { permission };
      }
      return { ok: true as const, settings, auth, authDenied };
    } catch (error) {
      return { ...failure(error), permission: deniedPermission(error) };
    }
  });

export const updateSiteLocaleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { chainId: string; siteId: string; locale: string | null })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await updateSiteLocale(principal, data.chainId, data.siteId, data.locale, {
          source: "screen",
        }),
      };
    } catch (error) {
      return failure(error);
    }
  });

// ── AppSupport vertical ──────────────────────────────────────────────────────

export const listSupportTicketsFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { status?: string | null } | undefined)
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        queue: await listSupportTickets(principal, { status: data?.status ?? null }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const assignSupportTicketFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { ticketId: string; assignToUserId: string | null })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await assignSupportTicket(
          principal,
          data.ticketId,
          { assignToUserId: data.assignToUserId },
          { source: "screen" }
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const resolveSupportTicketFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { ticketId: string; note: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await resolveSupportTicket(principal, data.ticketId, data.note, { source: "screen" }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const listSupportAccessFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return failure(new Unauthenticated());
  try {
    return { ok: true as const, access: await listSupportAccess(principal) };
  } catch (error) {
    return failure(error);
  }
});

export const requestSupportAccessFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as { chainId: string; reason: string; requestedHours: number; ticketId?: string | null }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, result: await requestSupportAccess(principal, data, { source: "screen" }) };
    } catch (error) {
      return failure(error);
    }
  });

export const decideSupportAccessRequestFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as { requestId: string; approve: boolean; note?: string | null; grantedHours?: number | null }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await decideSupportAccessRequest(
          principal,
          data.requestId,
          { approve: data.approve, note: data.note ?? null, grantedHours: data.grantedHours ?? null },
          { source: "screen" }
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const useSupportAccessFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { chainId: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, result: await useSupportAccess(principal, data.chainId, { source: "screen" }) };
    } catch (error) {
      return failure(error);
    }
  });

// ── Phase 1 master data ──────────────────────────────────────────────────────
// A separate import at the end of the file rather than an edit to the block above: it
// keeps this slab's diff to one appended region, which matters more on a shared tree than
// import ordering does. `import` is hoisted, so position changes nothing.
import {
  getArticle,
  getArticleFilterOptions,
  listArticles,
  setArticleAvailability,
  updateArticlePrice,
} from "~/domain/mdm";

/**
 * The article master read. It has no input validator on purpose: the screen loads one page
 * and filters it locally (the same shape the chains list uses), while the *API* carries the
 * server-side filters the chatbot and an import will need. The permission decision is the
 * same either way — it happens here, on the server, before a row is read.
 */
export const listArticlesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await currentPrincipal();
  if (!principal) return failure(new Unauthenticated());
  try {
    const result = await listArticles(principal, { limit: 200 });
    const options = await getArticleFilterOptions(principal);
    return { ok: true as const, ...result, options };
  } catch (error) {
    return failure(error);
  }
});

export const getArticleFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { code: string })
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, article: await getArticle(principal, data.code) };
    } catch (error) {
      return failure(error);
    }
  });

export const updateArticlePriceFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as {
        code: string;
        outletCode: string;
        amount: number;
        currencyCode: string;
        effectiveFrom?: string | null;
      }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return {
        ok: true as const,
        result: await updateArticlePrice(principal, data, {
          source: "screen",
          intent: "mdm.article.price.update",
        }),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const setArticleAvailabilityFn = createServerFn({ method: "POST" })
  .validator(
    (input: unknown) =>
      input as {
        code: string;
        outletCode: string;
        availability: "available" | "seasonal" | "unavailable";
        reason?: string | null;
      }
  )
  .handler(async ({ data }) => {
    const principal = await currentPrincipal();
    if (!principal) return failure(new Unauthenticated());
    try {
      return { ok: true as const, result: await setArticleAvailability(principal, data, { source: "screen" }) };
    } catch (error) {
      return failure(error);
    }
  });
