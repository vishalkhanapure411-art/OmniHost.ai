import { Link } from "@tanstack/react-router";

import { Badge, formatWhen } from "~/components/ui";
import type { ChainSummary } from "~/domain/chains";

/** The master pane of the list-detail pattern, shared by both chain routes. */
export function ChainMaster({
  chains,
  selectedChainId,
  canRead,
}: {
  chains: ChainSummary[];
  selectedChainId?: string;
  canRead: boolean;
}) {
  if (chains.length === 0) {
    return (
      <p className="px-3 py-6 text-xs text-fg-muted">
        No chain is inside your scope. An AppSupport or AppConfig operator only sees the chains a
        grant names, so an empty list here is the permission model working.
      </p>
    );
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Chain</th>
          <th>Tier</th>
          <th className="text-right">Sites</th>
          <th className="text-right">Features</th>
          <th>Onboarded</th>
        </tr>
      </thead>
      <tbody>
        {chains.map((chain) => (
          <tr key={chain.id} data-selected={chain.id === selectedChainId ? "true" : "false"}>
            <td>
              {canRead ? (
                <Link
                  to="/chains/$chainId"
                  params={{ chainId: chain.id }}
                  className="font-medium text-fg hover:text-accent"
                >
                  {chain.name}
                </Link>
              ) : (
                <span className="font-medium text-fg">{chain.name}</span>
              )}
              <span className="block font-mono text-2xs text-fg-subtle">{chain.code}</span>
            </td>
            <td>
              <Badge
                tone={
                  chain.licenceTier === "platinum"
                    ? "accent"
                    : chain.licenceTier === "gold"
                      ? "info"
                      : "neutral"
                }
              >
                {chain.licenceTier}
              </Badge>
            </td>
            <td className="text-right text-fg-muted">{chain.siteCount}</td>
            <td className="text-right text-fg-muted">
              {chain.enabledFeatureCount}/{chain.featureCount}
            </td>
            <td className="text-fg-muted">{formatWhen(chain.onboardedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
