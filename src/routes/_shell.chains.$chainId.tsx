import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";

import { ChainStatusBadge, TierBadge } from "~/components/status";
import { Tabs, type TabItem } from "~/components/tabs";
import { Button, Card, ErrorState, PageHeader, TableSkeleton } from "~/components/ui";
import { useI18n } from "~/i18n";
import { getChainFn } from "~/server-fns";

/**
 * The chain record — a **layout**, not a screen.
 *
 * The page it replaces was a master-detail split: the same list down the left third, the
 * record in the remainder, and everything about the chain stacked in one column that
 * needed three page-heights at 1280 to read. That is the shape the owner rejected (8 Oct:
 * one task per page, tabs per entity, "no scrolling to assemble one record's facts").
 *
 * So this route now owns exactly three things — the record's identity, the tab bar, and
 * the outlet — and each tab is a child route with its own URL:
 *
 *   /chains/$chainId            Overview
 *   /chains/$chainId/features   Features
 *   /chains/$chainId/sites      Sites & outlets
 *   /chains/$chainId/settings   Settings
 *   /chains/$chainId/history    History
 *
 * The identity strip is deliberately thin: name, code, tier, status and the way back. The
 * verbs that act on the chain (change tier, toggle a feature) live in the tab that owns
 * them, so the header makes no promise the panel does not keep.
 *
 * The list is gone from here on purpose. A record does not need to repeat the list it came
 * from — the browser's back button, the tab bar and the sidebar all lead back to it, and
 * repeating it cost a third of the width on every one of the five tabs.
 */
export const Route = createFileRoute("/_shell/chains/$chainId")({
  staticData: { titleKey: "chains.detail.titleFallback" },
  loader: async ({ params }) => ({ detail: await getChainFn({ data: { chainId: params.chainId } }) }),
  pendingComponent: ChainRecordPending,
  component: ChainRecordLayout,
});

function ChainRecordPending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4">
      <TableSkeleton rows={4} columns={3} label={t("state.loading.title")} />
    </div>
  );
}

function ChainRecordLayout() {
  const { detail } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useI18n();
  const { principal } = Route.useRouteContext();

  const pathname = router.state.location.pathname.replace(/\/+$/, "");
  const canReadAudit = principal.permissions.includes("chain.audit.read");

  const items: TabItem[] = [
    { value: "overview", label: "chains.tab.overview" },
    { value: "features", label: "chains.tab.features" },
    { value: "sites", label: "chains.tab.sites" },
    { value: "settings", label: "chains.tab.settings" },
    {
      value: "history",
      label: "chains.tab.history",
      disabled: !canReadAudit,
      disabledReason: "chains.history.disabled",
    },
  ];

  const active = ["features", "sites", "settings", "history"].find((tab) => pathname.endsWith(`/${tab}`)) ?? "overview";

  if (!detail.ok) {
    return (
      <>
        <PageHeader eyebrow={t("chains.detail.eyebrow")} title={t("chains.detail.titleFallback")} />
        <div className="p-4">
          <Card>
            <ErrorState
              title={t("chains.detail.notFound.title")}
              description={t("chains.detail.notFound.description")}
              detail={detail.message}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    void router.navigate({ to: "/chains" });
                  }}
                >
                  {t("action.back")}
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const chain = detail.chain;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border bg-surface px-5 py-3.5">
        <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-wider text-subtle-text uppercase">
            {t("chains.detail.eyebrow")}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold text-text">{chain.name}</h1>
            <code className="font-mono text-2xs text-subtle-text">{chain.code}</code>
            <TierBadge tier={chain.licenceTier} />
            <ChainStatusBadge status={chain.status} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void router.navigate({ to: "/chains" });
            }}
          >
            {t("action.back")}
          </Button>
        </div>
      </header>

      <Tabs
        idBase={`chain-${chain.id}`}
        ariaLabel="chains.tabs.aria"
        value={active}
        items={items}
        onChange={(next) => {
          if (next === "features") {
            void router.navigate({ to: "/chains/$chainId/features", params: { chainId: chain.id } });
            return;
          }
          if (next === "sites") {
            void router.navigate({ to: "/chains/$chainId/sites", params: { chainId: chain.id } });
            return;
          }
          if (next === "settings") {
            void router.navigate({ to: "/chains/$chainId/settings", params: { chainId: chain.id } });
            return;
          }
          if (next === "history") {
            void router.navigate({ to: "/chains/$chainId/history", params: { chainId: chain.id } });
            return;
          }
          void router.navigate({ to: "/chains/$chainId", params: { chainId: chain.id } });
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas" role="tabpanel" id={`chain-${chain.id}-panel-${active}`}>
        <Outlet />
      </div>
    </div>
  );
}
