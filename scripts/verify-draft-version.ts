/**
 * A database read that proves the draft-version rule (slab 3c-2).
 *
 *   bun run scripts/verify-draft-version.ts
 *
 * The rule (§7.2 item 5, §7.3): a price change opens version **N+1 as a `draft` while N
 * stays `active` and sellable**, submitting N+1 raises a real review task against it, and
 * approving that task supersedes N — N+1 `active`, N `superseded`, N's open price windows
 * closed, the article's pointer moved, one audit row carrying both version ids — in one
 * transaction. Two refusals guard the path: a decision whose base has moved
 * (`validation.review.baseMoved`) and a content write onto an article that has an open
 * draft (`validation.review.articleOpen`), each changing nothing.
 *
 * **It runs against the `omnihost_check` scratch database and refuses to run anywhere
 * else.** `DATABASE_URL` is read, its database name is swapped for `omnihost_check`, and
 * a name that is not the owner's demo database (`OmniHost`) is rejected outright — so a
 * mis-set environment fails loudly instead of writing test rows into the demo data. There
 * is no local PostgreSQL on this machine, so the scratch database lives on the same Neon
 * server as the demo one.
 *
 * Every step is exercised through the domain functions the product calls — `createArticle`,
 * `updateArticlePrice`, `submitArticleForReview`, `decideArticleReview`, `updateArticle`,
 * `planArticleWrite` — under sessions minted for real demo users, so capability checks and
 * the four-eyes rule run exactly as they do in the app. Nothing is hand-written except the
 * two fixtures named in the transcript, both of which are stated out loud.
 *
 * Every step ends in a read back from the database: the rows themselves, not the return
 * value of the call that wrote them.
 */
import { poolQueryable, withTransaction, type Queryable } from "~/db";
import {
  createArticle,
  planArticleWrite,
  updateArticle,
  updateArticlePrice,
  type ArticleWriteInput,
} from "~/domain/mdm";
import { decideArticleReview, submitArticleForReview } from "~/domain/mdm-approvals";
import { can } from "~/server/permissions";
import { createSession, findUserByEmail, resolvePrincipal, type Principal } from "~/server/session";

const OWNER_DATABASE = "OmniHost";
const CHECK_DATABASE = "omnihost_check";

// ---------------------------------------------------------------------------
// Connection — swapped to the scratch database, or refuse to run
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// The scratch database, and the fixture it needs
// ---------------------------------------------------------------------------
const q = poolQueryable();
const CHAIN_CODE = "saffron-table";
const OUTLET_CODE = "koramangala-restaurant";
const ARTICLE_CODE = "CHK-DRAFT-VERIFY";
const AUTHOR_EMAIL = "mdm.head@saffron.example";
const APPROVER_CANDIDATES = ["admin@omnihost.ai", "purchase.head@saffron.example", "site.head@saffron.example"];

say("OmniHost.ai — slab 3c-2 (the draft-version rule), verified by reading the database.");
say(`database under test: ${swapped.replace(/:[^:@]*@/, ":***@")}`);
say("No production or demo row is touched: this is the scratch database only.");

const chainRows = await q.query<{ id: string; name: string }>(`select id, name from chain where code = $1`, [
  CHAIN_CODE,
]);
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
say(`chain ${CHAIN_CODE} = ${chain.id} (${chain.name}); outlet ${OUTLET_CODE} = ${outlet.id} (${outlet.currency})`);

// Sessions for two real people. A session row in the scratch database is a fixture; the
// principal it resolves to — roles, grants, flattened registry — is the real thing.
async function principalFor(email: string): Promise<Principal> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`no user ${email} in the scratch database`);
  const { token } = await createSession(user.id, { chainId, userAgent: "verify-draft-version" });
  const principal = await resolvePrincipal(token);
  if (!principal) throw new Error(`session for ${email} did not resolve`);
  return principal;
}
const author = await principalFor(AUTHOR_EMAIL);
say(`author   ${author.email} (${author.roles.map((role) => role.code).join(",")}) user ${author.userId}`);
say(`  holds mdm.article.create      ${await can(author, "mdm.article.create", { chainId })}`);
say(`  holds mdm.article.price.update ${await can(author, "mdm.article.price.update", { chainId })}`);
say(`  holds mdm.article.propose      ${await can(author, "mdm.article.propose", { chainId })}`);
say(`  holds mdm.article.approve      ${await can(author, "mdm.article.approve", { chainId })}`);

