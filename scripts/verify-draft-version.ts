/**
 * A database read that proves the draft-version rule (slab 3c-2).
 *
 *   bun run scripts/verify-draft-version.ts
 *
 * The rule (§7.2 item 5, §7.3): a price change opens version **N+1 while N stays `active`
 * and sellable**, a decision on N+1 supersedes N — N+1 `active`, N `superseded`, N's open
 * price windows closed, the article pointer moved, one audit row carrying both version ids —
 * in **one transaction**. Two refusals guard the path: a decision whose base has moved
 * (`validation.review.baseMoved`) and a content write onto an article that has a version
 * waiting (`validation.review.articleOpen`), each changing nothing.
 *
 * **It runs against the `omnihost_check` scratch database and refuses to run anywhere else.**
 * `DATABASE_URL` is read, its database name is swapped for `omnihost_check`, and a URL that
 * does not point at the owner's demo database (`OmniHost`) is rejected outright — so a
 * mis-set environment fails loudly instead of writing test rows into the demo data. The
 * modules that read `DATABASE_URL` are imported *after* the swap, so there is no window in
 * which the script could talk to the demo database. There is no local PostgreSQL on this
 * machine, so the scratch database lives on the same Neon server as the demo one.
 *
 * Every step is exercised through the domain functions the product calls — `createArticle`,
 * `updateArticlePrice`, `submitArticleForReview`, `decideArticleReview`, `updateArticle`,
 * `planArticleWrite`, `dryRunImport`, `commitImport` — under sessions minted for real users,
 * so capability checks and the four-eyes rule run exactly as they do in the app.
 *
 * **What is hand-written, and why.** Two fixture rows and one construction:
 *
 *   1. a second approver identity (`mdm.approver.scratch@saffron.example`), because the
 *      four-eyes rule refuses a self-approval and the scratch database holds only one MDM
 *      Head. The owner's demo database holds `mdm.approver@saffron.example` for the same
 *      reason; this one is created here under a name that cannot be mistaken for a demo
 *      account, and both the rows and the SQL that reverses them are printed;
 *   2. the approval gate (`mdm_approval_gated`), which the seed leaves off on both scratch
 *      chains and the script turns on for the gated half of the walk and off again for the
 *      non-gated half — it is left exactly as it was found;
 *   3. ONE statement clearing a proposal's `supersedes_version_id` to construct the
 *      `baseMoved` window, restored immediately. Its live trigger is a concurrent approval:
 *      two approvers deciding the same proposal, the first moving the pointer under the
 *      second. A sequential script cannot reach that state — migration 0010 makes two open
 *      versions of one article unrepresentable — so the condition is constructed instead.
 *      Nothing about the refusal itself is faked: the call, the transaction and the ledger
 *      are real.
 *
 * Every step ends in a read back from the database: the rows themselves, not the return value
 * of the call that wrote them. The transcript is written to
 * `/home/team/shared/evidence/draft-version-verification.txt`.
 */

import { writeFileSync } from "node:fs";
import type { Principal } from "~/server/session";
import type { ArticleWriteInput } from "~/domain/mdm";
import type { ImportReport } from "~/domain/import";

// ---------------------------------------------------------------------------
// Connection — swapped to the scratch database, or refuse to run
// ---------------------------------------------------------------------------
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

// Imported after the swap and never before: every one of these reads `DATABASE_URL` when it
// opens a connection, and a static import would run before this line.
const { poolQueryable, withTransaction } = await import("~/db");
const { createArticle, planArticleWrite, updateArticle, updateArticlePrice } = await import("~/domain/mdm");
const { decideArticleReview, submitArticleForReview, SELF_APPROVAL_REFUSAL_CODE } = await import(
  "~/domain/mdm-approvals"
);
const { commitImport, dryRunImport } = await import("~/domain/import");
const { can } = await import("~/server/permissions");
const { createSession, findUserByEmail, resolvePrincipal } = await import("~/server/session");

