import type { ReactNode } from "react";

import { useI18n } from "~/i18n";

/**
 * The reusable list-detail pattern.
 *
 * Every module in this platform eventually needs the same thing: a dense list on one
 * side, the selected record on the other, and the selection addressable in the URL so a
 * link can be pasted into a chat, a ticket or a message. Building it once means the
 * chain list, the audit trail and every later module (articles, POs, GRNs, tickets)
 * behave identically instead of each inventing its own split view.
 *
 * Sizing: the list pane is a fixed, generous column (`26rem`) and the detail pane takes
 * the remainder. Under `lg` the panes stack, so the same markup works on a site
 * back-office tablet without a second layout. Both panes scroll independently, which is
 * what keeps a 200-row ledger usable next to its detail.
 *
 * Direction: the divider is `border-inline-end`, so in an RTL locale the list sits on
 * the right and the divider moves with it, without a second set of classes.
 */
export function MasterDetail({
  master,
  masterLabel,
  detail,
  detailLabel,
  masterWidth = "26rem",
}: {
  master: ReactNode;
  masterLabel: string;
  detail: ReactNode;
  detailLabel?: string;
  masterWidth?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,var(--master-w))_minmax(0,1fr)]"
      style={{ ["--master-w" as string]: masterWidth }}
    >
      <div
        aria-label={masterLabel}
        role="region"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-border bg-surface lg:border-e lg:border-b-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{master}</div>
      </div>
      <div aria-label={detailLabel ?? t("a11y.detailPane")} role="region" className="min-h-0 min-w-0 overflow-y-auto bg-canvas">
        {detail}
      </div>
    </div>
  );
}

/** The tool strip above a list pane: a filter, a density note, row count, an action. */
export function ListToolbar({
  filter,
  actions,
  meta,
}: {
  filter?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      {filter}
      {meta ? <span className="text-2xs text-fg-subtle">{meta}</span> : null}
      {actions ? <div className="ms-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function DetailHeader({
  eyebrow,
  title,
  actions,
  meta,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">{eyebrow}</p>
        ) : null}
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
