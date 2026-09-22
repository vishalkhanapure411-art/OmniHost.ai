import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ApprovalQueueList, type ApprovalDecision, type ApprovalDecisionExtras, type ApprovalRowView } from "~/components/ApprovalQueue";
import { ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { Check, Plus } from "~/components/icons";
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, SegmentedControl } from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { ARTICLE_VERSION_ENTITY } from "~/domain/approvals";
import type { ApprovalQueueScope } from "~/domain/inbox";
import type { ArticleVersionReview } from "~/domain/mdm-approvals";
import { decideArticleApprovalFn, getArticleVersionReviewFn, listApprovalsFn } from "~/server-fns";

/**
 * The approvals / task inbox — the shared maker-checker surface.
 *
 * Spec "Chatbot Interaction Model" (guardrails): "Maker-checker actions route the
 * confirmation card to the approver's own chatbot as an actionable item, not to the
 * requester".
 *
 * The queue is scoped by `listApprovals` to the tasks assigned to the caller's role or
 * user, and that scoping is the control — the screen neither widens it nor narrows it. The
 * decisions are made by the server (`decideArticleApprovalFn`), so a task the queue shows
 * is still refusable on its merits: a self-approval is refused with `mdm.approve.self`
 * whatever this screen offered.
 *
 * **Two halves, read once.** The screen reads the *waiting* half and the *decided* half in
 * one loader pass and switches between them with no round trip, so a decided item can
 * never be counted as pending work: it is absent from the waiting read, and its count is
 * the decided read's own. The same rule reaches a task sent back to the person who raised
 * it — `returnedToMe` — which stays in the waiting half (the work really is theirs again)
 * under a badge that says so rather than pretending to be a fresh request.
 *
 * Master-data items can be *read* before they are decided. Every other article read joins
 * `article.current_version_id`, so a version under review is invisible to them by design —
 * the review read exists so an approver has something to approve, and it is composed into
 * the decision dialog rather than into a second screen. A before/after diff is
 * deliberately not built here.
 */
export const Route = createFileRoute("/_shell/approvals")({
  staticData: { titleKey: "nav.route./approvals" },
  loader: async () => {
    const [waiting, decided] = await Promise.all([
      listApprovalsFn({ data: { scope: "waiting" } }),
      listApprovalsFn({ data: { scope: "decided" } }),
    ]);
    // What each open master-data task is asking to approve. Fetched per item because the
    // review read is a read of one version, and the queue is small by construction: it is
    // already filtered to the items routed to this caller.
    const reviews: Record<string, ArticleVersionReview> = {};
    if (waiting.ok) {
      const pending = waiting.inbox.items.filter(
        (item) => item.entityType === ARTICLE_VERSION_ENTITY && item.status === "open"
      );
      const fetched = await Promise.all(
        pending.map((item) => getArticleVersionReviewFn({ data: { taskId: item.id } }))
      );
      fetched.forEach((result, index) => {
        if (result.ok) reviews[pending[index].id] = result.review;
      });
    }
    return { waiting, decided, reviews };
  },
  component: ApprovalsScreen,
});