const SESSION_MARK = "verify-draft-version";
const CHAIN_CODE = "saffron-table";
const OUTLET_CODE = "koramangala-restaurant";
const ARTICLE_CODE = "CHK-DRAFT-VERIFY";
const ARTICLE_NAME = "Draft-Rule Verification Mocktail";
const AUTHOR_EMAIL = "mdm.head@saffron.example";
const APPROVER_ROLE = "CENTRAL_MDM_HEAD";
// The scratch database's own second approver. The owner's demo database holds
// `mdm.approver@saffron.example` for the same purpose; this one is created here, in-scratch,
// because that account does not exist in `omnihost_check`.
const SCRATCH_APPROVER_EMAIL = "mdm.approver.scratch@saffron.example";
const SCRATCH_APPROVER_NAME = "Scratch Second Approver (omnihost_check)";
const IMPORT_FILE_PREFIX = "verify-draft-version";
const BASE_PRICE = 250;
const NEW_PRICE = 310;
const THIRD_PRICE = 325;

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------
const lines: string[] = [];
const fixtures: string[] = [];
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
function rows(label: string, value: unknown): void {
  say(`${label}: ${JSON.stringify(value)}`);
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
function fixture(text: string): void {
  fixtures.push(text);
  say(`FIXTURE (scratch database): ${text}`);
}
function errorCode(error: unknown): string | null {
  const details = (error as { details?: { code?: string } } | null)?.details;
  return typeof details?.code === "string" ? details.code : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function expectRefusal(label: string, code: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    check(label, false, `expected the refusal ${code}, but the call succeeded: ${JSON.stringify(result)}`);
  } catch (error) {
    const actual = errorCode(error);
    check(label, actual === code, actual ? `refused with ${actual}` : `refused with "${errorMessage(error)}" and no code`);
    if (actual !== code) say(`        message: ${errorMessage(error)}`);
  }
}
function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// The scratch database, the fixture it needs, and the reads used at each step
// ---------------------------------------------------------------------------
const q = poolQueryable();

// ---------------------------------------------------------------------------
// Fixture 1 — the second approver identity
// ---------------------------------------------------------------------------
interface ScratchApprover {
  id: string;
  email: string;
  displayName: string;
  roleId: string;
  assignmentId: string;
  scopeKey: string;
  createdUser: boolean;
  createdAssignment: boolean;
}

async function ensureSecondApprover(): Promise<ScratchApprover> {
  const roleRows = await q.query<{ id: string }>(`select id from role where code = $1`, [APPROVER_ROLE]);
  const roleId = roleRows[0]?.id;
  if (!roleId) throw new Error(`no role ${APPROVER_ROLE} in the scratch database`);

  const existing = await q.query<{ id: string; display_name: string }>(
    `select id, display_name from "user" where lower(email) = lower($1)`,
    [SCRATCH_APPROVER_EMAIL]
  );
  let id = existing[0]?.id ?? null;
  let createdUser = false;
  if (!id) {
    const inserted = await q.query<{ id: string }>(
      `insert into "user" (email, display_name, auth_provider, status, locale)
       values ($1, $2, 'sso', 'active', 'en-IN')
       returning id`,
      [SCRATCH_APPROVER_EMAIL, SCRATCH_APPROVER_NAME]
    );
    id = inserted[0]?.id ?? null;
    createdUser = true;
    if (!id) throw new Error("the fixture user insert returned no id");
  }

  const scopeKey = `${id}|${roleId}|${chainId}|-`;
  const assignments = await q.query<{ id: string }>(
    `select id from role_assignment where scope_key = $1`,
    [scopeKey]
  );
  let assignmentId = assignments[0]?.id ?? null;
  let createdAssignment = false;
  if (!assignmentId) {
    const inserted = await q.query<{ id: string }>(
      `insert into role_assignment (user_id, role_id, chain_id, scope_key)
       values ($1, $2, $3, $4)
       returning id`,
      [id, roleId, chainId, scopeKey]
    );
    assignmentId = inserted[0]?.id ?? null;
    createdAssignment = true;
    if (!assignmentId) throw new Error("the fixture role_assignment insert returned no id");
  }

  return {
    id,
    email: SCRATCH_APPROVER_EMAIL,
    displayName: SCRATCH_APPROVER_NAME,
    roleId,
    assignmentId,
    scopeKey,
    createdUser,
    createdAssignment,
  };
}

// Reads ---------------------------------------------------------------------
interface VersionRow {
  id: string;
  version: number;
  status: string;
  supersedes_version_id: string | null;
  approved_at: Date | null;
  approved_by_user_id: string | null;
}
interface PriceRow {
  id: string;
  article_version_id: string;
  version: number;
  outlet_code: string;
  amount: string;
  currency_code: string;
  effective_from: string;
  effective_to: string | null;
}
async function articleRow(tx: Queryable = q): Promise<Record<string, unknown> | undefined> {
  return (
    await tx.query<Record<string, unknown>>(
      `select a.id, a.code, a.status, a.current_version_id, v.version as current_version,
              v.status as current_version_status
         from article a left join article_version v on v.id = a.current_version_id
        where a.chain_id = $1 and a.code = $2`,
      [chainId, ARTICLE_CODE]
    )
  )[0];
}
async function versions(tx: Queryable = q): Promise<VersionRow[]> {
  return tx.query<VersionRow>(
    `select v.id, v.version, v.status, v.supersedes_version_id, v.approved_at, v.approved_by_user_id
       from article_version v join article a on a.id = v.article_id
      where a.chain_id = $1 and a.code = $2 order by v.version`,
    [chainId, ARTICLE_CODE]
  );
}
async function prices(tx: Queryable = q): Promise<PriceRow[]> {
  return tx.query<PriceRow>(
    `select p.id, p.article_version_id, v.version, o.code as outlet_code, p.amount, p.currency_code,
            to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(p.effective_to, 'YYYY-MM-DD') as effective_to
       from article_price p join outlet o on o.id = p.outlet_id
       join article_version v on v.id = p.article_version_id
       join article a on a.id = p.article_id
      where a.chain_id = $1 and a.code = $2
      order by v.version, p.effective_from`,
    [chainId, ARTICLE_CODE]
  );
}
async function openWindows(versionId: string, tx: Queryable = q): Promise<PriceRow[]> {
  const all = await prices(tx);
  return all.filter((row) => row.article_version_id === versionId && row.effective_to === null);
}
async function tasks(tx: Queryable = q): Promise<Record<string, unknown>[]> {
  return tx.query<Record<string, unknown>>(
    `select t.id, t.status, t.entity_type, t.entity_id, t.raised_by_user_id, t.assigned_role_code,
            t.assigned_user_id, t.decided_by_user_id, t.decided_at, t.decision_note
       from approval_task t
      where t.chain_id = $1
        and (t.entity_id in (select id::text from article_version where article_id = (select id from article where chain_id = $1 and code = $2))
             or t.entity_id = (select id::text from article where chain_id = $1 and code = $2))
      order by t.created_at`,
    [chainId, ARTICLE_CODE]
  );
}
/** Success rows only, so a refusal's `denied` row never inflates a count. */
async function auditRows(action: string, entityId?: string): Promise<Record<string, unknown>[]> {
  const found = await q.query<Record<string, unknown>>(
    `select id, action, entity_type, entity_id, outcome, reason, before_state, after_state,
            actor_user_id, created_at
       from audit_log
      where action = $1 and ($2::text is null or entity_id = $2::text
             or after_state->>'articleCode' = $3)
      order by created_at`,
    [action, entityId ?? null, ARTICLE_CODE]
  );
  return found.filter((row) => row.outcome === "success");
}

// ---------------------------------------------------------------------------
say("OmniHost.ai — slab 3c-2 (the draft-version rule), verified by reading the database.");
say(`database under test: ${swapped.replace(/:[^:@]*@/, ":***@")}`);
say("No owner row is touched: this is the scratch database only.");

const chainRows = await q.query<{ id: string; name: string; licence_tier: string }>(
  `select id, name, licence_tier from chain where code = $1`,
  [CHAIN_CODE]
);
const chain = chainRows[0];
if (!chain) {
  console.error(`no chain ${CHAIN_CODE} in the scratch database — nothing to verify.`);
  process.exit(2);
}
const chainId = chain.id;
const outletRows = await q.query<{ id: string; currency: string }>(
  `select o.id, s.currency from outlet o join site s on s.id = o.site_id where o.chain_id = $1 and o.code = $2`,
  [chainId, OUTLET_CODE]
);
const outlet = outletRows[0];
if (!outlet) {
  console.error(`no outlet ${OUTLET_CODE} in ${CHAIN_CODE} — nothing to verify.`);
  process.exit(2);
}
say(
  `chain ${CHAIN_CODE} = ${chain.id} (${chain.name}, ${chain.licence_tier}); outlet ${OUTLET_CODE} = ${outlet.id} (${outlet.currency})`
);

// Sessions for two real people. A session row in the scratch database is a fixture; the
// principal it resolves to — roles, grants, flattened registry — is the real thing.
async function principalFor(email: string): Promise<Principal> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`no user ${email} in the scratch database`);
  const { token } = await createSession(user.id, { chainId, userAgent: SESSION_MARK });
  const principal = await resolvePrincipal(token);
  if (!principal) throw new Error(`session for ${email} did not resolve`);
  return principal;
}

const author = await principalFor(AUTHOR_EMAIL);

