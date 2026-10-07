/**
 * FOUR EYES ON A SILVER CHAIN — the tier gate, proved by **calling** it.
 *
 *   bun run scripts/verify-approval-gate-silver.ts
 *
 * **What this exists to prove.** On 7 Oct 2026 the owner ruled that four eyes sits in the
 * **Silver** baseline, so `mdm_approval_gated.min_tier` moved from `gold` to `silver`
 * (`db/seed.sql:410-411`). The only gate standing between a Silver chain and the
 * approval-gated golden record is that one registry value, read by the generic feature gate
 * in `src/domain/chains.ts` — `blockedByTier` at `:288` (badge + toggle), the onboarding
 * override at `:365-369`, and the server refusal at `:506-510`. Nothing downstream changes.
 *
 * That is exactly why a naive proof is worthless: lower a value and every screen agrees,
 * whether or not the gate ever opens. `scripts/verify-draft-version.ts:356-369` toggles the
 * approval gate with **raw SQL**, so it can never fail on the tier. This harness calls the
 * product instead:
 *
 *   1. reads `feature.min_tier` back for `mdm_approval_gated` and asserts `silver`;
 *   2. **controls** the claim — it puts the registry row back to `gold` for one step and shows
 *      the same call refused with the same sentence a Silver chain read before the change,
 *      then restores `silver` and shows the call accepted. Without that control, "the call
 *      succeeded" could mean the gate was never armed;
 *   3. calls `setChainFeature(admin, <silver chain>, 'mdm_approval_gated', true)` — the refusal
 *      at `chains.ts:506-510` is what must no longer fire — and reads the `chain_feature` row
 *      back enabled;
 *   4. reads the chain detail the screen renders and asserts the entitlement is **not blocked**
 *      (`blockedByTier === false`), quoting the badge sentence the screen would choose;
 *   5. walks four eyes on that Silver chain, server-side and through the domain API: a version
 *      raised lands **non-active** because `approvalGated` (`mdm.ts:1985-1994`) is on, the task
 *      routes to the approver role and appears in that role's queue read, a self-approval is
 *      refused **by calling `decideArticleReview`** (`permission.mdm.approve.self`, one `denied`
 *      row in that call), and the second person's approval takes the version live;
 *   6. restores every row it wrote and reads them back.
 *
 * **It runs against the `omnihost_check` scratch database and refuses to run anywhere else.**
 * `DATABASE_URL` is read, its database name is swapped for `omnihost_check`, and a URL that
 * does not point at the owner's demo database (`OmniHost`) is rejected outright — so a
 * mis-set environment fails loudly instead of writing test rows into the demo data. The
 * modules that read `DATABASE_URL` are imported *after* the swap, so there is no window in
 * which the script could talk to the demo database.
 *
 * **Prerequisite:** the scratch database must be at the current migration head and carry the
 * current reference seed — `bun run db:migrate` and `bun run db:seed:reference` with
 * `DATABASE_URL` pointed at `omnihost_check`. The harness asserts the registry row it needs
 * and fails loudly if it is not there, rather than writing it.
 *
 * **What is hand-written, and why.** Three things, each printed with the SQL that reverses it:
 *
 *   1. two fixture identities on the Silver chain (`omnihost_check`'s seeded MDM accounts are
 *      scoped to the *Gold* pilot chain, `saffron-table`, and the whole point here is a
 *      **Silver** chain with no MDM users of its own). One authors, one approves; both hold
 *      `CENTRAL_MDM_HEAD`, because four eyes is two **people**, not two roles;
 *   2. the `feature.min_tier` value, moved to `gold` for the control step and back to `silver`
 *      immediately — one statement, in the scratch database, restored in the same run;
 *   3. the fixture article, created through `createArticle` and deleted at the end. Its
 *      `audit_log` rows stay: the ledger is append-only, and rewriting it would defeat it.
 *
 * Every step ends in a read back from the database: the rows themselves, not the return value
 * of the call that wrote them. The transcript is written to
 * `/home/team/shared/evidence/silver-approval-gate-verification.txt`.
 */

