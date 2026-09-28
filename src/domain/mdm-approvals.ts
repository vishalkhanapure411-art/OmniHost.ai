import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { auditedMutation, guard, primaryRoleCode, recordAudit, type MutationOutcome } from "~/server/audit";
import { NotFound, PermissionDenied, ValidationError } from "~/server/errors";
import { articleVersionComplianceGaps } from "~/domain/jurisdiction";
import { ARTICLE_APPROVER_ROLE, ARTICLE_VERSION_ENTITY, MDM_APPROVAL_CATEGORY, isArticleReviewReason } from "~/domain/approvals";
import type { ArticleReviewReasonCode, MdmReviewDecision } from "~/domain/approvals";
import type { MutationMeta } from "~/domain/mdm";
import type { Principal } from "~/server/session";

/**
 * The article review path — maker-checker for master data, wired end to end.
 *
 * The tables and the capability codes existed before this file; nothing wrote them. This
 * module is the writer, and it holds to four rules, each of which is a requirement rather
 * than a preference:
 *
 *   1. **A submission is a version, not an article.** `article_version.status` moves
 *      `draft → pending_review` and the `approval_task` names that version as its entity,
 *      so "what exactly was approved" has one answer even once a second version exists.
 *   2. **The decision and its ledger row commit together.** The version's new status, the
 *      task's decision and the audit row are written inside one `auditedMutation`
 *      transaction — there is no window where a version is `active` and no ledger row
 *      says who approved it.
 *   3. **Four eyes.** The person who raised a task can never decide it. That refusal is a
 *      `denied` audit row carrying the seeded reason code `mdm.approve.self`, and it
 *      changes no state: not the version, not the task.
 *   4. **A pending version is not sellable.** Nothing here resolves a price from anything
 *      but `article.current_version_id`, and a version only becomes `active` through a
 *      decision. `mdm_approval_gated` decides whether a *new* record lands
 *      `pending_review` on its own; submitting an existing draft is an explicit act
 *      either way, so the review path works on a chain where that flag is off.
 *
 * Deliberately absent, and flagged rather than half-built:
 *   * approval thresholds — the PRD sets none for master data (the seeded
 *     `*.approve.threshold` codes belong to the financial functions that will need them);
 *   * **content** drafts (editing an active version's name or ingredients → N+1). The
 *     clone primitive this file now carries makes that cheap on the day it is wanted, but
 *     a content write path needs a form, a submission and a diff worth reviewing first;
 *   * delegation / out-of-office, and the same path for vendor, raw material and tax class.
 *
 * It also owns the version *transitions* the draft-version rule needs — cloning N into N+1
 * and superseding N when N+1 is approved — because those are the state changes this path
 * decides. `~/domain/mdm` calls them through the import edge that already exists
 * (`mdm` → `mdm-approvals`), so this module still imports nothing from `mdm` at runtime.
 */

/**
 * A coded validation refusal, identical in shape to `~/domain/mdm`'s `invalid()`.
 *
 * Repeated here rather than imported because of the import direction: `~/domain/mdm`
 * imports this module (to raise a review task when a create lands `pending_review`), so
 * this module may import **types** from it and nothing at runtime. Two copies of a
 * three-line error constructor is a smaller cost than a runtime import cycle.
 */
function coded(code: string, column: string, params: Record<string, string | number> = {}): ValidationError {
  return new ValidationError(`${code}:${column}`, { code, column, params });
}

/**
 * The message-catalog key the four-eyes refusal is rendered by.
 *
 * A constant rather than a literal in two places, and under the `permission.` prefix by
 * convention: a *policy* refusal — the platform doing exactly what it promises — is rendered
 * as a sentence in a neutral tone, while a validation or capability refusal keeps the error
 * tone. The screen applies that rule by prefix, and this is the refusal it exists for.
 */
export const SELF_APPROVAL_REFUSAL_CODE = "permission.mdm.approve.self";

/** The caller's chain. Every task in this path, and every check, is chain-scoped. */
function resolveChainId(principal: Principal): string {
  if (!principal.chainId) {
    throw new ValidationError("a chain context is required (chainId)");
  }
  return principal.chainId;
}

export interface ArticleReviewTaskInput {
  chainId: string;
  principal: Principal;
  code: string;
  articleId: string;
  versionId: string;
  version: number;
  note?: string | null;
}

/**
 * Inserts the open review task for one version, in the caller's own transaction.
 *
 * Shared by the two ways a version reaches review: an author submitting an existing
 * draft, and a *create* on an approval-gated chain landing straight in `pending_review`
 * (§6). One insert, one routing rule, one assignee role — a second copy of this SQL is
 * how a queue ends up with items nobody is assigned to.
 *
 * The task's title is the record's own name from the database, never a sentence composed
 * here: a title assembled in the domain layer would be an untranslatable string the
 * moment the interface is not English. The screen adds its own labels from the catalog.
 */
