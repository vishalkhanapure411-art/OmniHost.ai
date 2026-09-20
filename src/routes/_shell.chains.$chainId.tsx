import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ChainMaster } from "~/components/ChainMaster";
import { MasterDetail, MasterHeader } from "~/components/MasterDetail";
import { Badge, Card, CardHeader, EmptyState, Note, PageHeader, Select, Toggle, formatWhen } from "~/components/ui";
import type { LicenceTier } from "~/domain/chains";
import { getChainFn, listChainsFn, setChainFeatureFn, updateChainTierFn } from "~/server-fns";

/**
 * Chain detail — licence tier and per-chain feature toggles.
 *
 * Both mutations go through the same permission-checked, audit-logged domain
 * functions the HTTP API exposes, and the screen re-reads the chain from the database
 * after each write, so what you see is the stored state rather than an optimistic
 * guess.
 */
export const Route = createFileRoute("/_shell/chains/$chainId")({
  staticData: { title: "Chain detail" },
  loader: async ({ params }) => {
    const [chains, detail] = await Promise.all([
      listChainsFn(),
      getChainFn({ data: { chainId: params.chainId } }),
    ]);
    return { chains, detail };
  },
  component: ChainDetailScreen,
});

const TIER_LABEL: Record<string, string> = { silver: "Silver", gold: "Gold", platinum: "Platinum" };

function ChainDetailScreen() {
  const { chains, detail } = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const chainList = chains.ok ? chains.chains : [];
  const canUpdateTier = principal.permissions.includes("chain.tier.update");
  const canToggleFeature = principal.permissions.includes("chain.feature.update");

  async function changeTier(next: LicenceTier) {
    if (!detail.ok) return;
    setError(null);
    const response = await updateChainTierFn({
      data: { chainId: detail.chain.id, licenceTier: next },
    });
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  async function toggleFeature(featureCode: string, enabled: boolean) {
    if (!detail.ok) return;
    setError(null);
    const response = await setChainFeatureFn({
      data: { chainId: detail.chain.id, featureCode, enabled },
    });
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  return (
    <>
      <PageHeader
        eyebrow="App layer · Licensing"
        title={detail.ok ? detail.chain.name : "Chain detail"}
        description={
          detail.ok
            ? `Licence tier and feature toggles for ${detail.chain.code}. Every change is permission-checked server-side and written to the audit log with before and after state.`
            : "This chain is not inside your scope."
        }
      />
      <MasterDetail
        masterLabel="Chain list"
        master={
          <>
            <MasterHeader title="Chains" count={chainList.length} />
            <ChainMaster
              chains={chainList}
              selectedChainId={detail.ok ? detail.chain.id : undefined}
              canRead={principal.permissions.includes("chain.read")}
            />
          </>
        }
        detail={
          detail.ok ? (
            <div className="flex flex-col gap-4 p-4">
              {error ? <Note tone="danger">{error}</Note> : null}

              <Card>
                <CardHeader
                  title="Licence tier"
                  subtitle="Set per chain, never per site — every site in the chain runs the same tier."
                />
                <div className="flex flex-wrap items-center gap-3 p-4">
                  <Select
                    ariaLabel="Licence tier"
                    value={detail.chain.licenceTier}
                    disabled={!canUpdateTier}
                    onChange={(next) => void changeTier(next)}
                    options={[
                      { value: "silver", label: "Silver" },
                      { value: "gold", label: "Gold" },
                      { value: "platinum", label: "Platinum" },
                    ]}
                  />
                  <Badge tone="accent">{TIER_LABEL[detail.chain.licenceTier]}</Badge>
                  <span className="text-xs text-fg-muted">
                    Tax jurisdiction {detail.chain.taxJurisdiction ?? "—"} · status {detail.chain.status} ·
                    onboarded {formatWhen(detail.chain.onboardedAt)}
                  </span>
                  {!canUpdateTier ? (
                    <Note tone="warn">
                      Read-only: your registry has no <code className="font-mono">chain.tier.update</code>.
                    </Note>
                  ) : null}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Feature toggles"
                  subtitle={`${detail.chain.enabledFeatureCount} of ${detail.chain.featureCount} switched on. A feature below the chain's tier cannot be enabled.`}
                />
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Feature</th>
                      <th>Module</th>
                      <th>Min tier</th>
                      <th>Last change</th>
                      <th className="text-right">Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.chain.features.map((feature) => (
                      <tr key={feature.code}>
                        <td>
                          <span className="font-medium text-fg">{feature.name}</span>
                          <span className="block font-mono text-2xs text-fg-subtle">{feature.code}</span>
                          {feature.description ? (
                            <span className="mt-0.5 block max-w-prose text-2xs text-fg-muted">
                              {feature.description}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-fg-muted">{feature.module}</td>
                        <td>
                          <Badge
                            tone={
                              feature.blockedByTier
                                ? "danger"
                                : feature.minTier === "platinum"
                                  ? "accent"
                                  : "neutral"
                            }
                            title={
                              feature.blockedByTier
                                ? `Needs the ${feature.minTier} tier; this chain is on ${detail.chain.licenceTier}`
                                : `Available from ${feature.minTier}`
                            }
                          >
                            {feature.minTier}
                          </Badge>
                        </td>
                        <td className="text-fg-muted">{formatWhen(feature.updatedAt)}</td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Toggle
                              label={`${feature.name} enabled`}
                              checked={feature.enabled}
                              disabled={!canToggleFeature || !feature.toggleable || feature.blockedByTier}
                              onChange={(next) => void toggleFeature(feature.code, next)}
                            />
                            {!feature.toggleable ? (
                              <span className="text-2xs text-fg-subtle">always on</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card>
                <CardHeader title="Sites & outlets" subtitle="Where this chain operates today." />
                {detail.chain.sites.length === 0 ? (
                  <EmptyState
                    title="No sites yet"
                    description="Site management arrives with its own phase; this chain was onboarded without one."
                  />
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Site</th>
                        <th>Timezone</th>
                        <th>Outlets</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.chain.sites.map((site) => (
                        <tr key={site.id}>
                          <td>
                            <span className="font-medium text-fg">{site.name}</span>
                            <span className="block font-mono text-2xs text-fg-subtle">{site.code}</span>
                          </td>
                          <td className="text-fg-muted">{site.timezone}</td>
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
                            <Badge tone={site.status === "active" ? "ok" : "neutral"}>{site.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          ) : (
            <EmptyState
              title="Not available"
              description={detail.message}
            />
          )
        }
      />
    </>
  );
}
