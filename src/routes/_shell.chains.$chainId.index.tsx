import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { TierChange } from "~/components/TierChange";
import { ChainStatusBadge, TierBadge } from "~/components/status";
import { TimestampValue } from "~/components/values";
import { Card, CardHeader, DescriptionList } from "~/components/ui";
import { useI18n } from "~/i18n";
import { currencyForJurisdiction } from "~/i18n/locales";

/**
 * Overview — what this chain *is*, on one screen, with no scroll to assemble it.
 *
 * The licence facts and the tier control sit together because they are one task: an
 * operator who reads a tier is usually the person about to move it. Everything else the
 * chain holds lives in the tab that owns it (Features, Sites & outlets, Settings,
 * History) rather than being stacked under this one.
 *
 * Contract and billing are **not here**: nothing in the domain carries them (see the
 * browse screen's expanded row for the same note). They are reported as a gap, not drawn.
 */
const parent = getRouteApi("/_shell/chains/$chainId");

export const Route = createFileRoute("/_shell/chains/$chainId/")({
  staticData: { titleKey: "chains.tab.overview" },
  component: ChainOverview,
});

function ChainOverview() {
  const { detail } = parent.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();

  if (!detail.ok) return null;
  const chain = detail.chain;
  const currency = currencyForJurisdiction(chain.taxJurisdiction);
  const canUpdateTier = principal.permissions.includes("chain.tier.update");

  return (
    <div className="flex flex-col gap-4 p-4" aria-labelledby={`chain-${chain.id}-tab-overview`}>
      <Card>
        <CardHeader
          title={t("chains.detail.tier.title")}
          subtitle={t("chains.detail.description")}
          actions={<TierBadge tier={chain.licenceTier} />}
        />
        <div className="flex flex-col gap-4 p-4">
          <DescriptionList
            columns={3}
            items={[
              { label: t("chains.column.tier"), value: <TierBadge tier={chain.licenceTier} /> },
              { label: t("chains.column.status"), value: <ChainStatusBadge status={chain.status} /> },
              {
                label: t("chains.column.jurisdiction"),
                value: (
                  <span className="font-mono text-xs">{chain.taxJurisdiction ?? t("common.none")}</span>
                ),
              },
              {
                label: t("common.currency.label"),
                value: <code className="font-mono text-xs">{currency ?? t("common.none")}</code>,
              },
              {
                label: t("chains.column.onboarded"),
                value: <TimestampValue value={chain.onboardedAt} mode="dateTime" />,
              },
              { label: t("chains.column.sites"), value: <span className="num">{format.integer(chain.siteCount)}</span> },
            ]}
          />
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-2xs font-semibold tracking-wide text-subtle-text uppercase">
              {t("chains.expanded.changeTier")}
            </p>
            <TierChange chain={chain} canUpdate={canUpdateTier} />
          </div>
        </div>
      </Card>
    </div>
  );
}