export async function raiseArticleReviewTask(tx: Queryable, input: ArticleReviewTaskInput): Promise<string> {
  const names = await tx.query<{ name: string }>(
    `select name from article_version_text where article_version_id = $1 order by locale limit 1`,
    [input.versionId]
  );
  const tasks = await tx.query<{ id: string }>(
    `insert into approval_task (chain_id, site_id, category, title, summary, entity_type, entity_id,
                                payload, raised_by_user_id, raised_by_role_code, assigned_role_code, status)
     values ($1, null, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'open')
     returning id`,
    [
      input.chainId,
      MDM_APPROVAL_CATEGORY,
      names[0]?.name ?? input.code,
      input.note?.trim() || null,
      ARTICLE_VERSION_ENTITY,
      input.versionId,
      JSON.stringify({
        code: input.code,
        articleId: input.articleId,
        version: input.version,
        versionId: input.versionId,
        note: input.note?.trim() || null,
      }),
      input.principal.userId,
      primaryRoleCode(input.principal, "mdm.article.propose"),
      ARTICLE_APPROVER_ROLE,
    ]
  );
  const taskId = tasks[0]?.id;
  if (!taskId) throw new ValidationError("approval_task insert returned no id");
  return taskId;
}

// ---------------------------------------------------------------------------
// The version transitions — the draft-version rule (slab 3c-2)
// ---------------------------------------------------------------------------

/**
 * An article's *open* version: the one nobody has decided yet.
 *
 * `draft` and `pending_review` are the two states a version can be in while a decision
 * is still ahead of it; every other state is settled. Migration 0010 makes two open
 * versions of one article unrepresentable, so this reads at most one row — and it reads
 * it without touching `article.current_version_id`, which stays pointed at whatever
 * version is sellable right now.
 */
export interface OpenArticleVersion {
  id: string;
  version: number;
  status: string;
}

export async function openArticleVersion(
  tx: Queryable,
  articleId: string
): Promise<OpenArticleVersion | null> {
  const rows = await tx.query<OpenArticleVersion>(
    `select id, version, status
       from article_version
      where article_id = $1 and status in ('draft', 'pending_review')
      order by version desc
      limit 1`,
    [articleId]
  );
  return rows[0] ?? null;
}

/**
 * The same question, asked with the row locked.
 *
 * A write that is about to change or supersede the open version has to know that the
 * version it read is still the open one when it writes: without `for update` a submit and
 * a price change racing on the same draft would both read `draft` and both proceed. The
 * read path uses the unlocked one deliberately — a screen reading a record has no reason
 * to take a row lock.
 */
export async function openArticleVersionLocked(
  tx: Queryable,
  articleId: string
): Promise<OpenArticleVersion | null> {
  const rows = await tx.query<OpenArticleVersion>(
    `select id, version, status
       from article_version
      where article_id = $1 and status in ('draft', 'pending_review')
      order by version desc
      limit 1
      for update`,
    [articleId]
  );
  return rows[0] ?? null;
}

export interface ClonedArticleVersion {
  id: string;
  version: number;
  /**
   * Every open price window the clone carries.
   *
   * `article_price.article_version_id` is `not null` (`0008_mdm_masters.sql`), so a price
   * row cannot exist without a version and the grid is per version: a new version that
   * copied only the changed outlet would drop every other outlet's sellable price the
   * moment it was approved. Every open row is therefore carried forward, unchanged.
   */
  prices: { outletCode: string; amount: number; currencyCode: string; effectiveFrom: string }[];
}

/**
 * Opens version N+1 as a `draft` by cloning N — the primitive a price change uses (§7.2
 * item 5), and the same one a rollback will use later (approving a clone of an earlier
 * version).
 *
 * What is copied, and why not less:
 *   * **the version row** minus its lifecycle: status `draft`, no approval, and
 *     `supersedes_version_id` pointing at N. Only the identity (`article`) is not
 *     versioned (§7.3), so everything else carries forward or the draft renders blank;
 *   * **the per-locale content** — the name is what the queue row and the compliance gate
 *     read, so a clone without it is a proposal with no name;
 *   * **allergens and nutrients** — the approve-time compliance gate counts rows in both
 *     tables, so a clone that dropped them could never be approved;
 *   * **the per-jurisdiction grid** — nothing reads it today, which is exactly why
 *     forgetting it would go unnoticed (migration 0010's sibling note);
 *   * **every open price row** — see `prices` above.
 *
 * N is left exactly as it is: still `active`, still what `article.current_version_id`
 * points at, still what every price read in this codebase resolves. That is what makes the
 * draft invisible to billing without a single new enforcement.
 */
