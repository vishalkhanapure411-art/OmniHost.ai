import { useState, type ReactNode } from "react";

import { ApprovalStateBadge, CategoryBadge, SeverityBadge, type ApprovalState, type Severity } from "~/components/status";
import { Button, Card, ConfirmSummary, Dialog, EmptyState, Field, Select, Textarea } from "~/components/ui";
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
  const { t } = useI18n();
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [reasonCode, setReasonCode] = useState<ArticleReviewReasonCode | "">("");
  const [note, setNote] = useState("");
  const overdue = item.state === "overdue";

  return (
    <li className="list-row flex flex-wrap items-start gap-x-4 gap-y-2 hover:bg-surface-muted">
      <div className="min-w-[16rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.severity ? <SeverityBadge severity={item.severity} /> : null}
          <p className="text-sm font-medium text-fg">{item.title}</p>
          <ApprovalStateBadge state={item.state} />
        </div>
        {item.summary ? <p className="mt-0.5 max-w-prose text-xs text-fg-muted">{item.summary}</p> : null}
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
          {item.dueAt ? <TimestampValue value={item.dueAt} mode="weekday" /> : null}
        </span>
        {onDecide ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => { setPending("sendBack"); }}>
              {t("action.review")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => { setPending("approve"); }}>
              {t("action.confirm")}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={pending !== null}
        onClose={() => { setPending(null); }}
        title={pending === "approve" ? t("action.confirm") : t("action.review")}
        description={item.title}
        tone={pending === "approve" ? "default" : "default"}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPending(null); }}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
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
              {t("action.confirm")}
            </Button>
          </>
        }
      >
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