let approver: Principal | null = null;
for (const email of APPROVER_CANDIDATES) {
  const candidate = await principalFor(email);
  const may = await can(candidate, "mdm.article.approve", { chainId });
  say(`candidate approver ${email}: mdm.article.approve = ${may}`);
  if (may && candidate.userId !== author.userId) {
    approver = candidate;
    break;
  }
}
if (!approver) {
  say("");
  say("STOP — no second identity in the scratch database holds mdm.article.approve other than the author,");
  say("so the four-eyes rule cannot be exercised here. Nothing further was attempted.");
  await Bun.write("/home/team/shared/evidence/draft-version-verification.txt", lines.join("\n"));
  process.exit(3);
}
say(`approver ${approver.email} (${approver.roles.map((role) => role.code).join(",")}) user ${approver.userId}`);

// The approval gate. Migration and seed both leave `mdm_approval_gated` off; the pilot
// chain's gate was switched on by hand in the owner's database. The rule under test is
// stated for a gated chain, so the fixture turns it on here — in the scratch database,
// named out loud, and left on (a scratch database's state is the point of it).
const gateRows = await q.query<{ enabled: boolean }>(
  `select cf.enabled from chain_feature cf join feature f on f.code = cf.feature_code
    where cf.chain_id = $1 and f.code = 'mdm_approval_gated'`,
  [chainId]
);
say("");
say(`FIXTURE (scratch database): mdm_approval_gated for ${CHAIN_CODE} was ${String(gateRows[0]?.enabled)}`);
if (!gateRows[0]?.enabled) {
  await withTransaction(async (tx) =>
    tx.query(`update chain_feature set enabled = true where chain_id = $1 and feature_code = 'mdm_approval_gated'`, [
      chainId,
    ])
  );
  say(`FIXTURE (scratch database): set mdm_approval_gated = true for chain ${chainId}`);
}
const gatedRows = await q.query<{ enabled: boolean }>(
  `select cf.enabled from chain_feature cf join feature f on f.code = cf.feature_code
    where cf.chain_id = $1 and f.code = 'mdm_approval_gated'`,
  [chainId]
);
equal("the chain is approval-gated, as the rule requires", gatedRows[0]?.enabled, true);

