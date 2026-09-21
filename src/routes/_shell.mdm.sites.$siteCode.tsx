import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  DescriptionList,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PermissionDenied,
  SectionHeader,
  Select,
  Skeleton,
} from "~/components/ui";
import { NoValue, TimestampValue } from "~/components/values";
import { ProvenanceChip } from "~/components/provenance";
import type { OutletView, SiteDetail } from "~/domain/mdm-sites";
import { useI18n } from "~/i18n";
import { LOCALES } from "~/i18n/locales";
import type { MessageKey } from "~/i18n/catalog-en";
import { getSiteFn, updateSiteLocaleFn } from "~/server-fns";
/**
 * The site record (§12.4): Identity · Address · Trading · Outlets · Language ·
 * Configuration · Compliance · Change history · ERP-maintained.
 *
 * **This is a reader's screen**, and that is a decision rather than an omission. §12.3
 * defines site creation, outlet creation and site closure as their own audited actions behind
 * `mdm.site.create`, `mdm.outlet.create` / `mdm.outlet.propose` and `mdm.site.deactivate`,
 * and the lead scoped this slab to the screens and the reads behind them. So instead of a
 * create wizard with no maker-checker behind it, this record states which capability each
 * unbuilt action *would* need and where it will live — the same honesty the article record
 * applies to its own missing halves.
 *
 * The one write it does offer is the **site's interface locale**, and it goes through the
 * server function that already exists (`updateSiteLocale`, `site.locale.update`) — the
 * existing write path, reused rather than paralleled (§12.1, §12.3 item 3).
 *
 * Two things this screen refuses to blur:
 *
 *   * **The licence tier belongs to the chain.** It is shown read-only, once, with a link to
 *     the chain record. There is no tier field here and no per-site gating anywhere — the
 *     PRD's "assigned license tier" on the site record is contradicted by the owner's locked
 *     decision, and the plan wins.
 *   * **An outlet carries no jurisdiction and no currency** (§12.2). The outlet rows show
 *     those values *labelled as inherited from the site*, so nobody reads the pane as a
 *     second source of truth for tax.
 */
