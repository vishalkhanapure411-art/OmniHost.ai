import { useEffect, useRef, type ReactNode } from "react";

import { Close } from "~/components/icons";
import { IconButton } from "~/components/ui";
import { useI18n } from "~/i18n";

/**
 * Drawer — the transient side panel.
 *
 * `Dialog` interrupts: it centres, it dims, it demands an answer. Half the things this
 * console asks are not answers — a before/after diff, a licence detail, one ledger row's
 * evidence. Those want to sit *beside* the table they came from, so the operator keeps
 * the row and the reasoning in one glance and can open the next one without a round trip.
 *
 * Contract, deliberately the same as `Dialog` where the semantics are the same:
 *   * `role="dialog"`, `aria-modal="true"`, focus moved in on open and returned to the
 *     trigger on close, `Escape` closes, a labelled close control from the catalogue.
 *     The close control has a **text** accessible name (`action.close`) rather than a
 *     bare ✕.
 *   * Anchored to the **inline end** (`inset-inline-end`), so it slides from the right
 *     in a left-to-right locale and from the left in a right-to-left one. No `left` or
 *     `right` appears below; the only direction-sensitive value is a CSS variable that
 *     flips with `[dir="rtl"]`.
 *   * Sizes are three named widths, not free pixels, and inner content uses the
 *     `--density-*` variables, so a drawer in a compact container is compact.
 *   * Closed means not rendered, so a closed drawer holds no focusable furniture to tab
 *     into — the same reason `Dialog` does it this way.
 *
 * First consumers, in the order they were promised: the History tab's per-row diff, the
 * Approvals decision panel, the Audit trail diff.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  width = "md",
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  /** Resolved by the caller (match `Dialog`: a key resolved where it is used). */
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  tone?: "default" | "danger";
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = (document.activeElement as HTMLElement | null) ?? null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      // Keep Tab inside the panel: several drawers sit over a dense table, and letting
      // focus walk out behind the scrim is how a keyboard user gets lost.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      returnFocusTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const widthClass = width === "sm" ? "drawer-panel-sm" : width === "lg" ? "drawer-panel-lg" : "drawer-panel-md";

  return (
    <div
      className="drawer-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={`drawer-panel ${widthClass} ${tone === "danger" ? "drawer-panel-danger" : ""}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="min-w-0 text-sm font-semibold text-text">{title}</h2>
          <IconButton label={t("action.close")} onClick={onClose}>
            <Close size={14} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
