import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ChainList } from "~/components/ChainList";
import { ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { ArrowRight, Plus, Store } from "~/components/icons";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  TableSkeleton,
} from "~/components/ui";
import { useI18n } from "~/i18n";
import { listChainsFn } from "~/server-fns";

/**
 * Chains — the AppAdmin slice's list.
 *
 * The list pane is the master-data pattern the later modules copy: a filter, sortable
 * columns, a selection that is addressable in the URL, and a footer that says how many
 * rows you are looking at. The detail pane is what you land on before choosing: the
 * pattern, the entry point to onboarding, and an honest note about what an empty list
 * means.
 *
 * Four states are handled here on purpose, because these are the ones that break UIs:
 *   * **loading** — `pendingComponent`, a skeleton with the same row rhythm as the table;
 *   * **empty in scope** — no chain at all, which for a delegated operator is the
 *     permission model working, not an error;
 *   * **filtered to nothing** — a different sentence, because the fix is different;
 *   * **refused** — the server's own message, never re-worded by the UI.
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
    <MasterDetail
      masterLabel={t("a11y.masterPane")}
      master={<TableSkeleton rows={8} columns={4} label={t("state.loading.title")} />}
      detail={
        <div className="p-4">
          <TableSkeleton rows={5} columns={2} label={t("state.loading.title")} />
        </div>
      }
    />
  );
}

function ChainsScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const canOnboard = principal.permissions.includes("chain.onboard");
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

  return (
    <>
      <PageHeader
        eyebrow={t("chains.eyebrow")}
        title={t("chains.title")}
        description={t("chains.description")}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={14} />}
            onClick={() => {
              void router.navigate({ to: "/chains/onboard" });
            }}
          >
            {t("chains.onboard.title")}
          </Button>
        }
      />

      <MasterDetail
        masterLabel={t("a11y.masterPane")}
        master={
          <>
            <ListToolbar
              filter={
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={t("common.search.placeholder")}
                  label={t("action.search")}
                />
              }
              actions={
                busy ? (
                  <span className="text-2xs text-fg-subtle">{t("common.loading")}</span>
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
                )
              }
              meta={
                chains.length > 0
                  ? format.integer(filtered.length) + " / " + format.integer(chains.length)
                  : undefined
              }
            />
            {result.ok ? (
              filtered.length === 0 && chains.length > 0 ? (
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
                <ChainList
                  chains={filtered}
                  onSelect={(chain) => {
                    void router.navigate({ to: "/chains/$chainId", params: { chainId: chain.id } });
                  }}
                />
              )
            ) : (
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
            )}
          </>
        }
        detail={
          <div className="flex flex-col gap-4 p-4">
            {chains.length === 0 && result.ok ? (
              <Card>
                <CardHeader title={t("chains.list.empty.title")} subtitle={t("chains.list.empty.description")} />
                <div className="p-4">
                  <EmptyState
                    compact
                    icon={<Store size={20} />}
                    title={t("chains.list.empty.title")}
                    description={t("chains.list.empty.description")}
                  />
                </div>
              </Card>
            ) : null}

            <Card>
              <CardHeader title={t("chains.onboard.title")} subtitle={t("chains.onboard.description")} />
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <ul className="flex max-w-prose flex-col gap-1 text-xs text-fg-muted">
                  <li>1. {t("chains.onboard.section.identity")}</li>
                  <li>2. {t("chains.onboard.section.licence")}</li>
                  <li>3. {t("chains.onboard.section.features")}</li>
                </ul>
                <Button
                  variant="primary"
                  iconAfter={<ArrowRight size={14} />}
                  disabled={!canOnboard}
                  title={canOnboard ? undefined : t("chains.onboard.denied.title")}
                  onClick={() => {
                    void router.navigate({ to: "/chains/onboard" });
                  }}
                >
                  {t("chains.onboard.title")}
                </Button>
              </div>
              {!canOnboard ? (
                <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
                  {t("chains.onboard.denied.description")}
                </p>
              ) : null}
            </Card>
          </div>
        }
      />
    </>
  );
}
