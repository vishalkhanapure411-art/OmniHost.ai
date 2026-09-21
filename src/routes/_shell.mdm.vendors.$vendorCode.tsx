import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
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
  Select,
  Skeleton,
  TextInput,
} from "~/components/ui";
import { BeforeAfter, MoneyValue, NoValue, TimestampValue } from "~/components/values";
import { ProvenanceChip } from "~/components/provenance";
import type { VendorDetail } from "~/domain/mdm-vendors";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import {
  addVendorTaxRegistrationFn,
  getVendorFn,
  revealVendorBankFn,
  setVendorStatusFn,
  updateVendorTermsFn,
  verifyVendorTaxRegistrationFn,
} from "~/server-fns";
/**
 * The vendor record (§9.3), sections in the spec's order.
 *
 * Four rules the last two review passes taught, applied here from the start:
 *
 *   1. **Every mutating control names the capability its own write needs, before the click.**
 *      The line above the action states the code; a caller who does not hold it sees the
 *      required capability and **no button at all**, because a disabled button that says
 *      "edit terms" is a control that cannot do what its label says.
 *   2. **The record is not one form.** Terms are a *financial* write under
 *      `mdm.vendor.terms.update`; a tax registration is a master-data write under
 *      `mdm.vendor.update`; suspending is `mdm.vendor.suspend`. Each is its own dialog with
 *      its own capability, its own confirm summary and its own server-side refusal.
 *   3. **A bank value is masked until it is revealed, the reveal is one field at a time,
 *      it is announced, and it re-masks when the panel loses focus** (§9.3) — a value that
 *      stays on screen indefinitely is one that ends up in a screenshot.
 *   4. **ERP-owned fields are values with provenance, never disabled inputs** (§25.3). The
 *      section is last, collapsed, with a count, and it says who owns each group.
 *
 * A vendor is **not versioned** — the article master is. That is stated on the screen rather
 * than implied by a missing panel, and the change history (the audit trail for this record)
 * is where a change lives, with `chain.audit.read` named when the caller lacks it.
 */
export const Route = createFileRoute("/_shell/mdm/vendors/$vendorCode")({
  staticData: { titleKey: "mdm.vendor.detail.titleFallback" },
  loader: async ({ params }) => getVendorFn({ data: { code: params.vendorCode } }),
  pendingComponent: VendorPending,
  component: VendorScreen,
});

const STATUS_LABEL: Record<string, MessageKey> = {
  proposed: "mdm.vendor.status.proposed",
  active: "mdm.vendor.status.active",
  suspended: "mdm.vendor.status.suspended",
  inactive: "mdm.vendor.status.inactive",
};
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "accent"> = {
  proposed: "accent",
  active: "ok",
  suspended: "warn",
  inactive: "neutral",
};
const TYPE_LABEL: Record<string, MessageKey> = {
  manufacturer: "mdm.vendor.type.manufacturer",
  distributor: "mdm.vendor.type.distributor",
  wholesaler: "mdm.vendor.type.wholesaler",
  importer: "mdm.vendor.type.importer",
  service: "mdm.vendor.type.service",
  logistics: "mdm.vendor.type.logistics",
};
const TERMS_LABEL: Record<string, MessageKey> = {
  net_days: "mdm.vendor.terms.net_days",
  eom: "mdm.vendor.terms.eom",
  cod: "mdm.vendor.terms.cod",
  prepaid: "mdm.vendor.terms.prepaid",
};
const CONTACT_KIND_LABEL: Record<string, MessageKey> = {
  ordering: "mdm.vendor.contact.kind.ordering",
  accounts: "mdm.vendor.contact.kind.accounts",
  escalation: "mdm.vendor.contact.kind.escalation",
  general: "mdm.vendor.contact.kind.general",
};
const DOCUMENT_KIND_LABEL: Record<string, MessageKey> = {
  fssai_licence: "mdm.vendor.document.kind.fssai_licence",
  gst_certificate: "mdm.vendor.document.kind.gst_certificate",
  insurance: "mdm.vendor.document.kind.insurance",
};
const ERP_GROUP_LABEL: Record<string, MessageKey> = {
  identity: "mdm.erp.group.identity",
  tax: "mdm.erp.group.tax",
  commercial: "mdm.erp.group.commercial",
  trade: "mdm.erp.group.trade",
  blocking: "mdm.erp.group.blocking",
};
const ERP_GROUP_ORDER = ["identity", "tax", "commercial", "trade", "blocking"];
const ERP_FIELD_LABEL: Record<string, MessageKey> = {
  erpAccountGroup: "mdm.erp.field.erpAccountGroup",
  externalRef: "mdm.erp.field.externalRef",
  sourceSystem: "mdm.erp.field.sourceSystem",
  erpSourceVersion: "mdm.erp.field.erpSourceVersion",
  erpTaxClassification: "mdm.erp.field.erpTaxClassification",
  erpWithholdingTaxType: "mdm.erp.field.erpWithholdingTaxType",
  erpWithholdingTaxCode: "mdm.erp.field.erpWithholdingTaxCode",
  erpTaxJurisdictionCode: "mdm.erp.field.erpTaxJurisdictionCode",
  billingCurrency: "mdm.vendors.column.currency",
  paymentTerms: "mdm.vendors.column.terms",
  creditLimit: "mdm.vendor.field.creditLimit",
  incoterms: "mdm.erp.field.incoterms",
  incotermsLocation: "mdm.erp.field.incotermsLocation",
  erpBlocked: "mdm.erp.field.erpBlocked",
  erpDeletionFlag: "mdm.erp.field.erpDeletionFlag",
  erpBlockedReason: "mdm.erp.field.erpBlockedReason",
};
const SCHEME_LABEL: Record<string, MessageKey> = {
  GSTIN: "mdm.vendor.scheme.GSTIN",
  TRN: "mdm.vendor.scheme.TRN",
  VAT: "mdm.vendor.scheme.VAT",
  USt_IdNr: "mdm.vendor.scheme.USt_IdNr",
};
const COMPLIANCE_FIELD_LABEL: Record<string, MessageKey> = {
  address: "mdm.vendor.field.address",
  billingCurrency: "mdm.vendor.field.billingCurrency",
  taxRegistrations: "mdm.vendor.field.taxRegistrations",
};
const BANK_FIELDS = ["accountNumber", "ifscOrSwift", "iban", "upiId"] as const;
type BankField = (typeof BANK_FIELDS)[number];
const BANK_FIELD_LABEL: Record<BankField, MessageKey> = {
  accountNumber: "mdm.vendor.field.bankAccount",
  ifscOrSwift: "mdm.vendor.field.ifscOrSwift",
  iban: "mdm.vendor.field.iban",
  upiId: "mdm.vendor.field.upiId",
};

