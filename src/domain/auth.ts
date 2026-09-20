import "@tanstack/react-start/server-only";

import { sql, withTransaction } from "~/db";
import { recordAudit } from "~/server/audit";
import { verifyPassword } from "~/server/crypto";
import { Unauthenticated, ValidationError } from "~/server/errors";
import { createSession, findUserByEmail, resolvePrincipal, revokeSessionToken, type Principal } from "~/server/session";

/**
 * Native sign-in — the only authentication this phase implements.
 *
 * Spec: authentication is configurable per chain by AppConfig, either SSO
 * (SAML/OIDC) or "OmniHost-native username/password with OTP", and "Role and
 * permission resolution work identically either way once a session exists — login
 * method never changes what a role can do". So the login path is kept deliberately
 * thin: verify the credential, open a session, and hand off to `resolvePrincipal`,
 * which is the single source of authority from then on.
 *
 * SPEC-OPEN: the spec names OTP as part of native auth but gives no delivery channel,
 * code length or lifetime. Not implemented here — it belongs with AppConfig and the
 * notification provider, and inventing a channel would be worse than leaving it.
 */

export interface SignInResult {
  token: string;
  expiresAt: string;
  principal: Principal;
}

export async function signIn(
  email: string,
  password: string,
  context: { ip?: string | null; userAgent?: string | null }
): Promise<SignInResult> {
  const address = email?.trim() ?? "";
  if (!address || !password) throw new ValidationError("Email and password are required.");

  const user = await findUserByEmail(address);
  // Deliberately the same error for "no such user" and "wrong password": the sign-in
  // response must not confirm which addresses exist.
  const invalid = new Unauthenticated("Email or password is incorrect.");

  if (!user) throw invalid;
  if (user.status !== "active") throw new Unauthenticated("This account is disabled.");
  if (user.auth_provider !== "native") {
    throw new Unauthenticated("This account signs in through your chain's identity provider.");
  }
  if (!verifyPassword(password, user)) throw invalid;

  const scope = await withTransaction((tx) =>
    tx.query<{ chain_id: string | null; site_id: string | null }>(
      `select ra.chain_id, ra.site_id
         from role_assignment ra
         join role r on r.id = ra.role_id
        where ra.user_id = $1 and ra.status = 'active'
          and ra.revoked_at is null
          and (ra.expires_at is null or ra.expires_at > now())
          and r.layer in ('central', 'site')
        order by (ra.site_id is not null) desc
        limit 1`,
      [user.id]
    )
  );

  const { token, expiresAt, sessionId } = await createSession(user.id, {
    chainId: scope[0]?.chain_id ?? null,
    siteId: scope[0]?.site_id ?? null,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  const principal = await resolvePrincipal(token);
  if (!principal) throw new Unauthenticated("Session could not be established.");

  await recordAudit({
    principal,
    action: "auth.sign_in",
    entityType: "app_session",
    entityId: sessionId,
    chainId: principal.chainId,
    siteId: principal.siteId,
    outcome: "success",
    reason: `native sign-in for ${principal.email}`,
    source: "screen",
  });

  return { token, expiresAt, principal };
}

export async function signOut(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const principal = await resolvePrincipal(token);
  if (principal) {
    await recordAudit({
      principal,
      action: "auth.sign_out",
      entityType: "app_session",
      entityId: principal.sessionId,
      chainId: principal.chainId,
      siteId: principal.siteId,
      outcome: "success",
      reason: "signed out",
      source: "screen",
    });
  }
  await revokeSessionToken(token, "signed out");
}

/**
 * The navigation a signed-in identity should be offered. Built from the same registry
 * the permission check uses, so a link can never lead to a page the server will
 * refuse — and, more importantly, hiding a link is never the control; the server
 * check is.
 */
export const NAV_ITEMS: {
  to: string;
  label: string;
  description: string;
  requires: string[];
}[] = [
  {
    to: "/approvals",
    label: "Approvals & tasks",
    description: "Maker-checker items waiting on your role.",
    requires: [],
  },
  {
    to: "/chains",
    label: "Chains",
    description: "Onboard chains, set licence tier, switch features.",
    requires: ["chain.list"],
  },
  {
    // AppConfig's working surface: the chains a delegation names are the only ones the
    // server will return, so an operator with no grant sees an empty list rather than a
    // refused screen.
    to: "/support",
    label: "Support queue",
    description: "Escalated tickets and the chain access you hold.",
    requires: ["support.ticket.read"],
  },
  {
    to: "/support/access",
    label: "Support access",
    description: "Time-boxed access into a chain's account, and who asked for it.",
    requires: ["support.access.request"],
  },
  {
    to: "/audit",
    label: "Audit trail",
    description: "Who did what, with before and after state.",
    requires: ["chain.audit.read"],
  },
];

export async function countOpenApprovals(principal: Principal): Promise<number> {
  const roles = principal.roles.map((role) => role.code);
  if (roles.length === 0) return 0;
  const rows = await sql()<{ count: string }>`
    select count(*) as count
      from approval_task
     where status = 'open'
       and (chain_id = ${principal.chainId} or ${principal.chainId}::uuid is null)
       and (assigned_user_id = ${principal.userId} or assigned_role_code = any(${roles}::text[]))
  `;
  return Number(rows[0]?.count ?? 0);
}
