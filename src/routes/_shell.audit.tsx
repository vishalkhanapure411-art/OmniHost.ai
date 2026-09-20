import { createFileRoute } from "@tanstack/react-router";

import { MasterDetail, MasterHeader } from "~/components/MasterDetail";
import { Badge, BeforeAfter, EmptyState, PageHeader, formatWhen } from "~/components/ui";
import { listAuditFn } from "~/server-fns";

/**
 * The audit trail. Every mutation in this phase writes here through one helper, so this
 * screen is a direct view of the spec's requirement rather than a curated report —
 * including refused attempts, which are exactly what a chain's security team asks about.
 */
export const Route = createFileRoute("/_shell/audit")({
  staticData: { title: "Audit trail" },
  loader: async () => listAuditFn(),
  component: AuditScreen,
});

const OUTCOME_TONE: Record<string, "ok" | "danger" | "warn"> = {
  success: "ok",
  denied: "danger",
  error: "warn",
};

function AuditScreen() {
  const result = Route.useLoaderData();
  const entries = result.ok ? result.entries : [];

  return (
    <>
      <PageHeader
        eyebrow="Controls · Transparency"
        title="Audit trail"
        description="Who, which role, which chain and site, what action, and the state before and after — written by the same shared helper for every mutation."
      />
      <MasterDetail
        masterLabel="Audit entries"
        master={
          <>
            <MasterHeader title="Most recent" count={entries.length} />
            {entries.length === 0 ? (
              <EmptyState
                title={result.ok ? "Nothing recorded yet" : "Not permitted"}
                description={
                  result.ok
                    ? "No audited action is visible to your scope yet."
                    : `${result.message} Holding no audit capability is the expected state for most roles.`
                }
              />
            ) : (
              <ul>
                {entries.map((entry) => (
                  <li key={entry.id} className="list-row border-b border-border">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-fg">{entry.action}</span>
                      <Badge tone={OUTCOME_TONE[entry.outcome] ?? "neutral"}>{entry.outcome}</Badge>
                    </div>
                    <p className="mt-0.5 text-2xs text-fg-muted">
                      {entry.actorName ?? "unknown"} · {entry.actorRole} · {entry.actorScope} ·{" "}
                      {formatWhen(entry.createdAt)}
                    </p>
                    <p className="text-2xs text-fg-subtle">
                      {entry.chainName ?? "platform"} · {entry.entityType}
                      {entry.entityId ? `:${entry.entityId.slice(0, 8)}` : ""} · {entry.source}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        }
        detail={
          <div>
            <header className="border-b border-border bg-surface px-4 py-3">
              <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
                Before / after
              </p>
              <h2 className="text-lg font-semibold text-fg">State changes</h2>
            </header>
            {entries.length === 0 ? (
              <EmptyState
                title="No entries to show"
                description="Once a mutation runs, its before and after state appears here."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>State change</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, 60).map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap text-fg-muted">{formatWhen(entry.createdAt)}</td>
                      <td>
                        <span className="text-fg">{entry.actorName ?? "unknown"}</span>
                        <span className="block font-mono text-2xs text-fg-subtle">{entry.actorRole}</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-fg">{entry.action}</span>
                        {entry.reason ? (
                          <span className="mt-0.5 block max-w-xs text-2xs text-fg-muted">{entry.reason}</span>
                        ) : null}
                      </td>
                      <td className="text-fg-muted">
                        {entry.entityType}
                        {entry.entityId ? (
                          <span className="block font-mono text-2xs text-fg-subtle">{entry.entityId}</span>
                        ) : null}
                      </td>
                      <td>
                        <BeforeAfter before={entry.before} after={entry.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        }
      />
    </>
  );
}
