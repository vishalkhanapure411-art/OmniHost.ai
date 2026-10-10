import { useRef, type ReactNode } from "react";

import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";

/**
 * Tabs — the entity-level navigation primitive.
 *
 * Every entity screen in this product is now "one record, one page, tabs per facet"
 * (owner, 8 Oct 2026: one task per page, fewer touch points, no scrolling to assemble
 * one record's facts). Before this component each screen welded its own bar together
 * out of `SegmentedControl`, which is an either/or picker — `role="group"` with
 * `aria-pressed`, no panel relationship, no keyboard contract — and it cannot carry a
 * URL. A tab bar is a different thing and this is it.
 *
 *   * **Controlled, like `SegmentedControl`.** The component renders state and reports
 *     intent; *the caller* owns the value. That is what lets the router own it: the
 *     route decides `value`, `onChange` navigates, and each tab ends up with a real,
 *     pasteable URL. A tab bar that cannot be linked to is a tab bar people route
 *     around.
 *   * **No `aria-controls`.** The panel a tab shows is the *route* the tab navigates to, so
 *     only the active one is mounted; naming the other four would be four dangling ID
 *     references, which is worse than none. The panel names its tab instead
 *     (`aria-labelledby` on the panel, set by the screen that renders it) — that is the
 *     direction an assistive technology needs to announce the panel's own name.
 *   * **Labels are catalogue keys, never strings** — the type is `MessageKey`, so a
 *     literal does not compile. The same rule the rest of the console lives by.
 *   * **WAI-ARIA APG, automatic activation.** Arrows move focus *and* select, because
 *     an operator scanning a record wants the panel to follow the key, not to press
 *     Enter after every move. Roving tabindex: one tab stop for the whole bar.
 *   * **Density-aware, not fixed.** Height comes from `--density-control-py`, so the
 *     bar tracks the `.density-*` container like every other control. There is no
 *     `density` prop, deliberately — a component that reads the container cannot
 *     disagree with the table beside it.
 *   * **RTL-safe.** Separators are `border-inline-start` and the active rule is
 *     `border-block-end`, which is the bottom edge in both directions. No `left`/`right`
 *     appears below; a mirrored locale moves the bar without a second rule set.
 *   * **Colour is never the only signal.** The active tab is `aria-selected="true"`
 *     *and* semibold *and* underlined. A disabled tab carries `title` with the reason
 *     it is disabled — a silently dead control never tells an operator whether the
 *     thing is not theirs to do or the product forgot it.
 */
export interface TabItem {
  /** Stable id, used as the URL segment by the caller. */
  value: string;
  /** Catalogue key; resolved inside the primitive so the caller cannot pass prose. */
  label: MessageKey;
  /** Optional count or state chip, e.g. the number of pending items. */
  badge?: ReactNode;
  /** A permission-gated tab (e.g. History without `chain.audit.read`). */
  disabled?: boolean;
  /** Why it is disabled — rendered as the `title`, never as a silent grey. */
  disabledReason?: MessageKey;
}

export function Tabs({
  idBase,
  items,
  value,
  onChange,
  ariaLabel,
  align = "start",
}: {
  /** The caller-owned id prefix shared with `TabPanel`, so the two stay linked. */
  idBase: string;
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the tablist, e.g. "Chain views". */
  ariaLabel: MessageKey;
  align?: "start" | "stretch";
}) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement | null>(null);

  const enabled = items.filter((item) => !item.disabled);

  /** Move focus *and* selection to `index`, clamping to the enabled items. */
  function go(index: number) {
    if (enabled.length === 0) return;
    const item = enabled[(index + enabled.length) % enabled.length];
    if (!item) return;
    onChange(item.value);
    requestAnimationFrame(() => {
      barRef.current?.querySelector<HTMLButtonElement>(`[data-tab-value="${item.value}"]`)?.focus();
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const anywhere = enabled.findIndex((item) => item.value === items[index]?.value);
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        go(anywhere + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        go(anywhere - 1);
        break;
      case "Home":
        event.preventDefault();
        go(0);
        break;
      case "End":
        event.preventDefault();
        go(enabled.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={t(ariaLabel)}
      aria-orientation="horizontal"
      className={`flex items-stretch gap-0 border-b border-border bg-surface px-2 ${
        align === "stretch" ? "w-full" : ""
      }`}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.value}`}
            aria-selected={selected}
            aria-disabled={item.disabled ? "true" : undefined}
            disabled={item.disabled}
            data-tab-value={item.value}
            tabIndex={selected ? 0 : -1}
            title={item.disabled && item.disabledReason ? t(item.disabledReason) : undefined}
            onClick={() => {
              if (!item.disabled) onChange(item.value);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={`tab-item ${selected ? "tab-item-on" : ""} ${align === "stretch" ? "flex-1" : ""}`}
          >
            <span className="min-w-0 truncate">{t(item.label)}</span>
            {item.badge !== undefined ? (
              <span className="num tab-badge" aria-hidden="true">
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
