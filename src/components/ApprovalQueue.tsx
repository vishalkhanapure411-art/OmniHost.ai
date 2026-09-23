import { useState, type ReactNode } from "react";

import { ApprovalStateBadge, CategoryBadge, SeverityBadge, type ApprovalState, type Severity } from "~/components/status";
import { Banner, Button, Card, ConfirmSummary, Dialog, EmptyState, Field, Select, Textarea } from "~/components/ui";
import { Clock, Layers } from "~/components/icons";
import { ARTICLE_REVIEW_REASONS, isArticleReviewReason } from "~/domain/approvals";
import type { ArticleReviewReasonCode } from "~/domain/approvals";
import type { MessageKey } from "~/i18n/catalog-en";
import { MoneyValue, TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { Money } from "~/i18n/format";

/**
 * The approval queue row — the shape the maker-checker model needs on every screen.
 *
 * One row answers six questions an approver asks before deciding, in reading order:
 * what is it, how bad is it, which chain and site, who raised it and under which role,
 * what is it worth, and when does it breach SLA. The two decisions are the last thing
 * in the row, not the first, because deciding is the end of the thought, not the start.
 *
 * Decisions go through the same confirm-before-commit dialog as every other
 * money- or stock-affecting action, and the dialog is where the approver sees *what* they
 * are deciding: `review` is the version's own content, composed by the caller, so the
 * component stays presentational and the copy stays in the catalogs.
 *
 * A send-back carries a reason code and, optionally, the reviewer's words. The code is
 * required by the server as well as offered here — the control is on the server, this is
 * the surface that makes it usable — and the field is deliberately left empty by default
 * so the requirement is a thing an operator meets rather than a thing they never see.
 */
export interface ApprovalRowView {
  id: string;
  title: string;
  summary?: string | null;
  chainName: string;
  siteName?: string | null;
  category: string;
  severity?: Severity;
  state: ApprovalState;
  dueAt?: string | null;
  raisedBy?: string | null;
  raisedByRole: string;
  assignedRole?: string | null;
  value?: Money | null;
  /** What the approver is approving, as label/value facts. Composed by the caller. */
  review?: { label: string; value: string }[];
  /**
   * Reasons this item cannot be decided in its favour, as sentences the caller composed.
   *
   * Shown in the dialog, above the facts, *before* the decision is taken: the server refuses
   * such a decision anyway (slab 3c-1's compliance gate), and an operator who only learns why
   * after clicking has been told too late. The component stays presentational — it renders
   * what it is given and composes no sentence of its own.
   */
  blockers?: string[];
  /**
   * The thing being decided, named the way the decision dialogs must name it — the caller
   * composes `version 1 of DEMO-MC-GATED` from the review read. Without it the dialog can
   * only name the record by its display name, which is not what an approval is *of*.
   */
  decisionSubject?: string | null;
  /**
   * The decision that was taken against the caller, for a returned item.
   *
   * A send-back that says only "sent back to you" leaves the author to guess what has to
   * change — the reason is the whole point of the transition. `reasonCode` is the raw code
   * and is resolved through `approval.reason.<code>` here, so the row reads as a sentence
   * and the audit trail keeps the code.
   */
  returned?: {
    by?: string | null;
    at?: string | null;
    reasonCode?: string | null;
    note?: string | null;
  } | null;
  /**
   * An honest note about what this dialog cannot show. The review read returns one version,
   * not a pair, so there is no before/after to draw: saying nothing would imply the version
   * as shown *is* the change.
   */
  reviewNote?: string | null;
  /** What the task points at — the caller decides whether a decision path exists at all. */
  entityType?: string;
}

export type ApprovalDecision = "approve" | "sendBack";

/** What a decision carries beyond the decision itself. */
export interface ApprovalDecisionExtras {
  reasonCode?: ArticleReviewReasonCode | null;
  note?: string | null;
}

export function ApprovalQueueList({
  items,
  onDecide,
  decided = [],
  emptyState,
}: {
  items: ApprovalRowView[];
  onDecide?: (item: ApprovalRowView, decision: ApprovalDecision, extras: ApprovalDecisionExtras) => void;
  /** Ids already decided in this session — removed from the queue optimistically. */
  decided?: string[];
  emptyState?: ReactNode;
}) {
  const { t } = useI18n();
  const visible = items.filter((item) => !decided.includes(item.id));

  if (visible.length === 0) return <>{emptyState ?? <EmptyState title={t("state.empty.title")} />}</>;

  return (
    <ul className="divide-y divide-border" aria-label={t("a11y.queue")}>
      {visible.map((item) => (
        <ApprovalQueueRow key={item.id} item={item} onDecide={onDecide} />
      ))}
    </ul>
  );
}

export function ApprovalQueueRow({
  item,
  onDecide,
}: {
  item: ApprovalRowView;
  onDecide?: (item: ApprovalRowView, decision: ApprovalDecision, extras: ApprovalDecisionExtras) => void;
}) {
  const { t, format } = useI18n();
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [reasonCode, setReasonCode] = useState<ArticleReviewReasonCode | "">("");
  const [note, setNote] = useState("");
  const overdue = item.state === "overdue";
  const subject = item.decisionSubject ?? item.title;
  // The catalog label for the coded reason. An unknown code falls back to the code itself
  // rather than to `approval.reason.<code>`, which would be a developer error shown to an
  // operator as prose.
  const reasonKey = item.returned?.reasonCode
    ? (`approval.reason.${item.returned.reasonCode}` as MessageKey)
    : null;
  const reasonLabel = reasonKey ? t(reasonKey) : null;
  const sendBackReason = reasonKey
    ? reasonLabel === reasonKey
      ? item.returned?.reasonCode ?? null
      : reasonLabel
    : null;

  return (
    <li className="list-row flex flex-wrap items-start gap-x-4 gap-y-2 hover:bg-surface-muted">
      <div className="min-w-[16rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.severity ? <SeverityBadge severity={item.severity} /> : null}
          <p className="text-sm font-medium text-fg">{item.title}</p>
          <ApprovalStateBadge state={item.state} />
        </div>
        {item.summary ? <p className="mt-0.5 max-w-prose text-xs text-fg-muted">{item.summary}</p> : null}
        {item.returned ? (
          <div className="mt-1 flex flex-col gap-0.5">
            <p className="text-xs text-fg-muted">
              {t("approval.returned.line", {
                who: item.returned.by ?? t("common.unknown"),
                when: item.returned.at ? format.dateTime(item.returned.at) : t("common.unknown"),
                reason: sendBackReason ?? t("approval.reason.other"),
              })}
            </p>
            {item.returned.note ? (
              <p className="text-xs text-fg-subtle">
                {t("approval.returned.note", { note: item.returned.note })}
              </p>
            ) : null}
            {/*
              What to do next. A content correction is a re-import, not a form (slab 3c-2 §5),
              and that is only discoverable if the returned row says it — otherwise the author
              is left holding a send-back with no way back in.
            */}
            <p className="text-xs text-fg-muted">{t("approval.returned.correction")}</p>
          </div>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-subtle">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true">
              <Layers size={11} />
            </span>
            {item.chainName}
            {item.siteName ? ` · ${item.siteName}` : ""}
          </span>
          <CategoryBadge category={item.category} />
          <span>{t("approvals.queue.raisedBy", { who: item.raisedBy ?? t("common.unknown"), role: item.raisedByRole })}</span>
          <span>
            {item.assignedRole
              ? t("approvals.queue.assignedTo", { role: item.assignedRole })
              : t("approvals.queue.unassigned")}
          </span>
        </p>
      </div>

      <div className="flex min-w-[10rem] flex-col items-end gap-1">
        {item.value ? <MoneyValue money={item.value} tone="default" /> : null}
        <span
          className={`inline-flex items-center gap-1 text-2xs ${overdue ? "font-semibold text-danger" : "text-fg-muted"}`}
        >
          <span aria-hidden="true">
            <Clock size={11} />
          </span>
          {item.dueAt ? t("approvals.queue.due", { when: "" }) : null}
          {item.dueAt ? (
            <TimestampValue value={item.dueAt} mode="weekday" />
          ) : (
            // A null due_at is a real state — no SLA has been set on this item — and an
            // icon with no words next to it said nothing about which state it was.
            t("approvals.queue.noSla")
          )}
        </span>
        {onDecide ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => { setPending("sendBack"); }}>
              {t("approval.action.sendBack")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => { setPending("approve"); }}>
              {t("approval.action.approve")}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={pending !== null}
        onClose={() => { setPending(null); }}
        title={
          pending === "approve"
            ? t("approval.dialog.approve.title", { subject })
            : t("approval.dialog.sendBack.title", { subject })
        }
        description={item.title}
        // A send-back is the destructive half: it puts someone's work back and refuses it.
        // The two dialogs are otherwise the same shape, so the footer's own tone is what
        // separates "this publishes" from "this rejects" at a glance.
        tone={pending === "approve" ? "default" : "danger"}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPending(null); }}>
              {t("action.cancel")}
            </Button>
            <Button
              variant={pending === "approve" ? "primary" : "danger"}
              onClick={() => {
                if (pending) {
                  onDecide?.(item, pending, {
                    reasonCode: pending === "sendBack" && isArticleReviewReason(reasonCode) ? reasonCode : null,
                    note: note.trim() || null,
                  });
                }
                setPending(null);
              }}
            >
              {pending === "approve"
                ? t("approval.dialog.approve.commit")
                : t("approval.dialog.sendBack.commit")}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-xs text-fg-muted">
          {pending === "approve"
            ? t("approval.dialog.approve.effect")
            : t("approval.dialog.sendBack.effect", {
                author: item.raisedBy ?? t("common.unknown"),
              })}
        </p>
        {item.blockers && item.blockers.length > 0 ? (
          <div className="mb-3">
            <Banner tone="warn" title={t("approval.review.missingRequired")}>
              <p>{t("approval.review.missingRequired.note")}</p>
              <ul className="mt-1 list-disc ps-4">
                {item.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Banner>
          </div>
        ) : null}
        {item.reviewNote ? (
          // The absent state, said out loud. `getArticleVersionReview` reads one version, so
          // there is no pair to diff — silence here would read as "nothing changes".
          <p className="mb-3 text-2xs text-fg-subtle">{item.reviewNote}</p>
        ) : null}
        {item.review && item.review.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
              {t("approval.review.title")}
            </p>
            <dl className="divide-y divide-border rounded-md border border-border">
              {item.review.map((fact) => (
                <div key={fact.label} className="flex items-baseline justify-between gap-4 px-3 py-1.5">
                  <dt className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
                    {fact.label}
                  </dt>
                  <dd className="text-sm text-fg">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        <ConfirmSummary
          items={[
            { label: t("approvals.column.item"), value: item.title },
            { label: t("approvals.column.chain"), value: item.chainName },
            { label: t("approvals.column.category"), value: item.category },
            {
              label: t("approvals.column.assignedRole"),
              value: item.assignedRole ?? t("approvals.queue.unassigned"),
            },
          ]}
        />
        {pending === "sendBack" ? (
          <div className="mt-3 flex flex-col gap-3">
            <Field id="approval-send-back-reason" label={t("approval.reason.label")} required>
              <Select
                id="approval-send-back-reason"
                value={reasonCode}
                onChange={(value) => {
                  setReasonCode(isArticleReviewReason(value) ? value : "");
                }}
                emptyLabel={t("approval.reason.choose")}
                options={ARTICLE_REVIEW_REASONS.map((code) => ({
                  value: code,
                  label: t(`approval.reason.${code}` as MessageKey),
                }))}
              />
            </Field>
            <Field
              id="approval-send-back-note"
              label={t("approval.reason.note")}
              hint={t("approval.reason.noteHint")}
            >
              <Textarea
                id="approval-send-back-note"
                value={note}
                onChange={setNote}
                rows={2}
                placeholder={t("approval.reason.notePlaceholder")}
              />
            </Field>
          </div>
        ) : null}
      </Dialog>
    </li>
  );
}

/** A worked example for the pattern spec / gallery — never used with tenant data. */
export function ApprovalQueueSample({ items }: { items: ApprovalRowView[] }) {
  const { t } = useI18n();
  return (
    <Card>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <ApprovalQueueRow key={item.id} item={item} />
        ))}
      </ul>
      <p className="border-t border-border px-3 py-1.5 text-2xs text-fg-subtle">{t("pattern.approval.body")}</p>
    </Card>
  );
}