export async function cloneArticleVersion(
  tx: Queryable,
  input: {
    chainId: string;
    articleId: string;
    fromVersionId: string;
    principalId: string;
    /** The selling date the new version claims — the price change's effective date. */
    effectiveFrom?: string | null;
  }
): Promise<ClonedArticleVersion> {
  const inserted = await tx.query<{ id: string; version: number }>(
    `insert into article_version (
        chain_id, article_id, version, status, dietary_mark, tax_class_id, hsn_sac_code,
        serving_size_qty, serving_size_uom_id, calories_kcal, channel_flags,
        recipe_id, recipe_version_pin, effective_from, supersedes_version_id, created_by_user_id
     )
     select v.chain_id, v.article_id,
            (select coalesce(max(version), 0) + 1 from article_version where article_id = v.article_id),
            'draft', v.dietary_mark, v.tax_class_id, v.hsn_sac_code,
            v.serving_size_qty, v.serving_size_uom_id, v.calories_kcal, v.channel_flags,
            v.recipe_id, v.recipe_version_pin, $3::date, v.id, $4::uuid
       from article_version v
      where v.id = $1 and v.chain_id = $2 and v.article_id = $5
     returning id, version`,
    [
      input.fromVersionId,
      input.chainId,
      input.effectiveFrom?.trim() || null,
      input.principalId,
      input.articleId,
    ]
  );
  const clone = inserted[0];
  if (!clone) throw new NotFound("Article version", input.fromVersionId);

  await tx.query(
    `insert into article_version_text (chain_id, article_version_id, locale, name, short_name,
                                       description, ingredient_declaration)
     select chain_id, $2, locale, name, short_name, description, ingredient_declaration
       from article_version_text where article_version_id = $1`,
    [input.fromVersionId, clone.id]
  );
  await tx.query(
    `insert into article_version_allergen (chain_id, article_version_id, allergen_id, may_contain,
                                           source, derived_from_raw_material_id)
     select chain_id, $2, allergen_id, may_contain, source, derived_from_raw_material_id
       from article_version_allergen where article_version_id = $1`,
    [input.fromVersionId, clone.id]
  );
  await tx.query(
    `insert into article_version_nutrient (chain_id, article_version_id, nutrient_id, value, basis)
     select chain_id, $2, nutrient_id, value, basis
       from article_version_nutrient where article_version_id = $1`,
    [input.fromVersionId, clone.id]
  );
  await tx.query(
    `insert into article_version_jurisdiction (chain_id, article_version_id, jurisdiction_code,
                                               tax_class_id, hsn_sac_code, calories_kcal,
                                               serving_size_qty, serving_size_uom_id,
                                               nutrition_basis, overrides)
     select chain_id, $2, jurisdiction_code, tax_class_id, hsn_sac_code, calories_kcal,
            serving_size_qty, serving_size_uom_id, nutrition_basis, overrides
       from article_version_jurisdiction where article_version_id = $1`,
    [input.fromVersionId, clone.id]
  );
  // The grid: every open window, amount and currency copied verbatim. A currency is never
  // re-derived here — §7.1 says money is an amount plus the ISO code it was sold in, and a
  // clone that recomputed one from the site would change a figure nobody asked to change.
  const prices = await tx.query<{
    outlet_code: string;
    amount: string;
    currency_code: string;
    effective_from: string;
  }>(
    `insert into article_price (chain_id, article_id, article_version_id, outlet_id, amount,
                                currency_code, effective_from, created_by_user_id)
     select p.chain_id, p.article_id, $2, p.outlet_id, p.amount,
            p.currency_code, p.effective_from, $3
       from article_price p
      where p.article_version_id = $1 and p.effective_to is null
     returning outlet_id, amount, currency_code, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
               (select o.code from outlet o where o.id = outlet_id) as outlet_code`,
    [input.fromVersionId, clone.id, input.principalId]
  );

  return {
    id: clone.id,
    version: clone.version,
    prices: prices.map((price) => ({
      outletCode: price.outlet_code,
      amount: Number(price.amount),
      currencyCode: price.currency_code,
      effectiveFrom: price.effective_from,
    })),
  };
}

export interface SupersededVersion {
  /** The version that was sellable and is now history. */
  baseVersionId: string;
  baseVersion: number;
  /** The version that just became sellable. */
  activeVersionId: string;
  activeVersion: number;
  /** The windows that closed, with the date each one closed on. */
  closedPrices: { outletCode: string; effectiveTo: string }[];
}

/**
 * Approves a proposal by superseding the version it replaces — one transaction, four
 * writes, no window in which the platform has two sellable versions or none.
 *
 * The order matters and is the reason this is one function rather than four statements at
 * each call site: the grid is checked *before* anything is written (a proposal that prices
 * fewer outlets than the version it replaces would silently unprice a dish the moment it
 * went live), the base's open windows are closed rather than deleted (a closed window is
 * how a historical bill stays reproducible), and the article's pointer moves last.
 *
 * Called from two places, which is why it takes the version ids rather than looking them
 * up: the approval branch of `decideArticleReview`, and the price-change path on a chain
 * where approval is not gated and the caller may approve (a one-person Silver chain has to
 * be able to reprice at all).
 */