export const Route = createFileRoute("/_shell/mdm/sites/$siteCode")({
  staticData: { titleKey: "mdm.site.detail.titleFallback" },
  loader: async ({ params }) => getSiteFn({ data: { code: params.siteCode } }),
  pendingComponent: SitePending,
  component: SiteScreen,
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
const OUTLET_STATUS_LABEL: Record<string, MessageKey> = {
  onboarding: "mdm.site.status.onboarding",
  active: "mdm.site.status.active",
  suspended: "mdm.site.status.suspended",
  closed: "mdm.site.status.closed",
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
const SECTION_KIND_LABEL: Record<string, MessageKey> = {
  kitchen: "mdm.outlet.section.kind.kitchen",
  bar: "mdm.outlet.section.kind.bar",
  grill: "mdm.outlet.section.kind.grill",
  cold: "mdm.outlet.section.kind.cold",
  bakery: "mdm.outlet.section.kind.bakery",
  dessert: "mdm.outlet.section.kind.dessert",
  beverage: "mdm.outlet.section.kind.beverage",
  expedite: "mdm.outlet.section.kind.expedite",
  other: "mdm.outlet.section.kind.other",
};
const SERVICE_MODE_LABEL: Record<string, MessageKey> = {
  dine_in: "mdm.site.serviceMode.dine_in",
  takeaway: "mdm.site.serviceMode.takeaway",
  delivery: "mdm.site.serviceMode.delivery",
  room_service: "mdm.site.serviceMode.room_service",
  drive_thru: "mdm.site.serviceMode.drive_thru",
};
const TIER_LABEL: Record<string, MessageKey> = {
  silver: "chains.tier.silver",
  gold: "chains.tier.gold",
  platinum: "chains.tier.platinum",
};
const ERP_GROUP_LABEL: Record<string, MessageKey> = {
  org: "mdm.erp.group.org",
  admin: "mdm.erp.group.admin",
};
const SITE_ERP_FIELD_LABEL: Record<string, MessageKey> = {
  erpCompanyCode: "mdm.erp.field.erpCompanyCode",
  erpTaxJurisdictionCode: "mdm.erp.field.taxJurisdictionCode",
  erpSourceVersion: "mdm.erp.field.erpSourceVersion",
};
const DAY_LABEL: Record<string, MessageKey> = {
  mon: "mdm.site.day.mon",
  tue: "mdm.site.day.tue",
  wed: "mdm.site.day.wed",
  thu: "mdm.site.day.thu",
  fri: "mdm.site.day.fri",
  sat: "mdm.site.day.sat",
  sun: "mdm.site.day.sun",
};
const ERP_STATUS_LABEL: Record<string, MessageKey> = {
  not_configured: "mdm.erp.status.not_configured",
  active: "mdm.erp.status.active",
  paused: "mdm.erp.status.paused",
  error: "mdm.erp.status.error",
};
const CONFIG_SOURCE_LABEL: Record<string, MessageKey> = {
  site: "mdm.site.configuration.source.site",
  chain: "mdm.site.configuration.source.chain",
  definition: "mdm.site.configuration.source.definition",
};
const COMPLIANCE_FIELD_LABEL: Record<string, MessageKey> = {
  address: "mdm.site.field.address",
  currency: "mdm.site.field.currency",
  jurisdiction: "mdm.site.field.jurisdiction",
};

function SitePending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <span className="sr-only">{t("mdm.site.detail.loading")}</span>
      <Card className="p-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-1/2" />
      </Card>
      <Card className="p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </Card>
    </div>
  );
}

function SiteScreen() {
  // Same union as the vendor record: the read, or the refusal envelope.
  const result = Route.useLoaderData() as
    | { ok: true; site: SiteDetail }
    | { ok: false; status: number; error: string; message: string; permission?: string | null };
  const { principal } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localeOpen, setLocaleOpen] = useState(false);

  if (!result.ok) {
    return <SiteFailure result={result} />;
  }
  const site = result.site;
  const canSetLocale = principal.permissions.includes("site.locale.update");

  const erpGroups = ["org", "admin"].filter((group) =>
    site.erp.fields.some((field) => field.group === group)
  );
  const ownershipByGroup = new Map(site.erp.ownership.map((row) => [row.fieldGroup, row]));

  return (
    <>
      <PageHeader
        eyebrow={t("mdm.site.detail.eyebrow")}
        title={site.name}
        description={t("mdm.site.detail.scope")}
        meta={
          <>
            <code className="font-mono text-xs text-fg-muted">{site.code}</code>
            <Badge tone={STATUS_TONE[site.status] ?? "neutral"}>
              {t(STATUS_LABEL[site.status] ?? "mdm.site.status.active")}
            </Badge>
            {site.jurisdictionCode ? (
              <Badge tone="neutral" shape={false}>
                {site.jurisdictionCode}
              </Badge>
            ) : null}
            <span className="font-mono text-xs text-fg-muted">{site.timezone}</span>
          </>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void router.navigate({ to: "/mdm/sites" });
            }}
          >
            {t("mdm.site.detail.back")}
          </Button>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        {error ? (
          <Banner tone="danger" title={t("error.title")}>
            {error}
          </Banner>
        ) : null}
        {notice ? (
          <Banner tone="ok" title={t("action.confirm")}>
            {notice}
          </Banner>
        ) : null}
        {site.status === "closed" ? (
          <Banner tone="warn" compact>
            {t("mdm.site.detail.closed", { reason: site.closureReason ?? t("common.none") })}
          </Banner>
        ) : null}

        {/* ── Identity ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.site.section.identity")} subtitle={t("mdm.site.detail.tierNote")} />
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.site.field.code"),
                  value: <code className="font-mono text-xs">{site.code}</code>,
                },
                { label: t("mdm.site.field.name"), value: site.name },
                {
                  label: t("mdm.site.field.chain"),
                  value: (
                    <Link
                      to="/chains/$chainId"
                      params={{ chainId: site.chain.id }}
                      className="underline decoration-dotted underline-offset-2"
                    >
                      {site.chain.name}
                    </Link>
                  ),
                },
                {
                  label: t("mdm.site.field.tier"),
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral" shape={false}>
                        {t(TIER_LABEL[site.chain.licenceTier] ?? "chains.tier.silver")}
                      </Badge>
                      <span className="text-xs text-fg-muted">{t("mdm.site.field.tierReadOnly")}</span>
                    </span>
                  ),
                },
                {
                  label: t("mdm.site.field.status"),
                  value: (
                    <Badge tone={STATUS_TONE[site.status] ?? "neutral"}>
                      {t(STATUS_LABEL[site.status] ?? "mdm.site.status.active")}
                    </Badge>
                  ),
                },
                {
                  label: t("mdm.site.field.externalRef"),
                  value: site.externalRef ? (
                    <span>
                      <code className="font-mono text-xs">{site.externalRef}</code>
                      {site.sourceSystem ? (
                        <span className="ms-2 text-xs text-fg-muted">{site.sourceSystem}</span>
                      ) : null}
                    </span>
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.site.field.serviceModes"),
                  value:
                    site.serviceModes.length === 0 ? (
                      <span className="text-warn">{t("mdm.site.serviceModes.empty")}</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {site.serviceModes.map((mode) => (
                          <li key={mode}>
                            <Badge tone="neutral" shape={false}>
                              {t(SERVICE_MODE_LABEL[mode] ?? "mdm.site.serviceMode.dine_in")}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  label: t("mdm.site.field.outletCount"),
                  value: String(site.outlets.length),
                },
              ]}
            />
          </div>
        </Card>

        {/* ── Address ───────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.address")}
            subtitle={t("mdm.site.address.subtitle")}
          />
          <div className="p-4">
            {site.address.line1 === null && site.address.locality === null ? (
              <EmptyState
                compact
                title={t("mdm.site.address.empty.title")}
                description={t("mdm.site.address.empty.description")}
              />
            ) : (
              <address className="text-sm not-italic">
                {[
                  site.address.line1,
                  site.address.line2,
                  site.address.locality,
                  site.address.region,
                  site.address.postalCode,
                  site.address.countryCode,
                ]
                  .filter((part): part is string => part !== null && part !== "")
                  .map((part, index) => (
                    <span key={index} className="block">
                      {part}
                    </span>
                  ))}
              </address>
            )}
          </div>
        </Card>

        {/* ── Trading ───────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.site.section.trading")} subtitle={t("mdm.site.trading.subtitle", {
            zone: site.timezone,
          })} />
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.site.field.currency"),
                  value: site.currency ? (
                    <code className="font-mono text-xs">{site.currency}</code>
                  ) : (
                    <span className="text-warn">{t("mdm.site.currency.none")}</span>
                  ),
                },
                {
                  label: t("mdm.site.field.timezone"),
                  value: <code className="font-mono text-xs">{site.timezone}</code>,
                },
                {
                  label: t("mdm.site.field.jurisdiction"),
                  value: site.jurisdictionCode ?? <NoValue />,
                },
              ]}
            />
          </div>
          <SectionHeader
            level={3}
            title={t("mdm.site.hours.title")}
            count={String(site.operatingHours.length)}
          />
          {site.operatingHours.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.site.hours.empty.title")}
                description={t("mdm.site.hours.empty.description")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.site.hours.title")}</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted uppercase">
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.hours.column.scope")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.hours.column.day")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.hours.column.opens")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.hours.column.closes")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.hours.column.note")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {site.operatingHours.map((entry) => (
                    <tr
                      key={`${entry.scope}:${entry.outletCode ?? ""}:${String(entry.dayOfWeek)}`}
                      className="border-b border-border last:border-b-0"
                    >
                      <td className="px-4 py-2 text-xs text-fg-muted">
                        {entry.scope === "site"
                          ? t("mdm.site.hours.scope.site")
                          : t("mdm.site.hours.scope.outlet", { code: entry.outletCode ?? "" })}
                      </td>
                      <td className="px-4 py-2">
                        {DAY_LABEL[entry.dayKey] ? t(DAY_LABEL[entry.dayKey]) : entry.dayKey}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {entry.closed ? t("mdm.site.hours.closed") : (entry.opensAt ?? "—")}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {entry.closed ? "—" : (entry.closesAt ?? "—")}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-muted">{entry.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.site.hours.zoneNote", { zone: site.timezone })}
          </p>
        </Card>

        {/* ── Outlets ───────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.outlets")}
            subtitle={t("mdm.site.outlets.subtitle")}
          />
          {site.outlets.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.site.outlets.empty.title")}
                description={t("mdm.site.outlets.empty.description")}
              />
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {site.outlets.map((outlet) => (
                <OutletPane key={outlet.id} outlet={outlet} />
              ))}
            </div>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.site.outlets.actionNote", {
              create: "mdm.outlet.create",
              propose: "mdm.outlet.propose",
            })}
          </p>
        </Card>

        {/* ── Language ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.language")}
            subtitle={t("mdm.site.language.subtitle")}
          />
          <SectionHeader
            level={3}
            title={t("mdm.site.language.title")}
            actions={
              canSetLocale ? (
                <Button size="sm" variant="secondary" onClick={() => setLocaleOpen(true)}>
                  {t("mdm.site.language.action.set")}
                </Button>
              ) : undefined
            }
          />
          {canSetLocale ? (
            <p className="px-4 pt-3 text-xs text-fg-subtle">
              {t("mdm.site.language.capabilityHint", { permission: "site.locale.update" })}
            </p>
          ) : (
            <div className="px-4 pt-3">
              <Banner tone="info" compact>
                {t("mdm.site.language.readOnly", { permission: "site.locale.update" })}
              </Banner>
            </div>
          )}
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.site.language.siteLocale"),
                  value: site.locale ? (
                    <code className="font-mono text-xs">{site.locale}</code>
                  ) : (
                    <span className="text-fg-muted">{t("mdm.site.language.inherited")}</span>
                  ),
                },
                {
                  label: t("mdm.site.language.effectiveLocale"),
                  value: <code className="font-mono text-xs">{site.effectiveLocale}</code>,
                },
                {
                  label: t("mdm.site.language.resolution"),
                  value: t("mdm.site.language.resolutionNote"),
                  span: true,
                },
              ]}
            />
          </div>
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.site.language.writePathNote")}
          </p>
        </Card>

        {/* ── Configuration (read-only resolved values) ──────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.configuration")}
            subtitle={t("mdm.site.configuration.subtitle")}
          />
          {site.configuration.length === 0 ? (
            <p className="px-4 py-3 text-xs text-fg-muted">{t("mdm.site.configuration.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.site.section.configuration")}</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted uppercase">
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.configuration.column.key")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.configuration.column.value")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.configuration.column.source")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.site.configuration.column.bounds")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {site.configuration.map((setting) => (
                    <tr key={setting.key} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2">
                        <span className="block">
                          {t(setting.labelKey as MessageKey)}
                        </span>
                        <code className="font-mono text-2xs text-fg-subtle">{setting.key}</code>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {setting.value ?? "—"}
                        {setting.unit ? (
                          <span className="ms-1 text-fg-muted">{setting.unit}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={setting.source === "site" ? "accent" : "neutral"} shape={false}>
                          {t(CONFIG_SOURCE_LABEL[setting.source] ?? "mdm.site.configuration.source.definition")}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-muted">
                        {setting.min === null && setting.max === null
                          ? "—"
                          : `${setting.min ?? "—"} … ${setting.max ?? "—"}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
            <p className="max-w-prose text-xs text-fg-subtle">
              {t("mdm.site.configuration.writePathNote")}
            </p>
            <Link
              to="/chains/$chainId/settings"
              params={{ chainId: site.chain.id }}
              className="text-xs underline decoration-dotted underline-offset-2"
            >
              {t("mdm.site.configuration.openSettings")}
            </Link>
          </div>
        </Card>

        {/* ── Compliance ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.compliance")}
            subtitle={t("mdm.site.compliance.subtitle")}
          />
          <SectionHeader
            level={3}
            title={t("mdm.site.compliance.siteTitle")}
            count={String(site.compliance.length)}
          />
          {site.compliance.length === 0 ? (
            <p className="px-4 py-3 text-xs text-fg-muted">{t("mdm.site.compliance.none")}</p>
          ) : (
            <ul className="flex flex-col gap-2 p-4">
              {site.compliance.map((cell) => (
                <li key={`${cell.jurisdiction}:${cell.field}`} className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral" shape={false}>
                    {cell.jurisdiction}
                  </Badge>
                  <span className="text-sm">
                    {COMPLIANCE_FIELD_LABEL[cell.field] ? t(COMPLIANCE_FIELD_LABEL[cell.field]) : cell.field}
                  </span>
                  <code className="font-mono text-2xs text-fg-subtle">{cell.field}</code>
                  <span className="text-xs text-fg-muted">{cell.requirement}</span>
                  {!cell.checked ? (
                    <span title={t("mdm.articles.compliance.gap")}>
                      <Badge tone="neutral" shape={false}>
                        {t("mdm.articles.compliance.unchecked")}
                      </Badge>
                    </span>
                  ) : cell.satisfied ? (
                    <Badge tone="ok">{t("mdm.vendor.compliance.met")}</Badge>
                  ) : (
                    <Badge tone="warn">{t("mdm.vendor.compliance.missing")}</Badge>
                  )}
                  {cell.legalRef ? (
                    <span className="text-2xs text-fg-subtle">{cell.legalRef}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <SectionHeader
            level={3}
            title={t("mdm.site.compliance.articleTitle")}
            count={String(site.articleRequirements.length)}
            actions={
              <Link
                to="/mdm/articles"
                className="text-xs underline decoration-dotted underline-offset-2"
              >
                {t("mdm.site.compliance.openArticles")}
              </Link>
            }
          />
          {site.articleRequirements.length === 0 ? (
            <p className="px-4 py-3 text-xs text-fg-muted">{t("mdm.site.compliance.articlesNone")}</p>
          ) : (
            <ul className="flex flex-col gap-2 p-4 text-xs">
              {site.articleRequirements.map((requirement) => (
                <li key={requirement.field} className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-2xs text-fg-muted">{requirement.field}</code>
                  <span>{requirement.requirement}</span>
                  {requirement.legalRef ? (
                    <span className="text-2xs text-fg-subtle">{requirement.legalRef}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.site.compliance.perArticleNote")}
          </p>
        </Card>

        {/* ── Change history ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.history")}
            subtitle={t("mdm.site.history.subtitle")}
          />
          {site.history.denied ? (
            <div className="p-4">
              <PermissionDenied
                title={t("mdm.vendor.history.denied.title")}
                description={t("mdm.vendor.history.denied.description")}
                requiredPermission={site.history.denied.permission}
              />
            </div>
          ) : site.history.entries.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.site.history.empty.title")}
                description={t("mdm.site.history.empty.description")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.site.section.history")}</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted uppercase">
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.history.column.at")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.history.column.action")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.history.column.actor")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.history.column.outcome")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {site.history.entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2 whitespace-nowrap text-fg-muted">
                        <TimestampValue value={entry.at} mode="dateTime" />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{entry.action}</td>
                      <td className="px-4 py-2">
                        {entry.actorName ?? <NoValue />}
                        {entry.actorRoleCode ? (
                          <span className="ms-2 text-2xs text-fg-subtle">{entry.actorRoleCode}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={entry.outcome === "success" ? "ok" : "warn"}>
                          {entry.outcome === "success"
                            ? t("mdm.vendor.history.outcome.success")
                            : entry.outcome === "denied"
                              ? t("mdm.vendor.history.outcome.denied")
                              : t("mdm.vendor.history.outcome.error")}
                        </Badge>
                        {entry.reason ? (
                          <span className="ms-2 text-2xs text-fg-muted">{entry.reason}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
            <p className="max-w-prose text-xs text-fg-subtle">{t("mdm.vendor.history.note")}</p>
            <Link to="/audit" className="text-xs underline decoration-dotted underline-offset-2">
              {t("mdm.article.audit.open")}
            </Link>
          </div>
        </Card>

        {/* ── Unbuilt actions, named rather than implied ─────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.site.section.actions")}
            subtitle={t("mdm.site.actions.subtitle")}
          />
          <ul className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
            <li>{t("mdm.site.actions.createSite", { permission: "mdm.site.create" })}</li>
            <li>{t("mdm.site.actions.closeSite", { permission: "mdm.site.deactivate" })}</li>
            <li>{t("mdm.site.actions.createOutlet", { permission: "mdm.outlet.create" })}</li>
            <li>{t("mdm.site.actions.proposeOutlet", { permission: "mdm.outlet.propose" })}</li>
            <li>{t("mdm.site.actions.terminals")}</li>
          </ul>
        </Card>

        {/* ── ERP-maintained: last, collapsed, with a count (§25.1) ──────────── */}
        {site.erp.system ? (
          <Card>
            <details className="group">
              <summary className="cursor-pointer list-none px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold text-fg">{t("mdm.erp.section.title")}</span>
                  <span className="text-xs text-fg-muted">
                    {t("mdm.erp.section.count", {
                      count: String(site.erp.fields.length),
                      system: site.erp.system.displayName,
                    })}
                  </span>
                  <span className="text-xs text-fg-subtle group-open:hidden">
                    {t("mdm.erp.section.show")}
                  </span>
                  <span className="hidden text-xs text-fg-subtle group-open:inline">
                    {t("mdm.erp.section.hide")}
                  </span>
                </span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-border p-4">
                <p className="text-xs text-fg-muted">
                  {t("mdm.erp.system.declared", { system: site.erp.system.displayName })}
                </p>
                {site.erpOrgUnits.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <h3 className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                      {t("mdm.erp.group.org")}
                    </h3>
                    <ul className="flex flex-col gap-1 text-xs">
                      {site.erpOrgUnits.map((unit) => (
                        <li key={unit.id} className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-2xs">{unit.systemCode}</code>
                          <span>{unit.orgUnitType}</span>
                          <code className="font-mono text-xs">{unit.erpCode}</code>
                          {unit.isPrimary ? (
                            <Badge tone="accent" shape={false}>
                              {t("mdm.site.erpOrgUnit.primary")}
                            </Badge>
                          ) : null}
                          {unit.outletCode ? (
                            <span className="text-fg-muted">{unit.outletCode}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {erpGroups.length === 0 ? (
                  <p className="text-xs text-fg-muted">{t("mdm.erp.section.empty")}</p>
                ) : (
                  erpGroups.map((group) => {
                    const fields = site.erp.fields.filter((field) => field.group === group);
                    const ownership = ownershipByGroup.get(group) ?? null;
                    return (
                      <div key={group} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                            {t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                          </h3>
                          <ProvenanceChip
                            systemName={site.erp.system?.displayName ?? t("common.unknown")}
                            groupLabel={t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                            keyKind={site.provenance[0]?.externalKeyKind ?? null}
                            keyValue={site.provenance[0]?.externalKeyValue ?? null}
                            lastSyncAt={site.erp.system?.lastSyncAt ?? null}
                            systemStatusLabel={t(
                              ERP_STATUS_LABEL[site.erp.system?.status ?? "not_configured"] ??
                                "mdm.erp.status.not_configured"
                            )}
                            ownership={
                              ownership
                                ? {
                                    fieldGroup: ownership.fieldGroup,
                                    owner: ownership.owner,
                                    inboundAction: ownership.inboundAction,
                                    outboundAction: ownership.outboundAction,
                                    overrideAllowed: ownership.overrideAllowed,
                                    noteKey: ownership.noteKey,
                                  }
                                : null
                            }
                          />
                        </div>
                        <DescriptionList
                          columns={2}
                          items={fields.map((field) => ({
                            label: SITE_ERP_FIELD_LABEL[field.field]
                              ? t(SITE_ERP_FIELD_LABEL[field.field])
                              : field.field,
                            value: <span className="font-mono text-xs">{field.text ?? "—"}</span>,
                          }))}
                        />
                      </div>
                    );
                  })
                )}
                <p className="text-xs text-fg-subtle">{t("mdm.erp.section.readOnly")}</p>
                <p className="text-xs text-fg-subtle">
                  {t("mdm.erp.section.ownershipNote", { entity: "site" })}
                </p>
              </div>
            </details>
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-xs text-fg-muted">{t("mdm.erp.notConfigured")}</p>
          </Card>
        )}
      </div>

      {localeOpen ? (
        <LocaleDialog
          busy={busy}
          site={site}
          onClose={() => setLocaleOpen(false)}
          onSave={async (locale, success) => {
            setBusy(true);
            const response = await updateSiteLocaleFn({
              data: { chainId: site.chain.id, siteId: site.id, locale },
            });
            setBusy(false);
            setLocaleOpen(false);
            if (!response.ok) {
              setError(response.message ?? t("error.description"));
              return;
            }
            setError(null);
            setNotice(success);
            await router.invalidate();
          }}
        />
      ) : null}
    </>
  );
}

/** One outlet: what it owns, and what it inherits from its site (§12.2). */
function OutletPane({ outlet }: { outlet: OutletView }) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-fg">{outlet.name}</h3>
        <code className="font-mono text-2xs text-fg-muted">{outlet.code}</code>
        <Badge tone="neutral" shape={false}>
          {t(KIND_LABEL[outlet.kind] ?? "mdm.outlet.kind.restaurant")}
        </Badge>
        <Badge tone={outlet.status === "active" ? "ok" : outlet.status === "closed" ? "neutral" : "warn"}>
          {t(OUTLET_STATUS_LABEL[outlet.status] ?? "mdm.site.status.active")}
        </Badge>
        {outlet.serviceModes.map((mode) => (
          <Badge key={mode} tone="neutral" shape={false}>
            {t(SERVICE_MODE_LABEL[mode] ?? "mdm.site.serviceMode.dine_in")}
          </Badge>
        ))}
      </div>
      <DescriptionList
        columns={2}
        items={[
          {
            label: t("mdm.outlet.field.sections"),
            value:
              outlet.sections.length === 0 ? (
                <NoValue />
              ) : (
                <ul className="flex flex-wrap gap-1">
                  {outlet.sections.map((section) => (
                    <li key={section.code}>
                      <Badge tone="neutral" shape={false}>
                        {section.code} ·{" "}
                        {t(SECTION_KIND_LABEL[section.kind] ?? "mdm.outlet.section.kind.other")}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            label: t("mdm.outlet.field.pricedArticles"),
            value:
              outlet.pricedArticleCount === 0 ? (
                <span className="text-fg-muted">{t("mdm.outlet.pricedArticles.none")}</span>
              ) : (
                <span>
                  <span className="numeric">{String(outlet.pricedArticleCount)}</span>
                  <span className="ms-2 font-mono text-2xs text-fg-muted">
                    {outlet.pricedArticleCodes.slice(0, 6).join(", ")}
                    {outlet.pricedArticleCodes.length > 6 ? " …" : ""}
                  </span>
                </span>
              ),
          },
          {
            label: t("mdm.outlet.field.inherited"),
            value: (
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <span>
                  {t("mdm.outlet.inherited.zone", { zone: outlet.inherited.timezone })}
                </span>
                <span>
                  {t("mdm.outlet.inherited.currency", {
                    currency: outlet.inherited.currency || "—",
                  })}
                </span>
                <span>
                  {t("mdm.outlet.inherited.jurisdiction", {
                    jurisdiction: outlet.inherited.jurisdictionCode ?? "—",
                  })}
                </span>
                <span>
                  {t("mdm.outlet.inherited.locale", {
                    locale: outlet.inherited.locale ?? t("mdm.site.language.inherited"),
                  })}
                </span>
              </span>
            ),
          },
          {
            label: t("mdm.outlet.field.externalRef"),
            value: outlet.externalRef ? (
              <span>
                <code className="font-mono text-xs">{outlet.externalRef}</code>
                {outlet.sourceSystem ? (
                  <span className="ms-2 text-xs text-fg-muted">{outlet.sourceSystem}</span>
                ) : null}
              </span>
            ) : (
              <NoValue />
            ),
          },
        ]}
      />
      <p className="text-xs text-fg-subtle">{t("mdm.outlet.displays.note")}</p>
    </section>
  );
}

/** The locale hop, through the server function that already exists (§12.1). */
function LocaleDialog({
  busy,
  site,
  onClose,
  onSave,
}: {
  busy: boolean;
  site: SiteDetail;
  onClose: () => void;
  onSave: (locale: string | null, success: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(site.locale ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      width="sm"
      title={t("mdm.site.language.dialog.title")}
      description={t("mdm.site.language.dialog.description", { site: site.code })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void onSave(
                value === "" ? null : value,
                value === ""
                  ? t("mdm.site.language.savedInherited")
                  : t("mdm.site.language.saved", { locale: value })
              )
            }
          >
            {t("mdm.site.language.dialog.confirm")}
          </Button>
        </>
      }
    >
      <Field
        id="site-locale"
        label={t("mdm.site.language.siteLocale")}
        hint={t("mdm.site.language.dialog.hint")}
      >
        <Select
          value={value}
          onChange={setValue}
          ariaLabel={t("mdm.site.language.siteLocale")}
          emptyLabel={t("mdm.site.language.dialog.inherit")}
          options={LOCALES.map((locale) => ({
            value: locale.code,
            label: `${locale.label} · ${locale.code}`,
          }))}
        />
      </Field>
    </Dialog>
  );
}

function SiteFailure({
  result,
}: {
  result: { status: number; error: string; message: string; permission?: string | null };
}) {
  const { t } = useI18n();
  const router = useRouter();
  if (result.status === 403) {
    return (
      <div className="p-4">
        <Card>
          <PermissionDenied
            title={t("mdm.site.denied.title")}
            description={t("mdm.site.denied.description")}
            requiredPermission={result.permission ?? "mdm.site.view"}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void router.navigate({ to: "/mdm/sites" });
                }}
              >
                {t("mdm.site.detail.back")}
              </Button>
            }
          />
          <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">{result.message}</p>
        </Card>
      </div>
    );
  }
  if (result.status === 404) {
    return (
      <div className="p-4">
        <ErrorState
          title={t("error.notFound.title")}
          description={t("error.notFound.description")}
          detail={result.message}
        />
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
