import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { ChainsTabs } from "~/components/ChainsTabs";
import { DataTable, type Column } from "~/components/DataTable";
import { TierChange } from "~/components/TierChange";
import { ChainStatusBadge, TierBadge } from "~/components/status";
import { CodeLabel, TimestampValue } from "~/components/values";
import { ChevronDown, ChevronRight, Store } from "~/components/icons";
import {
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  TableSkeleton,
} from "~/components/ui";
import { useI18n } from "~/i18n";
import { currencyForJurisdiction } from "~/i18n/locales";
import type { ChainSummary } from "~/domain/chains";
import { getChainFn, listAuditFn, listChainsFn } from "~/server-fns";

/**
 * Chains — the AppAdmin browse screen, and the exemplar every later module copies.
 *
 * What changed and why (owner, 8 Oct: the built pages were "not looking professional";
 * 9 Oct: the designer owns the screens):
 *
 *   * **No master-detail split.** The detail half was a static explainer about onboarding —
 *     a second task on a browse screen, and one that repeated itself three times (header
 *     button, card title, card button). The list is full width now, and the verb "Onboard a
 *     chain" appears exactly once, as a tab.
 *   * **One bar for the two tasks.** `[ Chains | Onboard a chain ]` — the browse screen and
 *     the form are siblings, each with its own URL.
 *   * **The detail is inline, not a navigation.** Expanding a row appends its facts under
 *     its own row: the list keeps its scroll position, sort and filter, and
 *     `location.pathname` stays `/chains`. Clicking the row body still opens the full record
 *     for the operator who wants the whole thing.
 *   * **The table fits.** It adopts the mechanism that already existed for this
 *     (`DataTable`'s `hideBelow` + `.table-scroll`): columns drop lowest-priority-first
 *     instead of forcing a permanent horizontal scrollbar. The chain list was the one list
 *     that already used it correctly; the whole screen now does.
 *
 * The four states are still handled here on purpose — loading, empty in scope, filtered to
 * nothing, and refused — because a browse screen is where an operator learns which one they
 * are in.
 */
export const Route = createFileRoute("/_shell/chains/")({
  staticData: { titleKey: "nav.route./chains" },
  loader: async () => listChainsFn(),
  pendingComponent: ChainsPending,
  component: ChainsScreen,
});

function ChainsPending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4">
      <TableSkeleton rows={8} columns={5} label={t("state.loading.title")} />
    </div>
  );
}

function ChainsScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canOnboard = principal.permissions.includes("chain.onboard");
  const canUpdateTier = principal.permissions.includes("chain.tier.update");
  const chains = result.ok ? result.chains : [];

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? chains.filter((chain) =>
        [chain.name, chain.code, chain.taxJurisdiction ?? "", chain.licenceTier]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : chains;

  const siteTotal = chains.reduce((sum, chain) => sum + chain.siteCount, 0);
  const featuresOn = chains.reduce((sum, chain) => sum + chain.enabledFeatureCount, 0);
  const featuresTotal = chains.reduce((sum, chain) => sum + chain.featureCount, 0);

  const columns: Column<ChainSummary>[] = [
    {
      key: "chain",
      header: t("chains.column.chain"),
      sortValue: (chain) => chain.name,
      render: (chain) => <CodeLabel label={chain.name} code={chain.code} />,
    },
    {
      key: "tier",
      header: t("chains.column.tier"),
      sortValue: (chain) => chain.licenceTier,
      render: (chain) => <TierBadge tier={chain.licenceTier} />,
    },
    {
      key: "status",
      header: t("chains.column.status"),
      sortValue: (chain) => chain.status,
      render: (chain) => <ChainStatusBadge status={chain.status} />,
    },
    {
      key: "jurisdiction",
      hideBelow: "40rem",
      header: t("chains.column.jurisdiction"),
      sortValue: (chain) => chain.taxJurisdiction ?? "",
      render: (chain) => (
        <span className="font-mono text-xs text-muted-text">{chain.taxJurisdiction ?? t("common.none")}</span>
      ),
    },
    {
      key: "sites",
      hideBelow: "32rem",
      header: t("chains.column.sites"),
      numeric: true,
      sortValue: (chain) => chain.siteCount,
      render: (chain) => <span className="num">{format.integer(chain.siteCount)}</span>,
    },
    {
      key: "features",
      hideBelow: "48rem",
      header: t("chains.column.features"),
      headerTitle: t("chains.detail.features.title"),
      numeric: true,
      sortValue: (chain) => chain.enabledFeatureCount,
      render: (chain) => (
        <span className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-14 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
            <span
              className="block h-full bg-primary"
              style={{
                width: `${
                  chain.featureCount > 0
                    ? Math.round((chain.enabledFeatureCount / chain.featureCount) * 100)
                    : 0
                }%`,
              }}
            />
          </span>
          <span className="num text-xs">
            {t("chains.features.enabledOf", {
              enabled: format.integer(chain.enabledFeatureCount),
              total: format.integer(chain.featureCount),
            })}
          </span>
        </span>
      ),
    },
    {
      key: "onboarded",
      hideBelow: "56rem",
      header: t("chains.column.onboarded"),
      sortValue: (chain) => chain.onboardedAt,
      render: (chain) => <TimestampValue value={chain.onboardedAt} mode="date" className="text-muted-text" />,
    },
    {
      key: "expand",
      header: <span className="sr-only">{t("chains.expanded.openRecord")}</span>,
      srOnlyHeader: true,
      className: "col-action",
      width: "3rem",
      render: (chain) => {
        const expanded = expandedId === chain.id;
        return (
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            aria-expanded={expanded}
            aria-controls={`chain-band-${chain.id}`}
            title={expanded ? t("chains.list.collapse", { chain: chain.name }) : t("chains.list.expand", { chain: chain.name })}
            onClick={(event) => {
              event.stopPropagation();
              setExpandedId(expanded ? null : chain.id);
            }}
          >
            <span className="sr-only">
              {expanded ? t("chains.list.collapse", { chain: chain.name }) : t("chains.list.expand", { chain: chain.name })}
            </span>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        );
      },
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow={t("chains.eyebrow")} title={t("chains.title")} description={t("chains.description")} />
      <ChainsTabs active="list" count={result.ok ? chains.length : undefined} />

      {result.ok && chains.length > 0 ? (
        <section
          aria-label={t("chains.kpi.aria")}
          className="flex flex-wrap items-stretch gap-3 border-b border-border bg-surface px-5 py-3"
        >
          <KpiTile label={t("chains.kpi.chains")} value={format.integer(chains.length)} />
          <KpiTile label={t("chains.kpi.sites")} value={format.integer(siteTotal)} />
          <KpiTile
            label={t("chains.kpi.featuresOn")}
            value={t("chains.features.enabledOf", {
              enabled: format.integer(featuresOn),
              total: format.integer(featuresTotal),
            })}
          />
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t("common.search.placeholder")}
          label={t("action.search")}
        />
        {result.ok && chains.length > 0 ? (
          <span className="text-2xs text-subtle-text">
            {format.integer(filtered.length)} / {format.integer(chains.length)}
          </span>
        ) : null}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {busy ? (
            <span className="text-2xs text-subtle-text">{t("common.loading")}</span>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setBusy(true);
                void router.invalidate().finally(() => {
                  setBusy(false);
                });
              }}
            >
              {t("action.refresh")}
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!result.ok ? (
          <div className="p-4">
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
          </div>
        ) : chains.length === 0 ? (
          <EmptyState
            icon={<Store size={20} />}
            title={t("chains.list.empty.title")}
            description={t("chains.list.empty.description")}
            action={
              canOnboard ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    void router.navigate({ to: "/chains/onboard" });
                  }}
                >
                  {t("chains.onboard.title")}
                </Button>
              ) : undefined
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            title={t("state.noResults.title")}
            description={t("state.noResults.description", {
              query,
              total: format.integer(chains.length),
            })}
            action={
              <Button
                size="sm"
                onClick={() => {
                  setQuery("");
                }}
              >
                {t("action.clearFilters")}
              </Button>
            }
          />
        ) : (
          <DataTable<ChainSummary>
            caption={t("chains.list.title")}
            columns={columns}
            rows={filtered}
            getRowId={(chain) => chain.id}
            defaultSortKey="onboarded"
            defaultSortDirection="desc"
            expandedId={expandedId ?? undefined}
            renderExpanded={(chain) => (
              <ExpandedChain
                chain={chain}
                canUpdateTier={canUpdateTier}
                onOpenRecord={() => {
                  void router.navigate({ to: "/chains/$chainId", params: { chainId: chain.id } });
                }}
              />
            )}
            onSelect={(chain) => {
              void router.navigate({ to: "/chains/$chainId", params: { chainId: chain.id } });
            }}
            footer={
              <span>
                {t("common.showing", {
                  shown: format.integer(filtered.length),
                  total: format.integer(chains.length),
                })}
              </span>
            }
          />
        )}
      </div>
    </div>
  );
}

