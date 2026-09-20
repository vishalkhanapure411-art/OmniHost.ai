import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ApprovalQueueList, type ApprovalRowView } from "~/components/ApprovalQueue";
import { ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { Check, Plus } from "~/components/icons";
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader } from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import { listApprovalsFn } from "~/server-fns";

/**
 * The approvals / task inbox — the shared maker-checker surface.
 *
 * Spec "Chatbot Interaction Model" (guardrails): "Maker-checker actions route the
 * confirmation card to the approver's own chatbot as an actionable item, not to the
 * requester". Phase 0a ships the route, the routing model and the scope filters; the
 * modules that raise items (receiving, waste, refunds) arrive with their phases, so the
 * honest state today is the empty state below — stated as what it is, not dressed up as
 * activity.
 *
 * The row shape (`ApprovalQueueRow`) is already the one the later modules will use, and
 * the design gallery exercises it with worked examples so the pattern is reviewable
 * before the first real item exists.
 */
export const Route = createFileRoute("/_shell/approvals")({
  staticData: { titleKey: "nav.route./approvals" },
  loader: async () => listApprovalsFn(),
  component: ApprovalsScreen,
});

function ApprovalsScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);

  const items: ApprovalRowView[] = (result.ok ? result.inbox.items : []).map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    chainName: item.chainName,
    siteName: item.siteName,
    category: item.category,
    state: item.status === "open" ? "open" : "closed",
    dueAt: item.dueAt,
    raisedBy: item.raisedBy,
    raisedByRole: item.raisedByRole,
    assignedRole: item.assignedRole,
  }));

  return (
    <>
      <PageHeader
        eyebrow={t("approvals.eyebrow")}
        title={t("approvals.title")}
        description={t("approvals.description")}
        meta={
          result.ok ? (
            <span className="text-2xs text-fg-subtle">
              {format.integer(result.inbox.mine)} · {t("approvals.queue.title")}
            </span>
          ) : undefined
        }
      />

      <MasterDetail
        masterLabel={t("a11y.queue")}
        master={
          <>
            <ListToolbar
              meta={result.ok ? format.integer(items.length) : undefined}
              actions={
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    void router.invalidate();
                  }}
                >
                  {t("action.refresh")}
                </Button>
              }
            />
            {notice ? (
              <p className="border-b border-border bg-info-soft px-3 py-1.5 text-xs text-fg">{notice}</p>
            ) : null}
            {!result.ok ? (
              <ErrorState
                title={t("error.title")}
                description={t("error.description")}
                detail={result.message}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void router.invalidate();
                    }}
                  >
                    {t("action.retry")}
                  </Button>
                }
              />
            ) : (
              <ApprovalQueueList
                items={items}
                onDecide={(item) => {
                  setNotice(t("approvals.how.footer", { name: item.title, roles: item.assignedRole ?? "" }));
                }}
                emptyState={
                  <EmptyState
                    icon={<Check size={20} />}
                    title={t("approvals.empty.title")}
                    description={t("approvals.empty.description")}
                  />
                }
              />
            )}
          </>
        }
        detail={
          <div className="flex flex-col gap-4 p-4">
            <Card>
              <CardHeader title={t("approvals.how.title")} subtitle={t("approvals.how.subtitle")} />
              <div className="flex flex-col gap-3 p-4 text-xs text-fg-muted">
                <p>{t("approvals.how.paragraph1")}</p>
                <p>{t("approvals.how.paragraph2")}</p>
                <p className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                  {t("approvals.how.footer", {
                    name: principal.displayName,
                    roles:
                      principal.roles.map((role) => role.name).join(", ") || t("shell.roles.none"),
                  })}
                </p>
                <p className="flex items-center gap-1 text-2xs text-fg-subtle">
                  <span aria-hidden="true">
                    <Plus size={12} />
                  </span>
                  {t("pattern.approval.body")}
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader title={t("shell.permissions.title")} />
              <ul className="flex flex-col gap-1 p-4 text-xs text-fg-muted">
                <li>
                  {t("shell.grants.title.one")} · <TimestampValue value={principal.sessionExpiresAt} mode="weekday" />
                </li>
              </ul>
            </Card>
          </div>
        }
      />
    </>
  );
}
