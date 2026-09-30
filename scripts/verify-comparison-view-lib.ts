/**
 * Shared helpers for the two comparison-view verification scripts.
 *
 *   bun run scripts/verify-comparison-view-demo.ts      # the owner's database, read only
 *   bun run scripts/verify-comparison-view-scratch.ts   # `omnihost_check`, with fixtures
 *
 * Both were written for the server half of the before/after comparison view (the read in
 * `~/domain/mdm-approvals`). They share three things and nothing else: how a line is printed,
 * how a principal is assembled **from the database's own role and permission rows** without
 * minting a session, and the two structural assertions that apply to every diff this read
 * returns — the tier order and the counts.
 *
 * The principal is worth one sentence. `resolvePrincipal` needs a session row, and a session
 * row is a write; the demo script must write nothing, so it builds an equivalent `Principal`
 * from `"user"`, `role_assignment`, `role`, `role_permission` and `permission` — the same
 * rows `resolvePrincipal` reads, with the same flattened capability set. It is refused by
 * `guard()` exactly as a real session would be if any of it were wrong, and both scripts check
 * `can(principal, "mdm.article.view", …)` *before* calling the read, so a wrong principal
 * fails loudly instead of writing a `denied` audit row.
 */
import { writeFileSync } from "node:fs";
import type { Principal, PrincipalRole } from "~/server/session";
import type { Queryable } from "~/db";
import type { ArticleVersionReview, DiffRow } from "~/domain/mdm-approvals";

export const TIER_ORDER: Record<DiffRow["group"], number> = {
  required: 0,
  price: 1,
  content: 2,
  classification: 3,
};
export const KIND_ORDER: Record<DiffRow["kind"], number> = {
  removed: 0,
  added: 1,
  changed: 2,
  absent: 3,
  unchanged: 4,
};

export class Transcript {
  readonly lines: string[] = [];
  readonly failures: string[] = [];
  private step = 0;