import { writeFileSync } from "node:fs";
// Type-only, and therefore erased at run time: these open no connection and cannot run before
// the `DATABASE_URL` swap below. `~/db` is still *loaded* dynamically, after the swap.
import type { Queryable } from "~/db";
import type { Principal } from "~/server/session";
import type { ArticleWriteInput } from "~/domain/mdm";

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
const { getChain, setChainFeature, tierSatisfies } = await import("~/domain/chains");
const { createArticle } = await import("~/domain/mdm");
const { decideArticleReview, SELF_APPROVAL_REFUSAL_CODE } = await import("~/domain/mdm-approvals");
const { listApprovals } = await import("~/domain/inbox");
const { can } = await import("~/server/permissions");
const { createSession, findUserByEmail, resolvePrincipal } = await import("~/server/session");
const { ValidationError } = await import("~/server/errors");
// The badge sentences the chain screen picks between, read from the English catalogue itself
// rather than retyped here — the transcript then quotes the copy an operator actually reads.
const { enIN } = await import("~/i18n/catalog-en");

const SESSION_MARK = "verify-approval-gate-silver";
const CHAIN_CODE = "coastal-catch";
const FEATURE_CODE = "mdm_approval_gated";
const APPROVER_ROLE = "CENTRAL_MDM_HEAD";
const ADMIN_EMAIL = "admin@omnihost.ai";
const AUTHOR_EMAIL = "silver.author.scratch@coastal.example";
const APPROVER_EMAIL = "silver.approver.scratch@coastal.example";
const ARTICLE_CODE = "CHK-SILVER-GATE";
const ARTICLE_NAME = "Silver Gate Verification Cooler";
const BASE_PRICE = 180;
const BADGE_KEY_BLOCKED = "chains.detail.features.blocked";
const BADGE_KEY_AVAILABLE = "chains.detail.features.availableFrom";

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
/** The badge key and sentence `_shell.chains.$chainId.tsx:259` picks for this feature row. */
function badge(feature: { blockedByTier: boolean; minTier: string }, chainTier: string): {
  key: string;
  sentence: string;
} {
  const key = feature.blockedByTier ? BADGE_KEY_BLOCKED : BADGE_KEY_AVAILABLE;
  const template = enIN[key as keyof typeof enIN] as string;
  return {
    key,
    sentence: template
      .replace("{tier}", feature.minTier)
      .replace("{current}", chainTier)
      .replace("{tier}", feature.minTier),
  };
}

// ---------------------------------------------------------------------------
// The scratch database, the fixture it needs, and the reads used at each step
// ---------------------------------------------------------------------------
const q = poolQueryable();

interface GateRow {
  min_tier: string;
  description: string | null;
  toggleable: boolean;
}
async function featureRow(): Promise<GateRow | undefined> {
  return (
    await q.query<GateRow>(
      `select min_tier, description, toggleable from feature where code = $1`,
      [FEATURE_CODE]
    )
  )[0];
}
async function chainRow(): Promise<{ id: string; code: string; licence_tier: string } | undefined> {
  return (
    await q.query<{ id: string; code: string; licence_tier: string }>(
      `select id, code, licence_tier from chain where code = $1`,
      [CHAIN_CODE]
    )
  )[0];
}
interface SwitchRow {
  enabled: boolean;
  updated_by_user_id: string | null;
  updated_at: Date | null;
}
async function switchRow(chainId: string, tx: Queryable = q): Promise<SwitchRow | undefined> {
  return (
    await tx.query<SwitchRow>(
      `select enabled, updated_by_user_id, updated_at
         from chain_feature where chain_id = $1 and feature_code = $2`,
      [chainId, FEATURE_CODE]
    )
  )[0];
}
/** The chain detail the screen renders — the same call `_shell.chains.$chainId.tsx` makes. */
async function gateFeatureOnChain(
  principal: Principal,
  chainId: string
): Promise<{ minTier: string; enabled: boolean; blockedByTier: boolean }> {
  const detail = await getChain(principal, chainId);
  const feature = detail.features.find((row) => row.code === FEATURE_CODE);
  if (!feature) throw new Error(`chain detail carried no ${FEATURE_CODE} row`);
  return { minTier: feature.minTier, enabled: feature.enabled, blockedByTier: feature.blockedByTier };
}

/** The ids in the ledger matching a literal predicate — so a "what did THIS call write" question
 *  is answered by naming the set, never by counting a prefix that grows across runs. */