/** One KPI tile. The brass rule is a shape, never a label (see tokens.css, `--color-flag`). */
function KpiTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-36 rounded-lg border border-border bg-surface px-3 py-2">
      <span className="block h-0.5 w-6 rounded-pill bg-flag" aria-hidden="true" />
      <p className="mt-1.5 text-2xs font-semibold tracking-wide text-subtle-text uppercase">{label}</p>
      <p className="num mt-0.5 text-lg font-semibold text-text">{value}</p>
    </div>
  );
}

/**
 * The expanded row's band: the record's facts without leaving the list.
 *
 * Two reads happen lazily on expand, and only on expand — the chain's own detail (which
 * carries the feature list) and the audit slice this session may read. The list read model
 * is deliberately not widened for a browse screen: `listChains` stays a list.
 *
 * **Deliberately absent: contract and billing.** The preview that this exemplar comes from
 * shows both, and neither has a field anywhere in the domain — `ChainSummary` and
 * `ChainDetail` carry no contract date, no billing basis, no merchant-of-record. A screen
 * that prints a plausible-looking answer to a question the database cannot answer is worse
 * than one that does not ask, so they are dropped rather than faked.
 */
function ExpandedChain({
  chain,
  canUpdateTier,
  onOpenRecord,
}: {
  chain: ChainSummary;
  canUpdateTier: boolean;
  onOpenRecord: () => void;
}) {
  const { t, format } = useI18n();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getChainFn>> | null>(null);
  const [recent, setRecent] = useState<Awaited<ReturnType<typeof listAuditFn>> | null>(null);

  // One lazy read per source, fired once per mount. The band mounts on expand and unmounts
  // on collapse, so the next expand re-reads — which is what an operator expects after a
  // change elsewhere.
  useEffect(() => {
    let live = true;
    void getChainFn({ data: { chainId: chain.id } }).then((next) => {
      if (live) setDetail(next);
    });
    void listAuditFn().then((next) => {
      if (live) setRecent(next);
    });
    return () => {
      live = false;
    };
  }, [chain.id]);

  const currency = currencyForJurisdiction(chain.taxJurisdiction);
  const chainRows = recent?.ok ? recent.entries.filter((entry) => entry.chainId === chain.id).slice(0, 3) : [];

  return (
    <div id={`chain-band-${chain.id}`} className="flex flex-col gap-4 border-t border-border px-4 py-3">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
            {t("chains.expanded.licence")}
          </p>
          <DescriptionList
            columns={2}
            items={[
              { label: t("chains.column.tier"), value: <TierBadge tier={chain.licenceTier} /> },
              { label: t("chains.column.status"), value: <ChainStatusBadge status={chain.status} /> },
              {
                label: t("chains.column.jurisdiction"),
                value: <span className="font-mono text-xs">{chain.taxJurisdiction ?? t("common.none")}</span>,
              },
              {
                label: t("common.currency.label"),
                value: <code className="font-mono text-xs">{currency ?? t("common.none")}</code>,
              },
              {
                label: t("chains.column.sites"),
                value: <span className="num">{format.integer(chain.siteCount)}</span>,
              },
              {
                label: t("chains.column.onboarded"),
                value: <TimestampValue value={chain.onboardedAt} mode="date" />,
              },
            ]}
          />

          <div className="flex flex-col gap-1.5">
            <p className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
              {t("chains.expanded.features")}
            </p>
            <div className="flex items-center gap-2">
              <span className="h-2 w-32 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
                <span
                  className="block h-full bg-primary"
                  style={{
                    width: `${
                      chain.featureCount > 0
                        ? Math.round((chain.enabledFeatureCount / chain.featureCount) * 100)
                        : 0
                    }%`,
                  }}
                />
              </span>
              <span className="num text-xs text-text">
                {t("chains.features.enabledOf", {
                  enabled: format.integer(chain.enabledFeatureCount),
                  total: format.integer(chain.featureCount),
                })}
              </span>
            </div>
            {detail && !detail.ok ? (
              <p className="text-2xs text-subtle-text">{t("common.none")}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
              {t("chains.expanded.changeTier")}
            </p>
            <TierChange chain={chain} canUpdate={canUpdateTier} compact />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
              {t("chains.expanded.recentChanges")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void onOpenRecord();
              }}
            >
              {t("chains.expanded.openRecord")}
            </Button>
          </div>
          {recent === null ? (
            <p className="text-xs text-subtle-text">{t("common.loading")}</p>
          ) : chainRows.length === 0 ? (
            <p className="text-xs text-subtle-text">{t("chains.history.empty.title")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {chainRows.map((entry) => (
                <li key={entry.id} className="flex items-baseline gap-2 text-xs">
                  <TimestampValue value={entry.createdAt} mode="dateTime" className="text-subtle-text" />
                  <span className="font-mono text-2xs text-muted-text">{entry.action}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
