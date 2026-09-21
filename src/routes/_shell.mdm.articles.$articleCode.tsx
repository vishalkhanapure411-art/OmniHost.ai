import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { ProvenanceChip } from "~/components/provenance";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  ConfirmSummary,
  DescriptionList,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PermissionDenied,
  SectionHeader,
  SegmentedControl,
  Select,
  Skeleton,
  TextInput,
} from "~/components/ui";
import { MoneyValue, NumberValue, QuantityValue, TimestampValue } from "~/components/values";
import type { ErpOwnedField } from "~/domain/mdm";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { getArticleFn, setArticleAvailabilityFn, updateArticlePriceFn } from "~/server-fns";

/**
 * The article record — `/mdm/articles/ART-1042` (spec §7.5, Part II §25).
 *
 * One record, four things to read: identity, selling, compliance, versions — plus the
 * ERP-maintained section, which is last and collapsed because §25.1 is emphatic that
 * adding the ERP's ~35 fields must not add a single field to the common path.
 *
 * What this screen may **write** is deliberately narrow: the per-outlet price and the
 * per-outlet availability, both of which are effective-dated rows rather than versions, and
 * both of which are already live, audited endpoints (§7.2 items 5 and 6). Everything else
 * is read-only here, and says so — editing what an article *is* starts a new draft version
 * through maker-checker, which is the next slab and is not faked with a free-text form.
 *
 * Three rules the spec states that shaped the code rather than the comments:
 *
 *   1. **Money is never a bare number** (§8.4). A price renders through `MoneyValue` with
 *      its ISO code, and the dialog shows the outlet's own currency as a read-only fact
 *      rather than an editable field — the server refuses a mismatch anyway, so offering
 *      the choice would be a lie.
 *   2. **An ERP-owned field is a value, never a disabled input** (§25.3). It renders as a
 *      `DescriptionList` entry with a `ProvenanceChip` beside its group; the chip explains
 *      itself in words instead of announcing nothing to a screen reader.
 *   3. **The four states are never collapsed** (§17). Loading, refused, not found and the
 *      server's own error each get their own sentence, and the empty cases *inside* the
 *      panels are separate from the empty case of the record.
 *
 * Every string here resolves through `t()`. The codes it shows — `ART-1001`, `standard`,
 * `milk` — are data and are shown as they are, with a catalogued label beside them where
 * one exists (§4: codes are never translated, a label is resolved *from* the code).
 */
export const Route = createFileRoute("/_shell/mdm/articles/$articleCode")({
  staticData: { titleKey: "mdm.article.detail.titleFallback" },
  loader: async ({ params }) => getArticleFn({ data: { code: params.articleCode } }),
  pendingComponent: ArticlePending,
  component: ArticleScreen,
});

// ── Code → label maps. A code with no entry falls back to the code itself. ─────