  say(text = ""): void {
    this.lines.push(text);
    console.log(text);
  }
  heading(text: string): void {
    this.step += 1;
    this.say("");
    this.say("=".repeat(78));
    this.say(`STEP ${this.step}. ${text}`);
    this.say("=".repeat(78));
  }
  check(label: string, ok: boolean, detail = ""): void {
    if (ok) this.say(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    else {
      this.say(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
      this.failures.push(label);
    }
  }
  equal<T>(label: string, actual: T, expected: T): void {
    this.check(label, actual === expected, `expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
  }
  json(label: string, value: unknown): void {
    this.say(`${label}: ${JSON.stringify(value, null, 1)}`);
  }
  /** Writes the transcript where the team keeps evidence, and returns the failure count. */
  finish(path: string, verdict: string): number {
    this.say("");
    this.say("=".repeat(78));
    this.say(`steps: ${this.step}`);
    this.say(`failures: ${this.failures.length}`);
    for (const failure of this.failures) this.say(`  FAILED  ${failure}`);
    this.say(this.failures.length === 0 ? `VERDICT: ${verdict}` : "VERDICT: SEE FAILURES ABOVE.");
    writeFileSync(path, `${this.lines.join("\n")}\n`);
    return this.failures.length;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A principal assembled from the database's own rows — no session, no write.
 *
 * `roles[].permissions` and the flattened `permissions` are the role's `allow` rows, which is
 * what `authorise()` tests; grants are empty because these identities hold none. `scope` is
 * the highest layer held, and `platformWide` follows the rule in `PrincipalRole`: an App-layer
 * role with no role-level capability is purely delegated and must not widen reach.
 *
 * **The site scope matters and is not optional.** A site-layer principal that names no site is
 * refused by `authorise()` with "your scope names no site" on every action, so a helper that
 * drops it silently builds a principal that cannot do the job it was assembled for. The site
 * comes from the assignments' own `site_id` rows, the same way `resolvePrincipal` takes it.
 */
export async function principalFor(q: Queryable, email: string, chainId: string): Promise<Principal> {
  const users = await q.query<{ id: string; email: string; display_name: string; locale: string | null; status: string }>(
    `select id, email, display_name, locale, status from "user" where lower(email) = lower($1)`,
    [email]
  );
  const user = users[0];
  if (!user) throw new Error(`no user ${email}`);
  if (user.status !== "active") throw new Error(`user ${email} is ${user.status}`);

  const rows = await q.query<{
    assignment_id: string;
    code: string;
    name: string;
    layer: "app" | "central" | "site";
    seniority: PrincipalRole["seniority"];
    function_code: string | null;
    chain_id: string | null;
    site_id: string | null;
    expires_at: Date | null;
    permissions: string[] | null;
  }>(
    `select ra.id as assignment_id, r.code, r.name, r.layer, r.seniority, r.function_code,
            ra.chain_id, ra.site_id, ra.expires_at,
            array_remove(array_agg(case when rp.effect = 'allow' then p.code end), null) as permissions
       from role_assignment ra
       join role r on r.id = ra.role_id
       left join role_permission rp on rp.role_id = r.id
       left join permission p on p.id = rp.permission_id
      where ra.user_id = $1 and ra.status = 'active' and ra.revoked_at is null
        and (ra.expires_at is null or ra.expires_at > now())
      group by ra.id, r.code, r.name, r.layer, r.seniority, r.function_code,
               ra.chain_id, ra.site_id, ra.expires_at`,
    [user.id]
  );
  if (rows.length === 0) throw new Error(`${email} holds no active role assignment`);

  const roles: PrincipalRole[] = rows.map((row) => ({
    assignmentId: row.assignment_id,
    code: row.code,
    name: row.name,
    layer: row.layer,
    seniority: row.seniority,
    functionCode: row.function_code,
    chainId: row.chain_id,
    siteId: row.site_id,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    rolePermissionCount: (row.permissions ?? []).length,
    permissions: row.permissions ?? [],
  }));
  const permissions = [...new Set(roles.flatMap((role) => role.permissions))].sort();
  const scope: Principal["scope"] = roles.some((role) => role.layer === "app")
    ? "app"
    : roles.some((role) => role.layer === "central")
      ? "central"
      : "site";
  // The site the assignments name, read exactly as `resolvePrincipal` reads it
  // (`session.session_site_id ?? roles.find((r) => r.siteId !== null)?.siteId ?? null`).
  // This used to be written `null` unconditionally, which made every site-layer principal
  // fail `authorise()` with "your scope names no site" *before* the check under test — a
  // Site Head's own route write was refused for a scope the account genuinely holds. Found
  // by S-A's step 4; see the finding in display-foundation-sA-demo-data.txt.
  const siteId = roles.find((role) => role.siteId !== null)?.siteId ?? null;

  return {
    // Not a session row, and it has to say so in the shape the column expects: `audit_log`
    // stores `session_id` as a **uuid**, so a worded placeholder is refused by Postgres the
    // moment a real mutation reaches the ledger ("invalid input syntax for type uuid:
    // \"verification-principal\"" — S-A's step 4, the first write this harness ever made).
    // The nil uuid is a valid uuid, cannot collide with a session, and reads as "none".
    sessionId: "00000000-0000-0000-0000-000000000000",
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    locale: user.locale,
    scope,
    chainId,
    siteId,
    roles,
    grants: [],
    permissions,
    platformWide: roles.some((role) => role.layer === "app" && role.rolePermissionCount > 0),
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** The accounts that hold a capability, so a script names a real one rather than assuming. */
export async function emailsHolding(q: Queryable, code: string): Promise<string[]> {
  const rows = await q.query<{ email: string }>(
    `select distinct u.email
       from "user" u
       join role_assignment ra on ra.user_id = u.id
       join role r on r.id = ra.role_id
       join role_permission rp on rp.role_id = r.id
       join permission p on p.id = rp.permission_id
      where p.code = $1 and rp.effect = 'allow' and ra.status = 'active' and ra.revoked_at is null
        and u.status = 'active'
      order by u.email`,
    [code]
  );
  return rows.map((row) => row.email);
}

/** The rows of one diff, by id, for assertions that must not depend on position. */
export function byId(diff: DiffRow[]): Map<string, DiffRow> {
  return new Map(diff.map((row) => [row.id, row]));
}

/**
 * The two structural promises every diff makes, checked on the payload itself:
 * tiers in order (required → price → content → classification) with kinds ordered inside a
 * tier (removed → added → changed → absent → unchanged), and counts that agree with the rows.
 */
export function checkStructure(t: Transcript, review: ArticleVersionReview): void {
  const order = review.diff.map((row) => TIER_ORDER[row.group]);
  const nonDecreasingTiers = order.every((value, index) => index === 0 || order[index - 1]! <= value);
  t.check(
    "the rows are ordered required → price → content → classification",
    nonDecreasingTiers,
    review.diff.map((row) => `${row.group}/${row.kind}/${row.id}`).join(" , ")
  );
  const within = review.diff.every((row, index) => {
    if (index === 0) return true;
    const previous = review.diff[index - 1]!;
    if (previous.group !== row.group) return true;
    return KIND_ORDER[previous.kind] <= KIND_ORDER[row.kind];
  });
  t.check("inside a tier, removals and additions come before changes", within);

  const counted = { changed: 0, added: 0, removed: 0, absent: 0, unchanged: 0 };
  for (const row of review.diff) counted[row.kind] += 1;
  t.check(
    "diffCounts agrees with the rows it counts",
    JSON.stringify(counted) === JSON.stringify(review.diffCounts),
    JSON.stringify(review.diffCounts)
  );
  const kinds = new Set(["changed", "added", "removed", "absent", "unchanged"]);
  t.check(
    "every kind is one of the five the spec defines",
    review.diff.every((row) => kinds.has(row.kind))
  );
  t.check(
    "no row is 'unchanged' while its two values differ, or vice versa",
    review.diff.every((row) => {
      const bothNone = row.before.kind === "none" && row.after.kind === "none";
      if (row.kind === "unchanged") {
        return bothNone || JSON.stringify(row.before) === JSON.stringify(row.after);
      }
      if (row.kind === "added") return row.before.kind === "none" && row.after.kind !== "none";
      if (row.kind === "removed") return row.after.kind === "none" && row.before.kind !== "none";
      if (row.kind === "absent") return bothNone;
      return row.before.kind !== "none" && row.after.kind !== "none";
    })
  );
  t.check(
    "a money delta is present only when both sides are the same currency",
    review.diff.every((row) => {
      if (!row.delta) return true;
      return (
        row.before.kind === "money" &&
        row.after.kind === "money" &&
        row.before.currencyCode === row.after.currencyCode &&
        row.kind === "changed"
      );
    })
  );
}
