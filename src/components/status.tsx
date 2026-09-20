import { Badge, type BadgeTone } from "~/components/ui";
import { useT } from "~/i18n";
import type { LicenceTier } from "~/domain/chains";

/**
 * Domain-meaning badges.
 *
 * These live in one file so a status means the same thing on every screen: a Silver
 * chain, a refused audit attempt and a high-severity exception are drawn identically in
 * the chain list, the audit trail, an approval row and — later — the chatbot's card,
 * because they all call these.
 *
 * Each badge carries a shape as well as a colour. An operator with a colour-vision
 * deficiency, a monochrome printout or a screen-shared call sees the same distinction.
 * The raw code (`silver`, `denied`, the permission string) stays available in the
 * tooltip, because that is what the API, the spec and the audit log call it.
 */

const TIER_TONE: Record<LicenceTier, BadgeTone> = {
  silver: "neutral",
  gold: "info",
  platinum: "accent",
};

export function TierBadge({ tier, title }: { tier: LicenceTier; title?: string }) {
  const t = useT();
  return (
    <Badge tone={TIER_TONE[tier]} title={title ?? t("chains.tier.help")} mono={false}>
      {t(`chains.tier.${tier}` as never)}
    </Badge>
  );
}

const CHAIN_STATUS_TONE: Record<string, BadgeTone> = {
  active: "ok",
  suspended: "warn",
  pending: "neutral",
};

export function ChainStatusBadge({ status }: { status: string }) {
  const t = useT();
  const key = `chains.status.${status}`;
  const label = ["active", "suspended", "pending"].includes(status) ? t(key as never) : status;
  return <Badge tone={CHAIN_STATUS_TONE[status] ?? "neutral"}>{label}</Badge>;
}

const OUTCOME_TONE: Record<string, BadgeTone> = {
  success: "ok",
  denied: "danger",
  error: "warn",
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const t = useT();
  const key = `audit.outcome.${outcome}`;
  const label = ["success", "denied", "error"].includes(outcome) ? t(key as never) : outcome;
  return <Badge tone={OUTCOME_TONE[outcome] ?? "neutral"}>{label}</Badge>;
}

export type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  low: "neutral",
  medium: "info",
  high: "warn",
  critical: "danger",
};

/**
 * Exception/severity badge. Cross-cutting for Controls, QA, Revenue Assurance and the
 * support ticket queue — one vocabulary, so "High" means one thing platform-wide.
 */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const t = useT();
  return <Badge tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}` as never)}</Badge>;
}

export type ApprovalState = "open" | "in_review" | "closed" | "overdue";

const APPROVAL_TONE: Record<ApprovalState, BadgeTone> = {
  open: "info",
  in_review: "warn",
  closed: "ok",
  overdue: "danger",
};

export function ApprovalStateBadge({ state }: { state: ApprovalState }) {
  const t = useT();
  const labels: Record<ApprovalState, string> = {
    open: t("approvals.queue.title"),
    in_review: t("action.review"),
    closed: t("audit.outcome.success"),
    overdue: t("approvals.queue.overdue"),
  };
  return <Badge tone={APPROVAL_TONE[state]}>{labels[state]}</Badge>;
}

const SOURCE_LABEL_KEY: Record<string, string> = {
  screen: "audit.source.screen",
  chatbot: "audit.source.chatbot",
  api: "audit.source.api",
};

/**
 * Where a mutation came from. Worth its own badge: the spec's promise is that a
 * chatbot-initiated transaction is indistinguishable from a screen-driven one in the
 * audit trail, and the only way to check that claim is to be able to see it.
 */
export function SourceBadge({ source }: { source: string }) {
  const t = useT();
  const key = SOURCE_LABEL_KEY[source];
  const label = key ? t(key as never) : source;
  return (
    <Badge tone={source === "chatbot" ? "accent" : "neutral"} shape={false} mono={source === "api"}>
      {label}
    </Badge>
  );
}

/** A ticket category, as the support queue and the approval queue both render it. */
export function CategoryBadge({ category }: { category: string }) {
  return (
    <Badge tone="neutral" shape={false} mono>
      {category}
    </Badge>
  );
}