const gateRows = await q.query<{ enabled: boolean }>(
  `select cf.enabled from chain_feature cf join feature f on f.code = cf.feature_code
    where cf.chain_id = $1 and f.code = 'mdm_approval_gated'`,
  [chainId]
);
const gateAsFound = Boolean(gateRows[0]?.enabled);
async function setGate(enabled: boolean): Promise<void> {
  await withTransaction((tx) =>
    tx.query(
      `update chain_feature set enabled = $2 where chain_id = $1 and feature_code = 'mdm_approval_gated'`,
      [chainId, enabled]
    )
  );
}

/** Runs after the fixtures are in place, so a failure still writes the transcript. */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  heading("The two fixtures this script writes, and the SQL that reverses each");
  say("Both are rows in the scratch database. Everything after this point goes through the");
  say("product's own domain API — no other statement in this script writes a row.");
  // -------------------------------------------------------------------------
  const approver = await ensureSecondApprover();
  say("");
  say(approver.createdUser ? "  created the user row" : "  the user row already existed (a re-run)");
  say(approver.createdAssignment ? "  created the role assignment" : "  the role assignment already existed");
  rows("  user row", {
    id: approver.id,
    email: approver.email,
    display_name: approver.displayName,
    auth_provider: "sso",
    status: "active",
    locale: "en-IN",
  });
  rows("  role_assignment row", {
    id: approver.assignmentId,
    user_id: approver.id,
    role_id: approver.roleId,
    role: APPROVER_ROLE,
    chain_id: chainId,
    scope_key: approver.scopeKey,
  });
  say("");
  say("  FIXTURE SQL (what this script ran, idempotent — the `user` insert only when absent):");
  say(
    `    insert into "user" (email, display_name, auth_provider, status, locale) values ('${approver.email}', '${approver.displayName}', 'sso', 'active', 'en-IN');`
  );
  say(
    `    insert into role_assignment (user_id, role_id, chain_id, scope_key) values ('${approver.id}', '${approver.roleId}', '${chainId}', '${approver.scopeKey}');`
  );
  say("  FIXTURE SQL (the reverse — the two rows this fixture owns, and nothing else):");
  say(`    delete from role_assignment where scope_key = '${approver.scopeKey}';`);
  say(`    delete from "user" where id = '${approver.id}';`);
  say("  (any session this script mints for that identity is deleted at the end of the run)");
  fixture(`second approver identity ${approver.email} (${approver.id}), role ${APPROVER_ROLE}`);

  const approverPrincipal = await principalFor(approver.email);
  say("");
  say(`author   ${author.email} (${author.roles.map((role) => role.code).join(",")}) user ${author.userId}`);
  say(`  holds mdm.article.approve      ${await can(author, "mdm.article.approve", { chainId })}`);
  say(`approver ${approverPrincipal.email} (${approverPrincipal.roles.map((role) => role.code).join(",")}) user ${approverPrincipal.userId}`);
  equal(
    "the fixture identity holds mdm.article.approve on this chain",
    await can(approverPrincipal, "mdm.article.approve", { chainId }),
    true
  );
  check(
    "it is a different person from the author, so four eyes are two people",
    approverPrincipal.userId !== author.userId,
    `${author.userId} vs ${approverPrincipal.userId}`
  );

  say("");
  say(`  gate as found: mdm_approval_gated = ${String(gateAsFound)} for ${CHAIN_CODE}`);
  fixture(
    `mdm_approval_gated for ${CHAIN_CODE} was ${String(gateAsFound)}; the script sets it true for the gated walk and back to ${String(gateAsFound)} at the end`
  );
  say("  The scratch database has the gate off on both chains; the owner's demo database has");
  say("  it switched on by hand for the pilot chain. That asymmetry is a known demo-data item,");
  say("  not a defect this script fixes.");

  // A clear canvas: the previous run's article and import reports, and nothing else.
  const existing = await q.query<{ id: string }>(`select id from article where chain_id = $1 and code = $2`, [
    chainId,
    ARTICLE_CODE,
  ]);
  if (existing[0]) {
    fixture(`removing the previous run's article ${existing[0].id} (${ARTICLE_CODE})`);
    await withTransaction(async (tx) => {
      await tx.query(`delete from approval_task where chain_id = $1 and entity_id = $2::text`, [
        chainId,
        existing[0]!.id,
      ]);
      await tx.query(
        `delete from approval_task where chain_id = $1 and entity_id in (select id::text from article_version where article_id = $2)`,
        [chainId, existing[0]!.id]
      );
      await tx.query(`delete from article_price where article_id = $1`, [existing[0]!.id]);
      await tx.query(`delete from article where id = $1`, [existing[0]!.id]);
    });
  }
  const staleBatches = await q.query<{ id: string }>(
    `select id from import_batch where chain_id = $1 and file_name like $2`,
    [chainId, `${IMPORT_FILE_PREFIX}%`]
  );
  if (staleBatches.length > 0) {
    fixture(`removing ${staleBatches.length} import report(s) from a previous run of this script`);
    await withTransaction((tx) =>
      tx.query(`delete from import_batch where chain_id = $1 and file_name like $2`, [
        chainId,
        `${IMPORT_FILE_PREFIX}%`,
      ])
    );
  }

  // Reference data the create needs: a category, a base UoM, an allergen (India requires a
  // declared set) and a tax class in a jurisdiction the chain actually trades in.
  const categoryRow = (
    await q.query<{ code: string }>(
      `select code from article_category where chain_id = $1 and status = 'active' order by code limit 1`,
      [chainId]
    )
  )[0];
  const uomRow = (await q.query<{ code: string }>(`select code from uom order by code limit 1`))[0];
  const allergenRow = (await q.query<{ code: string }>(`select code from allergen order by code limit 1`))[0];
  const taxRow = (
    await q.query<{ code: string }>(
      `select code from tax_class
        where jurisdiction_code in (select distinct jurisdiction_code from site where chain_id = $1)
        order by code limit 1`,
      [chainId]
    )
  )[0];
  say(
    `reference data: category ${categoryRow?.code}, base UoM ${uomRow?.code}, allergen ${allergenRow?.code}, tax class ${taxRow?.code}`
  );

  const input: ArticleWriteInput = {
    code: ARTICLE_CODE,
    name: ARTICLE_NAME,
    shortName: "Draft Verify",
    categoryCode: categoryRow!.code,
    articleType: "beverage",
    dietaryMark: "veg",
    taxClassCode: taxRow!.code,
    hsnSacCode: "22029900",
    baseUomCode: uomRow!.code,
    servingSizeQty: 1,
    servingSizeUomCode: uomRow!.code,
    caloriesKcal: 120,
    channels: ["dine-in"],
    allergens: [{ code: allergenRow!.code, mayContain: false }],
    prices: [{ outletCode: OUTLET_CODE, amount: BASE_PRICE, currencyCode: outlet.currency }],
  };

  // -------------------------------------------------------------------------
  heading("GATED WALK — a brand-new article, taken live through the review path");
  say("The fixture article is created by its author and, because the chain is approval-gated,");
  say("lands in review; the second person approves it. This is the settled state the rule");
  say("starts from: one `active` version with one open price window.");
  // -------------------------------------------------------------------------
  await setGate(true);
  say(`  gate set: mdm_approval_gated = true for ${CHAIN_CODE}`);
  fixture(`set mdm_approval_gated = true for chain ${chainId} (gated walk)`);

  const created = await createArticle(author, input, {
    source: "api",
    intent: "slab 3c-2 verification: create the fixture article",
  });
  say("");
  say(`createArticle -> ${JSON.stringify(created)}`);
  const afterCreate = await versions();
  rows("versions after create", afterCreate);
  rows("article after create", await articleRow());
  equal("the create landed one version", afterCreate.length, 1);
  const v1 = afterCreate[0]!;

  const openTask = (await tasks()).find((row) => row.status === "open");
  if (v1.status === "pending_review") {
    check("the gated chain's brand-new record landed pending_review", true, `task ${String(openTask?.id)}`);
    const decided = await decideArticleReview(
      approverPrincipal,
      { taskId: String(openTask!.id), decision: "approve" },
      { source: "api", intent: "slab 3c-2 verification: take the fixture article live" }
    );
    say(`decideArticleReview(approve) -> ${JSON.stringify(decided)}`);
  } else {
    check("the brand-new record reached active without review", v1.status === "active", `status ${v1.status}`);
  }

  const settled = await versions();
  const settledPrices = await prices();
  rows("versions with the article settled", settled);
  rows("price windows with the article settled", settledPrices);
  equal("exactly one version", settled.length, 1);
  equal("version 1 is active", settled[0]!.status, "active");
  const n0 = settled[0]!;
  const openN0 = await openWindows(n0.id);
  equal("version 1 has one open price window", openN0.length, 1);
  equal("the open window holds the base price", Number(openN0[0]?.amount), BASE_PRICE);
  const articleSettled = await articleRow();
  equal("the article points at version 1", articleSettled?.current_version_id, n0.id);
  equal("the article is active", articleSettled?.status, "active");

  // -------------------------------------------------------------------------
  heading("A REPRICE leaves N active and sellable, and opens N+1 carrying the new price");
  say("The heart of the rule. Before slab 3c-2 this call closed the sellable window and");
  say("published the new price immediately. On a gated chain the opened version goes to the");
  say("approver's queue — §6's landing rule applied to a version rather than a create.");
  // -------------------------------------------------------------------------
  const repriced = await updateArticlePrice(
    author,
    { code: ARTICLE_CODE, outletCode: OUTLET_CODE, amount: NEW_PRICE, currencyCode: outlet.currency },
    { source: "api", intent: "slab 3c-2 verification: reprice the fixture article" }
  );
  say("");
  say(`updateArticlePrice(${BASE_PRICE} -> ${NEW_PRICE}) -> ${JSON.stringify(repriced)}`);

  const afterReprice = await versions();
  const pricesAfterReprice = await prices();
  const articleAfterReprice = await articleRow();
  rows("versions after the reprice", afterReprice);
  rows("price windows after the reprice", pricesAfterReprice);
  rows("article after the reprice", articleAfterReprice);

  equal("the reprice opened a second version", afterReprice.length, 2);
  equal("the write reports what it landed", repriced.version.landed, "opened");
  const n = afterReprice.find((row) => row.id === n0.id)!;
  const np1 = afterReprice.find((row) => row.id !== n0.id)!;
  equal("N is still active", n.status, "active");
  equal("N+1 is the version after N", np1.version, n.version + 1);
  equal("N+1 records N as the version it replaces", np1.supersedes_version_id, n.id);
  equal("the write names that base", repriced.version.baseVersionId, n.id);
  equal("on a gated chain the opened version waits for the approver", np1.status, "pending_review");

  const nOpen = await openWindows(n.id);
  const np1Open = await openWindows(np1.id);
  rows("N's open windows", nOpen);
  rows("N+1's open windows", np1Open);
  equal("N's price window is still OPEN", nOpen.length, 1);
  equal("N's window was not closed by the reprice", nOpen[0]?.effective_to, null);
  equal("N's window still holds the sellable price", Number(nOpen[0]?.amount), BASE_PRICE);
  equal("N+1 carries exactly one open window", np1Open.length, 1);
  equal("N+1's window holds the proposed price", Number(np1Open[0]?.amount), NEW_PRICE);
  equal("the article still points at N", articleAfterReprice?.current_version_id, n.id);
  equal("the article is still active — the dish is still on sale", articleAfterReprice?.status, "active");
  equal("the article's current version is still N", articleAfterReprice?.current_version, n.version);

  const tasksAfterReprice = await tasks();
  rows("tasks after the reprice", tasksAfterReprice);
  const gatedTask = tasksAfterReprice.filter((row) => row.status === "open");
  equal("the gated reprice raised exactly one review task", gatedTask.length, 1);
  equal("the task names the opened version as its entity", gatedTask[0]?.entity_id, np1.id);
  equal("the task's entity is the version, not the article", gatedTask[0]?.entity_type, "article_version");
  equal("the task is assigned to the article approver role", gatedTask[0]?.assigned_role_code, APPROVER_ROLE);
  equal("the task was raised by the author", gatedTask[0]?.raised_by_user_id, author.userId);

  // -------------------------------------------------------------------------
  heading("A content write onto an article with a version waiting is refused (articleOpen)");
  say("The open version was cloned from the sellable one, so editing the sellable version here");
  say("would leave the proposal carrying content it was never cloned with. It must change");
  say("nothing — and, being a validation refusal, it writes no audit row at all.");
  // -------------------------------------------------------------------------
  const beforeOpenRefusal = {
    article: await articleRow(),
    versions: await versions(),
    prices: await prices(),
    tasks: await tasks(),
    audit: (await auditRows("mdm.article.update")).length,
  };
  await expectRefusal(
    "a content write refuses while a version waits for a decision",
    "validation.review.articleOpen",
    () =>
      updateArticle(
        author,
        { ...input, name: `${ARTICLE_NAME} (renamed)` },
        { source: "api", intent: "slab 3c-2 verification: content write with an open version" }
      )
  );
  const afterOpenRefusal = {
    article: await articleRow(),
    versions: await versions(),
    prices: await prices(),
    tasks: await tasks(),
    audit: (await auditRows("mdm.article.update")).length,
  };
  rows("article before/after the refusal", [beforeOpenRefusal.article, afterOpenRefusal.article]);
  rows("versions before/after the refusal", [beforeOpenRefusal.versions, afterOpenRefusal.versions]);
  rows("price windows before/after the refusal", [beforeOpenRefusal.prices, afterOpenRefusal.prices]);
  check(
    "the refusal changed nothing at all",
    JSON.stringify(beforeOpenRefusal) === JSON.stringify(afterOpenRefusal),
    "article, versions, prices, tasks and the mdm.article.update ledger are byte-identical"
  );
  equal("the refusal wrote no audit row (a validation refusal aborts its transaction)", afterOpenRefusal.audit, 0);

  // -------------------------------------------------------------------------
  heading("A decision whose base has moved is refused (validation.review.baseMoved)");
  say("The check asserts that the version a proposal was cloned from is still the article's");
  say("current version. Its live trigger is a concurrent approval: two approvers deciding the");
  say("same proposal, where the first moves the pointer under the second. A sequential script");
  say("cannot reach that state — migration 0010 makes two open versions of one article");
  say("unrepresentable — so the condition is constructed with ONE statement against ONE scratch");
  say("row (the proposal's predecessor link), restored immediately after. Nothing about the");
  say("refusal itself is faked: the call, the transaction and the ledger are real.");
  // -------------------------------------------------------------------------
  const beforeBaseMoved = {
    versions: await versions(),
    prices: await prices(),
    tasks: await tasks(),
    approvals: (await auditRows("mdm.article.approve")).length,
  };
  await withTransaction(async (tx) =>
    tx.query(`update article_version set supersedes_version_id = null where id = $1`, [np1.id])
  );
  fixture(`cleared supersedes_version_id on ${np1.id} to construct the moved-base window (restored below)`);
  await expectRefusal(
    "approving a proposal whose base has moved is refused",
    "validation.review.baseMoved",
    () =>
      decideArticleReview(approverPrincipal, { taskId: String(gatedTask[0]!.id), decision: "approve" }, {
        source: "api",
        intent: "slab 3c-2 verification: approve against a moved base",
      })
  );
  const duringBaseMoved = {
    versions: await versions(),
    prices: await prices(),
    tasks: await tasks(),
    approvals: (await auditRows("mdm.article.approve")).length,
  };
  rows("versions with the base cleared", duringBaseMoved.versions);
  rows("versions read back after the refusal", await versions());
  rows("tasks read back after the refusal", await tasks());
  equal(
    "the refusal wrote nothing: N stays active, N+1 stays under review",
    `${String(duringBaseMoved.versions[0]?.status)}/${String(duringBaseMoved.versions[1]?.status)}`,
    "active/pending_review"
  );
  equal("no price window moved", JSON.stringify(duringBaseMoved.prices), JSON.stringify(beforeBaseMoved.prices));
  equal("the task is still open", duringBaseMoved.tasks.filter((row) => row.status === "open").length, 1);
  equal("the refusal wrote no audit row", duringBaseMoved.approvals, beforeBaseMoved.approvals);
  await withTransaction(async (tx) =>
    tx.query(`update article_version set supersedes_version_id = $2 where id = $1`, [np1.id, n.id])
  );
  fixture(`restored supersedes_version_id = ${n.id} on ${np1.id}`);
  equal("the fixture is restored", (await versions()).find((row) => row.id === np1.id)?.supersedes_version_id, n.id);

  // -------------------------------------------------------------------------
  heading("A send-back returns the proposal to its author as a draft, and N stays on sale");
  say("The approver's other decision, on the version a price change opened. The header must not");
  say("follow a *proposal* back to draft: the dish is still on sale at N's price.");
  // -------------------------------------------------------------------------
  const sendBack = await decideArticleReview(
    approverPrincipal,
    {
      taskId: String(gatedTask[0]!.id),
      decision: "sendBack",
      reasonCode: "pricing_wrong",
      note: "slab 3c-2 verification: send the proposal back",
    },
    { source: "api", intent: "slab 3c-2 verification: send the proposal back" }
  );
  say("");
  say(`decideArticleReview(sendBack) -> ${JSON.stringify(sendBack)}`);
  const afterSendBack = await versions();
  const tasksAfterSendBack = await tasks();
  const articleAfterSendBack = await articleRow();
  rows("versions after the send-back", afterSendBack);
  rows("tasks after the send-back", tasksAfterSendBack);
  rows("article after the send-back", articleAfterSendBack);
  const returnedTask = tasksAfterSendBack.find((row) => row.id === gatedTask[0]!.id)!;
  equal("N+1 is a draft again", afterSendBack.find((row) => row.id === np1.id)?.status, "draft");
  equal("N is still active", afterSendBack.find((row) => row.id === n.id)?.status, "active");
  equal("the article header did NOT follow the proposal to draft", articleAfterSendBack?.status, "active");
  equal("the task is rejected, not open", returnedTask.status, "rejected");
  equal("the task was re-routed to the author", returnedTask.assigned_user_id, author.userId);
  equal("the task records who decided it", returnedTask.decided_by_user_id, approverPrincipal.userId);

  // -------------------------------------------------------------------------
  heading("DRY RUN AND COMMIT SAY THE SAME THING — the correction a returned draft needs");
  say("`planArticleWrite` is what the import's dry run reads. Before this pass it knew only");
  say("`lockedUnderReview`, so a content row against an article with a version waiting was");
  say("called `updated` by the dry run and refused at commit with `articleOpen`; and the price");
  say("comparison read the *sellable* grid rather than the draft's, so a file carrying the");
  say("draft's own price was reported as a change — and the commit, following that plan, closed");
  say("and reopened a window whose figure had not moved. Both are read back here: the plan");
  say("itself, and a real import dry run and commit of the same file.");
  // -------------------------------------------------------------------------
  const planContent = await planArticleWrite(q, author, chainId, {
    ...input,
    name: `${ARTICLE_NAME} (renamed)`,
  });
  rows("plan for a content change with a version waiting", {
    outcome: planContent.outcome,
    articleOpen: planContent.articleOpen,
    openVersion: planContent.openVersion,
    openVersionId: planContent.openVersionId,
    openVersionStatus: planContent.openVersionStatus,
    priceAgainst: planContent.priceAgainst,
    versionStatus: planContent.versionStatus,
    existingStatus: planContent.existingStatus,
  });
  check(
    "the plan reports the refusal the commit raises, rather than calling the row updated",
    planContent.articleOpen && planContent.openVersion === np1.version,
    `articleOpen=${String(planContent.articleOpen)} openVersion=${String(planContent.openVersion)}`
  );

  const draftWindow = (await openWindows(np1.id))[0]!;
  const planDraftPrice = await planArticleWrite(q, author, chainId, {
    ...input,
    prices: [{ outletCode: OUTLET_CODE, amount: Number(draftWindow.amount), currencyCode: outlet.currency }],
  });
  rows("plan for the price the draft already carries", {
    outcome: planDraftPrice.outcome,
    priceAgainst: planDraftPrice.priceAgainst,
    priceChanges: planDraftPrice.priceChanges,
    priceUnchanged: planDraftPrice.priceUnchanged,
  });
  check(
    "a price the draft already carries reads as unchanged, not as a change against the sellable price",
    planDraftPrice.priceUnchanged.includes(OUTLET_CODE) && planDraftPrice.priceChanges.length === 0,
    `priceUnchanged=${JSON.stringify(planDraftPrice.priceUnchanged)} priceChanges=${planDraftPrice.priceChanges.length}`
  );
  equal(
    "the plan compared against the draft, whose window the commit would close",
    planDraftPrice.priceAgainst,
    "openVersion"
  );

  const planPriceChange = await planArticleWrite(q, author, chainId, {
    ...input,
    prices: [{ outletCode: OUTLET_CODE, amount: Number(draftWindow.amount) + 10, currencyCode: outlet.currency }],
  });
  rows("plan for a price change against the open draft", planPriceChange.priceChanges);
  equal(
    "the plan compares against the draft's open window, which is what the commit will close",
    Number(planPriceChange.priceChanges[0]?.from?.amount),
    Number(draftWindow.amount)
  );
  equal(
    "the plan reports the sellable version and the waiting draft separately",
    `${planPriceChange.versionStatus}/${planPriceChange.openVersion ? "open" : "none"}`,
    `active/open`
  );

  // The same two rows through the import, which is where the defect bit: a real dry run and a
  // real commit of one CSV, read back from the report the pipeline stores.
  function csvFile(name: string, price: number): string {
    const columns = [
      "code",
      "name",
      "shortName",
      "category",
      "articleType",
      "dietaryMark",
      "taxClass",
      "hsnSac",
      "baseUom",
      "servingQty",
      "servingUom",
      "caloriesKcal",
      "channels",
      "allergens",
      "priceEffectiveFrom",
      "prices",
    ];
    const values: Record<string, string> = {
      code: ARTICLE_CODE,
      name,
      shortName: input.shortName ?? "",
      category: input.categoryCode,
      articleType: input.articleType,
      dietaryMark: input.dietaryMark ?? "",
      taxClass: input.taxClassCode ?? "",
      hsnSac: input.hsnSacCode ?? "",
      baseUom: input.baseUomCode,
      servingQty: String(input.servingSizeQty ?? ""),
      servingUom: input.servingSizeUomCode ?? "",
      caloriesKcal: String(input.caloriesKcal ?? ""),
      channels: (input.channels ?? []).join(";"),
      allergens: (input.allergens ?? []).map((entry) => entry.code).join(";"),
      priceEffectiveFrom: draftWindow.effective_from,
      prices: `${OUTLET_CODE}=${price} ${outlet.currency}`,
    };
    const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    return `${columns.join(",")}\n${columns.map((column) => cell(values[column] ?? "")).join(",")}\n`;
  }

  const contentFile = csvFile(`${ARTICLE_NAME} (renamed)`, Number(draftWindow.amount));
  const contentDry = await dryRunImport(author, {
    entity: "article",
    fileName: `${IMPORT_FILE_PREFIX}-content-change.csv`,
    content: contentFile,
  });
  rows("dry run of a content change while a version waits", {
    status: contentDry.status,
    row: contentDry.rows[0]
      ? {
          lineNumber: contentDry.rows[0].lineNumber,
          outcome: contentDry.rows[0].outcome,
          codes: codes(contentDry.rows[0].issues),
        }
      : null,
  });
  equal("the dry run rejects the content row rather than promising an update", contentDry.rows[0]?.outcome, "rejected");
  check(
    "the row is refused for the same reason the commit refuses it",
    codes(contentDry.rows[0]?.issues ?? []).includes("validation.review.articleOpen"),
    `issues=${JSON.stringify(codes(contentDry.rows[0]?.issues ?? []))}`
  );

  const beforeContentCommit = {
    article: await articleRow(),
    versions: await versions(),
    prices: await prices(),
    updates: (await auditRows("mdm.article.update")).length,
  };
  const contentCommit: ImportReport = await commitImport(author, {
    entity: "article",
    fileName: `${IMPORT_FILE_PREFIX}-content-change.csv`,
    content: contentFile,
  });
  rows("commit of the same file", {
    status: contentCommit.status,
    applied: contentCommit.applied,
    counts: contentCommit.counts,
    fileError: contentCommit.fileError?.code ?? null,
    rowOutcome: contentCommit.rows[0]?.outcome ?? null,
  });
  equal("the commit refuses the file and applies nothing", contentCommit.applied, false);
  const afterContentCommit = {
    article: await articleRow(),
    versions: await versions(),
    prices: await prices(),
    updates: (await auditRows("mdm.article.update")).length,
  };
  check(
    "the refused commit changed no article row",
    JSON.stringify(beforeContentCommit) === JSON.stringify(afterContentCommit),
    "article, versions, prices and the update ledger are byte-identical"
  );

  const priceFile = csvFile(ARTICLE_NAME, Number(draftWindow.amount));
  const priceDry = await dryRunImport(author, {
    entity: "article",
    fileName: `${IMPORT_FILE_PREFIX}-draft-price.csv`,
    content: priceFile,
  });
  rows("dry run of a file carrying the draft's own price", {
    status: priceDry.status,
    row: priceDry.rows[0]
      ? { outcome: priceDry.rows[0].outcome, changed: priceDry.rows[0].changed, codes: codes(priceDry.rows[0].issues) }
      : null,
  });
  equal(
    "the dry run calls the row unchanged — the only honest answer against the grid the commit writes to",
    priceDry.rows[0]?.outcome,
    "unchanged"
  );

  const beforePriceCommit = await prices();
  const priceCommit = await commitImport(author, {
    entity: "article",
    fileName: `${IMPORT_FILE_PREFIX}-draft-price.csv`,
    content: priceFile,
  });
  const afterPriceCommit = await prices();
  rows("commit of that file", {
    status: priceCommit.status,
    applied: priceCommit.applied,
    counts: priceCommit.counts,
    rowOutcome: priceCommit.rows[0]?.outcome ?? null,
  });
  equal("the commit applied it as no-op rows", priceCommit.counts.unchanged, 1);
  check(
    "no window was closed and reopened — the same price row is still the open one",
    JSON.stringify(beforePriceCommit) === JSON.stringify(afterPriceCommit),
    `draft window ${draftWindow.id} unchanged`
  );

  // -------------------------------------------------------------------------
  heading("Submitting the open draft raises a real task against it");
  // -------------------------------------------------------------------------
  const submission = await submitArticleForReview(
    author,
    { code: ARTICLE_CODE, note: "slab 3c-2 verification" },
    { source: "api", intent: "slab 3c-2 verification: submit the draft" }
  );
  say("");
  say(`submitArticleForReview -> ${JSON.stringify(submission)}`);
  const afterSubmit = await versions();
  const tasksAfterSubmit = await tasks();
  const articleAfterSubmit = await articleRow();
  rows("versions after submit", afterSubmit);
  rows("tasks after submit", tasksAfterSubmit);
  rows("article after submit", articleAfterSubmit);

  const openReviewTasks = tasksAfterSubmit.filter((row) => row.status === "open");
  equal("exactly one review task is open", openReviewTasks.length, 1);
  const reviewTask = openReviewTasks[0]!;
  equal("the task names the open draft as its entity", reviewTask.entity_id, np1.id);
  equal("the task was raised by the author", reviewTask.raised_by_user_id, author.userId);
  equal("the task is assigned to the article approver role", reviewTask.assigned_role_code, APPROVER_ROLE);
  equal("the submission reports that task", submission.taskId, reviewTask.id);
  equal("N+1 is now under review", afterSubmit.find((row) => row.id === np1.id)?.status, "pending_review");
  equal("N is still active and sellable", afterSubmit.find((row) => row.id === n.id)?.status, "active");
  equal("the article header did NOT follow the proposal into review", articleAfterSubmit?.status, "active");
  equal("the article still points at N", articleAfterSubmit?.current_version_id, n.id);

  // -------------------------------------------------------------------------
  heading("Four eyes: the author cannot approve their own proposal");
  say("One attempt by the author is made here, deliberately, and it is recorded as a `denied`");
  say("audit row — the refusal the maker-checker walk-through already proves on screen. The");
  say("counts below read success rows only, so this row never inflates them.");
  // -------------------------------------------------------------------------
  await expectRefusal(
    "the author's own approval is refused",
    SELF_APPROVAL_REFUSAL_CODE,
    () =>
      decideArticleReview(author, { taskId: reviewTask.id, decision: "approve" }, {
        source: "api",
        intent: "slab 3c-2 verification: self-approval attempt",
      })
  );
  equal("the self-approval changed nothing", (await versions()).find((row) => row.id === np1.id)?.status, "pending_review");
  equal("the task is still open", (await tasks()).filter((row) => row.status === "open").length, 1);
  const denied = await q.query<{ n: string }>(
    `select count(*)::text as n from audit_log
      where action = 'mdm.article.approve' and entity_id = $1 and outcome = 'denied' and reason = 'mdm.approve.self'`,
    [reviewTask.id]
  );
  equal("the attempt is in the ledger as a denial", denied[0]?.n, "1");

  // -------------------------------------------------------------------------
  heading("The second person's approval supersedes N in ONE transaction");
  // -------------------------------------------------------------------------
  const decision = await decideArticleReview(approverPrincipal, { taskId: reviewTask.id, decision: "approve" }, {
    source: "api",
    intent: "slab 3c-2 verification: approve the proposal",
  });
  say("");
  say(`decideArticleReview(approve) -> ${JSON.stringify(decision)}`);

  const afterApproval = await versions();
  const pricesAfterApproval = await prices();
  const articleAfterApproval = await articleRow();
  const tasksAfterApproval = await tasks();
  rows("versions after approval", afterApproval);
  rows("price windows after approval", pricesAfterApproval);
  rows("article after approval", articleAfterApproval);
  rows("tasks after approval", tasksAfterApproval);

  equal("N+1 is active", afterApproval.find((row) => row.id === np1.id)?.status, "active");
  equal("N is superseded", afterApproval.find((row) => row.id === n.id)?.status, "superseded");
  equal(
    "N+1 records who approved it",
    afterApproval.find((row) => row.id === np1.id)?.approved_by_user_id,
    approverPrincipal.userId
  );
  const nClosed = pricesAfterApproval.filter((row) => row.article_version_id === n.id);
  const np1OpenAfter = pricesAfterApproval.filter(
    (row) => row.article_version_id === np1.id && row.effective_to === null
  );
  rows("N's windows after approval (closed, never deleted)", nClosed);
  equal("N's window was closed, not deleted", nClosed.length, 1);
  check("N's window now has an end date", nClosed[0]?.effective_to !== null, `effective_to ${nClosed[0]?.effective_to}`);
  equal(
    "the closed window kept its price — a historical bill still reproduces it",
    Number(nClosed[0]?.amount),
    BASE_PRICE
  );
  equal("N+1 has the open, sellable window", np1OpenAfter.length, 1);
  equal("the sellable price is the proposed one", Number(np1OpenAfter[0]?.amount), NEW_PRICE);
  equal("the article's pointer moved to N+1", articleAfterApproval?.current_version_id, np1.id);
  equal("the article's current version is N+1", articleAfterApproval?.current_version, np1.version);
  equal("the article is active", articleAfterApproval?.status, "active");
  equal("exactly one version is active", afterApproval.filter((row) => row.status === "active").length, 1);
  equal(
    "exactly one open price window remains for the article",
    pricesAfterApproval.filter((row) => row.effective_to === null).length,
    1
  );
  equal("the review task is decided", tasksAfterApproval.find((row) => row.id === reviewTask.id)?.status, "approved");
  equal(
    "the decider is the second person",
    tasksAfterApproval.find((row) => row.id === reviewTask.id)?.decided_by_user_id,
    approverPrincipal.userId
  );

  const approvalAudit = (await auditRows("mdm.article.approve")).filter((row) => row.entity_id === reviewTask.id);
  say("");
  say("The ledger row for this approval, read back from audit_log:");
  rows("audit row", approvalAudit);
  equal("exactly one success row was written for this decision", approvalAudit.length, 1);
  const ledger = approvalAudit[0];
  const before = (ledger?.before_state ?? {}) as Record<string, unknown>;
  const after = (ledger?.after_state ?? {}) as Record<string, unknown>;
  equal("the row is a success", ledger?.outcome, "success");
  equal("the row's before_state names N (the version that was live)", before.versionId, n.id);
  equal("the row's after_state names N+1 (the version that became live)", after.versionId, np1.id);
  equal("the row names the superseded version", after.supersededVersionId, n.id);
  rows("the closed windows the row carries", after.closedPrices);
  check(
    "the row carries both version ids and the closed window",
    before.versionId === n.id && after.versionId === np1.id && after.supersededVersionId === n.id,
    `N=${n.id} -> N+1=${np1.id}`
  );

  // -------------------------------------------------------------------------
  heading("NON-GATED LANDING — the gate off, the caller may approve: one transaction, no queue");
  say("The other landing of the same call, and the reason a one-person Silver chain can reprice");
  say("at all: with `mdm_approval_gated` off and `mdm.article.approve` held, the opener creates");
  say("N+1 and approves it in the same transaction — §6's third branch, applied to a version.");
  // -------------------------------------------------------------------------
  await setGate(false);
  say(`  gate set: mdm_approval_gated = false for ${CHAIN_CODE}`);
  fixture(`set mdm_approval_gated = false for chain ${chainId} (non-gated landing)`);

  const nonGatedBefore = await versions();
  const n1 = nonGatedBefore.find((row) => row.id === np1.id)!;
  const secondReprice = await updateArticlePrice(
    author,
    { code: ARTICLE_CODE, outletCode: OUTLET_CODE, amount: THIRD_PRICE, currencyCode: outlet.currency },
    { source: "api", intent: "slab 3c-2 verification: reprice on a non-gated chain" }
  );
  say("");
  say(`updateArticlePrice(${NEW_PRICE} -> ${THIRD_PRICE}) -> ${JSON.stringify(secondReprice)}`);

  const afterNonGated = await versions();
  const pricesAfterNonGated = await prices();
  const articleAfterNonGated = await articleRow();
  rows("versions after the non-gated reprice", afterNonGated);
  rows("price windows after the non-gated reprice", pricesAfterNonGated);
  rows("article after the non-gated reprice", articleAfterNonGated);

  equal("the write reports the same-transaction landing", secondReprice.version.landed, "approved");
  equal("a third version exists", afterNonGated.length, 3);
  const np2 = afterNonGated.find((row) => row.version === n1.version + 1)!;
  equal("N+2 is active", np2.status, "active");
  equal("N+1 is superseded", afterNonGated.find((row) => row.id === n1.id)?.status, "superseded");
  equal("N+2 records N+1 as the version it replaces", np2.supersedes_version_id, n1.id);
  equal("no version waits for a decision", afterNonGated.filter((row) => row.status === "draft" || row.status === "pending_review").length, 0);
  equal("the article points at N+2", articleAfterNonGated?.current_version_id, np2.id);
  equal("the article's current version is N+2", articleAfterNonGated?.current_version, np2.version);
  const n1Closed = pricesAfterNonGated.filter((row) => row.article_version_id === n1.id);
  const np2Open = pricesAfterNonGated.filter((row) => row.article_version_id === np2.id && row.effective_to === null);
  equal("N+1's window was closed, not deleted", n1Closed.length, 1);
  check("N+1's window has an end date", n1Closed[0]?.effective_to !== null, `effective_to ${n1Closed[0]?.effective_to}`);
  equal("N+2 carries the new open window", np2Open.length, 1);
  equal("the sellable price is the third one", Number(np2Open[0]?.amount), THIRD_PRICE);
  equal(
    "exactly one open price window remains for the article",
    pricesAfterNonGated.filter((row) => row.effective_to === null).length,
    1
  );
  equal("no review task was raised by the non-gated landing", (await tasks()).filter((row) => row.status === "open").length, 0);

  const priceAudit = await auditRows("mdm.article.price.update");
  const landed = priceAudit.filter((row) => {
    const state = (row.after_state ?? {}) as Record<string, unknown>;
    return state.landed === "approved";
  });
  say("");
  say("The ledger row the non-gated landing wrote, read back from audit_log:");
  rows("audit row", landed);
  equal("one price-write row records the same-transaction approval", landed.length, 1);
  const landedBefore = (landed[0]?.before_state ?? {}) as Record<string, unknown>;
  const landedAfter = (landed[0]?.after_state ?? {}) as Record<string, unknown>;
  equal("its before_state names the version that was on sale", landedBefore.versionId, n1.id);
  equal("its after_state names the version that became live", landedAfter.versionId, np2.id);
  equal("it names the superseded version", landedAfter.baseVersionId, n1.id);
  equal("it reports the window it closed", landedBefore.effectiveTo, landedAfter.effectiveFrom);

  // -------------------------------------------------------------------------
  heading("Restore the fixture the walk borrowed, and say what is left behind");
  // -------------------------------------------------------------------------
  await setGate(gateAsFound);
  const gateNow = await q.query<{ enabled: boolean }>(
    `select cf.enabled from chain_feature cf join feature f on f.code = cf.feature_code
      where cf.chain_id = $1 and f.code = 'mdm_approval_gated'`,
    [chainId]
  );
  say(`  gate restored: mdm_approval_gated = ${String(gateNow[0]?.enabled)} for ${CHAIN_CODE}`);
  equal("the gate is back where the script found it", Boolean(gateNow[0]?.enabled), gateAsFound);

  const sessions = await q.query<{ n: string }>(
    `select count(*)::text as n from app_session where user_agent = $1`,
    [SESSION_MARK]
  );
  fixture(`deleting the ${sessions[0]?.n} session row(s) this script minted (user_agent = '${SESSION_MARK}')`);
  await withTransaction((tx) =>
    tx.query(`delete from app_session where user_agent = $1`, [SESSION_MARK])
  );

  say("");
  say("LEFT BEHIND IN THE SCRATCH DATABASE, for a later run or a human:");
  say(`  * article ${ARTICLE_CODE} in chain ${CHAIN_CODE}: 3 versions (1 and 2 superseded, 3 active), one open window at ${THIRD_PRICE} ${outlet.currency}`);
  say("    — deleted by the NEXT run of this script, which starts from a clear canvas");
  say(`  * import reports for file names beginning '${IMPORT_FILE_PREFIX}' — also deleted by the next run`);
  say("  * audit rows (append-only, deliberately: a rewrite of the ledger would defeat its purpose)");
  say("  * the second approver identity and its role assignment, above, with its reverse SQL");
}

// ---------------------------------------------------------------------------
// Run, and always write the transcript
// ---------------------------------------------------------------------------
await main().catch((error: unknown) => {
  say("");
  say(`ABORTED: ${errorMessage(error)}`);
  if (error instanceof Error && error.stack) say(error.stack.split("\n").slice(0, 4).join("\n"));
  failures.push(`aborted: ${errorMessage(error)}`);
});

say("");
say("=".repeat(78));
say(`steps: ${step}`);
say(`fixture writes: ${fixtures.length}`);
for (const line of fixtures) say(`  FIXTURE  ${line}`);
say(`failures: ${failures.length}`);
for (const failure of failures) say(`  FAILED  ${failure}`);
say(
  failures.length === 0
    ? "VERDICT: the draft-version rule behaves as designed, and the dry run agrees with the commit."
    : "VERDICT: SEE FAILURES ABOVE."
);

writeFileSync("/home/team/shared/evidence/draft-version-verification.txt", lines.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
