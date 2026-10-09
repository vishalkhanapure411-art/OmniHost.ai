/**
 * APPROVER SPLIT — session 1 read-back: the grant change, asserted from the database.
 *
 *   bun run scripts/verify-approver-split.ts
 *
 * **What this proves (and what it deliberately does not).** This is the *grant* half of the
 * approver-role split (owner, 7 Oct 2026): migration 0019 and the matching db/seed.sql change
 * move everyday approval off `CENTRAL_MDM_HEAD` onto a new `CENTRAL_MDM_APPROVER` role holding
 * the approve acts and no raise act. This harness reads the rows back and asserts the
 * capability facts the split is *for*:
 *
 *   - the approver holds `mdm.article.approve` (and the other three approve acts) and the
 *     `mdm.article.view` read the review screen is guarded by — and NOT `mdm.article.create`
 *     / `.update` / `.propose` / `.price.update` (an approver may not initiate);
 *   - the head no longer holds `mdm.article.approve` nor `mdm.article.create`, but still holds
 *     `mdm.article.view`, `mdm.article.search`, `mdm.approve.threshold` and
 *     `mdm.policy.configure` — reads plus above-threshold and policy (TRAP 1);
 *   - the approver role's `seniority` is `approver`, not `head`/`team` (TRAP 3);
 *   - `CENTRAL_MDM_TEAM` holds the raise acts that were the head's alone, and
 *     `SITE_CULINARY_TEAM` holds `mdm.article.create`/`.update`/`.price.update`.
 *
 * It does **not** call the acts — that is session 2 (the proof that routes a task to the
 * approver and exercises both refusals). A grant that is never called is invisible, so nothing
 * here is claimed as the end-to-end proof.
 *
 * **It runs against the `omnihost_check` scratch database and refuses to run anywhere else.**
 * `DATABASE_URL` is read, its database name is swapped for `omnihost_check`, and a URL that
 * does not point at the owner's demo database (`OmniHost`) is rejected outright.
 *
 * **Prerequisite:** the scratch database must be at the migration head (0019) and carry the
 * reference seed and the demo users — `bun run db:migrate`, `bun run db:seed:reference` and
 * `bun run db:seed:users` with `DATABASE_URL` pointed at `omnihost_check`. The harness reads
 * what it asserts and writes nothing but the two session rows `resolvePrincipal` needs.
 *
 * The transcript is written to `/home/team/shared/evidence/approver-split-grants.txt` and to
 * `docs/evidence/approver-split-grants.txt`.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OWNER_DATABASE = "OmniHost";
const CHECK_DATABASE = "omnihost_check";

const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("DATABASE_URL is not set — nothing to verify against.");
  process.exit(2);
}
const swapped = raw.replace(new RegExp(`/${OWNER_DATABASE}(\\?|$)`), `/${CHECK_DATABASE}$1`);
if (!swapped.includes(`/${CHECK_DATABASE}?`) && !swapped.endsWith(`/${CHECK_DATABASE}`)) {
  console.error(
    `refusing to run: DATABASE_URL does not point at ${OWNER_DATABASE}, so the scratch database cannot be derived from it. Nothing was written.`
  );
  process.exit(2);
}
process.env.DATABASE_URL = swapped;

const { poolQueryable } = await import("~/db");
const { can } = await import("~/server/permissions");
const { createSession, findUserByEmail, resolvePrincipal } = await import("~/server/session");
import type { Principal } from "~/server/session";

const SESSION_MARK = "verify-approver-split";
const APPROVER_EMAIL = "mdm.approver@saffron.example";
const HEAD_EMAIL = "mdm.head@saffron.example";
const CHAIN_CODE = "saffron-table";
const TRANSCRIPT_PATHS = [
  "/home/team/shared/evidence/approver-split-grants.txt",
  "/home/team/shared/site/docs/evidence/approver-split-grants.txt",
];

// --- transcript helpers ---------------------------------------------------
const lines: string[] = [];
const failures: string[] = [];
let step = 0;
function say(text = ""): void {
  lines.push(text);
  console.log(text);
}
function heading(text: string): void {
  say("");
  say("=".repeat(78));
  say(`STEP ${++step}. ${text}`);
  say("=".repeat(78));
}
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) say(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    say(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}
function equal<T>(label: string, actual: T, expected: T): void {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
}

const q = poolQueryable();

async function chainIdFor(code: string): Promise<string> {
  const rows = await q.query<{ id: string }>(`select id from chain where code = $1`, [code]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`chain ${code} not found in scratch database`);
  return id;
}

async function principalFor(email: string, chainId: string): Promise<Principal> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`scratch database has no user ${email} — run db:seed:users first`);
  const { token } = await createSession(user.id, { chainId, userAgent: SESSION_MARK });
  const principal = await resolvePrincipal(token);
  if (!principal) throw new Error(`could not resolve a principal for ${email}`);
  return principal;
}

interface GrantRow {
  role_code: string;
  permission_code: string;
}
async function grantRows(): Promise<GrantRow[]> {
  return q.query<GrantRow>(
    `select r.code as role_code, p.code as permission_code
       from role_permission rp
       join role r on r.id = rp.role_id
       join permission p on p.id = rp.permission_id
      where r.code in ('CENTRAL_MDM_APPROVER','CENTRAL_MDM_HEAD','CENTRAL_MDM_TEAM','SITE_CULINARY_TEAM')
      order by r.code, p.code`
  );
}

say(`approver split — session 1 grant read-back (scratch database ${CHECK_DATABASE})`);
say(`run at ${new Date().toISOString()}`);
say(`asserts the grant facts; does NOT call the acts (that is session 2)`);

heading("the approver role exists with seniority 'approver'");
const approverRoleRows = await q.query<{ code: string; seniority: string }>(
  `select code, seniority from role where code = 'CENTRAL_MDM_APPROVER'`
);
check("CENTRAL_MDM_APPROVER exists", approverRoleRows.length === 1);
equal("its seniority", approverRoleRows[0]?.seniority, "approver");

heading("resolve the two principals (approver and head)");
const chainId = await chainIdFor(CHAIN_CODE);
const approver = await principalFor(APPROVER_EMAIL, chainId);
const head = await principalFor(HEAD_EMAIL, chainId);
check("approver holds exactly the approver role", approver.roles.map((r) => r.code).join(",") === "CENTRAL_MDM_APPROVER", approver.roles.map((r) => r.code).join(","));
check("head holds the MDM head role", head.roles.some((r) => r.code === "CENTRAL_MDM_HEAD"));

heading("the capability facts, asserted through can()");
equal("can(approver, 'mdm.article.approve')", await can(approver, "mdm.article.approve"), true);
equal("can(approver, 'mdm.article.create')", await can(approver, "mdm.article.create"), false);
equal("can(approver, 'mdm.article.update')", await can(approver, "mdm.article.update"), false);
equal("can(approver, 'mdm.article.propose')", await can(approver, "mdm.article.propose"), false);
equal("can(approver, 'mdm.article.price.update')", await can(approver, "mdm.article.price.update"), false);
equal("can(approver, 'mdm.article.view')", await can(approver, "mdm.article.view"), true);
equal("can(head, 'mdm.article.approve')", await can(head, "mdm.article.approve"), false);
equal("can(head, 'mdm.article.create')", await can(head, "mdm.article.create"), false);
equal("can(head, 'mdm.article.view')", await can(head, "mdm.article.view"), true);
equal("can(head, 'mdm.article.search')", await can(head, "mdm.article.search"), true);
equal("can(head, 'mdm.approve.threshold')", await can(head, "mdm.approve.threshold"), true);
equal("can(head, 'mdm.policy.configure')", await can(head, "mdm.policy.configure"), true);

heading("the four approve acts and the four entity reads, from the grant rows");
const grants = await grantRows();
const held = new Set(grants.map((g) => `${g.role_code}|${g.permission_code}`));
const roleHolds = (role: string, perm: string): boolean => held.has(`${role}|${perm}`);
for (const perm of [
  "mdm.article.approve",
  "mdm.raw_material.approve",
  "mdm.vendor.approve",
  "mdm.tax_class.approve",
  "mdm.article.view",
  "mdm.raw_material.view",
  "mdm.vendor.view",
  "mdm.tax_class.view",
]) {
  check(`approver holds ${perm}`, roleHolds("CENTRAL_MDM_APPROVER", perm));
}
check("approver does NOT hold mdm.vendor.bank.view", !roleHolds("CENTRAL_MDM_APPROVER", "mdm.vendor.bank.view"));

heading("the raise acts the head alone held, now on the team (and the two deactivates)");
for (const perm of [
  "mdm.article.reactivate",
  "mdm.raw_material.reactivate",
  "mdm.vendor.reactivate",
  "mdm.raw_material.cost.update",
  "mdm.vendor.bank.update",
  "mdm.vendor.terms.update",
  "mdm.uom.conversion.update",
  "mdm.tax_class.rate.update",
  "mdm.tax_class.deactivate",
  "mdm.site.deactivate",
]) {
  check(`team holds ${perm}`, roleHolds("CENTRAL_MDM_TEAM", perm));
}

heading("the outlet's own team can raise");
for (const perm of ["mdm.article.create", "mdm.article.update", "mdm.article.price.update"]) {
  check(`site_culinary holds ${perm}`, roleHolds("SITE_CULINARY_TEAM", perm));
}

heading("the head's read set is intact");
for (const perm of ["mdm.article.view", "mdm.article.search", "mdm.raw_material.view", "mdm.vendor.view", "mdm.vendor.bank.view", "mdm.uom.view"]) {
  check(`head holds ${perm}`, roleHolds("CENTRAL_MDM_HEAD", perm));
}
check("head does NOT hold mdm.article.approve", !roleHolds("CENTRAL_MDM_HEAD", "mdm.article.approve"));
check("head does NOT hold mdm.article.create", !roleHolds("CENTRAL_MDM_HEAD", "mdm.article.create"));

heading("the grant rows, read back");
for (const g of grants) {
  say(`  ${g.role_code}  <-  ${g.permission_code}`);
}

say("");
say("-".repeat(78));
say(`steps: ${step} / failures: ${failures.length}`);
say(failures.length === 0 ? "VERDICT: PASS" : `VERDICT: FAIL — ${failures.join(", ")}`);

for (const p of TRANSCRIPT_PATHS) {
  mkdirSync(p.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}
console.log(`transcript written to ${TRANSCRIPT_PATHS.join(" and ")}`);

if (failures.length > 0) process.exit(1);