// A clear canvas. The article this script authors is deleted first, so a second run starts
// from nothing; the delete names exactly one article of this chain and nothing else.
const existing = await q.query<{ id: string }>(`select id from article where chain_id = $1 and code = $2`, [
  chainId,
  ARTICLE_CODE,
]);
if (existing[0]) {
  say(`FIXTURE (scratch database): removing the previous run's article ${existing[0].id} (${ARTICLE_CODE})`);
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

// Reference data the create needs: a category, a base UoM, an allergen (India requires a
// declared set), and a tax class in a jurisdiction the chain actually trades in.
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

const BASE_PRICE = 250;
const NEW_PRICE = 310;
const input: ArticleWriteInput = {
  code: ARTICLE_CODE,
  name: "Draft-Rule Verification Mocktail",
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

// ---------------------------------------------------------------------------
// Reads used at each step
// ---------------------------------------------------------------------------
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
    `select p.id, p.article_version_id, o.code as outlet_code, p.amount, p.currency_code,
            to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(p.effective_to, 'YYYY-MM-DD') as effective_to
       from article_price p join outlet o on o.id = p.outlet_id join article a on a.id = p.article_id
      where a.chain_id = $1 and a.code = $2 order by p.article_version_id, p.effective_from`,
    [chainId, ARTICLE_CODE]
  );
}
async function tasks(tx: Queryable = q): Promise<Record<string, unknown>[]> {
  return tx.query<Record<string, unknown>>(
    `select t.id, t.status, t.entity_type, t.entity_id, t.raised_by_user_id, t.assigned_role_code,
            t.decided_by_user_id, t.decided_at, t.decision_note
       from approval_task t
      where t.chain_id = $1
        and (t.entity_id in (select id::text from article_version where article_id = (select id from article where chain_id = $1 and code = $2))
             or t.entity_id = (select id from article where chain_id = $1 and code = $2))
      order by t.created_at`,
    [chainId, ARTICLE_CODE]
  );
}
async function auditRows(action: string, entityId?: string): Promise<Record<string, unknown>[]> {
  return q.query<Record<string, unknown>>(
    `select id, action, entity_type, entity_id, outcome, reason, before_state, after_state,
            actor_user_id, created_at
       from audit_log
      where action = $1 and ($2::text is null or entity_id = $2::text
             or after_state->>'articleCode' = $3)
      order by created_at`,
    [action, entityId ?? null, ARTICLE_CODE]
  );
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  heading("A brand-new article, taken live through the review path");
  say("The fixture article is created by its author and (a gated chain) lands in review; the");
  say("second person approves it. This is the *settled* state the rule starts from: one");
  say("`active` version with an open price window.");
  // -------------------------------------------------------------------------
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

  const openTask = (await tasks()).find((t) => t.status === "open");
  if (v1.status === "pending_review") {
    check("the gated chain's brand-new record landed pending_review", true, `task ${String(openTask?.id)}`);
    const decided = await decideArticleReview(approver, { taskId: String(openTask!.id), decision: "approve" }, {
      source: "api",
      intent: "slab 3c-2 verification: take the fixture article live",
    });
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
  const currentV1 = settled[0]!;
  const openV1 = settledPrices.filter((p) => p.effective_to === null);
  equal("version 1 has one open price window", openV1.length, 1);
  equal("the open window holds the base price", Number(openV1[0]?.amount), BASE_PRICE);
  const articleSettled = await articleRow();
  equal("the article points at version 1", articleSettled?.current_version_id, currentV1.id);
  equal("the article is active", articleSettled?.status, "active");

  // -------------------------------------------------------------------------
  heading("A REPRICE leaves N active and sellable, and opens N+1 as a draft");
  say("The heart of the rule. Before slab 3c-2 this call closed the sellable window and");
  say("published the new price immediately; it must now open a draft beside the live version.");
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
  const n = afterReprice.find((v) => v.id === currentV1.id)!;
  const np1 = afterReprice.find((v) => v.id !== currentV1.id)!;
  equal("N is still active", n.status, "active");
  equal("N+1 is a draft", np1.status, "draft");
  equal("N+1 is the version after N", np1.version, n.version + 1);
  equal("N+1 records N as the version it replaces", np1.supersedes_version_id, n.id);
  equal("the write names that base", repriced.version.baseVersionId, n.id);

  const nOpen = pricesAfterReprice.filter((p) => p.article_version_id === n.id && p.effective_to === null);
  const np1Open = pricesAfterReprice.filter((p) => p.article_version_id === np1.id && p.effective_to === null);
  rows("N's open windows", nOpen);
  rows("N+1's open windows", np1Open);
  equal("N's price window is still OPEN", nOpen.length, 1);
  equal("N's window was not closed by the reprice", nOpen[0]?.effective_to, null);
  equal("N's window still holds the sellable price", Number(nOpen[0]?.amount), BASE_PRICE);
  equal("N+1 carries exactly one open window", np1Open.length, 1);
  equal("N+1's window holds the proposed price", Number(np1Open[0]?.amount), NEW_PRICE);
  equal("the sellable window is unchanged in count", nOpen.length, 1);

  equal("the article still points at N", articleAfterReprice?.current_version_id, n.id);
  equal("the article is still active — the dish is still on sale", articleAfterReprice?.status, "active");
  equal("the article's current version is still N", articleAfterReprice?.current_version, n.version);

  // -------------------------------------------------------------------------
  heading("A content write onto an article with an open draft is refused (validation.review.articleOpen)");
  say("The open draft was cloned from the sellable version, so editing the sellable version");
  say("here would leave the proposal carrying stale content. The refusal must change nothing.");
  // -------------------------------------------------------------------------
  const beforeOpenRefusal = {
    article: await articleRow(),
    versions: await versions(),
    prices: await prices(),
    tasks: await tasks(),
    audit: (await auditRows("mdm.article.update")).length,
  };
  await expectRefusal(
    "a content write refuses while a draft is open",
    "validation.review.articleOpen",
    () =>
      updateArticle(
        author,
        { ...input, name: "Draft-Rule Verification Mocktail (renamed)" },
        { source: "api", intent: "slab 3c-2 verification: content write onto an article with an open draft" }
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
  heading("Submitting the draft for review raises a real task against N+1");
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

  const openReviewTask = tasksAfterSubmit.filter((t) => t.status === "open");
  equal("exactly one review task is open", openReviewTask.length, 1);
  const reviewTask = openReviewTask[0]!;
  equal("the task names the open draft as its entity", reviewTask.entity_id, np1.id);
  equal("the task's entity is the version, not the article", reviewTask.entity_type, "article_version");
  equal("the task was raised by the author", reviewTask.raised_by_user_id, author.userId);
  equal("the task is assigned to the article approver role", reviewTask.assigned_role_code, "CENTRAL_MDM_HEAD");
  equal("the submission reports that task", submission.taskId, reviewTask.id);
  equal("N+1 is now under review", afterSubmit.find((v) => v.id === np1.id)?.status, "pending_review");
  equal("N is still active and sellable", afterSubmit.find((v) => v.id === n.id)?.status, "active");
  equal(
    "the article header did NOT follow the proposal into review",
    articleAfterSubmit?.status,
    "active"
  );
  equal("the article still points at N", articleAfterSubmit?.current_version_id, n.id);

  // -------------------------------------------------------------------------
  heading("A decision whose base has moved is refused (validation.review.baseMoved)");
  say("The check asserts that the version a proposal was cloned from is still the article's");
  say("current version. Its live trigger is a concurrent approval: two approvers deciding the");
  say("same proposal, where the first moves the pointer under the second. A sequential script");
  say("cannot reach that state — migration 0010 makes two open versions of one article");
  say("unrepresentable — so the condition is constructed here with ONE statement against ONE");
  say("scratch row (the proposal's predecessor link), and restored immediately after. Nothing");
  say("about the refusal itself is faked: the call, the transaction and the ledger are real.");
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
  say(`FIXTURE (scratch database): cleared supersedes_version_id on ${np1.id} (restored below)`);
  await expectRefusal(
    "approving a proposal whose base has moved is refused",
    "validation.review.baseMoved",
    () =>
      decideArticleReview(approver, { taskId: reviewTask.id, decision: "approve" }, {
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
  equal(
    "the task is still open",
    duringBaseMoved.tasks.filter((t) => t.status === "open").length,
    1
  );
  equal("the refusal wrote no audit row", duringBaseMoved.approvals, beforeBaseMoved.approvals);
  await withTransaction(async (tx) =>
    tx.query(`update article_version set supersedes_version_id = $2 where id = $1`, [np1.id, n.id])
  );
  say(`FIXTURE (scratch database): restored supersedes_version_id = ${n.id} on ${np1.id}`);
  equal("the fixture is restored", (await versions()).find((v) => v.id === np1.id)?.supersedes_version_id, n.id);

  // -------------------------------------------------------------------------
  heading("The second person's approval supersedes N in ONE transaction");
  // -------------------------------------------------------------------------
  const beforeApproval = await auditRows("mdm.article.approve");
  const decision = await decideArticleReview(approver, { taskId: reviewTask.id, decision: "approve" }, {
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

  equal("N+1 is active", afterApproval.find((v) => v.id === np1.id)?.status, "active");
  equal("N is superseded", afterApproval.find((v) => v.id === n.id)?.status, "superseded");
  equal("N+1 records who approved it", afterApproval.find((v) => v.id === np1.id)?.approved_by_user_id, approver.userId);
  const nClosed = pricesAfterApproval.filter((p) => p.article_version_id === n.id);
  const np1OpenAfter = pricesAfterApproval.filter(
    (p) => p.article_version_id === np1.id && p.effective_to === null
  );
  rows("N's windows after approval (closed, never deleted)", nClosed);
  equal("N's was closed, not deleted", nClosed.length, 1);
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
  equal("exactly one version is active", afterApproval.filter((v) => v.status === "active").length, 1);
  equal("exactly one open price window remains for the article", pricesAfterApproval.filter((p) => p.effective_to === null).length, 1);
  equal("the review task is decided", tasksAfterApproval.find((t) => t.id === reviewTask.id)?.status, "approved");
  equal("the decider is the second person", tasksAfterApproval.find((t) => t.id === reviewTask.id)?.decided_by_user_id, approver.userId);

  const approvalAudit = (await auditRows("mdm.article.approve")).filter((row) => row.entity_id === reviewTask.id);
  say("");
  say("The ledger row for this approval, read back from audit_log:");
  rows("audit row", approvalAudit);
  equal("exactly one audit row was written for this decision", approvalAudit.length, 1);
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
  heading("A dry run and a commit now say the same thing about the same file");
  say("planArticleWrite is what the import's dry run reads. With a draft open it used to call a");
  say("content row `updated` (the commit refuses it) and show the sellable price rather than the");
  say("draft's (the commit writes to the draft). Both are read back here.");
  // -------------------------------------------------------------------------
  const planContent = await planArticleWrite(q, author, chainId, {
    ...input,
    name: "Draft-Rule Verification Mocktail (renamed)",
  });
  rows("plan for a content change while a draft is open", {
    outcome: planContent.outcome,
    articleOpen: planContent.articleOpen,
    openVersion: planContent.openVersion,
    versionStatus: planContent.versionStatus,
    existingStatus: planContent.existingStatus,
  });
  check(
    "the plan says the row is refused for the same reason the commit refuses it",
    planContent.articleOpen && planContent.outcome !== "updated",
    `articleOpen=${String(planContent.articleOpen)} outcome=${planContent.outcome}`
  );

  const draftPrice = (await prices()).find((p) => p.article_version_id === np1.id)!;
  const planPrice = await planArticleWrite(q, author, chainId, {
    ...input,
    prices: [{ outletCode: OUTLET_CODE, amount: Number(draftPrice.amount), currencyCode: outlet.currency }],
  });
  rows("plan for the price the draft already carries", {
    outcome: planPrice.outcome,
    priceChanges: planPrice.priceChanges,
    priceUnchanged: planPrice.priceUnchanged,
    proposedPriceFrom: planPrice.proposedPriceFrom,
  });
  check(
    "a price the draft already carries reads as unchanged, not as a change against the sellable price",
    planPrice.priceUnchanged.includes(OUTLET_CODE) && planPrice.priceChanges.length === 0,
    `priceUnchanged=${JSON.stringify(planPrice.priceUnchanged)} priceChanges=${planPrice.priceChanges.length}`
  );

  const planPriceChange = await planArticleWrite(q, author, chainId, {
    ...input,
    prices: [{ outletCode: OUTLET_CODE, amount: Number(draftPrice.amount) + 10, currencyCode: outlet.currency }],
  });
  rows("plan for a price change against the open draft", planPriceChange.priceChanges);
  equal(
    "the plan compares against the draft's open window, which is what the commit will close",
    Number(planPriceChange.priceChanges[0]?.from?.amount),
    Number(draftPrice.amount)
  );
  equal(
    "the plan reports the sellable version and the open draft separately",
    `${planPriceChange.versionStatus}/${planPriceChange.openVersion ? "open" : "none"}`,
    "active/open"
  );

  // -------------------------------------------------------------------------
  heading("Result");
  // -------------------------------------------------------------------------
  say(`steps: ${step}`);
  say(`failures: ${failures.length}`);
  for (const failure of failures) say(`  FAILED  ${failure}`);
  say(failures.length === 0 ? "VERDICT: the draft-version rule behaves as designed." : "VERDICT: SEE FAILURES ABOVE.");
}

await main().catch((error: unknown) => {
  say("");
  say(`ABORTED: ${errorMessage(error)}`);
  failures.push(`aborted: ${errorMessage(error)}`);
});

await Bun.write("/home/team/shared/evidence/draft-version-verification.txt", lines.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
