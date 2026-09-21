import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PermissionDenied,
  SearchInput,
  Select,
  TableSkeleton,
} from "~/components/ui";
import { TimestampValue } from "~/components/values";
import type { SiteListItem } from "~/domain/mdm-sites";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { listSitesFn } from "~/server-fns";
/**
 * Sites — the master list (§12.4).
 *
 * The hierarchy is **chain → site → outlet**, and this screen shows it the way the spec
 * insists: sites are grouped under their chain, and the **chain's licence tier appears once
 * in the section header, never on a row** — a per-row tier would suggest a per-site tier,
 * and the owner's locked decision is that the tier belongs to the chain.
 *
 * A site row carries what a site actually owns: its jurisdiction (the market that drives tax
 * regime, currency, timezone and locale defaults), its own timezone and trading currency, its
 * outlets by kind, its locale *or the word "inherited"* — a null locale is a fact, not a
 * blank — and its status. The last column is the last change, because a master screen that
 * cannot say when it last moved sends people to the database.
 *
 * Same four states as every other list: loading, empty in scope, filtered to nothing, and
 * refused with the capability named. A control that could not mean anything (a jurisdiction
 * filter with no site carrying one) is disabled **with its reason on screen**.
 */
export const Route = createFileRoute("/_shell/mdm/sites/")({
  staticData: { titleKey: "nav.route./mdm/sites" },
  loader: async () => listSitesFn(),
  pendingComponent: SitesPending,
  component: SitesScreen,
});

const STATUS_LABEL: Record<string, MessageKey> = {
  onboarding: "mdm.site.status.onboarding",
  active: "mdm.site.status.active",
  suspended: "mdm.site.status.suspended",
  closed: "mdm.site.status.closed",
};
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "accent"> = {
  onboarding: "accent",
  active: "ok",
  suspended: "warn",
  closed: "neutral",
};
const TIER_LABEL: Record<string, MessageKey> = {
  silver: "chains.tier.silver",
  gold: "chains.tier.gold",
  platinum: "chains.tier.platinum",
};
const KIND_LABEL: Record<string, MessageKey> = {
  restaurant: "mdm.outlet.kind.restaurant",
  bar: "mdm.outlet.kind.bar",
  qsr: "mdm.outlet.kind.qsr",
  kiosk: "mdm.outlet.kind.kiosk",
  cloud_kitchen: "mdm.outlet.kind.cloud_kitchen",
  hotel_outlet: "mdm.outlet.kind.hotel_outlet",
  banquet: "mdm.outlet.kind.banquet",
  room_service: "mdm.outlet.kind.room_service",
  kitchen: "mdm.outlet.kind.kitchen",
};

function SitesPending() {
  const { t } = useI18n();
  return (
    <div className="p-4">
      <TableSkeleton rows={8} columns={8} label={t("state.loading.title")} />
    </div>
  );
}

