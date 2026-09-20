import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ChainList } from "~/components/ChainList";
import { ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { Button, Card, CardHeader, ConfirmSummary, DescriptionList, Dialog, EmptyState, ErrorState, Note, PageHeader, TableSkeleton, Toggle } from "~/components/ui";
import { CategoryBadge, ChainStatusBadge, TierBadge } from "~/components/status";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import { currencyForJurisdiction } from "~/i18n/locales";
import type { LicenceTier } from "~/domain/chains";
import { getChainFn, listChainsFn, setChainFeatureFn, updateChainTierFn } from "~/server-fns";

/**
 * Chain detail — the licence tier and the per-chain feature toggles.
 *
 * Every mutation on this screen goes through the same permission-checked, audit-logged
 * domain function the HTTP API and (later) the chatbot call, and the screen re-reads the
 * chain from the database after each write, so what is on screen is the stored state
 * rather than an optimistic guess. A failed write leaves the toggle where the server
 * says it is and explains why.
 *
 * Tier changes are confirm-before-commit: a tier gates module depth across every site in
 * the chain, and switching it down silently disables features. The dialog names the
 * consequence and the number of sites affected before anything is written.
 *
 * Missing permissions are shown as read-only with the reason, never by hiding the
 * control — an operator needs to know the capability exists and is not theirs.
 */
export const Route = createFileRoute("/_shell/chains/$chainId")({
  staticData: { titleKey: "chains.detail.titleFallback" },
  loader: async ({ params }) => {
    const [chains, detail] = await Promise.all([
      listChainsFn(),
      getChainFn({ data: { chainId: params.chainId } }),
    ]);
    return { chains, detail };
  },
  pendingComponent: ChainDetailPending,
  component: ChainDetailScreen,
});

function ChainDetailPending() {
  const { t } = useI18n();
  return (
    <MasterDetail
      masterLabel={t("a11y.masterPane")}
      master={<TableSkeleton rows={8} columns={4} label={t("state.loading.title")} />}
      detail={
        <div className="flex flex-col gap-4 p-4">
          <TableSkeleton rows={3} columns={3} label={t("state.loading.title")} />
          <TableSkeleton rows={6} columns={4} label={t("state.loading.title")} />
        </div>
      }
    />
  );
}

function ChainDetailScreen() {
  const { chains, detail } = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingTier, setPendingTier] = useState<LicenceTier | null>(null);
  const [busy, setBusy] = useState(false);

  const chainList = chains.ok ? chains.chains : [];
  const canUpdateTier = principal.permissions.includes("chain.tier.update");
  const canToggleFeature = principal.permissions.includes("chain.feature.update");

  async function changeTier(next: LicenceTier) {
    if (!detail.ok) return;
    setBusy(true);
    setError(null);
    const response = await updateChainTierFn({ data: { chainId: detail.chain.id, licenceTier: next } });
    setBusy(false);
    setPendingTier(null);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  async function toggleFeature(featureCode: string, enabled: boolean) {
    if (!detail.ok) return;
    setError(null);
    const response = await setChainFeatureFn({ data: { chainId: detail.chain.id, featureCode, enabled } });
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  const currency = detail.ok ? currencyForJurisdiction(detail.chain.taxJurisdiction) : null;

  return (
    <>
      <PageHeader
        eyebrow={t("chains.detail.eyebrow")}
        title={detail.ok ? detail.chain.name : t("chains.detail.titleFallback")}
        description={detail.ok ? t("chains.detail.description") : undefined}
        meta={
          detail.ok ? (
            <>
              <code className="font-mono text-2xs text-fg-subtle">{detail.chain.code}</code>
              <TierBadge tier={detail.chain.licenceTier} />
              <ChainStatusBadge status={detail.chain.status} />
            </>
          ) : undefined
        }
        actions={
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

      <MasterDetail
        masterLabel={t("a11y.masterPane")}
        master={
          <>
            <ListToolbar meta={format.integer(chainList.length)} />
            {chains.ok ? (
              <ChainList
                chains={chainList}
                selectedChainId={detail.ok ? detail.chain.id : undefined}
                onSelect={(chain) => {
                  void router.navigate({ to: "/chains/$chainId", params: { chainId: chain.id } });
                }}
              />
            ) : (
              <ErrorState title={t("error.title")} detail={chains.message} />
            )}
          </>
        }
        detail={
          detail.ok ? (
            <div className="flex flex-col gap-4 p-4">
              {error ? (
                <Note tone="danger" title={t("error.title")}>
                  {error}
                </Note>
              ) : null}

              <Card>
                <CardHeader title={t("chains.detail.tier.title")} subtitle={t("chains.detail.tier.subtitle")} />
                <div className="flex flex-col gap-3 p-4">
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: t("chains.column.tier"), value: <TierBadge tier={detail.chain.licenceTier} /> },
                      {
                        label: t("chains.column.jurisdiction"),
                        value: (
                          <span className="font-mono text-xs">{detail.chain.taxJurisdiction ?? t("common.none")}</span>
                        ),
                      },
                      {
                        label: t("shell.chain.label"),
                        value: (
                          <span className="text-xs">
                            {t("common.currency.label")} <code className="font-mono">{currency ?? t("common.none")}</code>
                          </span>
                        ),
                      },
                      { label: t("chains.column.status"), value: <ChainStatusBadge status={detail.chain.status} /> },
                      {
                        label: t("chains.column.onboarded"),
                        value: <TimestampValue value={detail.chain.onboardedAt} mode="dateTime" />,
                      },
                      { label: t("chains.column.sites"), value: format.integer(detail.chain.siteCount) },
                    ]}
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    {(["silver", "gold", "platinum"] as LicenceTier[]).map((tier) => (
                      <Button
                        key={tier}
                        size="sm"
                        variant={tier === detail.chain.licenceTier ? "primary" : "secondary"}
                        disabled={!canUpdateTier || tier === detail.chain.licenceTier}
                        onClick={() => {
                          setPendingTier(tier);
                        }}
                      >
                        {t(`chains.tier.${tier}` as never)}
                      </Button>
                    ))}
                    {!canUpdateTier ? (
                      <Note tone="warn" compact>
                        {t("error.forbidden.needs", { permission: "chain.tier.update" })}
                      </Note>
                    ) : null}
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title={t("chains.detail.features.title")}
                  subtitle={
                    detail.chain.featureCount === 1
                      ? t("chains.detail.features.subtitle.one", { enabled: detail.chain.enabledFeatureCount })
                      : t("chains.detail.features.subtitle.other", {
                          enabled: detail.chain.enabledFeatureCount,
                          total: detail.chain.featureCount,
                        })
                  }
                />
                {detail.chain.features.length === 0 ? (
                  <EmptyState title={t("state.empty.title")} description={t("state.empty.description")} />
                ) : (
                  <table className="data-table">
                    <caption className="sr-only">{t("chains.detail.features.title")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("chains.detail.features.column.feature")}</th>
                        <th scope="col">{t("chains.detail.features.column.module")}</th>
                        <th scope="col">{t("chains.detail.features.column.minTier")}</th>
                        <th scope="col">{t("chains.detail.features.column.lastChange")}</th>
                        <th scope="col" className="numeric">
                          {t("chains.detail.features.column.enabled")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.chain.features.map((feature) => (
                        <tr key={feature.code}>
                          <td>
                            <span className="block text-fg">{feature.name}</span>
                            <code className="block font-mono text-2xs text-fg-subtle">{feature.code}</code>
                            {feature.description ? (
                              <span className="mt-0.5 block max-w-prose text-2xs text-fg-muted">
                                {feature.description}
                              </span>
                            ) : null}
                          </td>
                          <td>
                            <CategoryBadge category={feature.module} />
                          </td>
                          <td>
                            <TierBadge
                              tier={feature.minTier}
                              title={
                                feature.blockedByTier
                                  ? t("chains.detail.features.blocked", {
                                      tier: t(`chains.tier.${feature.minTier}` as never),
                                      current: t(`chains.tier.${detail.chain.licenceTier}` as never),
                                    })
                                  : t("chains.detail.features.availableFrom", {
                                      tier: t(`chains.tier.${feature.minTier}` as never),
                                    })
                              }
                            />
                          </td>
                          <td>
                            <TimestampValue value={feature.updatedAt} mode="dateTime" className="text-fg-muted" />
                          </td>
                          <td className="numeric">
                            <span className="flex items-center justify-end gap-2">
                              <Toggle
                                label={t("chains.detail.features.toggleLabel", { feature: feature.name })}
                                checked={feature.enabled}
                                disabled={!canToggleFeature || !feature.toggleable || feature.blockedByTier}
                                onChange={(next) => {
                                  void toggleFeature(feature.code, next);
                                }}
                              />
                              {!feature.toggleable ? (
                                <span className="text-2xs text-fg-subtle">
                                  {t("chains.detail.features.alwaysOn")}
                                </span>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card>
                <CardHeader title={t("chains.detail.sites.title")} subtitle={t("chains.detail.sites.subtitle")} />
                {detail.chain.sites.length === 0 ? (
                  <EmptyState
                    title={t("chains.detail.sites.empty.title")}
                    description={t("chains.detail.sites.empty.description")}
                  />
                ) : (
                  <table className="data-table">
                    <caption className="sr-only">{t("chains.detail.sites.title")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("chains.detail.sites.column.site")}</th>
                        <th scope="col">{t("chains.detail.sites.column.timezone")}</th>
                        <th scope="col">{t("chains.detail.sites.column.outlets")}</th>
                        <th scope="col">{t("chains.detail.sites.column.status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.chain.sites.map((site) => (
                        <tr key={site.id}>
                          <td>
                            <span className="block text-fg">{site.name}</span>
                            <code className="block font-mono text-2xs text-fg-subtle">{site.code}</code>
                          </td>
                          <td>
                            <code className="font-mono text-xs text-fg-muted">{site.timezone}</code>
                          </td>
                          <td>
                            <ul className="flex flex-col gap-0.5">
                              {site.outlets.map((outlet) => (
                                <li key={outlet.id} className="text-xs text-fg-muted">
                                  {outlet.name}{" "}
                                  <span className="font-mono text-2xs text-fg-subtle">{outlet.kind}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td>
                            <ChainStatusBadge status={site.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          ) : (
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
          )
        }
      />

      <Dialog
        open={pendingTier !== null}
        onClose={() => {
          setPendingTier(null);
        }}
        title={
          pendingTier
            ? t("chains.detail.tier.confirmTitle", { tier: t(`chains.tier.${pendingTier}` as never) })
            : ""
        }
        description={t("chains.detail.tier.confirmBody", {
          tier: pendingTier ? t(`chains.tier.${pendingTier}` as never) : "",
        })}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingTier(null);
              }}
            >
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                if (pendingTier) void changeTier(pendingTier);
              }}
            >
              {t("chains.detail.tier.confirmCta")}
            </Button>
          </>
        }
      >
        {pendingTier ? (
          <ConfirmSummary
            items={[
              { label: t("chains.column.chain"), value: detail.ok ? detail.chain.name : "" },
              { label: t("chains.detail.features.column.minTier"), value: <TierBadge tier={detail.ok ? detail.chain.licenceTier : "silver"} /> },
              { label: t("action.confirm"), value: <TierBadge tier={pendingTier} /> },
              {
                label: t("chains.column.sites"),
                value:
                  detail.ok && detail.chain.siteCount === 1
                    ? t("chains.detail.tier.sitesAffected.one")
                    : t("chains.detail.tier.sitesAffected.other", { count: detail.ok ? detail.chain.siteCount : 0 }),
              },
            ]}
          />
        ) : null}
      </Dialog>
    </>
  );
}
