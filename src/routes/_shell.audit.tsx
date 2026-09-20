import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "~/components/DataTable";
import { ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { OutcomeBadge, SourceBadge } from "~/components/status";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  Select,
  TableSkeleton,
} from "~/components/ui";
import { BeforeAfter } from "~/components/values";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { AuditEntryView } from "~/domain/inbox";
import { listAuditFn } from "~/server-fns";

/**
 * The audit trail. Every mutation in the platform writes here through one helper, so
 * this screen is a direct view of the spec's requirement rather than a curated report —
 * including refused attempts, which are exactly what a chain's security team asks about
 * and what the chatbot's guardrails produce when a role tries something it does not hold.
 *
 * Two things this screen is strict about:
 *   * **The before/after state is shown raw**, as the domain recorded it. The UI does not
 *     prettify or summarise it, because the audit log is evidence, not a report.
 *   * **The source is always visible** — screen, chatbot or API. The spec claims a
 *     chatbot-initiated transaction is indistinguishable from a screen-driven one
 *     *except* that it is logged; this column is how that claim is checked.
 */
export const Route = createFileRoute("/_shell/audit")({
  staticData: { titleKey: "nav.route./audit" },
  loader: async () => listAuditFn(),
  pendingComponent: AuditPending,
  component: AuditScreen,
});

function AuditPending() {
  const { t } = useI18n();
  return (
    <MasterDetail
      masterLabel={t("a11y.masterPane")}
      master={<TableSkeleton rows={8} columns={2} label={t("state.loading.title")} />}
      detail={<TableSkeleton rows={6} columns={4} label={t("state.loading.title")} />}
    />
  );
}

const OUTCOMES = ["all", "success", "denied", "error"] as const;
type OutcomeFilter = (typeof OUTCOMES)[number];

function AuditScreen() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const { t, format } = useI18n();
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");

  const entries = result.ok ? result.entries : [];
  const needle = query.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (outcome !== "all" && entry.outcome !== outcome) return false;
        if (!needle) return true;
        return [entry.action, entry.actorName ?? "", entry.entityType, entry.actorRole, entry.reason ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      }),
    [entries, needle, outcome]
  );

  const columns: Column<AuditEntryView>[] = [
    {
      key: "when",
      header: t("audit.column.when"),
      sortValue: (entry) => entry.createdAt,
      render: (entry) => <TimestampValue value={entry.createdAt} mode="dateTime" className="text-fg-muted" />,
    },
    {
      key: "actor",
      header: t("audit.column.actor"),
      sortValue: (entry) => entry.actorName ?? "",
      render: (entry) => (
        <span className="block">
          <span className="block text-fg">{entry.actorName ?? t("common.unknown")}</span>
          <code className="block font-mono text-2xs text-fg-subtle">{entry.actorRole}</code>
        </span>
      ),
    },
    {
      key: "action",
      header: t("audit.column.action"),
      sortValue: (entry) => entry.action,
      render: (entry) => (
        <span className="block">
          <code className="block font-mono text-xs text-fg">{entry.action}</code>
          {entry.reason ? <span className="block max-w-xs text-2xs text-fg-muted">{entry.reason}</span> : null}
        </span>
      ),
    },
    {
      key: "entity",
      header: t("audit.column.entity"),
      sortValue: (entry) => entry.entityType,
      render: (entry) => (
        <span className="block text-fg-muted">
          {entry.entityType}
          {entry.entityId ? (
            <code className="block truncate font-mono text-2xs text-fg-subtle">{entry.entityId}</code>
          ) : null}
        </span>
      ),
    },
    {
      key: "chain",
      header: t("chains.column.chain"),
      sortValue: (entry) => entry.chainName ?? "",
      render: (entry) => <span className="text-fg-muted">{entry.chainName ?? t("audit.platform")}</span>,
    },
    {
      key: "outcome",
      header: t("audit.column.outcome"),
      sortValue: (entry) => entry.outcome,
      render: (entry) => <OutcomeBadge outcome={entry.outcome} />,
    },
    {
      key: "source",
      header: t("audit.column.source"),
      sortValue: (entry) => entry.source,
      render: (entry) => (
        <span className="block">
          <SourceBadge source={entry.source} />
          {entry.intent ? <span className="mt-0.5 block text-2xs text-fg-subtle">{t("audit.intent", { intent: entry.intent })}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t("audit.eyebrow")}
        title={t("audit.title")}
        description={t("audit.description")}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void router.invalidate();
            }}
          >
            {t("action.refresh")}
          </Button>
        }
      />

      <MasterDetail
        masterLabel={t("a11y.masterPane")}
        masterWidth="30rem"
        master={
          <>
            <ListToolbar
              filter={
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={t("audit.filter.search.placeholder")}
                  label={t("action.search")}
                />
              }
              actions={
                <Select<OutcomeFilter>
                  ariaLabel={t("audit.filter.outcome.label")}
                  value={outcome}
                  onChange={setOutcome}
                  options={OUTCOMES.map((value) => ({
                    value,
                    label: value === "all" ? t("audit.filter.all") : t(`audit.outcome.${value}` as never),
                  }))}
                />
              }
              meta={format.integer(filtered.length)}
            />
            {!result.ok ? (
              <ErrorState
                title={t("error.forbidden.title")}
                description={t("error.forbidden.description")}
                detail={result.message}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={entries.length === 0 ? t("audit.empty.title") : t("state.noResults.title")}
                description={
                  entries.length === 0
                    ? t("audit.empty.description")
                    : t("state.noResults.description", { query, total: format.integer(entries.length) })
                }
                action={
                  entries.length > 0 ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setOutcome("all");
                      }}
                    >
                      {t("action.clearFilters")}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <DataTable<AuditEntryView>
                caption={t("audit.list.title")}
                columns={columns}
                rows={filtered}
                getRowId={(entry) => entry.id}
                defaultSortKey="when"
                defaultSortDirection="desc"
              />
            )}
          </>
        }
        detail={
          <div className="min-h-full">
            <header className="border-b border-border bg-surface px-4 py-3">
              <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
                {t("audit.detail.eyebrow")}
              </p>
              <h2 className="text-lg font-semibold text-fg">{t("audit.detail.title")}</h2>
              <p className="mt-0.5 text-xs text-fg-muted">{t("audit.detail.empty.description")}</p>
            </header>
            {filtered.length === 0 ? (
              <EmptyState title={t("state.empty.title")} description={t("state.empty.description")} />
            ) : (
              <div className="flex flex-col gap-3 p-4">
                {filtered.slice(0, 25).map((entry) => (
                  <Card key={entry.id}>
                    <CardHeader
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-xs">{entry.action}</code>
                          <OutcomeBadge outcome={entry.outcome} />
                          <SourceBadge source={entry.source} />
                        </span>
                      }
                      subtitle={
                        <span className="flex flex-wrap items-center gap-x-2">
                          <span>{entry.actorName ?? t("common.unknown")}</span>
                          <span className="font-mono text-2xs">{entry.actorRole}</span>
                          <span>{entry.chainName ?? t("audit.platform")}</span>
                          <TimestampValue value={entry.createdAt} mode="weekday" />
                        </span>
                      }
                    />
                    <div className="p-3">
                      <BeforeAfter before={entry.before} after={entry.after} />
                    </div>
                  </Card>
                ))}
                {filtered.length > 25 ? (
                  <p className="text-2xs text-fg-subtle">
                    {t("common.showing", { shown: format.integer(25), total: format.integer(filtered.length) })}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        }
      />
    </>
  );
}
