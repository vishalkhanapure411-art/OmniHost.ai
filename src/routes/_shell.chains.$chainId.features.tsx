import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { CategoryBadge, TierBadge } from "~/components/status";
import { TimestampValue } from "~/components/values";
import { Card, CardHeader, EmptyState, Note, Toggle } from "~/components/ui";
import { useI18n } from "~/i18n";
import { tierLabel } from "~/i18n/labels";
import { setChainFeatureFn } from "~/server-fns";

/**
 * Features — the per-chain toggles, as their own task.
 *
 * This table is the 202px-at-1024 offender the owner was told to scroll through. It now
 * adopts the fit mechanism that already existed for exactly this: a `.table-scroll`
 * wrapper (which establishes the container query) and a `data-hide-below` on every column
 * that is not the identifier or the control. Columns drop lowest-priority-first —
 * last change, then the module and the tier it needs — and the **toggle column is pinned
 * to the inline end** (`col-action`), so a narrow pane never takes the control away.
 *
 * A feature above the chain's tier stays visible, keeps its "needs Gold" reason, and its
 * toggle is disabled: whether a control is not theirs to move or refused by entitlement
 * has to be readable without a click.
 */
const parent = getRouteApi("/_shell/chains/$chainId");

export const Route = createFileRoute("/_shell/chains/$chainId/features")({
  staticData: { titleKey: "chains.tab.features" },
  component: ChainFeatures,
});

function ChainFeatures() {
  const { detail } = parent.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  if (!detail.ok) return null;
  const chain = detail.chain;
  const canToggleFeature = principal.permissions.includes("chain.feature.update");

  async function toggleFeature(featureCode: string, enabled: boolean) {
    setError(null);
    const response = await setChainFeatureFn({ data: { chainId: chain.id, featureCode, enabled } });
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  return (
    <div className="flex flex-col gap-4 p-4" aria-labelledby={`chain-${chain.id}-tab-features`}>
      {error ? (
        <Note tone="danger" title={t("error.title")}>
          {error}
        </Note>
      ) : null}
      <Card>
        <CardHeader
          title={t("chains.detail.features.title")}
          subtitle={
            chain.featureCount === 1
              ? t("chains.detail.features.subtitle.one", { enabled: chain.enabledFeatureCount })
              : t("chains.detail.features.subtitle.other", {
                  enabled: chain.enabledFeatureCount,
                  total: chain.featureCount,
                })
          }
        />
        {chain.features.length === 0 ? (
          <EmptyState title={t("state.empty.title")} description={t("state.empty.description")} />
        ) : (
          <div className="table-scroll overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">{t("chains.detail.features.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("chains.detail.features.column.feature")}</th>
                  <th scope="col" data-hide-below="40rem">
                    {t("chains.detail.features.column.module")}
                  </th>
                  <th scope="col" data-hide-below="40rem">
                    {t("chains.detail.features.column.minTier")}
                  </th>
                  <th scope="col" data-hide-below="48rem">
                    {t("chains.detail.features.column.lastChange")}
                  </th>
                  <th scope="col" className="numeric col-action">
                    {t("chains.detail.features.column.enabled")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {chain.features.map((feature) => (
                  <tr key={feature.code}>
                    <td>
                      <span className="block text-text">{feature.name}</span>
                      <code className="block font-mono text-2xs text-subtle-text">{feature.code}</code>
                      {feature.description ? (
                        <span className="mt-0.5 block max-w-prose text-2xs text-muted-text">
                          {feature.description}
                        </span>
                      ) : null}
                    </td>
                    <td data-hide-below="40rem">
                      <CategoryBadge category={feature.module} />
                    </td>
                    <td data-hide-below="40rem">
                      <TierBadge
                        tier={feature.minTier}
                        title={
                          feature.blockedByTier
                            ? t("chains.detail.features.blocked", {
                                tier: tierLabel(t, feature.minTier),
                                current: tierLabel(t, chain.licenceTier),
                              })
                            : t("chains.detail.features.availableFrom", {
                                tier: tierLabel(t, feature.minTier),
                              })
                        }
                      />
                    </td>
                    <td data-hide-below="48rem">
                      <TimestampValue value={feature.updatedAt} mode="dateTime" className="text-muted-text" />
                    </td>
                    <td className="numeric col-action">
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
                          <span className="text-2xs text-subtle-text">
                            {t("chains.detail.features.alwaysOn")}
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
