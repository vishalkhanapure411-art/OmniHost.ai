import "@tanstack/react-start/server-only";

import { sql } from "~/db";
import { PermissionDenied } from "~/server/errors";
import { accessibleChainIds, canReachChain, type Principal } from "~/server/session";

/**
 * The permission check.
 *
 * `requirePermission()` is the only place authority is decided, and every server
 * entry point calls it before touching data — API route, page loader, or the chatbot
 * gateway this phase deliberately does not build yet. `Chatbot Interaction Model`
 * guardrail: "Role-permission checks run server-side against the tool registry, never
 * inferred from the model's own judgement — a jailbroken prompt cannot grant an
 * action the role doesn't hold." The screen version of that rule is: a hidden button
 * is a convenience, never a control, so the same check runs whether the request
 * arrived by tap, by typing, or by curl.
 *
 * Two things are checked, and both are required:
 *   1. the action is in the caller's resolved tool registry, and
 *   2. the caller's own scope covers the tenant the action targets.
 */

export interface PermissionMeta {
  code: string;
  module: string;
  name: string;
  actionKind: "query" | "mutation";
  layer: "app" | "tenant";
  requiresSiteScope: boolean;
  checkFunction: boolean;
  financialOrStock: boolean;
}

let catalog: Map<string, PermissionMeta> | undefined;

/** The tool registry, cached per process. Small, changes only with a migration. */
export async function permissionCatalog(): Promise<Map<string, PermissionMeta>> {
  if (catalog) return catalog;
  const rows = await sql()<{
    code: string;
    module: string;
    name: string;
    action_kind: "query" | "mutation";
    layer: "app" | "tenant";
    requires_site_scope: boolean;
    check_function: boolean;
    financial_or_stock: boolean;
  }>`select code, module, name, action_kind, layer, requires_site_scope, check_function, financial_or_stock
       from permission`;
  catalog = new Map(
    rows.map((row) => [
      row.code,
      {
        code: row.code,
        module: row.module,
        name: row.name,
        actionKind: row.action_kind,
        layer: row.layer,
        requiresSiteScope: row.requires_site_scope,
        checkFunction: row.check_function,
        financialOrStock: row.financial_or_stock,
      },
    ])
  );
  return catalog;
}

export function resetPermissionCatalogCache(): void {
  catalog = undefined;
}

export interface TargetContext {
  /** The chain the action acts on, when it acts on one. */
  chainId?: string | null;
  /** The site the action acts on. */
  siteId?: string | null;
  /** A human-readable description of the target, for the denial message. */
  describes?: string;
}

export interface AuthorisationResult {
  allowed: boolean;
  /** Machine-readable reason, also written to audit_log on a denial. */
  reason: string;
  permission: PermissionMeta;
}

/**
 * Pure decision function: given a resolved Principal and the target, may this call
 * proceed? Kept free of side effects so the same logic answers both the enforcement
 * path and the "what should the UI offer" path — the nav and the buttons are built
 * from this, so the interface can never drift from what the server will accept.
 */
export function authorise(
  principal: Principal,
  permission: PermissionMeta,
  target: TargetContext = {}
): AuthorisationResult {
  const deny = (reason: string): AuthorisationResult => ({ allowed: false, reason, permission });

  if (!principal.permissions.includes(permission.code)) {
    return deny(
      `your roles (${principal.roles.map((r) => r.code).join(", ") || "none"}) do not hold ${permission.code}`
    );
  }

  if (permission.layer === "app") {
    // Platform capability. Only an App-layer identity, or a person holding an
    // explicit per-chain App-layer grant, can exercise it — a chain's own Head must
    // never be able to onboard or reconfigure a tenant they happen to work for.
    if (principal.scope !== "app") {
      return deny(`${permission.code} is a platform capability and your scope is ${principal.scope}`);
    }
    if (target.chainId && !canReachChain(principal, target.chainId)) {
      return deny(`your delegated scope does not include this chain`);
    }
    return { allowed: true, reason: "app capability held", permission };
  }

  // Tenant capability: the caller must sit in the tenant the action targets.
  const chainId = target.chainId ?? principal.chainId;
  if (!chainId) return deny(`${permission.code} needs a chain context and your session has none`);

  if (principal.scope === "app") {
    // An App-layer operator reaching chain data is doing so under a delegation; the
    // delegation decides which chains.
    if (!canReachChain(principal, chainId)) return deny(`your delegated scope does not include this chain`);
    return { allowed: true, reason: "delegated chain access", permission };
  }

  if (chainId !== principal.chainId) {
    return deny(`your scope is chain ${principal.chainId ?? "none"}; this action targets another chain`);
  }

  if (principal.scope === "site") {
    if (!principal.siteId) return deny("your scope names no site");
    if (target.siteId && target.siteId !== principal.siteId) {
      return deny(`${permission.code} targets another site`);
    }
    if (permission.requiresSiteScope && !target.siteId) {
      // e.g. a site-level approval or a goods receipt has to name the site it
      // happened at; a site-scoped caller cannot act on the chain in the abstract.
      return deny(`${permission.code} must be performed at a named site`);
    }
  }

  if (principal.scope === "central" && permission.requiresSiteScope && target.siteId === null) {
    return deny(`${permission.code} is performed at a site, and a Central identity has no site`);
  }

  return { allowed: true, reason: `${principal.scope} scope within tenant`, permission };
}

export async function can(
  principal: Principal,
  code: string,
  target: TargetContext = {}
): Promise<boolean> {
  const permission = (await permissionCatalog()).get(code);
  if (!permission) return false;
  return authorise(principal, permission, target).allowed;
}

/**
 * Enforcing wrapper. Throws `PermissionDenied` (403) rather than returning a boolean,
 * so a caller physically cannot forget the answer and carry on.
 */
export async function requirePermission(
  principal: Principal,
  code: string,
  target: TargetContext = {}
): Promise<PermissionMeta> {
  const permission = (await permissionCatalog()).get(code);
  if (!permission) {
    // An unregistered code is a programming error, not a user error: it must never
    // silently succeed.
    throw new PermissionDenied(code, `unknown tool code ${code}`);
  }
  const result = authorise(principal, permission, target);
  if (!result.allowed) throw new PermissionDenied(code, result.reason, { target: target.describes });
  return permission;
}

/** Convenience for the UI: the subset of a registry the caller holds. */
export function heldPermissions(principal: Principal, codes: string[]): string[] {
  return codes.filter((code) => principal.permissions.includes(code));
}

export { accessibleChainIds };
