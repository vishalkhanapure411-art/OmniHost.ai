import { DataTable, type Column } from "~/components/DataTable";
import { TierBadge, ChainStatusBadge } from "~/components/status";
import { TimestampValue } from "~/components/values";
import { CodeLabel } from "~/components/values";
import { useI18n } from "~/i18n";
import type { ChainSummary } from "~/domain/chains";

/**
 * The chain list — the master pane of the AppAdmin slice, and the reference
 * implementation of the master-data list pattern the later modules (articles, vendors,
 * outlets, staff) copy: sortable columns, a tier badge that does not rely on colour,
 * jurisdiction shown because it drives tax and menu rules, and numbers right-aligned so
 * the counts line up down the column.
 *
 * The empty state distinguishes "you have no chains in scope" from "your filter matched
 * nothing" — they are different problems and an operator should not have to guess which
 * one they have.
 */
export function ChainList({
  chains,
  selectedChainId,
  onSelect,
  filteredOut = 0,
}: {
  chains: ChainSummary[];
  selectedChainId?: string;
  onSelect?: (chain: ChainSummary) => void;
  filteredOut?: number;
}) {
  const { t, format } = useI18n();

  const columns: Column<ChainSummary>[] = [
    {
      key: "name",
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
      key: "jurisdiction",
      header: t("chains.column.jurisdiction"),
      sortValue: (chain) => chain.taxJurisdiction ?? "",
      render: (chain) => (
        <span className="font-mono text-xs text-fg-muted">{chain.taxJurisdiction ?? t("common.none")}</span>
      ),
    },
    {
      key: "status",
      header: t("chains.column.status"),
      sortValue: (chain) => chain.status,
      render: (chain) => <ChainStatusBadge status={chain.status} />,
    },
    {
      key: "sites",
      header: t("chains.column.sites"),
      numeric: true,
      sortValue: (chain) => chain.siteCount,
      render: (chain) => <span className="num">{format.integer(chain.siteCount)}</span>,
    },
    {
      key: "features",
      header: t("chains.column.features"),
      numeric: true,
      headerTitle: t("chains.detail.features.title"),
      sortValue: (chain) => chain.enabledFeatureCount,
      render: (chain) => (
        <span className="num" title={`${chain.enabledFeatureCount}/${chain.featureCount}`}>
          {t("chains.features.enabledOf", { enabled: chain.enabledFeatureCount, total: chain.featureCount })}
        </span>
      ),
    },
    {
      key: "onboarded",
      header: t("chains.column.onboarded"),
      sortValue: (chain) => chain.onboardedAt,
      render: (chain) => <TimestampValue value={chain.onboardedAt} mode="date" className="text-fg-muted" />,
    },
  ];

  return (
    <DataTable<ChainSummary>
      caption={t("chains.list.title")}
      columns={columns}
      rows={chains}
      getRowId={(chain) => chain.id}
      selectedId={selectedChainId}
      onSelect={onSelect}
      defaultSortKey="onboarded"
      defaultSortDirection="desc"
      footer={
        chains.length > 0 ? (
          <span>
            {t("common.showing", { shown: format.integer(chains.length), total: format.integer(chains.length + filteredOut) })}
          </span>
        ) : null
      }
    />
  );
}

/** Header for the list pane: title, count, and the filter that produced it. */
export function ChainListCount({ count }: { count: number }) {
  const { format } = useI18n();
  return <span className="text-xs text-fg-subtle">{format.integer(count)}</span>;
}