const STATUS_LABEL: Record<string, MessageKey> = {
  draft: "mdm.article.status.draft",
  pending_review: "mdm.article.status.pending_review",
  active: "mdm.article.status.active",
  superseded: "mdm.article.version.status.superseded",
  seasonal: "mdm.article.status.seasonal",
  discontinued: "mdm.article.status.discontinued",
};
const TYPE_LABEL: Record<string, MessageKey> = {
  food: "mdm.article.type.food",
  beverage: "mdm.article.type.beverage",
  retail: "mdm.article.type.retail",
  service: "mdm.article.type.service",
};
const DIET_LABEL: Record<string, MessageKey> = {
  veg: "mdm.article.diet.veg",
  non_veg: "mdm.article.diet.non_veg",
  egg: "mdm.article.diet.egg",
  vegan: "mdm.article.diet.vegan",
  none: "mdm.article.diet.none",
};
const AVAILABILITY_LABEL: Record<string, MessageKey> = {
  available: "mdm.article.availability.state.available",
  seasonal: "mdm.article.availability.state.seasonal",
  unavailable: "mdm.article.availability.state.unavailable",
};
const AVAILABILITY_TONE: Record<string, "ok" | "warn" | "danger"> = {
  available: "ok",
  seasonal: "warn",
  unavailable: "danger",
};
const CHANNEL_LABEL: Record<string, MessageKey> = {
  pos: "mdm.article.channel.pos",
  tab: "mdm.article.channel.tab",
  kiosk: "mdm.article.channel.kiosk",
  app: "mdm.article.channel.app",
  cds: "mdm.article.channel.cds",
  aggregator: "mdm.article.channel.aggregator",
};
const REQUIREMENT_LABEL: Record<string, MessageKey> = {
  required: "mdm.article.compliance.requirement.required",
  recommended: "mdm.article.compliance.requirement.recommended",
  optional: "mdm.article.compliance.requirement.optional",
  forbidden: "mdm.article.compliance.requirement.forbidden",
};
const COMPLIANCE_FIELD_LABEL: Record<string, MessageKey> = {
  name: "mdm.article.compliance.field.name",
  dietaryMark: "mdm.article.compliance.field.dietaryMark",
  taxClass: "mdm.article.compliance.field.taxClass",
  hsnSacCode: "mdm.article.compliance.field.hsnSacCode",
  servingSize: "mdm.article.compliance.field.servingSize",
  caloriesKcal: "mdm.article.compliance.field.caloriesKcal",
  allergens: "mdm.article.compliance.field.allergens",
  nutrition: "mdm.article.compliance.field.nutrition",
  ingredientDeclaration: "mdm.article.compliance.field.ingredientDeclaration",
};
const ALLERGEN_LABEL: Record<string, MessageKey> = {
  celery: "mdm.allergen.label.celery",
  cereals_gluten: "mdm.allergen.label.cereals_gluten",
  crustaceans: "mdm.allergen.label.crustaceans",
  eggs: "mdm.allergen.label.eggs",
  fish: "mdm.allergen.label.fish",
  lupin: "mdm.allergen.label.lupin",
  milk: "mdm.allergen.label.milk",
  molluscs: "mdm.allergen.label.molluscs",
  mustard: "mdm.allergen.label.mustard",
  peanuts: "mdm.allergen.label.peanuts",
  sesame: "mdm.allergen.label.sesame",
  soybeans: "mdm.allergen.label.soybeans",
  sulphites: "mdm.allergen.label.sulphites",
  tree_nuts: "mdm.allergen.label.tree_nuts",
};
const NUTRIENT_LABEL: Record<string, MessageKey> = {
  energy_kcal: "mdm.nutrient.label.energy_kcal",
  protein: "mdm.nutrient.label.protein",
  carbohydrate: "mdm.nutrient.label.carbohydrate",
  total_fat: "mdm.nutrient.label.total_fat",
  saturated_fat: "mdm.nutrient.label.saturated_fat",
  trans_fat: "mdm.nutrient.label.trans_fat",
  sugars: "mdm.nutrient.label.sugars",
  sodium: "mdm.nutrient.label.sodium",
  cholesterol: "mdm.nutrient.label.cholesterol",
  dietary_fibre: "mdm.nutrient.label.dietary_fibre",
};
const BASIS_LABEL: Record<string, MessageKey> = {
  per_serving: "mdm.article.nutrition.basis.per_serving",
  per_100g: "mdm.article.nutrition.basis.per_100g",
  per_100ml: "mdm.article.nutrition.basis.per_100ml",
};
const ALLERGEN_SOURCE_LABEL: Record<string, MessageKey> = {
  declared: "mdm.article.allergen.source.declared",
  derived: "mdm.article.allergen.source.derived",
};
const ERP_GROUP_LABEL: Record<string, MessageKey> = {
  erpIdentity: "mdm.erp.group.erpIdentity",
  erpSync: "mdm.erp.group.erpSync",
  dimensions: "mdm.erp.group.dimensions",
  storage: "mdm.erp.group.storage",
  batch: "mdm.erp.group.batch",
  quality: "mdm.erp.group.quality",
  valuation: "mdm.erp.group.valuation",
  erpTax: "mdm.erp.group.erpTax",
  customs: "mdm.erp.group.customs",
  manufacturer: "mdm.erp.group.manufacturer",
  revision: "mdm.erp.group.revision",
};
const ERP_FIELD_LABEL: Record<string, MessageKey> = {
  sourceSystem: "mdm.erp.field.sourceSystem",
  externalRef: "mdm.erp.field.externalRef",
  materialType: "mdm.erp.field.materialType",
  lifecycleState: "mdm.erp.field.lifecycleState",
  blocked: "mdm.erp.field.blocked",
  sourceVersion: "mdm.erp.field.sourceVersion",
  netWeight: "mdm.erp.field.netWeight",
  grossWeight: "mdm.erp.field.grossWeight",
  storageCondition: "mdm.erp.field.storageCondition",
  temperatureCondition: "mdm.erp.field.temperatureCondition",
  shelfLifeDays: "mdm.erp.field.shelfLifeDays",
  batchManagement: "mdm.erp.field.batchManagement",
  serialProfile: "mdm.erp.field.serialProfile",
  receiptInspectionRequired: "mdm.erp.field.receiptInspectionRequired",
  certificateRequired: "mdm.erp.field.certificateRequired",
  valuationClass: "mdm.erp.field.valuationClass",
  priceControl: "mdm.erp.field.priceControl",
  standardPrice: "mdm.erp.field.standardPrice",
  movingAveragePrice: "mdm.erp.field.movingAveragePrice",
  taxClassification: "mdm.erp.field.taxClassification",
  taxGroup: "mdm.erp.field.taxGroup",
  countryOfOrigin: "mdm.erp.field.countryOfOrigin",
  customsTariffNumber: "mdm.erp.field.customsTariffNumber",
  exportControlClass: "mdm.erp.field.exportControlClass",
  manufacturerName: "mdm.erp.field.manufacturerName",
  partNumber: "mdm.erp.field.partNumber",
  revisionLevel: "mdm.erp.field.revisionLevel",
};
const ERP_CODE_LABEL: Record<string, MessageKey> = {
  standard: "mdm.erp.code.standard",
  moving_average: "mdm.erp.code.moving_average",
  FG: "mdm.erp.code.FG",
  HAWA: "mdm.erp.code.HAWA",
  active: "mdm.erp.code.active",
  DRY: "mdm.erp.code.DRY",
  CHILLED: "mdm.erp.code.CHILLED",
  AMBIENT: "mdm.erp.code.AMBIENT",
  FROZEN: "mdm.erp.code.FROZEN",
};
const ERP_STATUS_LABEL: Record<string, MessageKey> = {
  not_configured: "mdm.erp.status.not_configured",
  active: "mdm.erp.status.active",
  paused: "mdm.erp.status.paused",
  error: "mdm.erp.status.error",
};

