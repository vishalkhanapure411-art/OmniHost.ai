import { useState, type ReactNode } from "react";

import { ApprovalStateBadge, CategoryBadge, SeverityBadge, type ApprovalState, type Severity } from "~/components/status";
import { Button, Card, ConfirmSummary, Dialog, EmptyState } from "~/components/ui";
import { Clock, Layers } from "~/components/icons";
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
 * money- or stock-affecting action. `onDecide` is the caller's business: today it is
 * unwired (the modules that raise items ship with their own phases), and the component
 * says so rather than pretending.
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
}

export type ApprovalDecision = "approve" | "sendBack";

export function ApprovalQueueList({
  items,
  onDecide,
  decided = [],
  emptyState,
}: {
  items: ApprovalRowView[];
  onDecide?: (item: ApprovalRowView, decision: ApprovalDecision) => void;
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
  onDecide?: (item: ApprovalRowView, decision: ApprovalDecision) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
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
                if (pending) onDecide?.(item, pending);
                setPending(null);
              }}
            >
              {t("action.confirm")}
            </Button>
          </>
        }
      >
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
