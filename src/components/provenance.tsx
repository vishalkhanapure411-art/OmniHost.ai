import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";

/**
 * ProvenanceChip — the marker for a field the ERP manages (Phase 1 spec Part II §25.3,
 * pattern spec §19).
 *
 * The whole point is that an ERP-owned field is rendered as a **value**, not as a
 * disabled input:
 *
 *   * a disabled `<input>` is skipped by a screen reader, announces nothing, and is
 *     indistinguishable from a control that has broken;
 *   * a read-only value with a chip beside it announces the field, announces its value,
 *     and can explain *why* it cannot be typed into.
 *
 * So the chip is a real `<button>` (Enter opens, Escape closes and restores focus), it
 * sits at the logical inline-end (`margin-inline-start`), and its popover names — in
 * words — the system, the key the record was matched on, when that key was last
 * confirmed, the ownership row in force, and a catalogued note explaining the rule. A
 * read-only field that cannot explain itself is the thing operators route around by
 * emailing somebody, which is worse than an editable field.
 *
 * Keyboard: **one tab stop per field group**, not per field. A 24-field section must not
 * become 24 stops, so the caller renders one chip beside each group's values.
 *
 * Direction: every offset is a logical property (`ms-*`, `start-*`), so the popover
 * mirrors with the document in an RTL locale rather than needing a second set of classes.
 * The text wraps rather than truncating — a German system name plus a key plus an instant
 * is three lines in a narrow column and is allowed to be.
 */

export interface ProvenanceOwnership {
  fieldGroup: string;
  owner: string;
  inboundAction: string;
  outboundAction: string;
  overrideAllowed: boolean;
  noteKey: string | null;
}

/** The subset of message keys the chip resolves. Kept explicit so a typo is a type error. */
const OWNER_LABEL: Record<string, MessageKey> = {
  erp: "mdm.erp.ownership.owner.erp",
  omnihost: "mdm.erp.ownership.owner.omnihost",
  shared: "mdm.erp.ownership.owner.shared",
};

const ACTION_LABEL: Record<string, MessageKey> = {
  accept: "mdm.erp.ownership.action.accept",
  refuse: "mdm.erp.ownership.action.refuse",
  review: "mdm.erp.ownership.action.review",
  ignore: "mdm.erp.ownership.action.ignore",
};

/** Codes are identifiers: the label is resolved *from* the code, and an unknown code
 * falls back to the code itself rather than to a made-up word. */
export function codeLabel(code: string, labels: Record<string, MessageKey>, t: (key: MessageKey) => string): string {
  const key = labels[code];
  return key ? t(key) : code;
}

export function labelForOwner(owner: string): MessageKey | null {
  return OWNER_LABEL[owner] ?? null;
}

export function labelForAction(action: string): MessageKey | null {
  return ACTION_LABEL[action] ?? null;
}

export function ProvenanceChip({
  systemName,
  groupLabel,
  keyKind,
  keyValue,
  lastSyncAt,
  ownership,
  systemStatusLabel,
}: {
  systemName: string;
  /** The catalogued name of the field group, already resolved — the popover's heading. */
  groupLabel: string;
  keyKind: string | null;
  keyValue: string | null;
  lastSyncAt: string | null;
  ownership: ProvenanceOwnership | null;
  /** e.g. `Declared, not connected` — the connection's own state, in words. */
  systemStatusLabel: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        // Focus returns to the trigger — a popover that strands focus is a trap.
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ownerLabel = ownership ? OWNER_LABEL[ownership.owner] ?? null : null;
  const inboundLabel = ownership ? ACTION_LABEL[ownership.inboundAction] ?? null : null;
  const outboundLabel = ownership ? ACTION_LABEL[ownership.outboundAction] ?? null : null;

  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-label={t("mdm.erp.chip.aria", { group: groupLabel, system: systemName })}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs text-fg-muted hover:text-fg"
      >
        <span aria-hidden="true">
          <LinkGlyph />
        </span>
        <span>{t("mdm.erp.chip.label")}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("mdm.erp.chip.aria", { group: groupLabel, system: systemName })}
          className="absolute start-0 top-full z-20 mt-1 w-72 max-w-[min(20rem,80vw)] rounded-md border border-border bg-surface p-3 shadow-card"
        >
          <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
            {t("mdm.erp.chip.group")}
          </p>
          <p className="text-sm text-fg">{groupLabel}</p>
          <dl className="mt-2 flex flex-col gap-1.5">
            <PopoverRow label={t("mdm.erp.chip.system")}>
              <span>{systemName}</span>
              <Badge tone="neutral" shape={false}>
                {systemStatusLabel}
              </Badge>
            </PopoverRow>
            {keyKind && keyValue ? (
              <>
                <PopoverRow label={t("mdm.erp.chip.keyType")}>
                  <code className="font-mono text-2xs">{keyKind}</code>
                </PopoverRow>
                <PopoverRow label={t("mdm.erp.chip.keyValue")}>
                  <code className="font-mono text-2xs">{keyValue}</code>
                </PopoverRow>
              </>
            ) : null}
            <PopoverRow label={t("mdm.erp.chip.lastSync")}>
              <TimestampValue value={lastSyncAt} mode="relative" />
            </PopoverRow>
          </dl>
          <p className="mt-2 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
            {t("mdm.erp.chip.ownership")}
          </p>
          {ownership ? (
            <dl className="mt-1 flex flex-col gap-1.5">
              <PopoverRow label={t("mdm.erp.chip.owner")}>
                <span>{ownerLabel ? t(ownerLabel) : ownership.owner}</span>
              </PopoverRow>
              <PopoverRow label={t("mdm.erp.chip.override")}>
                <span>
                  {ownership.overrideAllowed
                    ? t("mdm.erp.ownership.overrideYes")
                    : t("mdm.erp.ownership.overrideNo")}
                </span>
              </PopoverRow>
              <PopoverRow label={t("mdm.erp.chip.inbound")}>
                <span>{inboundLabel ? t(inboundLabel) : ownership.inboundAction}</span>
              </PopoverRow>
              <PopoverRow label={t("mdm.erp.chip.outbound")}>
                <span>{outboundLabel ? t(outboundLabel) : ownership.outboundAction}</span>
              </PopoverRow>
            </dl>
          ) : (
            <p className="mt-1 text-xs text-fg-muted">{t("mdm.erp.ownership.none")}</p>
          )}
          <p className="mt-2 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
            {t("mdm.erp.chip.note")}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {ownership?.noteKey
              ? noteText(t, ownership.noteKey)
              : t("mdm.erp.ownership.none")}
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              buttonRef.current?.focus();
            }}
            className="mt-2 text-xs text-fg-muted underline"
          >
            {t("mdm.erp.chip.close")}
          </button>
        </div>
      ) : null}
    </span>
  );
}

/**
 * The note a sync run attaches to an ownership row is a *catalog key stored as data*
 * (`note_key`), not a translated string in the database — the same rule §4 applies to
 * reason codes. A key this build does not know is shown as the key, never as a
 * reassuring sentence that was invented here.
 */
function noteText(t: (key: MessageKey) => string, key: string): string {
  const known = t(key as MessageKey);
  return known;
}

function PopoverRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-2xs text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-1 text-xs text-fg">{children}</dd>
    </div>
  );
}

function LinkGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" strokeLinecap="round" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" strokeLinecap="round" />
    </svg>
  );
}
