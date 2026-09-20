import { createServerFn } from "@tanstack/react-start";

import { listChains, getChain, onboardChain, setChainFeature, updateChainTier } from "~/domain/chains";
import type { LicenceTier } from "~/domain/chains";
import { NAV_ITEMS, countOpenApprovals } from "~/domain/auth";
import { canReadAudit, listApprovals, listAuditEntries } from "~/domain/inbox";
import { currentPrincipal } from "~/server/context";
import { Unauthenticated, toErrorResponse } from "~/server/errors";
function failure(error: unknown): { ok: false; status: number; error: string; message: string } {
  const { status, body } = toErrorResponse(error);
  return { ok: false, status, error: String(body.error ?? "error"), message: String(body.message ?? "Request failed.") };
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
 */

export interface PublicPrincipal {
  userId: string;
  email: string;
  displayName: string;
  scope: "app" | "central" | "site";
  chainId: string | null;
  siteId: string | null;
  roles: { code: string; name: string; layer: string; functionCode: string | null; chainId: string | null; siteId: string | null }[];
  grants: { reason: string; chainId: string | null; expiresAt: string | null; grantedBy: string | null; permissions: string[] }[];
  permissions: string[];
  sessionExpiresAt: string;
}

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

export interface NavItem {
  to: string;
  label: string;
  description: string;
}

/**
 * Role-aware navigation, derived from the same registry the enforcement path uses.
 * Hiding an item is a courtesy; the server refuses the request either way.
 */
export function navFor(principal: PublicPrincipal): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    item.requires.every((code) => principal.permissions.includes(code))
  ).map(({ to, label, description }) => ({ to, label, description }));
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
