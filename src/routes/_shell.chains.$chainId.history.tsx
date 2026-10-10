import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "~/components/DataTable";
import { Drawer } from "~/components/drawer";
import { OutcomeBadge, SourceBadge } from "~/components/status";
import { Button, Card, CardHeader, EmptyState, ErrorState, SearchInput, TableSkeleton } from "~/components/ui";
import { BeforeAfter, TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { AuditEntryView } from "~/domain/inbox";
import { listAuditFn } from "~/server-fns";

/**
 * History — this chain's slice of the audit trail.
 *
 * It is the same ledger `/audit` renders, filtered to the chain and read through the same
 * server function, so there is exactly one audit implementation in the product. The tab is
 * gated by `chain.audit.read` (the App-layer capability; the chain's own `audit.read` is a
 * different question with a different answer) — and it is *disabled with its reason*
 * rather than hidden, so an operator without it knows the capability exists.
 *
 * **One honest limit, stated on the screen:** `listAuditFn` returns the newest 100 entries
 * this session may read, across every chain it can reach, and this tab filters that set.
 * For a chain whose whole activity fits inside those entries — every pilot chain today —
 * that is the complete history. For a chain quieter than the platform, older entries fall
 * outside the window and are not shown. A `chainId` filter on the read model would fix it
 * (`listAuditEntries` already accepts one); the server function does not pass it yet, and
 * wiring that is API work, not screen work, so it is reported rather than rushed.
 *
 * Rows open in a `Drawer` instead of navigating: the diff of one entry is read *beside*
 * the ledger, so the operator keeps the row and the reasoning in one glance.
 */
const parent = getRouteApi("/_shell/chains/$chainId");
const MAX = 100;

export const Route = createFileRoute("/_shell/chains/$chainId/history")({
  staticData: { titleKey: "chains.tab.history" },
  loader: async () => listAuditFn(),
  pendingComponent: HistoryPending,
  component: ChainHistory,
});

function HistoryPending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4">
      <TableSkeleton rows={8} columns={5} label={t("state.loading.title")} />
    </div>
  );
}

function ChainHistory() {
  const { detail } = parent.useLoaderData();
  const result = Route.useLoaderData();
  const { t, format } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [openEntry, setOpenEntry] = useState<AuditEntryView | null>(null);

  const chainId = detail.ok ? detail.chain.id : "";
  const mine = useMemo(
    () => (result.ok ? result.entries.filter((entry) => entry.chainId === chainId) : []),
    [result, chainId]
  );

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? mine.filter((entry) =>
        [entry.action, entry.actorName ?? "", entry.actorRole, entry.entityType, entry.reason ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : mine;

  if (!detail.ok) return null;
  const chain = detail.chain;

  const columns: Column<AuditEntryView>[] = [
    {
      key: "when",
      header: t("audit.column.when"),
      sortValue: (entry) => entry.createdAt,
      render: (entry) => <TimestampValue value={entry.createdAt} mode="dateTime" />,
    },
    {
      key: "actor",
      header: t("audit.column.actor"),
      sortValue: (entry) => entry.actorName ?? "",
      render: (entry) => (
        <span className="flex flex-col">
          <span className="text-text">{entry.actorName ?? t("common.unknown")}</span>
          <span className="font-mono text-2xs text-subtle-text">{entry.actorRole}</span>
        </span>
      ),
    },
    {
      key: "action",
      header: t("audit.column.action"),
      sortValue: (entry) => entry.action,
      render: (entry) => <code className="font-mono text-xs">{entry.action}</code>,
    },
    {
      key: "entity",
      header: t("audit.column.entity"),
      hideBelow: "40rem",
      sortValue: (entry) => entry.entityType,
      render: (entry) => <code className="font-mono text-xs text-muted-text">{entry.entityType}</code>,
    },
    {
      key: "outcome",
      header: t("audit.column.outcome"),
      hideBelow: "32rem",
      sortValue: (entry) => entry.outcome,
      render: (entry) => <OutcomeBadge outcome={entry.outcome} />,
    },
    {
      key: "source",
      header: t("audit.column.source"),
      hideBelow: "48rem",
      sortValue: (entry) => entry.source,
      render: (entry) => <SourceBadge source={entry.source} />,
    },
    {
      key: "open",
      header: <span className="sr-only">{t("audit.detail.title")}</span>,
      srOnlyHeader: true,
      className: "col-action",
      width: "3rem",
      render: (entry) => (
        <Button
          size="sm"
          variant="quiet"
          aria-label={t("audit.detail.title")}
          title={t("audit.detail.title")}
          onClick={() => {
            setOpenEntry(entry);
          }}
        >
          {t("audit.column.detail")}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-4" aria-labelledby={`chain-${chain.id}-tab-history`}>
      {!result.ok ? (
        <Card>
          <ErrorState
            title={t("error.forbidden.title")}
            description={t("error.forbidden.description")}
            detail={result.message}
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={t("chains.history.title")}
            subtitle={t("chains.history.note", { limit: format.integer(MAX) })}
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
          <div className="border-b border-border px-3 py-2">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("common.search.placeholder")}
              label={t("action.search")}
            />
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={t("chains.history.empty.title")}
              description={t("chains.history.empty.description")}
            />
          ) : (
            <DataTable<AuditEntryView>
              caption={t("chains.history.title")}
              columns={columns}
              rows={filtered}
              getRowId={(entry) => entry.id}
              defaultSortKey="when"
              defaultSortDirection="desc"
              footer={
                <span>
                  {t("common.showing", {
                    shown: format.integer(filtered.length),
                    total: format.integer(mine.length),
                  })}
                </span>
              }
            />
          )}
        </Card>
      )}

      <Drawer
        open={openEntry !== null}
        onClose={() => {
          setOpenEntry(null);
        }}
        width="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{openEntry?.action ?? ""}</code>
            {openEntry ? <OutcomeBadge outcome={openEntry.outcome} /> : null}
          </span>
        }
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setOpenEntry(null);
            }}
          >
            {t("action.close")}
          </Button>
        }
      >
        {openEntry ? (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <dt className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
                  {t("audit.column.actor")}
                </dt>
                <dd className="text-sm text-text">
                  {openEntry.actorName ?? t("common.unknown")}{" "}
                  <span className="font-mono text-2xs text-subtle-text">{openEntry.actorRole}</span>
                </dd>
              </div>
              <div>
                <dt className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
                  {t("audit.column.when")}
                </dt>
                <dd className="text-sm text-text">
                  <TimestampValue value={openEntry.createdAt} mode="dateTime" />
                </dd>
              </div>
              <div>
                <dt className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
                  {t("audit.column.entity")}
                </dt>
                <dd className="font-mono text-xs text-text">{openEntry.entityType}</dd>
              </div>
              <div>
                <dt className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
                  {t("audit.column.source")}
                </dt>
                <dd>
                  <SourceBadge source={openEntry.source} />
                </dd>
              </div>
            </dl>
            {openEntry.reason ? (
              <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-xs text-muted-text">
                {openEntry.reason}
              </p>
            ) : null}
            <BeforeAfter before={openEntry.before} after={openEntry.after} />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