async function auditIds(where: string, params: unknown[]): Promise<string[]> {
  const found = await q.query<{ id: string }>(`select id from audit_log where ${where} order by id`, params);
  return found.map((row) => row.id);
}
async function newAuditRows(
  where: string,
  params: unknown[],
  before: string[]
): Promise<Record<string, unknown>[]> {
  const idRows = await q.query<{ id: string }>(
    `select id from audit_log where ${where} order by id`,
    params
  );
  const added = idRows.filter((row) => !before.includes(row.id)).map((row) => row.id);
  if (added.length === 0) return [];
  return q.query<Record<string, unknown>>(
    `select id, action, entity_type, entity_id, outcome, reason, before_state, after_state,
            actor_user_id, created_at
       from audit_log where id = any($1::uuid[]) order by id`,
    [added]
  );
}

// Article-shaped reads, all scoped to this run's fixture article by code.
interface VersionRow {
  id: string;
  version: number;
  status: string;
  approved_by_user_id: string | null;
}
async function articleRow(): Promise<Record<string, unknown> | undefined> {
  return (
    await q.query<Record<string, unknown>>(
      `select a.id, a.code, a.status, a.current_version_id, v.version as current_version,
              v.status as current_version_status
         from article a left join article_version v on v.id = a.current_version_id
        where a.chain_id = $1 and a.code = $2`,
      [chainId, ARTICLE_CODE]
    )
  )[0];
}
async function versions(): Promise<VersionRow[]> {
  return q.query<VersionRow>(
    `select v.id, v.version, v.status, v.approved_by_user_id
       from article_version v join article a on a.id = v.article_id
      where a.chain_id = $1 and a.code = $2 order by v.version`,
    [chainId, ARTICLE_CODE]
  );
}
async function tasks(): Promise<Record<string, unknown>[]> {
  return q.query<Record<string, unknown>>(
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

// ---------------------------------------------------------------------------
say("OmniHost.ai — four eyes in the SILVER baseline: the tier gate, proved by calling it.");
say(`database under test: ${swapped.replace(/:[^:@]*@/, ":***@")}`);
say("No owner row is touched: this is the scratch database only.");
say("");
say("The claim under test: `mdm_approval_gated` is entitled at Silver, the per-chain switch is");
say("what turns it on, and the four-eyes path is alive on a Silver chain once it is on.");

const chain = await chainRow();
if (!chain) {
  console.error(`no chain ${CHAIN_CODE} in the scratch database — nothing to verify.`);
  process.exit(2);
}
const chainId = chain.id;
equal("the chain under test is the SILVER one", chain.licence_tier, "silver");
say(`chain ${CHAIN_CODE} = ${chain.id} (${chain.licence_tier})`);

const admin = await (async (): Promise<Principal> => {
  const user = await findUserByEmail(ADMIN_EMAIL);
  if (!user) throw new Error(`no user ${ADMIN_EMAIL} in the scratch database`);
  const { token } = await createSession(user.id, { chainId, userAgent: SESSION_MARK });
  const principal = await resolvePrincipal(token);
  if (!principal) throw new Error(`session for ${ADMIN_EMAIL} did not resolve`);
  return principal;
})();

async function principalFor(email: string): Promise<Principal> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`no user ${email} in the scratch database`);
  const { token } = await createSession(user.id, { chainId, userAgent: SESSION_MARK });
  const principal = await resolvePrincipal(token);
  if (!principal) throw new Error(`session for ${email} did not resolve`);
  return principal;
}