export async function supersedeArticleVersion(
  tx: Queryable,
  input: {
    chainId: string;
    articleId: string;
    /** N+1, the version becoming sellable. */
    versionId: string;
    /** N, the version it was cloned from and replaces. */
    baseVersionId: string;
    principalId: string;
  }
): Promise<SupersededVersion> {
  const versions = await tx.query<{ id: string; version: number; status: string }>(
    `select id, version, status from article_version
      where id = any($1::uuid[]) and chain_id = $2
      order by version`,
    [[input.versionId, input.baseVersionId], input.chainId]
  );
  const next = versions.find((version) => version.id === input.versionId);
  const base = versions.find((version) => version.id === input.baseVersionId);
  if (!next || !base) throw new NotFound("Article version", input.versionId);

  // The grid assertion (§3): every outlet the outgoing version sold at must still be
  // priced on the incoming one. `article_price` has no constraint that would catch this —
  // it forbids two open rows for the *same* (version, outlet) and says nothing across
  // versions — so it is asserted here, by name, rather than squared away with the claim
  // that the database enforces it.
  const unpriced = await tx.query<{ outlet_code: string }>(
    `select o.code as outlet_code
       from article_price p
       join outlet o on o.id = p.outlet_id
      where p.article_version_id = $1 and p.effective_to is null
        and not exists (
          select 1 from article_price q
           where q.article_version_id = $2 and q.outlet_id = p.outlet_id and q.effective_to is null)
      order by o.code`,
    [input.baseVersionId, input.versionId]
  );
  const firstUnpriced = unpriced[0];
  if (firstUnpriced) {
    throw coded("validation.version.priceMissing", "outlet", {
      outlet: firstUnpriced.outlet_code,
      outlets: unpriced.map((row) => row.outlet_code).join(", "),
      version: next.version,
    });
  }

  // Close N's open windows the day before N+1's price for that outlet opens — the same
  // expression the in-version price change uses, applied once per outlet because each
  // outlet's new window can start on a different day. Never a delete.
  const closed = await tx.query<{ outlet_code: string; effective_to: string }>(
    `with closeable as (
       select p.id, q.effective_from as new_from, o.code as outlet_code
         from article_price p
         join article_price q
           on q.article_version_id = $2 and q.outlet_id = p.outlet_id and q.effective_to is null
         join outlet o on o.id = p.outlet_id
        where p.article_version_id = $1 and p.effective_to is null
     )
     update article_price a
        set effective_to = greatest(c.new_from - 1, a.effective_from)
       from closeable c
      where a.id = c.id
     returning c.outlet_code, to_char(a.effective_to, 'YYYY-MM-DD') as effective_to`,
    [input.baseVersionId, input.versionId]
  );

  await tx.query(
    `update article_version
        set status = 'superseded', updated_at = now()
      where id = $1`,
    [input.baseVersionId]
  );
  await tx.query(
    `update article_version
        set status = 'active', approved_at = now(), approved_by_user_id = $2::uuid, updated_at = now()
      where id = $1`,
    [input.versionId, input.principalId]
  );
  // The pointer moves last, inside the same transaction: until this statement there is a
  // version approved and unreachable, and the transaction makes that invisible.
  await tx.query(
    `update article set current_version_id = $2, status = 'active', updated_at = now() where id = $1`,
    [input.articleId, input.versionId]
  );

  return {
    baseVersionId: base.id,
    baseVersion: base.version,
    activeVersionId: next.id,
    activeVersion: next.version,
    closedPrices: closed.map((row) => ({
      outletCode: row.outlet_code,
      effectiveTo: row.effective_to,
    })),
  };
}

export interface ArticleReviewSubmission {
  taskId: string;
  versionId: string;
  code: string;
  version: number;
  status: "pending_review";
}

/**
 * Moves the article's **open draft** to `pending_review` and raises the review task in the
 * same transaction as its audit row.
 *
 * The target is the open draft, not `article.current_version_id` (slab 3c-2). With the
 * draft-version rule in place a proposal (N+1) is a version the article's pointer
 * deliberately does *not* follow — N stays sellable while N+1 waits — so asking the
 * pointer for the version to submit would submit the sellable one and leave the proposal
 * as a draft forever. Same distinction `decideArticleReview` already draws when it decides
 * whether the article header should mirror the version.
 *
 * The article header follows the version into review **only when that version is the
 * article's current one**, which is the case for a first version and not for a proposal:
 * a proposal that set the header to `pending_review` would say the dish is not on sale
 * while guests can still order it.
 *
 * Guarded on `mdm.article.propose` — the capability the authoring path already uses and
 * the one the demo Culinary Team actually holds, so the four-eyes demo runs on real
 * grants rather than on a code invented for it.
 */
