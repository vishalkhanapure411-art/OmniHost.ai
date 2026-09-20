import { createFileRoute } from "@tanstack/react-router";

import { MasterDetail, MasterHeader } from "~/components/MasterDetail";
import { Card, CardHeader, EmptyState, Note, PageHeader, formatWhen } from "~/components/ui";
import { listApprovalsFn } from "~/server-fns";

/**
 * The approvals / task inbox — the shared maker-checker surface.
 *
 * Spec "Chatbot Interaction Model" (guardrails): "Maker-checker actions route the
 * confirmation card to the approver's own chatbot as an actionable item, not to the
 * requester". Phase 0a ships the route, the routing model and the scope filters; the
 * modules that raise items (receiving, waste, refunds) arrive with their phases, so
 * the honest state today is the empty state below.
 */
export const Route = createFileRoute("/_shell/approvals")({
  staticData: { title: "Approvals & tasks" },
  loader: async () => listApprovalsFn(),
  component: ApprovalsScreen,
});

function ApprovalsScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const items = result.ok ? result.inbox.items : [];

  return (
    <>
      <PageHeader
        eyebrow="Shared inbox"
        title="Approvals & tasks"
        description="Items routed to a role you hold. Maker-checker actions land with the approver, never back with the requester."
      />
      <MasterDetail
        masterLabel="Approval queue"
        master={
          <>
            <MasterHeader title="Waiting on you" count={items.length} />
            {items.length === 0 ? (
              <EmptyState
                title="Nothing waiting on you"
                description="No maker-checker item is routed to your roles yet. Receiving approvals, waste write-offs and refund sign-offs start raising items when their modules ship."
              />
            ) : (
              <ul>
                {items.map((item) => (
                  <li key={item.id} className="list-row border-b border-border">
                    <p className="text-sm font-medium text-fg">{item.title}</p>
                    <p className="text-xs text-fg-muted">
                      {item.chainName} · {item.category} · {item.assignedRole ?? "unassigned"} · due{" "}
                      {formatWhen(item.dueAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        }
        detail={
          <div className="flex flex-col gap-4 p-4">
            <Card>
              <CardHeader
                title="How this inbox works"
                subtitle="Built from the spec's maker-checker rule, not from a screen design."
              />
              <div className="flex flex-col gap-3 p-4 text-xs text-fg-muted">
                <p>
                  Every item is an <code className="font-mono">approval_task</code> row carrying its
                  chain, its site, the role that raised it and the role that must decide. The query
                  behind this screen filters on the roles you hold and on your resolved tenant scope,
                  so an item can never appear to someone it was not routed to.
                </p>
                <p>
                  An SLA breach escalates one level — Team to Head, Head to Site Head or Operations —
                  and closure requires the raising role or their Head to verify the fix, per the
                  spec's ticketing rules.
                </p>
                <Note tone="info">
                  Signed in as <strong>{principal.displayName}</strong> with{" "}
                  {principal.roles.map((role) => role.name).join(", ") || "no role"} — that is what
                  this queue is filtered to.
                </Note>
              </div>
            </Card>
          </div>
        }
      />
    </>
  );
}