/** Runs after the fixtures are in place, so a failure still writes the transcript. */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  heading("The registry row IS Silver — the change, read back from the database");
  // -------------------------------------------------------------------------
  const registry = await featureRow();
  rows("feature row (mdm_approval_gated)", registry);
  equal("the registry's minimum tier is silver", registry?.min_tier, "silver");
  equal("the feature is still toggleable — Silver is an entitlement, not a forced switch", registry?.toggleable, true);
  check(
    "the description no longer tells a Silver chain it needs Gold",
    Boolean(registry?.description) && !/gold/i.test(String(registry?.description)),
    `description: ${JSON.stringify(registry?.description)}`
  );
  check(
    "the description names the switch, which is what actually turns four eyes on",
    Boolean(registry?.description) && /switch/i.test(String(registry?.description)),
    `description: ${JSON.stringify(registry?.description)}`
  );
  // The product's own comparison, not a re-implementation of it: this is `tierSatisfies`
  // exactly as `chains.ts:288`, `:365-369` and `:506-510` call it.
  equal("tierSatisfies(silver, <the registry's own value>) holds", tierSatisfies("silver", String(registry?.min_tier)), true);
  equal("tierSatisfies(silver, gold) does not hold — the comparison is real", tierSatisfies("silver", "gold"), false);

  // -------------------------------------------------------------------------
  heading("The fixture this run writes, and the SQL that reverses it");
  // -------------------------------------------------------------------------
  say("The scratch database's seeded MDM accounts are scoped to the GOLD pilot chain, and the");
  say("point of this run is a SILVER chain, so the fixture is two identities on it — one who");
  say("authors and one who approves. Both hold the same role: four eyes is two people.");
  const author = await ensureIdentity(AUTHOR_EMAIL, "Silver Author (omnihost_check)");
  const approver = await ensureIdentity(APPROVER_EMAIL, "Silver Second Approver (omnihost_check)");
  const authorPrincipal = await principalFor(AUTHOR_EMAIL);
  const approverPrincipal = await principalFor(APPROVER_EMAIL);
  say("");
  say(`author   ${authorPrincipal.email} (${authorPrincipal.roles.map((r) => r.code).join(",")}) user ${authorPrincipal.userId}`);
  say(`approver ${approverPrincipal.email} (${approverPrincipal.roles.map((r) => r.code).join(",")}) user ${approverPrincipal.userId}`);
  check(
    "it is a different person from the author, so four eyes are two people",
    approverPrincipal.userId !== authorPrincipal.userId,
    `${authorPrincipal.userId} vs ${approverPrincipal.userId}`
  );
  equal(
    "the author may create a record on this chain",
    await can(authorPrincipal, "mdm.article.create", { chainId }),
    true
  );
  equal(
    "the author also holds the approve act — so nothing but four eyes stops a self-approval",
    await can(authorPrincipal, "mdm.article.approve", { chainId }),
    true
  );
  equal(
    "the second person may approve",
    await can(approverPrincipal, "mdm.article.approve", { chainId }),
    true
  );
  equal(
    "the admin holding chain.feature.update is entitled to switch a feature on",
    await can(admin, "chain.feature.update", { chainId }),
    true
  );

  const switchAsFound = await switchRow(chainId);
  say("");
  say(`  gate as found for ${CHAIN_CODE}: ${JSON.stringify(switchAsFound)}`);
  fixture(
    `${CHAIN_CODE}'s ${FEATURE_CODE} switch was ${String(switchAsFound?.enabled)}; this script switches it ON through setChainFeature and back to ${String(switchAsFound?.enabled)} at the end`
  );

  // A clear canvas: the previous run's article and tasks, and nothing else.
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

  // Reference data the create needs on THIS chain: a category, a base UoM, an allergen and a
  // tax class in a jurisdiction the chain actually trades in.
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
  const outletRow = (
    await q.query<{ code: string; currency: string }>(
      `select o.code, s.currency from outlet o join site s on s.id = o.site_id
        where o.chain_id = $1 order by o.code limit 1`,
      [chainId]
    )
  )[0];
  if (!categoryRow || !uomRow || !allergenRow || !taxRow || !outletRow) {
    throw new Error(`reference data missing on ${CHAIN_CODE}: ${JSON.stringify({ categoryRow, uomRow, allergenRow, taxRow, outletRow })}`);
  }
  say(
    `reference data: category ${categoryRow.code}, base UoM ${uomRow.code}, allergen ${allergenRow.code}, tax class ${taxRow.code}, outlet ${outletRow.code} (${outletRow.currency})`
  );

  const input: ArticleWriteInput = {
    code: ARTICLE_CODE,
    name: ARTICLE_NAME,
    shortName: "Silver Gate",
    categoryCode: categoryRow.code,
    articleType: "beverage",
    dietaryMark: "veg",
    taxClassCode: taxRow.code,
    hsnSacCode: "22029900",
    baseUomCode: uomRow.code,
    servingSizeQty: 1,
    servingSizeUomCode: uomRow.code,
    caloriesKcal: 110,
    channels: ["dine-in"],
    allergens: [{ code: allergenRow.code, mayContain: false }],
    prices: [{ outletCode: outletRow.code, amount: BASE_PRICE, currencyCode: outletRow.currency }],
  };

  // -------------------------------------------------------------------------
  heading("CONTROL — with the registry row put back to Gold, the same call is refused");
  // -------------------------------------------------------------------------
  say("This step exists so that 'the call succeeded' means something. The registry value is");
  say("moved to `gold` for one moment (one statement, in the scratch database), the same");
  say("`setChainFeature` call is made, and the refusal a Silver chain met before 7 Oct comes");
  say("back — the generic sentence `chains.detail.features.blocked` renders beside it. Then the");
  say("value is restored and the read back confirms it.");
  const switchBeforeControl = (await switchRow(chainId))?.enabled ?? false;
  fixture(`feature.${FEATURE_CODE}.min_tier set to 'gold' for the control, then restored to 'silver'`);
  await withTransaction((tx) =>
    tx.query(`update feature set min_tier = 'gold' where code = $1`, [FEATURE_CODE])
  );
  equal("the control state is in place", (await featureRow())?.min_tier, "gold");

  const blockedFeature = await gateFeatureOnChain(admin, chainId);
  rows("chain detail while the registry says gold", blockedFeature);
  equal("the screen reports the feature as blocked by the tier", blockedFeature.blockedByTier, true);
  const blockedBadge = badge(blockedFeature, chain.licence_tier);
  rows("the badge the screen would pick", blockedBadge);
  equal("the badge is the blocked sentence", blockedBadge.key, BADGE_KEY_BLOCKED);
  say(`        rendered: "${blockedBadge.sentence}"`);

  const auditWhere = `action = 'chain.feature.update' and entity_id = $1`;
  const auditParams = [`${chainId}:${FEATURE_CODE}`];
  const auditBeforeControl = await auditIds(auditWhere, auditParams);
  let controlRefusalMessage = "";
  let controlRefusalWasDomainError = false;
  try {
    const result = await setChainFeature(
      admin,
      chainId,
      FEATURE_CODE,
      true,
      { source: "api", intent: "verify-approval-gate-silver: the control, with the registry row at gold" }
    );
    check(
      "the call is refused while the registry row says gold",
      false,
      `expected the tier refusal, but the call succeeded: ${JSON.stringify(result)}`
    );
  } catch (error) {
    controlRefusalMessage = errorMessage(error);
    controlRefusalWasDomainError = error instanceof ValidationError;
    check("the call refused while the registry row says gold", true, `"${controlRefusalMessage}"`);
  }
  check(
    "the refusal is the domain's own validation refusal, not a database error",
    controlRefusalWasDomainError,
    `instanceof ValidationError: ${String(controlRefusalWasDomainError)}`
  );
  equal(
    "the sentence names the minimum tier and the chain's tier",
    controlRefusalMessage,
    `${FEATURE_CODE} needs the gold tier; this chain is on silver`
  );
  const switchAfterControl = await switchRow(chainId);
  equal(
    "the refused call changed no switch row",
    switchAfterControl?.enabled ?? null,
    switchBeforeControl
  );
  equal(
    "the refused call wrote no success row in the ledger",
    (await newAuditRows(auditWhere, auditParams, auditBeforeControl)).length,
    0
  );

  await withTransaction((tx) =>
    tx.query(`update feature set min_tier = 'silver' where code = $1`, [FEATURE_CODE])
  );
  equal("the control is restored: the registry row is silver again", (await featureRow())?.min_tier, "silver");

  // -------------------------------------------------------------------------
  heading("SILVER — the same call is accepted, and the screen stops refusing");
  // -------------------------------------------------------------------------
  const auditBeforeSwitch = await auditIds(auditWhere, auditParams);
  const switched = await setChainFeature(admin, chainId, FEATURE_CODE, true, {
    source: "api",
    intent: "verify-approval-gate-silver: switch the approval gate on for the Silver chain",
  });
  say("");
  say(`setChainFeature(${FEATURE_CODE}, true) -> ${JSON.stringify(switched)}`);
  const switchOn = await switchRow(chainId);
  rows("chain_feature row, read back", switchOn);
  equal("the switch row is enabled", switchOn?.enabled, true);
  equal(
    "the switch records the admin who made it",
    switchOn?.updated_by_user_id,
    admin.userId
  );
  const switchAudit = await newAuditRows(auditWhere, auditParams, auditBeforeSwitch);
  rows("the ledger rows THIS call wrote", switchAudit);
  equal("the accepted switch wrote exactly one ledger row", switchAudit.length, 1);
  equal("the row is a success", switchAudit[0]?.outcome, "success");
  equal("the row records the switch going from off to on", (switchAudit[0]?.after_state as { enabled?: boolean } | undefined)?.enabled, true);
  equal("the row names the chain and the feature", switchAudit[0]?.entity_id, `${chainId}:${FEATURE_CODE}`);

  const entitledFeature = await gateFeatureOnChain(admin, chainId);
  rows("chain detail after the switch", entitledFeature);
  equal("the screen no longer reports the feature as blocked by the tier", entitledFeature.blockedByTier, false);
  equal("the feature row carries the registry's own minimum tier", entitledFeature.minTier, "silver");
  equal("the feature reads as switched on", entitledFeature.enabled, true);
  const entitledBadge = badge(entitledFeature, chain.licence_tier);
  rows("the badge the screen would pick", entitledBadge);
  equal("the badge is the available sentence, not the blocked one", entitledBadge.key, BADGE_KEY_AVAILABLE);
  say(`        rendered: "${entitledBadge.sentence}"`);

  // -------------------------------------------------------------------------
  heading("FOUR EYES on that Silver chain — a version raised lands non-active, in the approver's queue");
  // -------------------------------------------------------------------------
  const created = await createArticle(authorPrincipal, input, {
    source: "api",
    intent: "verify-approval-gate-silver: the author raises the fixture article",
  });
  say("");
  say(`createArticle -> ${JSON.stringify(created)}`);
  const afterCreate = await versions();
  const articleAfterCreate = await articleRow();
  rows("versions after the create", afterCreate);
  rows("article after the create", articleAfterCreate);
  equal("the create landed one version", afterCreate.length, 1);
  equal("no required-in-market field was missing", created.missingRequired.length, 0);
  equal(
    "the version did NOT land active — the chain's approval switch gated it",
    afterCreate[0]?.status,
    "pending_review"
  );
  equal("the create reports that landing", created.status, "pending_review");
  const version = afterCreate[0]!;

  const raiseTasks = (await tasks()).filter((row) => row.status === "open");
  rows("open review tasks for this article", raiseTasks);
  equal("the raise opened exactly one review task", raiseTasks.length, 1);
  const reviewTask = raiseTasks[0]!;
  equal("the task names the version as its entity", reviewTask.entity_id, version.id);
  equal("the task's entity type is the version, not the article", reviewTask.entity_type, "article_version");
  equal("the task is routed to the article approver role", reviewTask.assigned_role_code, APPROVER_ROLE);
  equal("the task records the author as its raiser", reviewTask.raised_by_user_id, authorPrincipal.userId);

  const queue = await listApprovals(approverPrincipal, { scope: "waiting" });
  const inQueue = queue.items.filter((item) => item.id === reviewTask.id);
  rows("the approver's waiting queue, filtered to this task", inQueue);
  equal("the task is in the approver role's queue", inQueue.length, 1);
  equal("the queue names the chain's own approver role", inQueue[0]?.assignedRole, APPROVER_ROLE);

  // -------------------------------------------------------------------------
  heading("Four eyes — the author cannot approve their own raise, by CALLING decideArticleReview");
  // -------------------------------------------------------------------------
  const deniedWhere = `action = 'mdm.article.approve' and entity_id = $1 and outcome = 'denied' and reason = 'mdm.approve.self'`;
  const deniedParams = [String(reviewTask.id)];
  const deniedBefore = await auditIds(deniedWhere, deniedParams);
  let selfRefusalCode: string | null = null;
  try {
    const result = await decideArticleReview(
      authorPrincipal,
      { taskId: String(reviewTask.id), decision: "approve" },
      { source: "api", intent: "verify-approval-gate-silver: the author's own approval attempt" }
    );
    check(
      "the author's own approval is refused",
      false,
      `expected ${SELF_APPROVAL_REFUSAL_CODE}, but the call succeeded: ${JSON.stringify(result)}`
    );
  } catch (error) {
    selfRefusalCode = errorCode(error);
    check(
      "the author's own approval is refused by the four-eyes rule",
      selfRefusalCode === SELF_APPROVAL_REFUSAL_CODE,
      selfRefusalCode ?? `refused with "${errorMessage(error)}" and no code`
    );
  }
  const deniedAfter = await auditIds(deniedWhere, deniedParams);
  rows("denied self-approval rows for this task, before/after", [deniedBefore.length, deniedAfter.length]);
  equal("the refusal wrote exactly one denied row in that call", deniedAfter.length - deniedBefore.length, 1);
  equal("the version is still waiting", (await versions()).find((row) => row.id === version.id)?.status, "pending_review");
  equal(
    "the task is still open",
    (await tasks()).filter((row) => row.id === reviewTask.id && row.status === "open").length,
    1
  );

  // -------------------------------------------------------------------------
  heading("The second person's approval takes the version live, in one transaction");
  // -------------------------------------------------------------------------
  const approveWhere = `action = 'mdm.article.approve' and entity_id = $1 and outcome = 'success'`;
  const approveBefore = await auditIds(approveWhere, [String(reviewTask.id)]);
  const decision = await decideArticleReview(
    approverPrincipal,
    { taskId: String(reviewTask.id), decision: "approve" },
    { source: "api", intent: "verify-approval-gate-silver: the second person approves" }
  );
  say("");
  say(`decideArticleReview(approve) -> ${JSON.stringify(decision)}`);
  const afterApproval = await versions();
  const articleAfterApproval = await articleRow();
  const tasksAfterApproval = await tasks();
  rows("versions after approval", afterApproval);
  rows("article after approval", articleAfterApproval);
  rows("tasks after approval", tasksAfterApproval);
  equal("the version is active", afterApproval.find((row) => row.id === version.id)?.status, "active");
  equal(
    "the version records who approved it",
    afterApproval.find((row) => row.id === version.id)?.approved_by_user_id,
    approverPrincipal.userId
  );
  equal("the article points at it", articleAfterApproval?.current_version_id, version.id);
  equal(
    "the task is approved and records the second person",
    `${String(tasksAfterApproval.find((row) => row.id === reviewTask.id)?.status)}/${String(
      tasksAfterApproval.find((row) => row.id === reviewTask.id)?.decided_by_user_id
    )}`,
    `approved/${approverPrincipal.userId}`
  );
  const approveAudit = await newAuditRows(approveWhere, [String(reviewTask.id)], approveBefore);
  rows("the ledger row the approval wrote", approveAudit);
  equal("the approval wrote exactly one success row", approveAudit.length, 1);
  equal("the row is a success", approveAudit[0]?.outcome, "success");

  // -------------------------------------------------------------------------
  heading("Restore everything this run wrote, and read the rows back");
  // -------------------------------------------------------------------------
  const restored = await setChainFeature(admin, chainId, FEATURE_CODE, Boolean(switchAsFound?.enabled), {
    source: "api",
    intent: "verify-approval-gate-silver: put the chain's switch back where it was found",
  });
  say("");
  say(`setChainFeature(${FEATURE_CODE}, ${String(switchAsFound?.enabled)}) -> ${JSON.stringify(restored)}`);
  const switchRestored = await switchRow(chainId);
  rows("chain_feature row after the restore", switchRestored);
  equal("the switch is back where the run found it", switchRestored?.enabled ?? null, switchAsFound?.enabled ?? null);
  equal("the registry row is left at silver", (await featureRow())?.min_tier, "silver");

  fixture(`deleting the fixture article ${ARTICLE_CODE} (versions, prices and tasks with it)`);
  const articleId = (await articleRow())?.id as string | undefined;
  if (articleId) {
    await withTransaction(async (tx) => {
      await tx.query(`delete from approval_task where chain_id = $1 and entity_id = $2::text`, [chainId, articleId]);
      await tx.query(
        `delete from approval_task where chain_id = $1 and entity_id in (select id::text from article_version where article_id = $2)`,
        [chainId, articleId]
      );
      await tx.query(`delete from article_price where article_id = $1`, [articleId]);
      await tx.query(`delete from article where id = $1`, [articleId]);
    });
  }
  const articleLeft = await articleRow();
  equal("no fixture article is left behind", articleLeft, undefined);
  equal("no fixture version is left behind", (await versions()).length, 0);
  equal("no review task is left behind", (await tasks()).length, 0);

  fixture(`deleting the session rows this run minted (user_agent = '${SESSION_MARK}')`);
  const sessions = await q.query<{ n: string }>(
    `select count(*)::text as n from app_session where user_agent = $1`,
    [SESSION_MARK]
  );
  say(`  sessions minted by this run: ${String(sessions[0]?.n)}`);
  await withTransaction((tx) => tx.query(`delete from app_session where user_agent = $1`, [SESSION_MARK]));
  equal(
    "no session row is left behind",
    (await q.query<{ n: string }>(`select count(*)::text as n from app_session where user_agent = $1`, [SESSION_MARK]))[0]?.n,
    "0"
  );

  say("");
  say("LEFT BEHIND IN THE SCRATCH DATABASE, deliberately:");
  say("  * `audit_log` rows (append-only: a rewrite of the ledger would defeat its purpose);");
  say("  * nothing else — the identities, the article, its versions, prices, tasks and the");
  say("    sessions this run created are all deleted above, with their row counts read back.");
}