function SitesScreen() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [kind, setKind] = useState("");

  if (!result.ok) {
    // Same refusal discipline as the vendor list and both record screens in this slab: a 403
    // names the capability the *server* refused on (carried on every failure by
    // `~/server-fns`), as a chip rather than only inside the message text, so the operator
    // knows what to ask for. A non-403 failure keeps the generic error state — a permission
    // panel over a server fault claims a refusal that never happened.
    if (result.status === 403) {
      return (
        <div className="p-4">
          <Card>
            <PermissionDenied
              title={t("mdm.sites.denied.title")}
              description={t("mdm.sites.denied.description")}
              requiredPermission={result.permission ?? "mdm.site.view"}
            />
            <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
              {result.message}
            </p>
          </Card>
        </div>
      );
    }
    return (
      <div className="p-4">
        <ErrorState
          title={t("error.title")}
          description={t("error.description")}
          detail={result.message}
        />
      </div>
    );
  }

  const sites = result.items;
  const needle = query.trim().toLowerCase();
  const matches = (site: SiteListItem): boolean => {
    if (status && site.status !== status) return false;
    if (jurisdiction && site.jurisdictionCode !== jurisdiction) return false;
    if (kind && !site.outletKinds.some((entry) => entry.kind === kind)) return false;
    if (needle) {
      // The two the search box promises: the code and the site's name.
      if (!`${site.code} ${site.name}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  };
  const sections = result.sections
    .map((section) => ({ ...section, sites: section.sites.filter(matches) }))
    .filter((section) => section.sites.length > 0);
  const shown = sections.reduce((count, section) => count + section.sites.length, 0);

  const clearFilters = () => {
    setQuery("");
    setStatus("");
    setJurisdiction("");
    setKind("");
  };

  const jurisdictionFilterUnavailable = result.options.jurisdictions.length === 0;
  const kindFilterUnavailable = result.options.outletKinds.every((option) => option.count === 0);

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <CardHeader title={t("mdm.sites.title")} subtitle={t("mdm.sites.subtitle")} />
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("mdm.sites.search.placeholder")}
            label={t("mdm.sites.search.label")}
          />
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel={t("mdm.sites.filter.status")}
            emptyLabel={t("mdm.sites.filter.all")}
            options={result.options.statuses.map((option) => ({
              value: option.code,
              label: `${t(STATUS_LABEL[option.code] ?? "mdm.site.status.active")} (${String(option.count)})`,
            }))}
          />
          <div className="flex flex-col gap-1">
            <Select
              value={jurisdiction}
              onChange={setJurisdiction}
              ariaLabel={t("mdm.sites.filter.jurisdiction")}
              emptyLabel={t("mdm.sites.filter.all")}
              disabled={jurisdictionFilterUnavailable}
              options={result.options.jurisdictions.map((option) => ({
                value: option.code,
                label: `${option.code} (${String(option.count)})`,
              }))}
            />
            {jurisdictionFilterUnavailable ? (
              <span className="max-w-prose text-2xs text-fg-subtle">
                {t("mdm.sites.filter.jurisdictionUnavailable")}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Select
              value={kind}
              onChange={setKind}
              ariaLabel={t("mdm.sites.filter.outletKind")}
              emptyLabel={t("mdm.sites.filter.all")}
              disabled={kindFilterUnavailable}
              options={result.options.outletKinds.map((option) => ({
                value: option.code,
                label: `${t(KIND_LABEL[option.code] ?? "mdm.outlet.kind.restaurant")} (${String(option.count)})`,
              }))}
            />
            {kindFilterUnavailable ? (
              <span className="max-w-prose text-2xs text-fg-subtle">
                {t("mdm.sites.filter.outletKindUnavailable")}
              </span>
            ) : null}
          </div>
        </div>

        {shown === 0 && sites.length > 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.sites.noResults.title")}
              description={t("mdm.sites.noResults.description", { total: String(sites.length) })}
              action={
                <Button size="sm" onClick={clearFilters}>
                  {t("action.clearFilters")}
                </Button>
              }
            />
          </div>
        ) : sites.length === 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.sites.empty.title")}
              description={t("mdm.sites.empty.description")}
            />
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.chainId}>
              {/* The tier, once, in the section header — never on a row (§12.4). */}
              <div className="flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-2">
                <h3 className="text-sm font-semibold text-fg">{section.chainName}</h3>
                <code className="font-mono text-2xs text-fg-muted">{section.chainCode}</code>
                <Badge tone="neutral" shape={false}>
                  {t("mdm.sites.chainTier", {
                    tier: t(TIER_LABEL[section.chainTier] ?? "chains.tier.silver"),
                  })}
                </Badge>
                <span className="text-xs text-fg-subtle">
                  {t("mdm.sites.chainScopeNote")}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">{t("mdm.sites.title")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("mdm.sites.column.code")}</th>
                      <th scope="col">{t("mdm.sites.column.name")}</th>
                      <th scope="col">{t("mdm.sites.column.jurisdiction")}</th>
                      <th scope="col">{t("mdm.sites.column.timezone")}</th>
                      <th scope="col">{t("mdm.sites.column.currency")}</th>
                      <th scope="col">{t("mdm.sites.column.outlets")}</th>
                      <th scope="col">{t("mdm.sites.column.locale")}</th>
                      <th scope="col">{t("mdm.sites.column.status")}</th>
                      <th scope="col">{t("mdm.sites.column.lastChange")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.sites.map((site) => (
                      <tr
                        key={site.id}
                        data-clickable="true"
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("a")) return;
                          if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                          void router.navigate({
                            to: "/mdm/sites/$siteCode",
                            params: { siteCode: site.code },
                          });
                        }}
                      >
                        <td className="font-mono text-xs">
                          <Link
                            to="/mdm/sites/$siteCode"
                            params={{ siteCode: site.code }}
                            className="block whitespace-nowrap underline decoration-dotted underline-offset-2"
                          >
                            {site.code}
                          </Link>
                        </td>
                        <td>{site.name}</td>
                        <td>
                          {site.jurisdictionCode ? (
                            <Badge tone="neutral" shape={false}>
                              {site.jurisdictionCode}
                            </Badge>
                          ) : (
                            <span className="text-xs text-warn">
                              {t("mdm.sites.jurisdiction.none")}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap font-mono text-xs">{site.timezone}</td>
                        <td className="whitespace-nowrap font-mono text-xs">
                          {site.currency === "" ? "—" : site.currency}
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="numeric">{String(site.outletCount)}</span>
                          {site.outletKinds.length > 0 ? (
                            <span className="ms-2 text-xs text-fg-muted">
                              {site.outletKinds
                                .map(
                                  (entry) =>
                                    `${t(KIND_LABEL[entry.kind] ?? "mdm.outlet.kind.restaurant")} ×${String(entry.count)}`
                                )
                                .join(" · ")}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap">
                          {site.localeInherited ? (
                            <span
                              className="text-xs text-fg-muted"
                              title={t("mdm.sites.locale.inheritedTitle")}
                            >
                              {t("mdm.sites.locale.inherited", { locale: site.effectiveLocale })}
                            </span>
                          ) : (
                            <span className="font-mono text-xs">{site.locale}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <Badge tone={STATUS_TONE[site.status] ?? "neutral"}>
                            {t(STATUS_LABEL[site.status] ?? "mdm.site.status.active")}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap text-fg-muted">
                          <TimestampValue value={site.lastChange} mode="dateTime" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}

        <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
          {t("mdm.sites.count", { shown: String(shown), total: String(result.total) })}
        </p>
        {result.hasMore ? (
          <p className="border-t border-border px-4 py-2 text-xs text-warn">
            {t("mdm.sites.truncated", {
              shown: String(sites.length),
              total: String(result.total),
            })}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={t("mdm.sites.markets.title")} subtitle={t("mdm.sites.scope.note")} />
        <ul className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
          {result.requirements.length === 0 ? (
            <li>{t("mdm.sites.markets.none")}</li>
          ) : (
            result.requirements.map((requirement) => (
              <li key={`${requirement.jurisdiction}:${requirement.field}`}>
                {t("mdm.sites.markets.row", {
                  jurisdiction: requirement.jurisdiction,
                  field: requirement.field,
                  requirement: requirement.requirement,
                })}
              </li>
            ))
          )}
          <li>{t("mdm.sites.tier.note")}</li>
          <li>{t("mdm.sites.openRecord")}</li>
        </ul>
      </Card>
    </div>
  );
}