export async function submitArticleForReview(
  principal: Principal,
  input: { code: string; note?: string | null },
  meta: MutationMeta = {}
): Promise<ArticleReviewSubmission> {
  const code = input.code?.trim();
  if (!code) throw coded("validation.required", "code", { field: "code" });
  const note = input.note?.trim() || null;
  const chainId = resolveChainId(principal);

  await guard({
    principal,
    action: "mdm.article.propose",
    entityType: ARTICLE_VERSION_ENTITY,
    chainId,
    target: `article ${code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const run = async (tx: Queryable): Promise<MutationOutcome> => {
    const articles = await tx.query<{ id: string; current_version_id: string | null; status: string }>(
      `select id, current_version_id, status from article
        where chain_id = $1 and code = $2
        for update`,
      [chainId, code]
    );
    const article = articles[0];
    if (!article) throw new NotFound("Article", code);

    // The version to submit is the article's *open* draft — not its current version. A
    // price change opens N+1 while N stays sellable, and after a send-back that draft is
    // exactly what has to go back to the approver.
    const open = await openArticleVersionLocked(tx, article.id);
    if (!open) {
      throw coded("validation.review.notDraft", "version", { code });
    }
    if (open.status !== "draft") {
      throw coded("validation.review.notDraft", "status", { status: open.status });
    }

    const existing = await tx.query<{ id: string }>(
      `select id from approval_task
        where chain_id = $1 and entity_type = $2 and entity_id = $3 and status = 'open'`,
      [chainId, ARTICLE_VERSION_ENTITY, open.id]
    );
    if (existing[0]) {
      throw coded("validation.review.alreadyOpen", "task", { taskId: existing[0].id });
    }

    const taskId = await raiseArticleReviewTask(tx, {
      chainId,
      principal,
      code,
      articleId: article.id,
      versionId: open.id,
      version: open.version,
      note,
    });

    await tx.query(
      `update article_version set status = 'pending_review', updated_at = now() where id = $1`,
      [open.id]
    );
    // The article header follows its version into review **only when that version is the
    // article's current one** — a list row and the record badge must not claim the dish is
    // off sale while a guest can still order it. A proposal leaves the header alone.
    if (article.current_version_id === open.id) {
      await tx.query(`update article set status = 'pending_review', updated_at = now() where id = $1`, [
        article.id,
      ]);
    }

    return {
      entityId: open.id,
      before: { versionStatus: open.status, articleStatus: article.status },
      after: {
        versionStatus: "pending_review",
        articleStatus: article.current_version_id === open.id ? "pending_review" : article.status,
        taskId,
        assignedRoleCode: ARTICLE_APPROVER_ROLE,
        version: open.version,
        code,
      },
    };
  };

  const outcome = await auditedMutation({
    principal,
    action: "mdm.article.propose",
    entityType: ARTICLE_VERSION_ENTITY,
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run,
  });
  const after = (outcome.after ?? {}) as { taskId?: string; version?: number };
  return {
    taskId: after.taskId ?? "",
    versionId: outcome.entityId ?? "",
    code,
    version: after.version ?? 0,
    status: "pending_review",
  };
}

export interface ArticleReviewDecisionResult {
  taskId: string;
  /** The article's code, so the screen's confirmation can name the record it changed. */
  code: string;
  decision: MdmReviewDecision;
  versionStatus: "active" | "draft";
  reasonCode: ArticleReviewReasonCode | null;
}

/**
 * Approves a pending version or sends it back.
 *
 * One function rather than two: the decisions share everything except the state they
 * write, and a single entry point is what lets the four-eyes refusal stand *before*
 * either branch, so neither can be reached without it.
 */
export async function decideArticleReview(
  principal: Principal,
  input: {
    taskId: string;
    decision: MdmReviewDecision;
    reasonCode?: string | null;
    note?: string | null;
  },
  meta: MutationMeta = {}
): Promise<ArticleReviewDecisionResult> {
  const taskId = input.taskId?.trim();
  if (!taskId) throw coded("validation.required", "taskId", { field: "taskId" });
  const decision = input.decision;
  if (decision !== "approve" && decision !== "sendBack") {
    throw coded("validation.review.unknownDecision", "decision", { decision: String(decision) });
  }
  const note = input.note?.trim() || null;
  const reasonCode = input.reasonCode ?? null;
  if (decision === "sendBack" && !isArticleReviewReason(reasonCode)) {
    // A send-back rejects someone's work: it carries a code — and, optionally, the
    // reviewer's own words — or it does not happen.
    throw coded("validation.review.reasonRequired", "reasonCode", {});
  }
  const chainId = resolveChainId(principal);

  await guard({
    principal,
    action: "mdm.article.approve",
    entityType: "approval_task",
    chainId,
    target: `approval task ${taskId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  // A read before the transaction, only so a refusal carries a good message (and so the
  // self-approval check can run before anything is locked or written).
  const tasks = await poolQueryable().query<{
    id: string;
    status: string;
    raised_by_user_id: string;
  }>(
    `select id, status, raised_by_user_id from approval_task
      where id = $1 and chain_id = $2 and entity_type = $3`,
    [taskId, chainId, ARTICLE_VERSION_ENTITY]
  );
  const task = tasks[0];
  if (!task) throw new NotFound("Approval task", taskId);
  if (task.status !== "open") {
    throw coded("validation.review.alreadyDecided", "status", { status: task.status });
  }

  // The four-eyes rule. Refused *before* any write, and recorded as a denial with the
  // seeded reason code — written through the same helper `guard()` uses, so an auditor
  // reads a self-approval attempt in the same place as any other refusal.
  if (task.raised_by_user_id === principal.userId) {
    await recordAudit({
      principal,
      action: "mdm.article.approve",
      entityType: "approval_task",
      entityId: taskId,
      chainId,
      outcome: "denied",
      reason: "mdm.approve.self",
      intent: meta.intent ?? "self-approval attempt",
      source: meta.source ?? "api",
    });
    // The ledger keeps the code, the operator gets the sentence: `reason` stays the seeded
    // `mdm.approve.self` (in the audit row above and in this error's own details), while
    // `code` is a message-catalog key so the screen can render a sentence that explains the
    // four-eyes rule instead of printing the machine code at the person.
    throw new PermissionDenied("mdm.article.approve", "mdm.approve.self", {
      code: SELF_APPROVAL_REFUSAL_CODE,
      reasonCode: "mdm.approve.self",
      taskId,
    });
  }

  const run = async (tx: Queryable): Promise<MutationOutcome> => {
    const rows = await tx.query<{
      id: string;
      status: string;
      raised_by_user_id: string;
      version_id: string;
      version_status: string;
      version: number;
      supersedes_version_id: string | null;
      article_id: string;
      article_code: string;
      article_status: string;
      current_version_id: string | null;
    }>(
      `select t.id, t.status, t.raised_by_user_id, v.id as version_id, v.status as version_status,
              v.version, v.supersedes_version_id,
              a.id as article_id, a.code as article_code, a.status as article_status,
              a.current_version_id
         from approval_task t
         join article_version v on v.id = t.entity_id::uuid
         join article a on a.id = v.article_id
        where t.id = $1 and t.chain_id = $2
        for update of t, v, a`,
      [taskId, chainId]
    );
    const row = rows[0];
    if (!row) throw new NotFound("Approval task", taskId);
    // Re-checked inside the transaction: the read above produces a better message, this
    // one is the check that cannot be raced.
    if (row.raised_by_user_id === principal.userId) {
      throw new PermissionDenied("mdm.article.approve", "mdm.approve.self", {
        code: SELF_APPROVAL_REFUSAL_CODE,
        reasonCode: "mdm.approve.self",
      });
    }
    if (row.status !== "open") {
      throw coded("validation.review.alreadyDecided", "status", { status: row.status });
    }
    if (row.version_status !== "pending_review") {
      throw coded("validation.review.notPending", "status", { status: row.version_status });
    }

    const approve = decision === "approve";
    if (approve) {
      // §15, and the review finding that this branch never asked: the create door refuses a
      // record missing a field its market requires, and an approval must not be the other door
      // into `active`. Evaluated here — inside the same transaction as the status write, and
      // against the *stored* version rather than whatever the approver's screen last showed,
      // which is the only version of the answer that cannot be stale.
      //
      // `article_version.compliance_override` exists for §14's case (a record that became
      // incomplete after a profile change) but nothing writes it yet, so an override would need
      // a reasoned writer of its own. Passing silently here because the column exists would be
      // the same defect this check closes.
      const gaps = await articleVersionComplianceGaps(tx, chainId, row.version_id);
      const first = gaps[0];
      if (first) {
        // The refusal names one field and the market it is required in; the review read hands
        // the approver the whole list before they decide, so nothing is discovered afterwards.
        throw coded("validation.review.jurisdictionIncomplete", "status", {
          field: first.field,
          jurisdiction: first.jurisdiction,
          // The profile the requirement is written on, so the sentence can name the market in
          // words (`IN` → "India") instead of handing the reader a code to decode — and so it
          // keeps saying which *law* it is: an `IN-KA` site inherits `IN`'s article profile.
          declaredFor: first.declaredFor,
        });
      }
    }

    // The article's pointer tells the two shapes apart, and they are genuinely different
    // transactions (slab 3c-2):
    //
    //   * `current_version_id === version_id` — the version under review *is* the article's
    //     version (a first version, or a draft edited in place). There is nothing to
    //     supersede, so approving activates it in place, exactly as before.
    //   * otherwise — the version under review is a **proposal** (N+1) that a price change
    //     opened while N stayed sellable. Approving it supersedes N: N+1 becomes `active`,
    //     N becomes `superseded`, the article's pointer moves and N's open price windows
    //     close, all in this one transaction. The reader who approved and the guest who
    //     orders next see the same change or neither.
    const isProposal = row.current_version_id !== row.version_id;
    let superseded: SupersededVersion | null = null;
    if (approve && isProposal) {
      // A discontinued article is not a price change away from being on sale again (§3).
      if (row.article_status === "discontinued") {
        throw coded("validation.review.articleClosed", "status", { status: row.article_status });
      }
      // The base must still be the version this proposal was cloned from. If the article's
      // pointer has moved — another proposal was approved in the meantime — approving this
      // one would overwrite a version nobody reviewed it against.
      if (row.supersedes_version_id === null || row.supersedes_version_id !== row.current_version_id) {
        throw coded("validation.review.baseMoved", "version", {
          version: row.version,
          code: row.article_code,
        });
      }
      superseded = await supersedeArticleVersion(tx, {
        chainId,
        articleId: row.article_id,
        versionId: row.version_id,
        baseVersionId: row.supersedes_version_id,
        principalId: principal.userId,
      });
    } else {
      await tx.query(
        `update article_version
            set status = $2,
                approved_at = case when $2 = 'active' then now() else approved_at end,
                approved_by_user_id = case when $2 = 'active' then $3::uuid else approved_by_user_id end,
                updated_at = now()
          where id = $1`,
        [row.version_id, approve ? "active" : "draft", principal.userId]
      );
      // The article header mirrors the version *only* when that version is the article's
      // current one. A proposal keeps the header pointed at the sellable N — that is the
      // draft-version rule, and it is what stops a list row from saying "pending review"
      // about a dish that is still on sale.
      if (!isProposal) {
        await tx.query(`update article set status = $2, updated_at = now() where id = $1`, [
          row.article_id,
          approve ? "active" : "draft",
        ]);
      }
    }
    await tx.query(
      `update approval_task
          set status = $2,
              -- A send-back is the *author's* work again, and the queue routes by assignment:
              -- a task left assigned to the approver's role would never appear to the person
              -- who has to fix it. So the send-back re-routes the task to whoever raised it,
              -- in this same transaction as the decision. An approval has no return path —
              -- nothing is left for the author to do beyond reading the article, whose status
              -- this transaction has already moved — so it keeps its assignment untouched.
              assigned_user_id = case when $2 = 'rejected' then raised_by_user_id else assigned_user_id end,
              decided_by_user_id = $3,
              decided_at = now(),
              decision_note = $4,
              payload = payload || $5::jsonb,
              updated_at = now()
        where id = $1`,
      [
        taskId,
        approve ? "approved" : "rejected",
        principal.userId,
        note ?? reasonCode,
        JSON.stringify({
          decision: {
            outcome: approve ? "approved" : "rejected",
            reasonCode,
            note,
            versionStatus: approve ? "active" : "draft",
            decidedByUserId: principal.userId,
            /** Where the task was routed as part of the decision. `null` for an approval. */
            reroutedToUserId: approve ? null : row.raised_by_user_id,
          },
        }),
      ]
    );

    return {
      entityId: taskId,
      before: {
        versionStatus: row.version_status,
        taskStatus: row.status,
        articleCode: row.article_code,
        // A versioned change audits the *version*, not the row (§7.3): approving a proposal
        // moves the article from N to N+1, so the ledger carries both ids and "which
        // version was live when this was approved" is answerable without arithmetic.
        versionId: superseded ? superseded.baseVersionId : row.version_id,
        version: superseded ? superseded.baseVersion : row.version,
        currentVersionId: row.current_version_id,
      },
      after: {
        versionStatus: approve ? "active" : "draft",
        taskStatus: approve ? "approved" : "rejected",
        versionId: row.version_id,
        version: row.version,
        decision,
        reasonCode,
        note,
        // Read back by the caller's confirmation, and written into the audit row: "who has
        // this now" is the fact a send-back turns on.
        returnedToUserId: approve ? null : row.raised_by_user_id,
        // Non-null only when an approval superseded the version that was on sale. The
        // windows it closed travel with it, because "the price changed" is not the fact an
        // auditor asks about — "from when, and to what" is.
        supersededVersionId: superseded?.baseVersionId ?? null,
        supersededVersion: superseded?.baseVersion ?? null,
        closedPrices: superseded?.closedPrices ?? null,
      },
      // A send-back's reason is the audit row's `reason` as well as the task's, so the
      // audit trail answers "why was this refused" without a join.
      reason: !approve && reasonCode ? reasonCode : undefined,
    };
  };

  const outcome = await auditedMutation({
    principal,
    action: "mdm.article.approve",
    entityType: "approval_task",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run,
  });
  const after = (outcome.after ?? {}) as {
    versionStatus?: "active" | "draft";
    articleCode?: string;
  };
  return {
    taskId,
    code: after.articleCode ?? "",
    decision,
    versionStatus: after.versionStatus ?? (decision === "approve" ? "active" : "draft"),
    reasonCode: isArticleReviewReason(reasonCode) && decision === "sendBack" ? reasonCode : null,
  };
}

export interface ArticleVersionReview {
  taskId: string | null;
  taskStatus: string | null;
  versionId: string;
  articleId: string;
  code: string;
  articleStatus: string;
  version: number;
  versionStatus: string;
  isCurrent: boolean;
  name: string | null;
  nameLocale: string | null;
  shortName: string | null;
  dietaryMark: string | null;
  taxClassCode: string | null;
  hsnSacCode: string | null;
  servingSizeQty: number | null;
  servingSizeUomCode: string | null;
  caloriesKcal: number | null;
  channelFlags: string[];
  effectiveFrom: string | null;
  submittedAt: string | null;
  raisedBy: string | null;
  raisedByRole: string | null;
  prices: { outletCode: string; amount: number; currencyCode: string }[];
  allergens: { code: string; mayContain: boolean }[];
  /**
   * The fields this version's chain's markets require and the version does not carry.
   *
   * Non-empty means an approval will be refused — so an approver reads what they are being
   * asked to waive *before* they click, not after. Read from the stored version by the same
   * function the approve branch refuses on, so the two cannot disagree.
   */
  complianceGaps: { field: string; jurisdiction: string; declaredFor: string }[];
}

/**
 * The minimum read that makes a pending version reviewable.
 *
 * Every other read in this codebase joins `article.current_version_id`, which is
 * deliberate and stays: it is what stops a draft or pending version from ever resolving
 * as the price a bill is computed from. The consequence — an approver could not read the
 * version they were being asked to approve — is what this function exists to remove. It
 * reads the version by its own id, returns content only, and resolves no price that
 * anything else uses.
 *
 * A full before/after diff does not exist and is deliberately not in this slab; the
 * designer's note on this surface shapes the next one.
 */
export async function getArticleVersionReview(
  principal: Principal,
  input: { taskId?: string | null; versionId?: string | null }
): Promise<ArticleVersionReview> {
  const chainId = resolveChainId(principal);
  const taskId = input.taskId?.trim() || null;
  const versionId = input.versionId?.trim() || null;
  if (!taskId && !versionId) {
    throw coded("validation.required", "versionId", { field: "versionId" });
  }

  await guard({
    principal,
    action: "mdm.article.view",
    entityType: ARTICLE_VERSION_ENTITY,
    chainId,
    target: taskId ? `approval task ${taskId}` : `article version ${versionId}`,
  });

  const rows = await poolQueryable().query<{
    task_id: string | null;
    task_status: string | null;
    version_id: string;
    article_id: string;
    code: string;
    article_status: string;
    version: number;
    version_status: string;
    current_version_id: string | null;
    name: string | null;
    name_locale: string | null;
    short_name: string | null;
    dietary_mark: string | null;
    tax_class_code: string | null;
    hsn_sac_code: string | null;
    serving_size_qty: string | null;
    serving_size_uom_code: string | null;
    calories_kcal: string | null;
    channel_flags: string[];
    effective_from: Date | null;
    submitted_at: Date | null;
    raised_by: string | null;
    raised_by_role: string | null;
  }>(
    `select t.id as task_id, t.status as task_status, t.created_at as submitted_at,
            t.raised_by_role_code as raised_by_role, u.display_name as raised_by,
            v.id as version_id, v.version, v.status as version_status, v.dietary_mark,
            v.hsn_sac_code, v.serving_size_qty, v.calories_kcal, v.channel_flags, v.effective_from,
            a.id as article_id, a.code, a.status as article_status, a.current_version_id,
            tc.code as tax_class_code, uom.code as serving_size_uom_code,
            txt.name, txt.locale as name_locale, txt.short_name
       from article_version v
       join article a on a.id = v.article_id
       left join approval_task t
              on t.entity_type = $3 and t.entity_id = v.id::text and t.status = 'open'
       left join "user" u on u.id = t.raised_by_user_id
       left join tax_class tc on tc.id = v.tax_class_id
       left join uom on uom.id = v.serving_size_uom_id
       left join article_version_text txt on txt.article_version_id = v.id
      where v.chain_id = $1
        and (($2::uuid is not null and v.id = $2::uuid)
             or ($4::uuid is not null and t.id = $4::uuid))
      order by (t.id is not null) desc, txt.locale
      limit 1`,
    [chainId, versionId, ARTICLE_VERSION_ENTITY, taskId]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Article version", versionId ?? taskId ?? "");

  const [outlets, allergens, gaps] = await Promise.all([
    poolQueryable().query<{ outlet_code: string; amount: string; currency_code: string }>(
      `select o.code as outlet_code, p.amount, p.currency_code
         from article_price p
         join outlet o on o.id = p.outlet_id
        where p.article_version_id = $1 and p.effective_to is null
        order by o.code`,
      [row.version_id]
    ),
    poolQueryable().query<{ code: string; may_contain: boolean }>(
      `select al.code, va.may_contain
         from article_version_allergen va
         join allergen al on al.id = va.allergen_id
        where va.article_version_id = $1
        order by al.code`,
      [row.version_id]
    ),
    articleVersionComplianceGaps(poolQueryable(), chainId, row.version_id),
  ]);

  return {
    taskId: row.task_id,
    taskStatus: row.task_status,
    versionId: row.version_id,
    articleId: row.article_id,
    code: row.code,
    articleStatus: row.article_status,
    version: row.version,
    versionStatus: row.version_status,
    isCurrent: row.current_version_id === row.version_id,
    name: row.name,
    nameLocale: row.name_locale,
    shortName: row.short_name,
    dietaryMark: row.dietary_mark,
    taxClassCode: row.tax_class_code,
    hsnSacCode: row.hsn_sac_code,
    servingSizeQty: row.serving_size_qty === null ? null : Number(row.serving_size_qty),
    servingSizeUomCode: row.serving_size_uom_code,
    caloriesKcal: row.calories_kcal === null ? null : Number(row.calories_kcal),
    channelFlags: row.channel_flags ?? [],
    effectiveFrom: row.effective_from ? row.effective_from.toISOString().slice(0, 10) : null,
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    raisedBy: row.raised_by,
    raisedByRole: row.raised_by_role,
    prices: outlets.map((price) => ({
      outletCode: price.outlet_code,
      amount: Number(price.amount),
      currencyCode: price.currency_code,
    })),
    allergens: allergens.map((allergen) => ({
      code: allergen.code,
      mayContain: allergen.may_contain,
    })),
    complianceGaps: gaps.map((gap) => ({
      field: gap.field,
      jurisdiction: gap.jurisdiction,
      declaredFor: gap.declaredFor,
    })),
  };
}