/** The group order the ERP section renders in: identity first, revision last. */
const ERP_GROUP_ORDER = [
  "erpIdentity",
  "erpSync",
  "dimensions",
  "storage",
  "batch",
  "quality",
  "valuation",
  "erpTax",
  "customs",
  "manufacturer",
  "revision",
];

function ArticlePending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <span className="sr-only">{t("mdm.article.detail.loading")}</span>
      <Card className="p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </Card>
      <Card className="p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-1/2" />
      </Card>
    </div>
  );
}

function ArticleScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceOutlet, setPriceOutlet] = useState<string | null>(null);
  const [availabilityOutlet, setAvailabilityOutlet] = useState<string | null>(null);

  if (!result.ok) {
    return <ArticleFailure result={result} />;
  }

  const article = result.article;
  const canPrice = principal.permissions.includes("mdm.article.price.update");
  const canAvailability = principal.permissions.includes("mdm.article.update");

  async function afterWrite(response: { ok: boolean; message?: string }, success: string) {
    setBusy(false);
    setPriceOutlet(null);
    setAvailabilityOutlet(null);
    if (!response.ok) {
      setError(response.message ?? t("error.description"));
      return;
    }
    setError(null);
    setNotice(success);
    await router.invalidate();
  }

  const pricesByOutlet: Record<string, { amount: number; currencyCode: string }> = {};
  for (const price of article.prices) {
    pricesByOutlet[price.outletCode] = {
      amount: price.money.amount,
      currencyCode: price.money.currencyCode,
    };
  }
  const availabilityByOutlet = new Map(
    article.availability.map((row) => [row.outletCode, row])
  );
  const outletLabel = (code: string): string =>
    article.outlets.find((outlet) => outlet.code === code)?.name ?? code;

  // The compliance matrix is a matrix only when a chain actually trades in more than one
  // market. §7.4: a single-market operator must not be turned into a matrix-reading
  // exercise, so the one row is shown as a note beside the fields instead.
  const markets = Array.from(new Set(article.compliance.map((cell) => cell.jurisdiction)));
  const erpFields = article.erp.fields;
  const erpGroups = ERP_GROUP_ORDER.filter((group) =>
    erpFields.some((field) => field.group === group)
  );
  const ownershipByGroup = new Map(article.erp.ownership.map((row) => [row.fieldGroup, row]));
  const primaryProvenance = article.provenance[0];

  return (
    <>
      <PageHeader
        eyebrow={t("mdm.article.detail.eyebrow")}
        title={article.currentVersion.name}
        description={t("mdm.article.detail.scope")}
        meta={
          <>
            <code className="font-mono text-xs text-fg-muted">{article.code}</code>
            <Badge tone="neutral" shape={false}>
              {t(STATUS_LABEL[article.status] ?? "mdm.article.status.active")}
            </Badge>
            <Badge tone="neutral" shape={false}>
              {t(TYPE_LABEL[article.articleType] ?? "mdm.article.type.food")}
            </Badge>
            <Badge tone="neutral" shape={false}>
              {t(DIET_LABEL[article.currentVersion.dietaryMark ?? "none"] ?? "mdm.article.diet.none")}
            </Badge>
            <span className="text-xs text-fg-muted">
              {t("mdm.article.field.version")} {String(article.currentVersion.version)}
            </span>
          </>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void router.navigate({ to: "/mdm/articles" });
            }}
          >
            {t("mdm.article.detail.back")}
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
        <Banner tone="info" compact>
          {t("mdm.article.detail.readOnlyRecord", {
            version: String(article.currentVersion.version),
            status: t(STATUS_LABEL[article.currentVersion.status] ?? "mdm.article.status.active"),
          })}
        </Banner>

        {/* ── Identity ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.article.section.identity")} />
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                { label: t("mdm.article.field.code"), value: <code className="font-mono text-xs">{article.code}</code> },
                {
                  label: t("mdm.article.field.name"),
                  value: (
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span>{article.currentVersion.name}</span>
                      {article.currentVersion.untranslated ? (
                        <span className="text-xs text-fg-muted">
                          {t("mdm.article.detail.untranslated", {
                            locale: article.currentVersion.nameLocale,
                          })}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  label: t("mdm.article.field.shortName"),
                  value: article.currentVersion.shortName ?? <NoValue />,
                },
                { label: t("mdm.article.field.category"), value: article.category.name },
                {
                  label: t("mdm.article.field.type"),
                  value: t(TYPE_LABEL[article.articleType] ?? "mdm.article.type.food"),
                },
                { label: t("mdm.article.field.baseUom"), value: <code className="font-mono text-xs">{article.baseUomCode}</code> },
                {
                  label: t("mdm.article.field.diet"),
                  value: t(DIET_LABEL[article.currentVersion.dietaryMark ?? "none"] ?? "mdm.article.diet.none"),
                },
                {
                  label: t("mdm.article.field.servingSize"),
                  value:
                    article.currentVersion.servingSizeQty === null ? (
                      <NoValue />
                    ) : (
                      <QuantityValue
                        value={article.currentVersion.servingSizeQty}
                        uom={article.currentVersion.servingSizeUomCode ?? ""}
                      />
                    ),
                },
                {
                  label: t("mdm.article.field.calories"),
                  value:
                    article.currentVersion.caloriesKcal === null ? (
                      <NoValue />
                    ) : (
                      <NumberValue value={article.currentVersion.caloriesKcal} decimals={2} />
                    ),
                },
                {
                  label: t("mdm.article.field.taxClass"),
                  value: article.currentVersion.taxClassCode ? (
                    <span className="flex flex-wrap items-baseline gap-2">
                      <code className="font-mono text-xs">{article.currentVersion.taxClassCode}</code>
                      <span className="text-xs text-fg-muted">
                        {article.currentVersion.taxClassJurisdiction}
                      </span>
                    </span>
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.article.field.hsnSac"),
                  value: article.currentVersion.hsnSacCode ? (
                    <code className="font-mono text-xs">{article.currentVersion.hsnSacCode}</code>
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.article.field.channels"),
                  value:
                    article.currentVersion.channelFlags.length === 0 ? (
                      <span className="text-fg-muted">{t("mdm.article.channels.none")}</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {article.currentVersion.channelFlags.map((channel) => (
                          <Badge key={channel} tone="neutral" shape={false}>
                            {t(CHANNEL_LABEL[channel] ?? "mdm.article.channel.pos")}
                          </Badge>
                        ))}
                      </span>
                    ),
                },
                {
                  label: t("mdm.article.field.effectiveFrom"),
                  value: <TimestampValue value={article.currentVersion.effectiveFrom} mode="date" />,
                },
                {
                  label: t("mdm.article.field.approvedAt"),
                  value: <TimestampValue value={article.currentVersion.approvedAt} mode="dateTime" />,
                },
                {
                  label: t("mdm.article.detail.translations.label"),
                  value:
                    article.currentVersion.translations.length === 0 ? (
                      <span className="text-fg-muted">{t("mdm.article.detail.translations.none")}</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {article.currentVersion.translations.map((translation) => (
                          <span key={translation.locale} className="flex items-baseline gap-1">
                            <code className="font-mono text-2xs text-fg-subtle">{translation.locale}</code>
                            <span>{translation.name}</span>
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  label: t("mdm.article.field.recordId"),
                  value: <code className="font-mono text-2xs text-fg-muted">{article.id}</code>,
                  span: true,
                },
              ]}
            />
          </div>
        </Card>

        {/* ── Selling ───────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.article.section.selling")} />
          <section>
            <SectionHeader
              level={3}
              title={t("mdm.article.price.title")}
              count={String(article.prices.length)}
            />
            {!canPrice ? (
              <div className="px-4 pt-3">
                <Banner tone="info" compact>
                  {t("mdm.article.price.readOnly")}
                </Banner>
              </div>
            ) : null}
            {article.prices.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.article.price.empty.title")}
                  description={t("mdm.article.price.empty.description")}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-fg-muted uppercase">
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.price.column.outlet")}
                      </th>
                      <th className="px-4 py-2 text-end font-medium">
                        {t("mdm.article.price.column.amount")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.price.column.action")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {article.prices.map((price) => (
                      <tr key={price.outletId} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2">
                          <span className="block">{price.outletName}</span>
                          <span className="font-mono text-2xs text-fg-subtle">{price.outletCode}</span>
                        </td>
                        <td className="px-4 py-2 text-end">
                          <MoneyValue
                            money={{ amount: price.money.amount, currency: price.money.currencyCode }}
                          />
                        </td>
                        <td className="px-4 py-2">
                          {canPrice ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setError(null);
                                setPriceOutlet(price.outletCode);
                              }}
                            >
                              {t("mdm.article.price.edit")}
                            </Button>
                          ) : (
                            <span className="text-xs text-fg-subtle">{t("common.readOnly")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-4 py-2 text-xs text-fg-subtle">{t("mdm.article.price.subtitle")}</p>
          </section>

          <section className="border-t border-border">
            <SectionHeader
              level={3}
              title={t("mdm.article.availability.title")}
              count={String(article.availability.length)}
            />
            {!canAvailability ? (
              <div className="px-4 pt-3">
                <Banner tone="info" compact>
                  {t("mdm.article.availability.readOnly")}
                </Banner>
              </div>
            ) : null}
            {article.availability.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.article.availability.empty.title")}
                  description={t("mdm.article.availability.empty.description")}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-fg-muted uppercase">
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.availability.column.outlet")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.availability.column.state")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.availability.column.reason")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.availability.column.action")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {article.availability.map((row) => (
                      <tr key={row.outletCode} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2">
                          <span className="block">{outletLabel(row.outletCode)}</span>
                          <span className="font-mono text-2xs text-fg-subtle">{row.outletCode}</span>
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={AVAILABILITY_TONE[row.availability] ?? "neutral"}>
                            {t(
                              AVAILABILITY_LABEL[row.availability] ??
                                "mdm.article.availability.unknown"
                            )}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-fg-muted">
                          {row.reason ?? <span className="text-fg-subtle">{t("common.none")}</span>}
                        </td>
                        <td className="px-4 py-2">
                          {canAvailability ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setError(null);
                                setAvailabilityOutlet(row.outletCode);
                              }}
                            >
                              {t("mdm.article.availability.change")}
                            </Button>
                          ) : (
                            <span className="text-xs text-fg-subtle">{t("common.readOnly")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-4 py-2 text-xs text-fg-subtle">
              {t("mdm.article.availability.subtitle")}
            </p>
          </section>
        </Card>

        {/* ── Compliance ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.article.section.compliance")}
            subtitle={t("mdm.article.compliance.subtitle")}
          />
          <section>
            <SectionHeader
              level={3}
              title={t("mdm.article.compliance.title")}
              count={String(markets.length)}
            />
            {article.compliance.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.article.compliance.empty.title")}
                  description={t("mdm.article.compliance.empty.description")}
                />
              </div>
            ) : (
              <>
                {markets.length === 1 ? (
                  <p className="px-4 pt-3 text-xs text-fg-muted">
                    {t("mdm.article.compliance.single", { jurisdiction: markets[0] })}
                  </p>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-fg-muted uppercase">
                        {markets.length > 1 ? (
                          <th className="px-4 py-2 text-start font-medium">
                            {t("mdm.article.compliance.column.market")}
                          </th>
                        ) : null}
                        <th className="px-4 py-2 text-start font-medium">
                          {t("mdm.article.compliance.column.field")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium">
                          {t("mdm.article.compliance.column.requirement")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium">
                          {t("mdm.article.compliance.column.status")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium">
                          {t("mdm.article.compliance.column.legalRef")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {article.compliance.map((cell) => (
                        <tr
                          key={`${cell.jurisdiction}:${cell.field}`}
                          className="border-b border-border last:border-b-0"
                        >
                          {markets.length > 1 ? (
                            <td className="px-4 py-2 font-mono text-2xs">{cell.jurisdiction}</td>
                          ) : null}
                          <td className="px-4 py-2">
                            {t(
                              COMPLIANCE_FIELD_LABEL[cell.field] ??
                                "mdm.article.compliance.field.name"
                            )}
                          </td>
                          <td className="px-4 py-2 text-fg-muted">
                            {t(REQUIREMENT_LABEL[cell.requirement] ?? "mdm.article.compliance.requirement.optional")}
                          </td>
                          <td className="px-4 py-2">
                            {!cell.checked ? (
                              <span title={t("mdm.article.compliance.status.uncheckedTitle")}>
                                <Badge tone="neutral">
                                  {t("mdm.article.compliance.status.unchecked")}
                                </Badge>
                              </span>
                            ) : cell.satisfied ? (
                              <Badge tone="ok">{t("mdm.article.compliance.status.satisfied")}</Badge>
                            ) : (
                              <Badge tone="warn">{t("mdm.article.compliance.status.missing")}</Badge>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs text-fg-muted">
                            {cell.legalRef ?? <span className="text-fg-subtle">{t("common.none")}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="border-t border-border">
            <SectionHeader
              level={3}
              title={t("mdm.article.allergen.title")}
              count={String(article.allergens.length)}
            />
            {article.allergens.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.article.allergen.empty.title")}
                  description={t("mdm.article.allergen.empty.description")}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-fg-muted uppercase">
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.allergen.column.allergen")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.allergen.column.containment")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.allergen.column.source")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.allergen.column.mandatory")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {article.allergens.map((allergen) => (
                      <tr key={allergen.code} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2">
                          <span className="flex flex-wrap items-baseline gap-2">
                            <span>{t(ALLERGEN_LABEL[allergen.code] ?? "mdm.article.allergen.column.allergen")}</span>
                            <code className="font-mono text-2xs text-fg-subtle">{allergen.code}</code>
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {allergen.mayContain
                            ? t("mdm.article.allergen.mayContain")
                            : t("mdm.article.allergen.contains")}
                        </td>
                        <td className="px-4 py-2 text-fg-muted">
                          {ALLERGEN_SOURCE_LABEL[allergen.source]
                            ? t(ALLERGEN_SOURCE_LABEL[allergen.source])
                            : allergen.source}
                        </td>
                        <td className="px-4 py-2 text-fg-muted">
                          {allergen.mandatoryHere
                            ? t("mdm.article.allergen.mandatory")
                            : t("mdm.article.allergen.voluntary")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-4 py-2 text-xs text-fg-subtle">{t("mdm.article.allergen.subtitle")}</p>
          </section>

          <section className="border-t border-border">
            <SectionHeader
              level={3}
              title={t("mdm.article.nutrition.title")}
              count={String(article.nutrition.length)}
            />
            {article.nutrition.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.article.nutrition.empty.title")}
                  description={t("mdm.article.nutrition.empty.description")}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-fg-muted uppercase">
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.nutrition.column.nutrient")}
                      </th>
                      <th className="px-4 py-2 text-end font-medium">
                        {t("mdm.article.nutrition.column.value")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.article.nutrition.column.basis")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {article.nutrition.map((row) => (
                      <tr
                        key={`${row.code}:${row.basis}`}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="px-4 py-2">
                          <span className="flex flex-wrap items-baseline gap-2">
                            <span>{t(NUTRIENT_LABEL[row.code] ?? "mdm.article.nutrition.column.nutrient")}</span>
                            <code className="font-mono text-2xs text-fg-subtle">{row.code}</code>
                          </span>
                        </td>
                        <td className="px-4 py-2 text-end">
                          <QuantityValue value={row.value} uom={row.unit} decimals={2} />
                        </td>
                        <td className="px-4 py-2 text-fg-muted">
                          {BASIS_LABEL[row.basis] ? t(BASIS_LABEL[row.basis]) : row.basis}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-4 py-2 text-xs text-fg-subtle">{t("mdm.article.nutrition.subtitle")}</p>
          </section>
        </Card>

        {/* ── ERP-maintained (last, collapsed, never empty when it holds a value) ── */}
        {article.erp.system === null && article.provenance.length === 0 ? (
          // §25.1 item 4: with no ERP declared, the section does not exist at all — the
          // honest empty state lives on the ERP connection screen, not on every record.
          <Card>
            <CardHeader title={t("mdm.erp.section.title")} />
            <p className="p-4 text-xs text-fg-muted">{t("mdm.erp.notConfigured")}</p>
          </Card>
        ) : (
          <Card>
            <details>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-2 px-4 py-2.5">
                <span className="text-sm font-semibold text-fg">{t("mdm.erp.section.title")}</span>
                <span className="text-xs text-fg-muted">
                  {t("mdm.erp.section.count", {
                    count: String(erpFields.length),
                    system: article.erp.system?.displayName ?? t("common.unknown"),
                  })}
                </span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-border p-4">
                <Banner tone="info" compact>
                  {t("mdm.erp.section.demoNote")}
                </Banner>
                {article.erp.system ? (
                  <p className="text-xs text-fg-muted">
                    {t("mdm.erp.system.declared", { system: article.erp.system.displayName })}
                  </p>
                ) : null}
                {erpFields.length === 0 ? (
                  <p className="text-xs text-fg-muted">{t("mdm.erp.section.empty")}</p>
                ) : (
                  erpGroups.map((group) => {
                    const fields = erpFields.filter((field) => field.group === group);
                    const ownership = ownershipByGroup.get(group) ?? null;
                    return (
                      <div key={group} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                            {t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                          </h3>
                          <ProvenanceChip
                            systemName={article.erp.system?.displayName ?? t("common.unknown")}
                            groupLabel={t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                            keyKind={primaryProvenance?.externalKeyKind ?? null}
                            keyValue={primaryProvenance?.externalKeyValue ?? null}
                            lastSyncAt={article.erp.lastSyncAt ?? primaryProvenance?.lastSyncAt ?? null}
                            systemStatusLabel={t(
                              ERP_STATUS_LABEL[article.erp.system?.status ?? "not_configured"] ??
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
                            label: t(ERP_FIELD_LABEL[field.field] ?? "mdm.erp.section.title"),
                            value: <ErpFieldValue field={field} />,
                          }))}
                        />
                      </div>
                    );
                  })
                )}
                <p className="text-xs text-fg-subtle">{t("mdm.erp.section.readOnly")}</p>
              </div>
            </details>
          </Card>
        )}

        {/* ── Versions ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.article.section.versions")}
            subtitle={t("mdm.article.versions.subtitle")}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-fg-muted uppercase">
                  <th className="px-4 py-2 text-start font-medium">
                    {t("mdm.article.versions.column.version")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium">
                    {t("mdm.article.versions.column.status")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium">
                    {t("mdm.article.versions.column.effectiveFrom")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium">
                    {t("mdm.article.versions.column.approvedAt")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {article.versions.map((version) => (
                  <tr
                    key={version.version}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{version.version}</span>
                        {version.version === article.currentVersion.version ? (
                          <Badge tone="accent" shape={false}>
                            {t("mdm.article.versions.current")}
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {t(STATUS_LABEL[version.status] ?? "mdm.article.status.active")}
                    </td>
                    <td className="px-4 py-2">
                      <TimestampValue value={version.effectiveFrom} mode="date" />
                    </td>
                    <td className="px-4 py-2">
                      <TimestampValue value={version.approvedAt} mode="dateTime" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
            <p className="max-w-prose text-xs text-fg-subtle">{t("mdm.article.audit.note")}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void router.navigate({ to: "/audit" });
              }}
            >
              {t("mdm.article.audit.open")}
            </Button>
          </div>
        </Card>
      </div>

      {priceOutlet ? (
        <PriceDialog
          busy={busy}
          articleCode={article.code}
          outletCode={priceOutlet}
          outletName={outletLabel(priceOutlet)}
          pricesByOutlet={pricesByOutlet}
          outlets={article.outlets}
          onChangeOutlet={setPriceOutlet}
          onClose={() => {
            setPriceOutlet(null);
          }}
          onSave={async (amount, currencyCode, effectiveFrom, success) => {
            setBusy(true);
            const response = await updateArticlePriceFn({
              data: { code: article.code, outletCode: priceOutlet, amount, currencyCode, effectiveFrom },
            });
            await afterWrite(response, success);
          }}
        />
      ) : null}

      {availabilityOutlet ? (
        <AvailabilityDialog
          busy={busy}
          outletCode={availabilityOutlet}
          outletName={outletLabel(availabilityOutlet)}
          current={availabilityByOutlet.get(availabilityOutlet) ?? null}
          onClose={() => {
            setAvailabilityOutlet(null);
          }}
          onSave={async (availability, reason, success) => {
            setBusy(true);
            const response = await setArticleAvailabilityFn({
              data: { code: article.code, outletCode: availabilityOutlet, availability, reason },
            });
            await afterWrite(response, success);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The four states a record read can be in (spec §17). A refusal names the capability the
 * server refused on rather than an empty screen; a not-found says which code was asked
 * for; anything else shows the server's own message as `detail`, unchanged.
 */
function ArticleFailure({
  result,
}: {
  result: { ok: false; status: number; error: string; message: string };
}) {
  const { t } = useI18n();
  const router = useRouter();
  if (result.status === 403) {
    return (
      <div className="p-4">
        <Card>
          <PermissionDenied
            title={t("mdm.article.detail.denied.title")}
            description={t("mdm.article.detail.denied.description")}
            requiredPermission="mdm.article.view"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void router.invalidate();
                }}
              >
                {t("action.retry")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }
  if (result.status === 404) {
    return (
      <div className="p-4">
        <Card>
          <ErrorState
            title={t("mdm.article.detail.notFound.title")}
            description={t("mdm.article.detail.notFound.description")}
            detail={result.message}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void router.navigate({ to: "/mdm/articles" });
                }}
              >
                {t("mdm.article.detail.back")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }
  return (
    <div className="p-4">
      <Card>
        <ErrorState
          title={t("mdm.article.detail.error.title")}
          description={t("mdm.article.detail.error.description")}
          detail={result.message}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void router.invalidate();
              }}
            >
              {t("action.retry")}
            </Button>
          }
        />
      </Card>
    </div>
  );
}