function ApprovalsScreen() {
  const { waiting, decided, reviews } = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format, money } = useI18n();
  const router = useRouter();
  const [scope, setScope] = useState<ApprovalQueueScope>("waiting");
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A refusal, with the tone it deserves.
   *
   * `policy` is the four-eyes rule and anything else the domain answers with a coded
   * *policy* sentence (`permission.*`): the platform did its job and nothing is broken, so
   * it is not painted danger red. Everything else — a validation refusal, a missing
   * capability — keeps the error tone, because it is one.
   */
  const [refusal, setRefusal] = useState<{ text: string; policy: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const result = scope === "waiting" ? waiting : decided;
  /** The figure the header shows: what the caller still has to act on (waiting), or what has
   *  been decided (history). Each scope counts its own half — the two cannot be confused. */
  const headline = result.ok ? (scope === "waiting" ? result.inbox.mine : result.inbox.decided) : 0;

  /**
   * The server's own words for a refusal, translated and parameterised when the domain gave
   * a code.
   *
   * A coded refusal is looked up in the catalog — with the code's own parameters — so an
   * operator reading Hindi is not handed an English sentence, and so a refusal that must
   * name a field and a market (`validation.review.jurisdictionIncomplete`) renders those
   * words rather than the literals `{field}` and `{jurisdiction}`. A refusal with no code —
   * a missing capability — is shown as it arrived, since the point of that message is the
   * capability it names.
   */
  function refusalText(response: {
    code: string | null;
    message: string;
    params?: Record<string, string | number> | null;
  }): string {
    if (response.code) {
      const key = response.code as MessageKey;
      const translated = t(key, response.params ?? undefined);
      if (translated !== key) return translated;
    }
    return response.message;
  }

  /** True when the refusal is a coded policy sentence rather than a data or capability error. */
  function isPolicyRefusal(response: { code: string | null }): boolean {
    return Boolean(response.code && response.code.startsWith("permission."));
  }

  /** What is being decided, in the decision dialogs' own words: `version 1 of DEMO-MC-GATED`. */
  function decisionSubject(taskId: string): string | null {
    const review = reviews[taskId];
    if (!review) return null;
    return t("approval.dialog.subject", { version: String(review.version), code: review.code });
  }

  function reviewFacts(taskId: string): { label: string; value: string }[] {
    const review = reviews[taskId];
    if (!review) return [];
    const facts: { label: string; value: string }[] = [
      {
        label: t("approval.review.article"),
        value: `${review.code} · ${t("approval.review.version", { version: String(review.version) })}`,
      },
      { label: t("approval.review.name"), value: review.name ?? review.code },
      {
        label: t("approval.review.status"),
        value: t(STATUS_LABEL[review.versionStatus] ?? "mdm.article.status.draft"),
      },
    ];
    if (review.dietaryMark) {
      facts.push({ label: t("mdm.article.field.diet"), value: review.dietaryMark });
    }
    if (review.taxClassCode) {
      facts.push({ label: t("mdm.article.field.taxClass"), value: review.taxClassCode });
    }
    if (review.hsnSacCode) {
      facts.push({ label: t("mdm.article.field.hsnSac"), value: review.hsnSacCode });
    }
    if (review.servingSizeQty !== null && review.servingSizeUomCode) {
      facts.push({
        label: t("mdm.article.field.servingSize"),
        value: format.quantity(review.servingSizeQty, review.servingSizeUomCode),
      });
    }
    if (review.prices.length > 0) {
      facts.push({
        label: t("approval.review.prices"),
        value: review.prices
          .map((price) => `${price.outletCode} ${money({ amount: price.amount, currency: price.currencyCode })}`)
          .join(" · "),
      });
    }
    if (review.allergens.length > 0) {
      facts.push({
        label: t("approval.review.allergens"),
        value: review.allergens.map((allergen) => allergen.code).join(", "),
      });
    }
    facts.push({
      label: t("approval.review.submittedBy"),
      value: t("approvals.queue.raisedBy", {
        who: review.raisedBy ?? t("common.unknown"),
        role: review.raisedByRole ?? t("shell.roles.none"),
      }),
    });
    if (review.submittedAt) {
      facts.push({
        label: t("approval.review.submittedAt"),
        value: format.dateTime(review.submittedAt),
      });
    }
    return facts;
  }

  /**
   * What would stop an approval of this item, in the approver's own words.
   *
   * The review read carries the version's unmet market requirements, and the approve
   * transition refuses on exactly those — so this is not a second opinion, it is the refusal
   * arriving early enough to be useful.
   */
  function reviewBlockers(taskId: string): string[] {
    const review = reviews[taskId];
    if (!review) return [];
    return review.complianceGaps.map((gap) =>
      t("approval.review.missingRequired.item", { field: gap.field, jurisdiction: gap.jurisdiction })
    );
  }

  async function decide(item: ApprovalRowView, decision: ApprovalDecision, extras: ApprovalDecisionExtras) {
    setNotice(null);
    setRefusal(null);
    if (item.entityType !== ARTICLE_VERSION_ENTITY) {
      // No module other than master data raises a task yet, so there is no decision path
      // behind this item and the screen says so instead of offering one.
      setNotice(t("approvals.how.footer", { name: item.title, roles: item.assignedRole ?? "" }));
      return;
    }
    setBusy(true);
    try {
      const response = await decideArticleApprovalFn({
        data: {
          taskId: item.id,
          decision,
          reasonCode: extras.reasonCode ?? null,
          note: extras.note ?? null,
        },
      });
      if (!response.ok) {
        setRefusal({ text: refusalText(response), policy: isPolicyRefusal(response) });
        return;
      }
      setNotice(
        decision === "approve"
          ? t("approval.notice.approved", {
              item: item.title,
              code: response.result.code,
            })
          : t("approval.notice.sentBack", {
              item: item.title,
              reason: extras.reasonCode ? t(`approval.reason.${extras.reasonCode}` as MessageKey) : "",
            })
      );
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  const items: ApprovalRowView[] = (result.ok ? result.inbox.items : []).map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    chainName: item.chainName,
    siteName: item.siteName,
    category: item.category,
    // The badge is where an operator reads the outcome, so it names the outcome: an open
    // item is awaiting a decision, a decided one was approved or sent back. A task sent back
    // to its author is decided *and* still the author's work, and collapsing it into
    // "closed" is what would hide the send-back.
    state:
      item.status === "open"
        ? "awaiting"
        : item.returnedToMe
          ? "returned"
          : item.status === "approved"
            ? "approved"
            : item.status === "rejected"
              ? "sent_back"
              : "closed",
    dueAt: item.dueAt,
    raisedBy: item.raisedBy,
    raisedByRole: item.raisedByRole,
    assignedRole: item.assignedRole,
    review: reviewFacts(item.id),
    blockers: reviewBlockers(item.id),
    decisionSubject: decisionSubject(item.id),
    returned: item.returnedToMe
      ? {
          by: item.decidedBy,
          at: item.decidedAt,
          reasonCode: item.decisionReason,
          note: item.decisionNote,
        }
      : null,
    // The review read returns one version, not a pair, so no before/after can be drawn. The
    // dialog says so rather than implying that what it shows is the change.
    reviewNote: reviews[item.id] ? t("approval.review.noComparison") : null,
    entityType: item.entityType,
  }));

  return (
    <>
      <PageHeader
        eyebrow={t("approvals.eyebrow")}
        title={t("approvals.title")}
        description={t("approvals.description")}
        meta={
          result.ok ? (
            <span className="text-2xs text-fg-subtle">
              {format.integer(headline)} ·{" "}
              {t(scope === "waiting" ? "approvals.queue.title" : "approvals.history.title")}
            </span>
          ) : undefined
        }
      />

      <MasterDetail
        masterLabel={t("a11y.queue")}
        master={
          <>
            <ListToolbar
              filter={
                <SegmentedControl<ApprovalQueueScope>
                  size="sm"
                  value={scope}
                  onChange={(next) => {
                    setRefusal(null);
                    setNotice(null);
                    setScope(next);
                  }}
                  ariaLabel={t("approvals.filter.label")}
                  options={[
                    { value: "waiting", label: t("approvals.queue.title") },
                    { value: "decided", label: t("approvals.history.title") },
                  ]}
                />
              }
              meta={
                result.ok
                  ? scope === "waiting"
                    ? t("approvals.queue.count", {
                        open: format.integer(result.inbox.open),
                        returned: format.integer(result.inbox.returned),
                      })
                    : t("approvals.history.count", { decided: format.integer(result.inbox.decided) })
                  : undefined
              }
              actions={
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    void router.invalidate();
                  }}
                >
                  {t("action.refresh")}
                </Button>
              }
            />
            {refusal ? (
              <p
                className={`border-b border-border px-3 py-1.5 text-xs text-fg ${
                  refusal.policy ? "bg-surface-sunken" : "bg-danger-soft"
                }`}
              >
                {refusal.policy
                  ? refusal.text
                  : t("approval.notice.refused", { reason: refusal.text })}
              </p>
            ) : null}
            {notice ? (
              <p className="border-b border-border bg-info-soft px-3 py-1.5 text-xs text-fg">{notice}</p>
            ) : null}
            {!result.ok ? (
              <ErrorState
                title={t("error.title")}
                description={t("error.description")}
                detail={result.message}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void router.invalidate();
                    }}
                  >
                    {t("action.retry")}
                  </Button>
                }
              />
            ) : (
              <ApprovalQueueList
                items={items}
                onDecide={(item, decision, extras) => {
                  void decide(item, decision, extras);
                }}
                emptyState={
                  <EmptyState
                    icon={<Check size={20} />}
                    title={scope === "waiting" ? t("approvals.empty.title") : t("approvals.history.empty.title")}
                    description={
                      scope === "waiting"
                        ? t("approvals.empty.description")
                        : t("approvals.history.empty.description")
                    }
                  />
                }
              />
            )}
          </>
        }
        detail={
          <div className="flex flex-col gap-4 p-4">
            <Card>
              <CardHeader title={t("approvals.how.title")} subtitle={t("approvals.how.subtitle")} />
              <div className="flex flex-col gap-3 p-4 text-xs text-fg-muted">
                <p>{t("approvals.how.paragraph1")}</p>
                <p>{t("approvals.how.paragraph2")}</p>
                <p className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                  {t("approvals.how.footer", {
                    name: principal.displayName,
                    roles:
                      principal.roles.map((role) => role.name).join(", ") || t("shell.roles.none"),
                  })}
                </p>
                <p className="flex items-center gap-1 text-2xs text-fg-subtle">
                  <span aria-hidden="true">
                    <Plus size={12} />
                  </span>
                  {t("pattern.approval.body")}
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader title={t("shell.permissions.title")} />
              <ul className="flex flex-col gap-1 p-4 text-xs text-fg-muted">
                <li>
                  {t("shell.grants.title.one")} · <TimestampValue value={principal.sessionExpiresAt} mode="weekday" />
                </li>
              </ul>
            </Card>
          </div>
        }
      />
    </>
  );
}

/** The version/appendix status labels the review panel reuses, so one status is one word. */
const STATUS_LABEL: Record<string, MessageKey> = {
  draft: "mdm.article.status.draft",
  pending_review: "mdm.article.status.pending_review",
  active: "mdm.article.status.active",
  discontinued: "mdm.article.status.discontinued",
};
