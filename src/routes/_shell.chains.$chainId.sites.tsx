import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ChainStatusBadge } from "~/components/status";
import { Card, CardHeader, EmptyState } from "~/components/ui";
import { useI18n } from "~/i18n";

/**
 * Sites & outlets — the estate, as its own task.
 *
 * The same fit rule as the features tab: a `.table-scroll` wrapper and a `data-hide-below`
 * per droppable column. `site` identifies the row and `status` is the primary state, so
 * neither is ever hidden; the timezone goes first, then the outlet list, then the locale.
 * Outlets are a list inside the cell, so the cell that holds them is the one that goes
 * before the columns that only hold a word.
 */
const parent = getRouteApi("/_shell/chains/$chainId");

export const Route = createFileRoute("/_shell/chains/$chainId/sites")({
  staticData: { titleKey: "chains.tab.sites" },
  component: ChainSites,
});

function ChainSites() {
  const { detail } = parent.useLoaderData();
  const { t } = useI18n();

  if (!detail.ok) return null;
  const chain = detail.chain;

  return (
    <div className="flex flex-col gap-4 p-4" aria-labelledby={`chain-${chain.id}-tab-sites`}>
      <Card>
        <CardHeader title={t("chains.detail.sites.title")} subtitle={t("chains.detail.sites.subtitle")} />
        {chain.sites.length === 0 ? (
          <EmptyState
            title={t("chains.detail.sites.empty.title")}
            description={t("chains.detail.sites.empty.description")}
          />
        ) : (
          <div className="table-scroll overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">{t("chains.detail.sites.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("chains.detail.sites.column.site")}</th>
                  <th scope="col" data-hide-below="32rem">
                    {t("chains.detail.sites.column.outlets")}
                  </th>
                  <th scope="col" data-hide-below="48rem">
                    {t("chains.detail.sites.column.timezone")}
                  </th>
                  <th scope="col">{t("chains.detail.sites.column.status")}</th>
                </tr>
              </thead>
              <tbody>
                {chain.sites.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <span className="block text-text">{site.name}</span>
                      <code className="block font-mono text-2xs text-subtle-text">{site.code}</code>
                    </td>
                    <td data-hide-below="32rem">
                      <ul className="flex flex-col gap-0.5">
                        {site.outlets.map((outlet) => (
                          <li key={outlet.id} className="text-xs text-muted-text">
                            {outlet.name}{" "}
                            <span className="font-mono text-2xs text-subtle-text">{outlet.kind}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td data-hide-below="48rem">
                      <code className="font-mono text-xs text-muted-text">{site.timezone}</code>
                    </td>
                    <td>
                      <ChainStatusBadge status={site.status} />
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
