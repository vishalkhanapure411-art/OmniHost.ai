import type { ReactNode } from "react";

import { Chat } from "~/components/icons";
import { Badge, Button, ConfirmSummary } from "~/components/ui";
import { useI18n } from "~/i18n";

/**
 * The chatbot card.
 *
 * The chatbot is the primary interface; these cards land inside its thread. A card is
 * not a new component language — it is the same tokens, the same badges, the same
 * confirm-before-commit rule as the screens, because the spec requires the chatbot to
 * call the identical domain API under the identical server-side permission check, and a
 * card that looked different would be the first hint that it did not.
 *
 * The card's contract:
 *   * **Say what will be written, with the values.** Not "raise an indent" but the
 *     article, the quantity, the site and the cost — a confirmation that hides the
 *     numbers is a confirmation nobody reads.
 *   * **One primary action.** Confirm is the only filled button; edit and cancel are
 *     quiet, because editing is the safe path and cancelling should cost nothing.
 *   * **Disclose the check.** The permission line is part of the card, not a tooltip.
 *     It is the visible half of "a jailbroken prompt cannot grant an action the role
 *     does not hold".
 *   * **Show the committed state in the thread.** After confirming, the card stays,
 *     marked as committed with the created record's identifier, which is what makes the
 *     conversation an audit trail rather than a chat log.
 */
export function ChatCard({
  intent,
  title,
  children,
  footerNote,
  onConfirm,
  onEdit,
  onCancel,
  state = "open",
  committedMessage,
}: {
  /** The intent the gateway resolved, shown as a chip so a mis-resolved intent is visible. */
  intent: string;
  title: string;
  children?: ReactNode;
  footerNote?: string;
  onConfirm?: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
  state?: "open" | "committed";
  committedMessage?: string;
}) {
  const { t } = useI18n();
  const committed = state === "committed";

  return (
    <div className="w-full max-w-xl rounded-lg border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
          <span className="text-accent" aria-hidden="true">
            <Chat size={13} />
          </span>
          {intent}
        </span>
        <Badge tone={committed ? "ok" : "warn"}>
          {committed ? t("action.confirm") : t("pattern.chatcard.queued")}
        </Badge>
      </header>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {children}
        {committed && committedMessage ? <p className="text-xs text-ok">{committedMessage}</p> : null}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-sunken px-3 py-2">
        <span className="max-w-[22rem] text-2xs text-fg-subtle">{footerNote ?? t("pattern.chatcard.disclosure")}</span>
        {committed ? null : (
          <div className="flex items-center gap-1.5">
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                {t("pattern.chatcard.cancel")}
              </Button>
            ) : null}
            {onEdit ? (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                {t("pattern.chatcard.edit")}
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={onConfirm}>
              {t("pattern.chatcard.confirm")}
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

/** A worked "confirm before commit" card, for the pattern spec and the gallery. */
export function ChatCardSample({ dateLabel }: { dateLabel: string }) {
  const { t } = useI18n();
  return (
    <ChatCard intent={t("pattern.chatcard.action")} title={t("pattern.chatcard.action")}>
      <ConfirmSummary
        items={[
          { label: t("pattern.ledger.column.item"), value: "tomato" },
          { label: t("pattern.ledger.column.bookQty"), value: "20 kg" },
          { label: t("approvals.column.due"), value: dateLabel },
        ]}
      />
      <p className="text-xs text-fg-muted">{t("pattern.chatcard.summary", { date: dateLabel })}</p>
    </ChatCard>
  );
}