function NoValue() {
  const { t } = useI18n();
  return <span className="text-fg-subtle">{t("common.none")}</span>;
}

/**
 * An ERP-maintained value. **Never a disabled input** (§25.3): the kinds the API can return
 * are rendered by the same value components every other screen uses, so money keeps its ISO
 * code on the decimal and a quantity keeps its UOM code.
 */
function ErpFieldValue({ field }: { field: ErpOwnedField }): ReactNode {
  const { t } = useI18n();
  switch (field.kind) {
    case "money":
      return field.amount === null || field.currencyCode === null ? (
        <NoValue />
      ) : (
        <MoneyValue money={{ amount: field.amount, currency: field.currencyCode }} />
      );
    case "quantity":
      return field.amount === null ? (
        <NoValue />
      ) : (
        <QuantityValue value={field.amount} uom={field.uomCode ?? ""} />
      );
    case "number":
      return field.amount === null ? <NoValue /> : <NumberValue value={field.amount} />;
    case "boolean":
      return <span>{field.text === "true" ? t("mdm.erp.value.yes") : t("mdm.erp.value.no")}</span>;
    case "code": {
      const code = field.text ?? "";
      const label = ERP_CODE_LABEL[code];
      return (
        <span className="flex flex-wrap items-baseline gap-2">
          <code className="font-mono text-xs">{code}</code>
          {label ? <span className="text-xs text-fg-muted">{t(label)}</span> : null}
        </span>
      );
    }
    default:
      return <span>{field.text ?? t("common.none")}</span>;
  }
}

