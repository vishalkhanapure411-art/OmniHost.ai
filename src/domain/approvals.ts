/**
 * The maker-checker vocabulary the article review path uses on both sides of the wire.
 *
 * **Why this file has no imports.** It is read at module scope by a screen (the approvals
 * route and the queue component both need the reason-code list and the entity-type
 * constant), and it is imported by the server's domain layer too. A module-scope value a
 * client-retained screen reads may import only import-free modules — pulling `pg` or the
 * `server-only` marker in here would put server code in the browser bundle and break the
 * production build while dev mode hid it. Same rule as `~/domain/nav` and
 * `~/domain/principal`; the values below are plain strings and types, so nothing is lost.
 */

/** A decision on a review task. The two the ledger model allows for a send-back-less world. */
export type MdmReviewDecision = "approve" | "sendBack";

/**
 * The role a master-data review is routed to: the Central MDM Head.
 *
 * A constant rather than a literal in the insert, because the *same* code decides the
 * queue's scope (`listApprovals` filters on the caller's role codes) and the task's
 * routing: two copies of a role code that must agree is one copy too many.
 */
export const ARTICLE_APPROVER_ROLE = "CENTRAL_MDM_HEAD";

/**
 * What an `approval_task` points at for this path — the article *version*, not the article.
 *
 * The version is what is under review: an article carries a current version and history,
 * and approving "the article" would be ambiguous the moment a second version exists.
 */
export const ARTICLE_VERSION_ENTITY = "article_version";

/** The `approval_task.category` a master-data review is raised under. */
export const MDM_APPROVAL_CATEGORY = "mdm";

/**
 * Why an approver sent a version back. A code, not free text alone: "how many send-backs
 * were about pricing" is a question the audit trail should answer without reading prose.
 * The label for each code lives in the message catalogs (`approval.reason.<code>`).
 */
export type ArticleReviewReasonCode =
  | "content_incorrect"
  | "pricing_wrong"
  | "compliance_gap"
  | "needs_evidence"
  | "other";

export const ARTICLE_REVIEW_REASONS: readonly ArticleReviewReasonCode[] = [
  "content_incorrect",
  "pricing_wrong",
  "compliance_gap",
  "needs_evidence",
  "other",
];

/** Narrows a value off the wire or out of the database to a reason code. */
export function isArticleReviewReason(value: unknown): value is ArticleReviewReasonCode {
  return typeof value === "string" && (ARTICLE_REVIEW_REASONS as readonly string[]).includes(value);
}
