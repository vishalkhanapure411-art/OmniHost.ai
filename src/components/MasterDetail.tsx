import type { ReactNode } from "react";

/**
 * The reusable list-detail pattern.
 *
 * Every module in this platform eventually needs the same thing: a dense list on the
 * left, the thing you selected on the right, and the selection addressable in the URL
 * so a link can be pasted into a chat. Building it once means the chain list, the
 * audit trail and every later module (POs, GRNs, tickets) behave identically instead
 * of each inventing its own split view.
 *
 * Below the `lg` breakpoint the two panes stack, so the same markup works on a site
 * back-office tablet without a second layout.
 */
export function MasterDetail({
  master,
  masterLabel,
  detail,
  detailLabel,
}: {
  master: ReactNode;
  masterLabel: string;
  detail: ReactNode;
  detailLabel?: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div
        aria-label={masterLabel}
        className="min-w-0 border-b border-border bg-surface lg:border-r lg:border-b-0"
      >
        {master}
      </div>
      <div aria-label={detailLabel ?? "Detail"} className="min-w-0 bg-canvas">
        {detail}
      </div>
    </div>
  );
}

export function MasterHeader({
  title,
  count,
  actions,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{title}</h2>
        {count !== undefined ? <span className="text-xs text-fg-subtle">{count}</span> : null}
      </div>
      {actions}
    </header>
  );
}

export function DetailHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div>
        {eyebrow ? (
          <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">{eyebrow}</p>
        ) : null}
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
