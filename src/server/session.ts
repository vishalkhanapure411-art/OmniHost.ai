import "@tanstack/react-start/server-only";

import { sql, withTransaction } from "~/db";
import { newSessionToken, sha256 } from "~/server/crypto";
import { reconcileLapsedAccessSoon } from "~/domain/grants";

/**
 * The session model, and the one place the caller's authority is resolved.
 *
 * Everything downstream reads a `Principal` and nothing else: role codes, the layer
 * they sit in (App / Central / Site), the chain and site those roles are scoped to,
 * and the flattened list of tool codes they may invoke. Nothing in this file reads a
 * role, scope, chain or permission from the request body, query string or header —
 * `Chatbot Interaction Model` guardrail: "Role-permission checks run server-side
 * against the tool registry, never inferred from the model's own judgement". The same
 * rule applies to a screen: the client tells the server *what it wants to do*, never
 * *what it is allowed to do*.
 */

export type OrgLayer = "app" | "central" | "site";

export interface PrincipalRole {
  assignmentId: string;
  code: string;
  name: string;
  layer: OrgLayer;
  seniority: "head" | "team" | "site_head" | "operator";
  functionCode: string | null;
  chainId: string | null;
  siteId: string | null;
  expiresAt: string | null;
  /**
   * How many tool codes the ROLE itself carries (before any per-person delegation).
   * An App-layer role with zero role-level capability is a purely delegated role —
   * AppConfig and AppSupport hold nothing by role — so holding it must not, by itself,
   * widen the operator's tenant reach to every chain.
   */
  rolePermissionCount: number;
  /**
   * The codes this role carries. `authorise()` needs them per role, not just flattened
   * across the identity, to answer "is this capability held *for this chain*": a grant
   * names one chain, and a permission it carries must not travel to another chain just
   * because the same person holds it somewhere else.
   */
  permissions: string[];
}

export interface PrincipalGrant {
  grantId: string;
  chainId: string | null;
  siteId: string | null;
  reason: string;
  grantedBy: string | null;
  expiresAt: string | null;
  permissions: string[];
}

export interface Principal {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  /** Personal language preference; NULL = follow the site default. */
  locale: string | null;
  /** The highest org layer this identity holds: app > central > site. */
  scope: OrgLayer;
  /** Tenant context. NULL for an App-layer identity until a request names a chain. */
  chainId: string | null;
  siteId: string | null;
  roles: PrincipalRole[];
  grants: PrincipalGrant[];
  /** Flattened tool registry for this identity, resolved server-side. */
  permissions: string[];
  /** True when this identity reaches every chain (AppAdmin's platform-wide role). */
  platformWide: boolean;
  sessionExpiresAt: string;
}

/**
 * SPEC-OPEN: the spec requires a session policy (Non-Functional Requirements →
 * Security) but the extracted spec states no timeout, idle window or MFA rule. 12
 * hours absolute is the smallest sensible default for a shift-length F&B back office;
 * it is a policy value, not a business rule, and belongs in AppConfig once that
 * screen exists.
 */
export const SESSION_TTL_HOURS = 12;

export const SESSION_COOKIE = "omnihost_session";

export interface SessionUserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  locale: string | null;
  auth_provider: string;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
}

export async function findUserByEmail(email: string): Promise<SessionUserRow | null> {
  const rows = await sql()<SessionUserRow>`
    select id, email, display_name, status, locale, auth_provider,
           password_hash, password_salt, password_algo
      from "user"
     where lower(email) = lower(${email})
     limit 1
  `;
  return rows[0] ?? null;
}

/** Creates a session row and returns the raw token that belongs in the cookie. */
export async function createSession(
  userId: string,
  context: { chainId?: string | null; siteId?: string | null; ip?: string | null; userAgent?: string | null } = {}
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const token = newSessionToken();
  const tokenHash = sha256(token);
  const rows = await withTransaction((tx) =>
    tx.query<{ id: string; expires_at: Date }>(
      `insert into app_session (token_hash, user_id, chain_id, site_id, expires_at, ip, user_agent)
       values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, $6, $7)
       returning id, expires_at`,
      [
        tokenHash,
        userId,
        context.chainId ?? null,
        context.siteId ?? null,
        String(SESSION_TTL_HOURS),
        context.ip ?? null,
        context.userAgent ?? null,
      ]
    )
  );
  const row = rows[0];
  if (!row) throw new Error("session insert returned no row");
  return { token, sessionId: row.id, expiresAt: row.expires_at.toISOString() };
}

