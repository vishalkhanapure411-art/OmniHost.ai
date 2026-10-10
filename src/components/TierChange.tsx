import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { TierBadge } from "~/components/status";
import { Button, ConfirmSummary, Dialog, Note } from "~/components/ui";
import type { LicenceTier } from "~/domain/chains";
import { useI18n } from "~/i18n";
import { tierLabel } from "~/i18n/labels";
import { updateChainTierFn } from "~/server-fns";

/**
 * Change a chain's licence tier — one control, two places it is needed (the browse
 * screen's expanded row and the record's Overview tab), so it lives once.
 *
 * Tier changes stay confirm-before-commit, for the reason they always did: a tier gates
 * module depth across every site in the chain, and switching it down turns features off.
 * The dialog names the consequence and the number of sites it affects *before* anything is
 * written, and the write goes through the same permission-checked, audited domain function
 * the HTTP API and the chatbot use. A refusal is the server's own sentence, never
 * re-worded here.
 *
 * A capability the operator does not hold is shown, not hidden: the buttons stay visible
 * and disabled with the reason beside them, because a control that quietly disappears
 * never tells an operator whether the value is not theirs to move or the product forgot it.
 */
export function TierChange({
  chain,
  canUpdate,
  compact = false,
}: {
  chain: { id: string; name: string; licenceTier: string; siteCount: number };
  canUpdate: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pendingTier, setPendingTier] = useState<LicenceTier | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeTier(next: LicenceTier) {
    setBusy(true);
    setError(null);
    const response = await updateChainTierFn({ data: { chainId: chain.id, licenceTier: next } });
    setBusy(false);
    setPendingTier(null);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    await router.invalidate();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(["silver", "gold", "platinum"] as LicenceTier[]).map((tier) => (
        <Button
          key={tier}
          size="sm"
          variant={tier === chain.licenceTier ? "primary" : "secondary"}
          disabled={!canUpdate || tier === chain.licenceTier}
          onClick={() => {
            setPendingTier(tier);
          }}
        >
          {tierLabel(t, tier)}
        </Button>
      ))}
      {!canUpdate ? (
        <Note tone="warn" compact>
          {t("error.forbidden.needs", { permission: "chain.tier.update" })}
        </Note>
      ) : null}
      {error ? (
        <Note tone="danger" compact>
          {error}
        </Note>
      ) : null}
      {compact ? null : (
        <span className="text-2xs text-subtle-text">{t("chains.detail.tier.subtitle")}</span>
      )}

      <Dialog
        open={pendingTier !== null}
        onClose={() => {
          setPendingTier(null);
        }}
        title={
          pendingTier ? t("chains.detail.tier.confirmTitle", { tier: tierLabel(t, pendingTier) }) : ""
        }
        description={t("chains.detail.tier.confirmBody", {
          tier: pendingTier ? tierLabel(t, pendingTier) : "",
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
              { label: t("chains.column.chain"), value: chain.name },
              { label: t("chains.detail.features.column.minTier"), value: <TierBadge tier={chain.licenceTier} /> },
              { label: t("action.confirm"), value: <TierBadge tier={pendingTier} /> },
              {
                label: t("chains.column.sites"),
                value:
                  chain.siteCount === 1
                    ? t("chains.detail.tier.sitesAffected.one")
                    : t("chains.detail.tier.sitesAffected.other", { count: chain.siteCount }),
              },
            ]}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