/**
 * Change a price at one outlet.
 *
 * The currency is **not** an input. §7.1 makes a price's currency the outlet's site
 * currency, and the domain refuses a mismatch — so the dialog states the currency it will
 * send and shows it as a fact. Offering a choice the server would reject is the kind of
 * affordance that teaches an operator to distrust the screen.
 */
function PriceDialog({
  busy,
  articleCode,
  outletCode,
  outletName,
  pricesByOutlet,
  outlets,
  onChangeOutlet,
  onClose,
  onSave,
}: {
  busy: boolean;
  articleCode: string;
  outletCode: string;
  outletName: string;
  /** The open price row per outlet, so switching outlet shows *that* outlet's price. */
  pricesByOutlet: Record<string, { amount: number; currencyCode: string }>;
  outlets: { code: string; name: string; siteCode: string; currency: string }[];
  onChangeOutlet: (code: string) => void;
  onClose: () => void;
  onSave: (
    amount: number,
    currencyCode: string,
    effectiveFrom: string | null,
    success: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const outlet = outlets.find((candidate) => candidate.code === outletCode) ?? null;
  const currency = outlet?.currency ?? pricesByOutlet[outletCode]?.currencyCode ?? "";
  const [amount, setAmount] = useState(
    pricesByOutlet[outletCode] ? String(pricesByOutlet[outletCode].amount) : ""
  );
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const parsed = Number(amount.trim());
  const amountValid = amount.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mdm.article.price.dialog.title", { outlet: outletName })}
      description={t("mdm.article.price.dialog.description")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (amount.trim() === "") {
                setLocalError(t("mdm.article.price.dialog.amountRequired"));
                return;
              }
              if (!amountValid) {
                setLocalError(t("mdm.article.price.dialog.amountInvalid"));
                return;
              }
              setLocalError(null);
              void onSave(
                parsed,
                currency,
                effectiveFrom.trim() === "" ? null : effectiveFrom.trim(),
                t("mdm.article.price.saved", { outlet: outletName })
              );
            }}
          >
            {t("mdm.article.price.dialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          id="price-outlet"
          label={t("mdm.article.price.column.outlet")}
          hint={`${articleCode} · ${outletCode}`}
        >
          <Select
            value={outletCode}
            onChange={(next) => {
              setLocalError(null);
              onChangeOutlet(next);
              // Follow the newly chosen outlet's own price rather than carrying a figure
              // across — a price typed for one outlet must never look like it is the other's.
              setAmount(pricesByOutlet[next] ? String(pricesByOutlet[next].amount) : "");
            }}
            ariaLabel={t("mdm.article.price.column.outlet")}
            options={outlets.map((candidate) => ({
              value: candidate.code,
              label: `${candidate.name} · ${candidate.siteCode}`,
            }))}
          />
        </Field>
        <Field
          id="price-amount"
          label={t("mdm.article.price.dialog.amount")}
          hint={t("mdm.article.price.dialog.amountHint", {
            currency,
            site: outlet?.siteCode ?? "",
          })}
          error={localError}
          required
          aside={currency}
        >
          <TextInput
            value={amount}
            onChange={(next) => {
              setAmount(next);
              setLocalError(null);
            }}
            inputMode="decimal"
          />
        </Field>
        <Field
          id="price-effective-from"
          label={t("mdm.article.price.dialog.effectiveFrom")}
          hint={t("mdm.article.price.dialog.effectiveFromHint")}
        >
          <TextInput value={effectiveFrom} onChange={setEffectiveFrom} type="date" />
        </Field>
        <ConfirmSummary
          items={[
            {
              label: t("mdm.article.price.column.amount"),
              value: <MoneyValue money={{ amount: amountValid ? parsed : 0, currency }} />,
            },
            {
              label: t("mdm.article.field.effectiveFrom"),
              value: effectiveFrom.trim() === "" ? t("common.none") : effectiveFrom.trim(),
            },
          ]}
        />
      </div>
    </Dialog>
  );
}

/** Availability is per outlet, not per version: it takes effect immediately and reverses. */
function AvailabilityDialog({
  busy,
  outletCode,
  outletName,
  current,
  onClose,
  onSave,
}: {
  busy: boolean;
  outletCode: string;
  outletName: string;
  current: { availability: string; reason: string | null } | null;
  onClose: () => void;
  onSave: (
    availability: "available" | "seasonal" | "unavailable",
    reason: string | null,
    success: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"available" | "seasonal" | "unavailable">(
    (current?.availability as "available" | "seasonal" | "unavailable" | undefined) ?? "available"
  );
  const [reason, setReason] = useState(current?.reason ?? "");

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mdm.article.availability.dialog.title", { outlet: outletName })}
      description={`${outletCode}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void onSave(
                state,
                reason.trim() === "" ? null : reason.trim(),
                t("mdm.article.availability.saved", { outlet: outletName })
              );
            }}
          >
            {t("mdm.article.availability.dialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          id="availability-state"
          label={t("mdm.article.availability.dialog.state")}
          hint={
            current
              ? t("mdm.article.availability.column.state")
              : t("mdm.article.availability.notListed")
          }
        >
          <SegmentedControl
            value={state}
            onChange={setState}
            ariaLabel={t("mdm.article.availability.dialog.state")}
            options={[
              { value: "available", label: t("mdm.article.availability.state.available") },
              { value: "seasonal", label: t("mdm.article.availability.state.seasonal") },
              { value: "unavailable", label: t("mdm.article.availability.state.unavailable") },
            ]}
          />
        </Field>
        <Field
          id="availability-reason"
          label={t("mdm.article.availability.dialog.reason")}
          hint={t("mdm.article.availability.dialog.reasonHint")}
        >
          <TextInput value={reason} onChange={setReason} />
        </Field>
      </div>
    </Dialog>
  );
}