function VendorPending() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <span className="sr-only">{t("mdm.vendor.detail.loading")}</span>
      <Card className="p-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </Card>
      <Card className="p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-3/4" />
      </Card>
    </div>
  );
}

function VendorScreen() {
  // The read and the refusal envelope are one union; the server function is its only
  // producer, so the shape is asserted here and the screen narrows on `ok`.
  const result = Route.useLoaderData() as
    | { ok: true; vendor: VendorDetail }
    | { ok: false; status: number; error: string; message: string; permission?: string | null };
  const { principal } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<"suspended" | "inactive" | "active" | null>(null);

  if (!result.ok) {
    return <VendorFailure result={result} />;
  }
  const vendor = result.vendor;
  const canTerms = principal.permissions.includes("mdm.vendor.terms.update");
  const canUpdate = principal.permissions.includes("mdm.vendor.update");
  const canSuspend = principal.permissions.includes("mdm.vendor.suspend");
  const canReactivate = principal.permissions.includes("mdm.vendor.reactivate");
  const canDeactivate = principal.permissions.includes("mdm.vendor.deactivate");
  const canRevealBank = principal.permissions.includes("mdm.vendor.bank.view");

  async function afterWrite(response: { ok: boolean; message?: string }, success: string) {
    setBusy(false);
    setTermsOpen(false);
    setRegistrationOpen(false);
    setStatusAction(null);
    if (!response.ok) {
      setError(response.message ?? t("error.description"));
      return;
    }
    setError(null);
    setNotice(success);
    await router.invalidate();
  }

  const erpGroups = ERP_GROUP_ORDER.filter((group) =>
    vendor.erp.fields.some((field) => field.group === group)
  );
  const ownershipByGroup = new Map(vendor.erp.ownership.map((row) => [row.fieldGroup, row]));

  return (
    <>
      <PageHeader
        eyebrow={t("mdm.vendor.detail.eyebrow")}
        title={vendor.legalName}
        description={t("mdm.vendor.detail.scope")}
        meta={
          <>
            <code className="font-mono text-xs text-fg-muted">{vendor.code}</code>
            <Badge tone={STATUS_TONE[vendor.status] ?? "neutral"}>
              {t(STATUS_LABEL[vendor.status] ?? "mdm.vendor.status.active")}
            </Badge>
            <Badge tone="neutral" shape={false}>
              {t(TYPE_LABEL[vendor.vendorType] ?? "mdm.vendor.type.distributor")}
            </Badge>
            {vendor.commercial.billingCurrency ? (
              <span className="font-mono text-xs text-fg-muted">{vendor.commercial.billingCurrency}</span>
            ) : null}
          </>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void router.navigate({ to: "/mdm/vendors" });
            }}
          >
            {t("mdm.vendor.detail.back")}
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
        {vendor.status === "inactive" && vendor.deactivationReason ? (
          <Banner tone="warn" compact>
            {t("mdm.vendor.detail.deactivated", { reason: vendor.deactivationReason })}
          </Banner>
        ) : null}
        {vendor.duplicateOfCode ? (
          <Banner tone="info" compact>
            {t("mdm.vendor.detail.merged", { code: vendor.duplicateOfCode })}
          </Banner>
        ) : null}

        {/* ── Identity ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.vendor.section.identity")} />
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.vendor.field.code"),
                  value: <code className="font-mono text-xs">{vendor.code}</code>,
                },
                { label: t("mdm.vendor.field.legalName"), value: vendor.legalName },
                {
                  label: t("mdm.vendor.field.type"),
                  value: t(TYPE_LABEL[vendor.vendorType] ?? "mdm.vendor.type.distributor"),
                },
                {
                  label: t("mdm.vendor.field.status"),
                  value: (
                    <Badge tone={STATUS_TONE[vendor.status] ?? "neutral"}>
                      {t(STATUS_LABEL[vendor.status] ?? "mdm.vendor.status.active")}
                    </Badge>
                  ),
                },
                {
                  label: t("mdm.vendor.field.tradeNames"),
                  value:
                    vendor.tradeNames.length === 0 ? (
                      <NoValue />
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {vendor.tradeNames.map((name) => (
                          <li key={name.locale}>
                            <span className="me-2 font-mono text-2xs text-fg-muted">{name.locale}</span>
                            {name.name}
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  label: t("mdm.vendor.field.externalRef"),
                  value: vendor.externalRef ? (
                    <span>
                      <code className="font-mono text-xs">{vendor.externalRef}</code>
                      {vendor.sourceSystem ? (
                        <span className="ms-2 text-xs text-fg-muted">{vendor.sourceSystem}</span>
                      ) : null}
                    </span>
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.vendor.field.categories"),
                  value:
                    vendor.categories.length === 0 ? (
                      <span className="text-warn">{t("mdm.vendor.categories.empty")}</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {vendor.categories.map((category) => (
                          <li key={category.code}>
                            <Badge tone="neutral" shape={false}>
                              {category.name ?? category.code}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  label: t("mdm.vendor.field.legalEntities"),
                  value:
                    vendor.legalEntities.length === 0 ? (
                      <span className="text-fg-muted">{t("mdm.vendor.legalEntities.empty")}</span>
                    ) : (
                      vendor.legalEntities.join(", ")
                    ),
                },
              ]}
            />
          </div>
        </Card>

        {/* ── Legal & tax ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.legalTax")}
            subtitle={t("mdm.vendor.tax.subtitle")}
          />
          <section>
            <SectionHeader
              level={3}
              title={t("mdm.vendor.tax.title")}
              count={String(vendor.taxRegistrations.length)}
              actions={
                canUpdate ? (
                  <Button size="sm" variant="secondary" onClick={() => setRegistrationOpen(true)}>
                    {t("mdm.vendor.tax.action.add")}
                  </Button>
                ) : undefined
              }
            />
            {canUpdate ? (
              <p className="px-4 pt-3 text-xs text-fg-subtle">
                {t("mdm.vendor.tax.capabilityHint", { permission: "mdm.vendor.update" })}
              </p>
            ) : (
              <div className="px-4 pt-3">
                <Banner tone="info" compact>
                  {t("mdm.vendor.tax.readOnly", { permission: "mdm.vendor.update" })}
                </Banner>
              </div>
            )}
            {vendor.taxRegistrations.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  compact
                  title={t("mdm.vendor.tax.empty.title")}
                  description={t("mdm.vendor.tax.empty.description")}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">{t("mdm.vendor.tax.title")}</caption>
                  <thead>
                    <tr className="border-b border-border text-xs text-fg-muted uppercase">
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.vendor.tax.column.jurisdiction")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.vendor.tax.column.scheme")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.vendor.tax.column.value")}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t("mdm.vendor.tax.column.verification")}
                      </th>
                      <th className="w-0 px-4 py-2 text-start font-medium whitespace-nowrap">
                        {t("mdm.vendor.tax.column.action")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.taxRegistrations.map((registration) => (
                      <tr key={registration.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2 font-mono text-xs">
                          {registration.jurisdictionCode}
                        </td>
                        <td className="px-4 py-2">
                          {SCHEME_LABEL[registration.schemeCode]
                            ? t(SCHEME_LABEL[registration.schemeCode])
                            : registration.schemeCode}
                          <span className="ms-2 font-mono text-2xs text-fg-subtle">
                            {registration.schemeCode}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">
                          {registration.value}
                          {registration.patternValid ? null : (
                            <span className="ms-2 text-warn">
                              {t("mdm.vendor.tax.patternMismatch")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {registration.status === "retired" ? (
                            <Badge tone="neutral" shape={false}>
                              {t("mdm.vendors.tax.retired")}
                            </Badge>
                          ) : registration.verified ? (
                            <span className="flex flex-col">
                              <Badge tone="ok" shape={false}>
                                {t("mdm.vendors.tax.verified")}
                              </Badge>
                              <span className="mt-0.5 text-2xs text-fg-muted">
                                {registration.verifiedByName ?? ""}{" "}
                                <TimestampValue value={registration.verifiedAt} mode="date" />
                              </span>
                            </span>
                          ) : (
                            <span title={t("mdm.vendors.tax.unverifiedTitle")}>
                              <Badge tone="warn" shape={false}>
                                {t("mdm.vendors.tax.unverified")}
                              </Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          {canUpdate && registration.status === "active" && !registration.verified ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                const response = await verifyVendorTaxRegistrationFn({
                                  data: { code: vendor.code, registrationId: registration.id },
                                });
                                await afterWrite(
                                  response,
                                  t("mdm.vendor.tax.verifiedNotice", {
                                    scheme: registration.schemeCode,
                                  })
                                );
                              }}
                            >
                              {t("mdm.vendor.tax.action.verify")}
                            </Button>
                          ) : (
                            <span className="text-xs text-fg-subtle">{t("common.none")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <SectionHeader
              level={3}
              title={t("mdm.vendor.compliance.title")}
              count={String(vendor.compliance.length)}
            />
            {vendor.compliance.length === 0 ? (
              <p className="px-4 py-3 text-xs text-fg-muted">{t("mdm.vendor.compliance.none")}</p>
            ) : (
              <ul className="flex flex-col gap-2 p-4">
                {vendor.compliance.map((cell) => (
                  <li
                    key={`${cell.jurisdiction}:${cell.field}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Badge tone="neutral" shape={false}>
                      {cell.jurisdiction}
                    </Badge>
                    <span className="text-sm">
                      {COMPLIANCE_FIELD_LABEL[cell.field]
                        ? t(COMPLIANCE_FIELD_LABEL[cell.field])
                        : cell.field}
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
          </section>
        </Card>

        {/* ── Contacts ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.vendor.section.contacts")} />
          {vendor.contacts.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.vendor.contacts.empty.title")}
                description={t("mdm.vendor.contacts.empty.description")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.vendor.section.contacts")}</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted uppercase">
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.contact.column.kind")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.contact.column.name")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.contact.column.email")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.contact.column.phone")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.contact.column.locale")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vendor.contacts.map((contact) => (
                    <tr key={contact.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2">
                        {t(CONTACT_KIND_LABEL[contact.kind] ?? "mdm.vendor.contact.kind.general")}
                        {contact.preferred ? (
                          <span className="ms-2">
                            <Badge tone="accent" shape={false}>
                              {t("mdm.vendor.contact.preferred")}
                            </Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">{contact.name}</td>
                      <td className="px-4 py-2">
                        {contact.email ? (
                          <a
                            className="underline decoration-dotted underline-offset-2"
                            href={`mailto:${contact.email}`}
                          >
                            {contact.email}
                          </a>
                        ) : (
                          <NoValue />
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {contact.phone ?? <NoValue />}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-muted">
                        {contact.locale ?? <NoValue />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.vendor.contacts.note")}
          </p>
        </Card>

        {/* ── Commercial ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.vendor.section.commercial")} />
          <SectionHeader
            level={3}
            title={t("mdm.vendor.terms.title")}
            actions={
              canTerms ? (
                <Button size="sm" variant="secondary" onClick={() => setTermsOpen(true)}>
                  {t("mdm.vendor.terms.action.edit")}
                </Button>
              ) : undefined
            }
          />
          {canTerms ? (
            <p className="px-4 pt-3 text-xs text-fg-subtle">
              {t("mdm.vendor.terms.capabilityHint", { permission: "mdm.vendor.terms.update" })}
            </p>
          ) : (
            <div className="px-4 pt-3">
              <Banner tone="info" compact>
                {t("mdm.vendor.terms.readOnly", { permission: "mdm.vendor.terms.update" })}
              </Banner>
            </div>
          )}
          <div className="p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.vendor.field.billingCurrency"),
                  value: vendor.commercial.billingCurrency ? (
                    <code className="font-mono text-xs">{vendor.commercial.billingCurrency}</code>
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.vendor.terms.kind"),
                  value: vendor.commercial.paymentTermsKind
                    ? t(TERMS_LABEL[vendor.commercial.paymentTermsKind] ?? "mdm.vendor.terms.cod", {
                        days: String(vendor.commercial.paymentTermsDays ?? 0),
                      })
                    : t("mdm.vendor.terms.none"),
                },
                {
                  label: t("mdm.vendor.field.creditLimit"),
                  value: vendor.commercial.creditLimit ? (
                    <MoneyValue
                      money={{
                        amount: vendor.commercial.creditLimit.amount,
                        currency: vendor.commercial.creditLimit.currencyCode,
                      }}
                    />
                  ) : (
                    <NoValue />
                  ),
                },
                {
                  label: t("mdm.vendor.field.leadTimeDays"),
                  value:
                    vendor.commercial.leadTimeDays === null ? (
                      <NoValue />
                    ) : (
                      String(vendor.commercial.leadTimeDays)
                    ),
                },
                {
                  label: t("mdm.vendor.field.moq"),
                  value:
                    vendor.commercial.moqQty === null ? (
                      <NoValue />
                    ) : (
                      `${vendor.commercial.moqQty} ${vendor.commercial.moqUomCode ?? ""}`
                    ),
                },
              ]}
            />
          </div>
        </Card>

        {/* ── Remittance ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.remittance")}
            subtitle={t("mdm.vendor.remittance.subtitle")}
          />
          {vendor.remittance.fieldsPresent.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.vendor.remittance.empty.title")}
                description={t("mdm.vendor.remittance.empty.description")}
              />
            </div>
          ) : (
            <RemittancePanel
              vendor={vendor}
              canReveal={canRevealBank}
              busy={busy}
              setBusy={setBusy}
              onError={setError}
            />
          )}
        </Card>

        {/* ── Documents ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.documents")}
            subtitle={t("mdm.vendor.documents.subtitle")}
          />
          {vendor.documents.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.vendor.documents.empty.title")}
                description={t("mdm.vendor.documents.empty.description")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.vendor.section.documents")}</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted uppercase">
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.document.column.kind")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.document.column.reference")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.document.column.issuedOn")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.document.column.expiresOn")}
                    </th>
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.document.column.state")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vendor.documents.map((document) => (
                    <tr key={document.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2">
                        {DOCUMENT_KIND_LABEL[document.kind]
                          ? t(DOCUMENT_KIND_LABEL[document.kind])
                          : document.kind}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {document.reference ?? <NoValue />}
                      </td>
                      <td className="px-4 py-2">
                        {document.issuedOn ? (
                          <TimestampValue value={document.issuedOn} mode="date" />
                        ) : (
                          <NoValue />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {document.expiresOn ? (
                          <TimestampValue value={document.expiresOn} mode="date" />
                        ) : (
                          <NoValue />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {document.daysToExpiry === null ? (
                          <span className="text-xs text-fg-muted">
                            {t("mdm.vendor.document.noExpiry")}
                          </span>
                        ) : document.daysToExpiry < 0 ? (
                          <Badge tone="danger">
                            {t("mdm.vendor.document.expired", {
                              days: String(Math.abs(document.daysToExpiry)),
                            })}
                          </Badge>
                        ) : document.daysToExpiry <= 90 ? (
                          <Badge tone="warn">
                            {t("mdm.vendor.document.expiresIn", {
                              days: String(document.daysToExpiry),
                            })}
                          </Badge>
                        ) : (
                          <span className="text-xs text-fg-muted">
                            {t("mdm.vendor.document.expiresIn", {
                              days: String(document.daysToExpiry),
                            })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── Duplicate review (§9.2) ───────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.duplicates")}
            subtitle={t("mdm.vendor.duplicates.subtitle")}
          />
          {vendor.duplicateReview.candidates.length === 0 ? (
            <p className="px-4 py-3 text-xs text-fg-muted">{t("mdm.vendor.duplicates.none")}</p>
          ) : (
            <ul className="flex flex-col gap-2 p-4">
              {vendor.duplicateReview.candidates.map((candidate) => (
                <li key={`${candidate.code}:${candidate.match}`} className="flex flex-wrap items-center gap-2">
                  <Badge tone={candidate.match === "tax_registration" ? "danger" : "warn"} shape={false}>
                    {candidate.match === "tax_registration"
                      ? t("mdm.vendor.duplicates.strong")
                      : t("mdm.vendor.duplicates.weak")}
                  </Badge>
                  <span className="font-mono text-xs">{candidate.code}</span>
                  <span className="text-sm">{candidate.legalName}</span>
                  <span className="text-xs text-fg-muted">{candidate.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.vendor.duplicates.scope")}
          </p>
        </Card>

        {/* ── Purchase history (Phase 3) ────────────────────────────────────── */}
        <Card>
          <CardHeader title={t("mdm.vendor.section.purchaseHistory")} />
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.vendor.purchaseHistory.title")}
              description={t("mdm.vendor.purchaseHistory.description")}
            />
          </div>
        </Card>

        {/* ── Provenance and versioning ─────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.provenance")}
            subtitle={t("mdm.vendor.provenance.subtitle")}
          />
          <div className="flex flex-col gap-3 p-4">
            <Banner tone="info" compact>
              {t("mdm.vendor.versioning.note")}
            </Banner>
            {vendor.provenance.length === 0 ? (
              <p className="text-xs text-fg-muted">{t("mdm.vendor.provenance.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {vendor.provenance.map((key) => (
                  <li key={`${key.externalKeyKind}:${key.externalKeyValue}`}>
                    <code className="font-mono">{key.externalKeyKind}</code>
                    <span className="ms-2">{key.externalKeyValue}</span>
                    <span className="ms-2 text-fg-muted">
                      <TimestampValue value={key.lastSyncAt} mode="dateTime" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* ── Change history ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.history")}
            subtitle={t("mdm.vendor.history.subtitle")}
          />
          {vendor.history.denied ? (
            <div className="p-4">
              <PermissionDenied
                title={t("mdm.vendor.history.denied.title")}
                description={t("mdm.vendor.history.denied.description")}
                requiredPermission={vendor.history.denied.permission}
              />
            </div>
          ) : vendor.history.entries.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={t("mdm.vendor.history.empty.title")}
                description={t("mdm.vendor.history.empty.description")}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("mdm.vendor.section.history")}</caption>
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
                    <th className="px-4 py-2 text-start font-medium">
                      {t("mdm.vendor.history.column.change")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vendor.history.entries.map((entry) => (
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
                      <td className="px-4 py-2 text-xs">
                        <BeforeAfter
                          before={summarise(entry.before)}
                          after={summarise(entry.after)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-fg-subtle">
            {t("mdm.vendor.history.note")}
          </p>
        </Card>

        {/* ── Lifecycle actions ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title={t("mdm.vendor.section.lifecycle")}
            subtitle={t("mdm.vendor.lifecycle.subtitle")}
          />
          <div className="flex flex-col gap-3 p-4">
            <DescriptionList
              columns={2}
              items={[
                {
                  label: t("mdm.vendor.lifecycle.suspend"),
                  value: (
                    <LifecycleAction
                      permission="mdm.vendor.suspend"
                      held={canSuspend}
                      disabled={vendor.status === "suspended" || vendor.status === "inactive"}
                      disabledReason={t("mdm.vendor.lifecycle.alreadyStopped")}
                      label={t("mdm.vendor.lifecycle.suspend")}
                      hint={t("mdm.vendor.lifecycle.suspendHint")}
                      onOpen={() => setStatusAction("suspended")}
                    />
                  ),
                },
                {
                  label: t("mdm.vendor.lifecycle.reactivate"),
                  value: (
                    <LifecycleAction
                      permission="mdm.vendor.reactivate"
                      held={canReactivate}
                      disabled={vendor.status === "active"}
                      disabledReason={t("mdm.vendor.lifecycle.alreadyActive")}
                      label={t("mdm.vendor.lifecycle.reactivate")}
                      hint={t("mdm.vendor.lifecycle.reactivateHint")}
                      onOpen={() => setStatusAction("active")}
                    />
                  ),
                },
                {
                  label: t("mdm.vendor.lifecycle.deactivate"),
                  value: (
                    <LifecycleAction
                      permission="mdm.vendor.deactivate"
                      held={canDeactivate}
                      disabled={vendor.status === "inactive"}
                      disabledReason={t("mdm.vendor.lifecycle.alreadyInactive")}
                      label={t("mdm.vendor.lifecycle.deactivate")}
                      hint={t("mdm.vendor.lifecycle.deactivateHint")}
                      onOpen={() => setStatusAction("inactive")}
                    />
                  ),
                },
              ]}
            />
            <p className="text-xs text-fg-subtle">{t("mdm.vendor.lifecycle.note")}</p>
          </div>
        </Card>

        {/* ── ERP-maintained: last, collapsed, with a count (§25.1) ──────────── */}
        {vendor.erp.system ? (
          <Card>
            <details className="group">
              <summary className="cursor-pointer list-none px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold text-fg">
                    {t("mdm.erp.section.title")}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {t("mdm.erp.section.count", {
                      count: String(vendor.erp.fields.length),
                      system: vendor.erp.system.displayName,
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
                  {t("mdm.erp.system.declared", { system: vendor.erp.system.displayName })}
                </p>
                {erpGroups.length === 0 ? (
                  <p className="text-xs text-fg-muted">{t("mdm.erp.section.empty")}</p>
                ) : (
                  erpGroups.map((group) => {
                    const fields = vendor.erp.fields.filter((field) => field.group === group);
                    const ownership = ownershipByGroup.get(group) ?? null;
                    return (
                      <div key={group} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                            {t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                          </h3>
                          <ProvenanceChip
                            systemName={vendor.erp.system?.displayName ?? t("common.unknown")}
                            groupLabel={t(ERP_GROUP_LABEL[group] ?? "mdm.erp.section.title")}
                            keyKind={vendor.provenance[0]?.externalKeyKind ?? null}
                            keyValue={vendor.provenance[0]?.externalKeyValue ?? null}
                            lastSyncAt={vendor.erp.system?.lastSyncAt ?? null}
                            systemStatusLabel={t(
                              ERP_STATUS_LABEL[vendor.erp.system?.status ?? "not_configured"] ??
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
                            // A field the catalogue has no label for shows its own code: §4
                            // says a code is never translated, and a raw code is honest.
                            label: ERP_FIELD_LABEL[field.field]
                              ? t(ERP_FIELD_LABEL[field.field])
                              : field.field,
                            value:
                              field.kind === "money" &&
                              field.amount !== null &&
                              field.currencyCode !== null ? (
                                <MoneyValue
                                  money={{ amount: field.amount, currency: field.currencyCode }}
                                />
                              ) : (
                                <span className="font-mono text-xs">{field.text ?? "—"}</span>
                              ),
                          }))}
                        />
                      </div>
                    );
                  })
                )}
                <p className="text-xs text-fg-subtle">{t("mdm.erp.section.readOnly")}</p>
                <p className="text-xs text-fg-subtle">
                  {t("mdm.erp.section.ownershipNote", { entity: "vendor" })}
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

      {termsOpen ? (
        <TermsDialog
          busy={busy}
          vendor={vendor}
          onClose={() => setTermsOpen(false)}
          onSave={async (input, success) => {
            setBusy(true);
            const response = await updateVendorTermsFn({
              data: {
                code: vendor.code,
                paymentTermsKind: input.kind,
                paymentTermsDays: input.days,
                creditLimitAmount: input.creditLimitAmount,
                creditLimitCurrency: input.creditLimitCurrency,
              },
            });
            await afterWrite(response, success);
          }}
        />
      ) : null}

      {registrationOpen ? (
        <RegistrationDialog
          busy={busy}
          vendor={vendor}
          onClose={() => setRegistrationOpen(false)}
          onSave={async (input, success) => {
            setBusy(true);
            const response = await addVendorTaxRegistrationFn({
              data: {
                code: vendor.code,
                jurisdictionCode: input.jurisdictionCode,
                schemeCode: input.schemeCode,
                value: input.value,
              },
            });
            await afterWrite(response, success);
          }}
        />
      ) : null}

      {statusAction ? (
        <StatusDialog
          busy={busy}
          target={statusAction}
          vendor={vendor}
          onClose={() => setStatusAction(null)}
          onSave={async (reason, success) => {
            setBusy(true);
            const response = await setVendorStatusFn({
              data: { code: vendor.code, status: statusAction, reason },
            });
            await afterWrite(response, success);
          }}
        />
      ) : null}
    </>
  );
}

const ERP_STATUS_LABEL: Record<string, MessageKey> = {
  not_configured: "mdm.erp.status.not_configured",
  active: "mdm.erp.status.active",
  paused: "mdm.erp.status.paused",
  error: "mdm.erp.status.error",
};

/** A one-line summary of an audit row's before/after state, so the table stays readable. */
function summarise(state: unknown): string | null {
  if (state === null || state === undefined) return null;
  if (typeof state === "string") return state;
  if (typeof state !== "object") return String(state);
  const entries = Object.entries(state as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined
  );
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ");
}

/**
 * The remittance panel: masked values, one reveal at a time, announced, re-masked on blur.
 * With no `mdm.vendor.bank.view` the values are masked *and* the button is absent — the
 * capability is named instead, because a button that would be refused is not a control.
 */
function RemittancePanel({
  vendor,
  canReveal,
  busy,
  setBusy,
  onError,
}: {
  vendor: VendorDetail;
  canReveal: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<{ field: BankField; value: string } | null>(null);
  const masked: Record<BankField, string | null> = {
    accountNumber: vendor.remittance.accountNumberMasked,
    ifscOrSwift: vendor.remittance.ifscOrSwiftMasked,
    iban: vendor.remittance.ibanMasked,
    upiId: vendor.remittance.upiIdMasked,
  };
  return (
    <div
      className="flex flex-col gap-3 p-4"
      // The value goes back behind the mask as soon as focus leaves the panel (§9.3).
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(next)) setRevealed(null);
      }}
    >
      <DescriptionList
        columns={2}
        items={[
          {
            label: t("mdm.vendor.field.remittanceMethod"),
            value: vendor.remittance.method ?? <NoValue />,
          },
          {
            label: t("mdm.vendor.field.bankName"),
            value: vendor.remittance.bankName ?? <NoValue />,
          },
          {
            label: t("mdm.vendor.field.accountName"),
            value: vendor.remittance.accountName ?? <NoValue />,
          },
        ]}
      />
      <ul className="flex flex-col gap-2">
        {BANK_FIELDS.filter((field) => masked[field] !== null).map((field) => (
          <li key={field} className="flex flex-wrap items-center gap-2">
            <span className="w-40 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
              {t(BANK_FIELD_LABEL[field])}
            </span>
            <span className="font-mono text-xs" aria-live="polite">
              {revealed?.field === field ? revealed.value : masked[field]}
            </span>
            {canReveal ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || revealed?.field === field}
                onClick={async () => {
                  setBusy(true);
                  const response = await revealVendorBankFn({
                    data: { code: vendor.code, field },
                  });
                  setBusy(false);
                  if (!response.ok) {
                    onError(response.message ?? t("error.description"));
                    return;
                  }
                  onError(null);
                  setRevealed({ field, value: response.result.value });
                }}
              >
                {t("mdm.vendor.remittance.reveal", { field: t(BANK_FIELD_LABEL[field]) })}
              </Button>
            ) : null}
            {revealed?.field === field ? (
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                {t("mdm.vendor.remittance.hide")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canReveal ? (
        <p className="max-w-prose text-xs text-fg-subtle">
          {t("mdm.vendor.remittance.revealNote", { permission: "mdm.vendor.bank.view" })}
        </p>
      ) : (
        <Banner tone="info" compact>
          {t("mdm.vendor.remittance.readOnly", { permission: "mdm.vendor.bank.view" })}
        </Banner>
      )}
      <p className="max-w-prose text-xs text-fg-subtle">{t("mdm.vendor.remittance.ownership")}</p>
    </div>
  );
}

/** One lifecycle action, rendered as a control only when the caller holds its capability. */
function LifecycleAction({
  permission,
  held,
  disabled,
  disabledReason,
  label,
  hint,
  onOpen,
}: {
  permission: string;
  held: boolean;
  disabled: boolean;
  disabledReason: string;
  label: string;
  hint: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  if (!held) {
    return (
      <span className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">
          {t("mdm.vendor.lifecycle.needs", { permission })}
        </span>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <Button size="sm" variant="secondary" disabled={disabled} onClick={onOpen}>
        {label}
      </Button>
      <span className="text-2xs text-fg-subtle">{disabled ? disabledReason : hint}</span>
    </span>
  );
}

function TermsDialog({
  busy,
  vendor,
  onClose,
  onSave,
}: {
  busy: boolean;
  vendor: VendorDetail;
  onClose: () => void;
  onSave: (
    input: {
      kind: string;
      days: number | null;
      creditLimitAmount: number | null;
      creditLimitCurrency: string | null;
    },
    success: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState(vendor.commercial.paymentTermsKind ?? "net_days");
  const [days, setDays] = useState(String(vendor.commercial.paymentTermsDays ?? ""));
  const [credit, setCredit] = useState(
    vendor.commercial.creditLimit ? String(vendor.commercial.creditLimit.amount) : ""
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const currency = vendor.commercial.billingCurrency;
  const parsedCredit = credit.trim() === "" ? null : Number(credit);
  const creditValid = parsedCredit === null || (Number.isFinite(parsedCredit) && parsedCredit >= 0);
  const nextKind = kind === "eom" || kind === "cod" || kind === "prepaid" ? kind : "net_days";
  const parsedDays = nextKind === "net_days" ? Number(days) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      width="md"
      title={t("mdm.vendor.terms.dialog.title")}
      description={t("mdm.vendor.terms.dialog.description", {
        permission: "mdm.vendor.terms.update",
      })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (nextKind === "net_days" && (!Number.isInteger(parsedDays) || (parsedDays ?? -1) < 0)) {
                setLocalError(t("mdm.vendor.terms.dialog.daysRequired"));
                return;
              }
              if (!creditValid) {
                setLocalError(t("mdm.vendor.terms.dialog.creditInvalid"));
                return;
              }
              setLocalError(null);
              void onSave(
                {
                  kind: nextKind,
                  days: parsedDays,
                  creditLimitAmount: parsedCredit,
                  creditLimitCurrency: currency === "" ? null : currency,
                },
                t("mdm.vendor.terms.saved")
              );
            }}
          >
            {t("mdm.vendor.terms.dialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field id="vendor-terms-kind" label={t("mdm.vendor.terms.kind")} required>
          <Select
            value={kind}
            onChange={setKind}
            ariaLabel={t("mdm.vendor.terms.kind")}
            options={[
              { value: "net_days", label: t("mdm.vendor.terms.net_days", { days: days || "0" }) },
              { value: "eom", label: t("mdm.vendor.terms.eom") },
              { value: "cod", label: t("mdm.vendor.terms.cod") },
              { value: "prepaid", label: t("mdm.vendor.terms.prepaid") },
            ]}
          />
        </Field>
        {nextKind === "net_days" ? (
          <Field
            id="vendor-terms-days"
            label={t("mdm.vendor.terms.days")}
            error={localError}
            required
          >
            <TextInput value={days} onChange={setDays} inputMode="numeric" />
          </Field>
        ) : null}
        <Field
          id="vendor-terms-credit"
          label={t("mdm.vendor.field.creditLimit")}
          hint={t("mdm.vendor.terms.dialog.creditHint")}
          error={localError}
          aside={currency === "" ? t("mdm.vendor.terms.dialog.noCurrency") : currency}
        >
          <TextInput value={credit} onChange={setCredit} inputMode="decimal" />
        </Field>
        <ConfirmSummary
          items={[
            {
              label: t("mdm.vendor.terms.kind"),
              value:
                nextKind === "net_days"
                  ? `${t("mdm.vendor.terms.net_days", { days: days || "0" })}`
                  : t(TERMS_LABEL[nextKind] ?? "mdm.vendor.terms.cod", { days: "0" }),
            },
            {
              label: t("mdm.vendor.field.creditLimit"),
              value: creditValid && parsedCredit !== null ? (
                <MoneyValue money={{ amount: parsedCredit, currency: currency || "INR" }} />
              ) : (
                t("common.none")
              ),
            },
          ]}
        />
      </div>
    </Dialog>
  );
}

function RegistrationDialog({
  busy,
  vendor,
  onClose,
  onSave,
}: {
  busy: boolean;
  vendor: VendorDetail;
  onClose: () => void;
  onSave: (
    input: { jurisdictionCode: string; schemeCode: string; value: string },
    success: string
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [schemeKey, setSchemeKey] = useState(
    vendor.taxSchemes[0] ? `${vendor.taxSchemes[0].jurisdictionCode}:${vendor.taxSchemes[0].code}` : ""
  );
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const scheme = vendor.taxSchemes.find(
    (candidate) => `${candidate.jurisdictionCode}:${candidate.code}` === schemeKey
  );
  return (
    <Dialog
      open
      onClose={onClose}
      width="md"
      title={t("mdm.vendor.tax.dialog.title")}
      description={t("mdm.vendor.tax.dialog.description", { permission: "mdm.vendor.update" })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy || !scheme}
            onClick={() => {
              if (!scheme) return;
              if (value.trim() === "") {
                setLocalError(t("mdm.vendor.tax.dialog.valueRequired"));
                return;
              }
              if (scheme.pattern && !new RegExp(scheme.pattern).test(value.trim())) {
                setLocalError(t("mdm.vendor.tax.dialog.patternMismatch", { scheme: scheme.code }));
                return;
              }
              setLocalError(null);
              void onSave(
                {
                  jurisdictionCode: scheme.jurisdictionCode,
                  schemeCode: scheme.code,
                  value: value.trim(),
                },
                t("mdm.vendor.tax.addedNotice", { scheme: scheme.code })
              );
            }}
          >
            {t("mdm.vendor.tax.dialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {vendor.taxSchemes.length === 0 ? (
          <Banner tone="warn" compact>
            {t("mdm.vendor.tax.dialog.noSchemes")}
          </Banner>
        ) : (
          <>
            <Field
              id="vendor-tax-scheme"
              label={t("mdm.vendor.tax.column.scheme")}
              hint={t("mdm.vendor.tax.dialog.schemeHint")}
              required
            >
              <Select
                value={schemeKey}
                onChange={setSchemeKey}
                ariaLabel={t("mdm.vendor.tax.column.scheme")}
                options={vendor.taxSchemes.map((candidate) => ({
                  value: `${candidate.jurisdictionCode}:${candidate.code}`,
                  label: `${candidate.jurisdictionCode} · ${candidate.code}`,
                }))}
              />
            </Field>
            <Field
              id="vendor-tax-value"
              label={t("mdm.vendor.tax.column.value")}
              hint={scheme?.pattern ? t("mdm.vendor.tax.dialog.patternHint", { pattern: scheme.pattern }) : undefined}
              error={localError}
              required
            >
              <TextInput value={value} onChange={setValue} />
            </Field>
            <p className="text-xs text-fg-subtle">{t("mdm.vendor.tax.dialog.unverifiedNote")}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function StatusDialog({
  busy,
  target,
  vendor,
  onClose,
  onSave,
}: {
  busy: boolean;
  target: "suspended" | "inactive" | "active";
  vendor: VendorDetail;
  onClose: () => void;
  onSave: (reason: string | null, success: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const permission =
    target === "suspended"
      ? "mdm.vendor.suspend"
      : target === "inactive"
        ? "mdm.vendor.deactivate"
        : "mdm.vendor.reactivate";
  const reasonRequired = target !== "active";
  return (
    <Dialog
      open
      onClose={onClose}
      width="md"
      tone={target === "inactive" ? "danger" : "default"}
      title={t(
        target === "suspended"
          ? "mdm.vendor.lifecycle.suspend"
          : target === "inactive"
            ? "mdm.vendor.lifecycle.deactivate"
            : "mdm.vendor.lifecycle.reactivate"
      )}
      description={t("mdm.vendor.lifecycle.dialog.description", { permission })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (reasonRequired && reason.trim() === "") {
                setLocalError(t("mdm.vendor.lifecycle.dialog.reasonRequired"));
                return;
              }
              setLocalError(null);
              void onSave(
                reason.trim() === "" ? null : reason.trim(),
                t("mdm.vendor.lifecycle.saved", {
                  status: t(STATUS_LABEL[target] ?? "mdm.vendor.status.active"),
                })
              );
            }}
          >
            {t("mdm.vendor.lifecycle.dialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ConfirmSummary
          items={[
            { label: t("mdm.vendor.field.code"), value: vendor.code },
            {
              label: t("mdm.vendor.field.status"),
              value: t(STATUS_LABEL[target] ?? "mdm.vendor.status.active"),
            },
          ]}
        />
        <Field
          id="vendor-status-reason"
          label={t("mdm.vendor.lifecycle.dialog.reason")}
          hint={t("mdm.vendor.lifecycle.dialog.reasonHint")}
          error={localError}
          required={reasonRequired}
        >
          <TextInput value={reason} onChange={setReason} />
        </Field>
        <p className="text-xs text-fg-subtle">
          {target === "inactive"
            ? t("mdm.vendor.lifecycle.dialog.deactivateNote")
            : t("mdm.vendor.lifecycle.dialog.note")}
        </p>
      </div>
    </Dialog>
  );
}

/**
 * The four states a record read can be in (§17). A refusal names the capability the server
 * refused on, taken from the server's own message — never re-worded into something vaguer.
 */
function VendorFailure({
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
            title={t("mdm.vendor.denied.title")}
            description={t("mdm.vendor.denied.description")}
            requiredPermission={result.permission ?? "mdm.vendor.view"}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void router.navigate({ to: "/mdm/vendors" });
                }}
              >
                {t("mdm.vendor.detail.back")}
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