export async function revokeSessionToken(token: string, reason: string): Promise<void> {
  await sql()`
    update app_session
       set revoked_at = now(), revoked_reason = ${reason}
     where token_hash = ${sha256(token)}
       and revoked_at is null
  `;
}

interface SessionJoinRow {
  session_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  session_chain_id: string | null;
  session_site_id: string | null;
  user_id: string;
  email: string;
  display_name: string;
  locale: string | null;
  status: string;
}

interface AssignmentRow {
  assignment_id: string;
  role_code: string;
  role_name: string;
  layer: OrgLayer;
  seniority: PrincipalRole["seniority"];
  function_code: string | null;
  chain_id: string | null;
  site_id: string | null;
  expires_at: Date | null;
  permission_codes: string[] | null;
  denied_codes: string[] | null;
}

interface GrantRow {
  grant_id: string;
  chain_id: string | null;
  site_id: string | null;
  reason: string;
  granted_by: string | null;
  expires_at: Date | null;
  permission_codes: string[] | null;
  denied_codes: string[] | null;
}

/**
 * Turns a bearer token into a Principal, or null when the session is unknown,
 * revoked, expired, or its owner is disabled. Expiry and revocation are enforced
 * here, on every call — not once at login.
 */
export async function resolvePrincipal(token: string | undefined | null): Promise<Principal | null> {
  if (!token) return null;
  const tokenHash = sha256(token);

  const sessions = await sql()<SessionJoinRow>`
    select s.id as session_id, s.expires_at, s.revoked_at,
           s.chain_id as session_chain_id, s.site_id as session_site_id,
           u.id as user_id, u.email, u.display_name, u.locale, u.status
      from app_session s
      join "user" u on u.id = s.user_id
     where s.token_hash = ${tokenHash}
     limit 1
  `;
  const session = sessions[0];
  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at.getTime() <= Date.now()) return null;
  if (session.status !== "active") return null;

  const [assignments, grants] = await Promise.all([
    sql()<AssignmentRow>`
      select ra.id as assignment_id, r.code as role_code, r.name as role_name,
             r.layer, r.seniority, r.function_code, ra.chain_id, ra.site_id, ra.expires_at,
             array_remove(array_agg(case when rp.effect = 'allow' then p.code end), null) as permission_codes,
             array_remove(array_agg(case when rp.effect = 'deny' then p.code end), null) as denied_codes
        from role_assignment ra
        join role r on r.id = ra.role_id
        left join role_permission rp on rp.role_id = r.id
        left join permission p on p.id = rp.permission_id
       where ra.user_id = ${session.user_id}
         and ra.status = 'active'
         and ra.revoked_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       group by ra.id, r.code, r.name, r.layer, r.seniority, r.function_code,
                ra.chain_id, ra.site_id, ra.expires_at
    `,
    sql()<GrantRow>`
      select sg.id as grant_id, sg.chain_id, sg.site_id, sg.reason, sg.expires_at,
             gb.display_name as granted_by,
             array_remove(array_agg(case when sgp.effect = 'allow' then p.code end), null) as permission_codes,
             array_remove(array_agg(case when sgp.effect = 'deny' then p.code end), null) as denied_codes
        from scope_grant sg
        left join "user" gb on gb.id = sg.granted_by_user_id
        left join scope_grant_permission sgp on sgp.scope_grant_id = sg.id
        left join permission p on p.id = sgp.permission_id
       where sg.granted_to_user_id = ${session.user_id}
         and sg.status = 'active'
         and sg.revoked_at is null
         and (sg.expires_at is null or sg.expires_at > now())
       group by sg.id, sg.chain_id, sg.site_id, sg.reason, sg.expires_at, gb.display_name
    `,
  ]);

  // The session row is refreshed opportunistically; a failure here must not deny a
  // legitimate request.
  void sql()`update app_session set last_seen_at = now() where id = ${session.session_id}`.catch(
    () => undefined
  );

  // Time-boxed grants that lapsed are stored as `expired` rather than left claiming
  // `active` (src/domain/grants.ts). Opportunistic for the same reason as the touch
  // above, and harmless if it never runs: every check in this file reads `expires_at`,
  // so an unreconciled row grants nothing.
  reconcileLapsedAccessSoon();

  const roles: PrincipalRole[] = assignments.map((row) => ({
    assignmentId: row.assignment_id,
    code: row.role_code,
    name: row.role_name,
    layer: row.layer,
    seniority: row.seniority,
    functionCode: row.function_code,
    chainId: row.chain_id,
    siteId: row.site_id,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    rolePermissionCount: (row.permission_codes ?? []).length,
    permissions: row.permission_codes ?? [],
  }));

  const principalGrants: PrincipalGrant[] = grants.map((row) => ({
    grantId: row.grant_id,
    chainId: row.chain_id,
    siteId: row.site_id,
    reason: row.reason,
    grantedBy: row.granted_by,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    permissions: row.permission_codes ?? [],
  }));

  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const row of assignments) {
    for (const code of row.permission_codes ?? []) allow.add(code);
    for (const code of row.denied_codes ?? []) deny.add(code);
  }
  for (const row of grants) {
    for (const code of row.permission_codes ?? []) allow.add(code);
    for (const code of row.denied_codes ?? []) deny.add(code);
  }
  // An explicit deny always wins, so a revoked capability cannot be re-granted
  // accidentally by a broader role.
  for (const code of deny) allow.delete(code);

  const scope: OrgLayer = roles.some((r) => r.layer === "app")
    ? "app"
    : roles.some((r) => r.layer === "central")
      ? "central"
      : "site";

  // Tenant context. A single-chain identity carries it on the session; otherwise it
  // is derived from the role assignments themselves, so it can never come from the
  // client. A Site identity additionally carries its site.
  const chainId =
    session.session_chain_id ??
    roles.find((r) => r.chainId !== null)?.chainId ??
    principalGrants.find((g) => g.chainId !== null)?.chainId ??
    null;
  const siteId =
    session.session_site_id ?? roles.find((r) => r.siteId !== null)?.siteId ?? null;

  //Platform-wide reach is a property of held *capability*, not of belonging to the App
  // layer. AppAdmin holds every App-layer tool at role level, so it reaches all chains.
  // AppConfig and AppSupport hold nothing by role — their reach is exactly what their
  // grants name — so a chain-scoped grant must not leak the rest of the tenant list.
  const platformWide =
    principalGrants.some((g) => g.chainId === null && g.siteId === null) ||
    roles.some((r) => r.layer === "app" && r.chainId === null && r.rolePermissionCount > 0);

  return {
    sessionId: session.session_id,
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
    locale: session.locale,
    scope,
    chainId,
    siteId,
    roles,
    grants: principalGrants,
    permissions: [...allow].sort(),
    platformWide,
    sessionExpiresAt: session.expires_at.toISOString(),
  };
}

/**
 * The chains this identity may reach. `null` means "every chain", which only a
 * platform-wide App-layer identity gets. A delegated AppConfig/AppSupport operator
 * reaches exactly the chains named in their grants — never the chain ids the client
 * happens to send.
 */
export function accessibleChainIds(principal: Principal): string[] | null {
  if (principal.scope === "app" && principal.platformWide) return null;
  const ids = new Set<string>();
  for (const role of principal.roles) if (role.chainId) ids.add(role.chainId);
  for (const grant of principal.grants) if (grant.chainId) ids.add(grant.chainId);
  return [...ids];
}

export function canReachChain(principal: Principal, chainId: string): boolean {
  const allowed = accessibleChainIds(principal);
  return allowed === null || allowed.includes(chainId);
}