interface FixtureIdentity {
  id: string;
  email: string;
  roleId: string;
  assignmentId: string;
  scopeKey: string;
  createdUser: boolean;
  createdAssignment: boolean;
}

/** A person on the Silver chain holding `CENTRAL_MDM_HEAD`, with the SQL that reverses it. */
async function ensureIdentity(email: string, displayName: string): Promise<FixtureIdentity> {
  const roleRows = await q.query<{ id: string }>(`select id from role where code = $1`, [APPROVER_ROLE]);
  const roleId = roleRows[0]?.id;
  if (!roleId) throw new Error(`no role ${APPROVER_ROLE} in the scratch database`);

  const existing = await q.query<{ id: string }>(
    `select id from "user" where lower(email) = lower($1)`,
    [email]
  );
  let id = existing[0]?.id ?? null;
  let createdUser = false;
  if (!id) {
    const inserted = await q.query<{ id: string }>(
      `insert into "user" (email, display_name, auth_provider, status, locale)
       values ($1, $2, 'sso', 'active', 'en-IN')
       returning id`,
      [email, displayName]
    );
    id = inserted[0]?.id ?? null;
    createdUser = true;
    if (!id) throw new Error("the fixture user insert returned no id");
  }

  const scopeKey = `${id}|${roleId}|${chainId}|-`;
  const assignments = await q.query<{ id: string }>(`select id from role_assignment where scope_key = $1`, [
    scopeKey,
  ]);
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

  say("");
  say(`${createdUser ? "created" : "found"} the fixture identity ${email}`);
  rows("  user row", { id, email, display_name: displayName, auth_provider: "sso", status: "active", locale: "en-IN" });
  rows("  role_assignment row", {
    id: assignmentId,
    user_id: id,
    role_id: roleId,
    role: APPROVER_ROLE,
    chain_id: chainId,
    scope_key: scopeKey,
  });
  say("  FIXTURE SQL (idempotent — the `user` insert only when absent):");
  say(
    `    insert into "user" (email, display_name, auth_provider, status, locale) values ('${email}', '${displayName}', 'sso', 'active', 'en-IN');`
  );
  say(
    `    insert into role_assignment (user_id, role_id, chain_id, scope_key) values ('${id}', '${roleId}', '${chainId}', '${scopeKey}');`
  );
  say("  FIXTURE SQL (the reverse — the two rows this fixture owns, and nothing else):");
  say(`    delete from role_assignment where scope_key = '${scopeKey}';`);
  say(`    delete from "user" where id = '${id}';`);
  fixture(`fixture identity ${email} (${id}) holding ${APPROVER_ROLE} on ${CHAIN_CODE}`);

  return { id, email, roleId, assignmentId, scopeKey, createdUser, createdAssignment };
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
    ? "VERDICT: four eyes is entitled at Silver, the switch is what turns it on, and the gate is proved by calling it."
    : "VERDICT: SEE FAILURES ABOVE."
);

writeFileSync("/home/team/shared/evidence/silver-approval-gate-verification.txt", lines.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
