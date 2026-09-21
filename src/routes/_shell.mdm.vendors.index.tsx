import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  SearchInput,
  Select,
  TableSkeleton,
  Toggle,
} from "~/components/ui";
import { MoneyValue, TimestampValue } from "~/components/values";
import type { VendorListItem } from "~/domain/mdm-vendors";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/catalog-en";
import { listVendorsFn } from "~/server-fns";
/**
 * Vendors — the master list (§9.3).
 *
 * A vendor is a *trading partner*, and the two things that make one real are on this row:
 * **who they are** (code, the trade name the kitchen uses, the legal name that invoices) and
 * **what identifies them to a tax authority** (the registration rows, collapsed to scheme +
 * jurisdiction + a masked value + whether we have verified it). A single `gstin` column would
 * have shown one market's number as if it were the vendor's identity; this row shows the
 * rows that exist, and says "A vendor is not one GST number" when there are none.
 *
 * Four states, the same four the article list has: **loading**, **empty in scope**,
 * **filtered to nothing**, and **refused** — with the server's own message naming the
 * capability, never re-worded here. Every filter is driven by counts the API returns, so a
 * state or type the seed does not use is visible as `(0)` rather than missing, and a control
 * that cannot mean anything (an "expiring" filter with no dated documents anywhere) is
 * disabled **with its reason on screen** rather than silently doing nothing.
 *
 * SCOPE, stated on the screen and not only in the pull request: this slab builds the list and
 * the record, the terms write, the tax-registration add/verify and suspend/reinstate/
 * deactivate. Bulk import, maker-checker, the duplicate-merge flow and purchase history are
 * later slabs; the screen says so where a reader would look for them rather than showing a
 * button that would lie.
 */
export const Route = createFileRoute("/_shell/mdm/vendors/")({
  staticData: { titleKey: "nav.route./mdm/vendors" },
  loader: async () => listVendorsFn(),
  pendingComponent: VendorsPending,
  component: VendorsScreen,
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

function VendorsPending() {
  const { t } = useI18n();
  return (
    <div className="p-4">
      <TableSkeleton rows={10} columns={7} label={t("state.loading.title")} />
    </div>
  );
}

function VendorsScreen() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [currency, setCurrency] = useState("");
  const [category, setCategory] = useState("");
  const [expiringOnly, setExpiringOnly] = useState(false);

  if (!result.ok) {
    return (
      <div className="p-4">
        <ErrorState
          title={t("mdm.vendors.denied.title")}
          description={t("mdm.vendors.denied.description")}
          detail={result.message}
        />
      </div>
    );
  }

  const vendors = result.items;
  const needle = query.trim().toLowerCase();
  const filtered = vendors.filter((vendor) => {
    if (status && vendor.status !== status) return false;
    if (type && vendor.vendorType !== type) return false;
    if (currency && vendor.billingCurrency !== currency) return false;
    if (jurisdiction && !vendor.taxRegistrations.some((row) => row.jurisdictionCode === jurisdiction)) {
      return false;
    }
    if (category && !vendor.categoryCodes.includes(category)) return false;
    if (expiringOnly && vendor.daysToEarliestExpiry === null) return false;
    if (expiringOnly && (vendor.daysToEarliestExpiry ?? 0) > result.expiryWindowDays) return false;
    if (needle) {
      // The three the search box promises: code, legal name and the name the kitchen uses.
      const haystack = `${vendor.code} ${vendor.legalName} ${vendor.tradeName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const clearFilters = () => {
    setQuery("");
    setStatus("");
    setType("");
    setJurisdiction("");
    setCurrency("");
    setCategory("");
    setExpiringOnly(false);
  };

  // A filter that could only ever be empty is a control that cannot mean anything. The API
  // reports how many vendors have a dated document at all, so this is a fact, not a guess.
  const expiringFilterUnavailable = result.options.documentsDated === 0;
  const categoryOptions = Array.from(
    vendors.reduce((map, vendor) => {
      for (const code of vendor.categoryCodes) map.set(code, (map.get(code) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  ).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <CardHeader title={t("mdm.vendors.title")} subtitle={t("mdm.vendors.subtitle")} />
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("mdm.vendors.search.placeholder")}
            label={t("mdm.vendors.search.label")}
          />
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel={t("mdm.vendors.filter.status")}
            emptyLabel={t("mdm.vendors.filter.all")}
            options={result.options.statuses.map((option) => ({
              value: option.code,
              label: `${t(STATUS_LABEL[option.code] ?? "mdm.vendor.status.active")} (${String(option.count)})`,
            }))}
          />
          <Select
            value={type}
            onChange={setType}
            ariaLabel={t("mdm.vendors.filter.type")}
            emptyLabel={t("mdm.vendors.filter.all")}
            options={result.options.types.map((option) => ({
              value: option.code,
              label: `${t(TYPE_LABEL[option.code] ?? "mdm.vendor.type.distributor")} (${String(option.count)})`,
            }))}
          />
          <Select
            value={jurisdiction}
            onChange={setJurisdiction}
            ariaLabel={t("mdm.vendors.filter.jurisdiction")}
            emptyLabel={t("mdm.vendors.filter.all")}
            options={result.options.jurisdictions.map((option) => ({
              value: option.code,
              label: `${option.code} (${String(option.count)})`,
            }))}
          />
          <Select
            value={currency}
            onChange={setCurrency}
            ariaLabel={t("mdm.vendors.filter.currency")}
            emptyLabel={t("mdm.vendors.filter.all")}
            options={result.options.currencies.map((option) => ({
              value: option.code,
              label: `${option.code} (${String(option.count)})`,
            }))}
          />
          <Select
            value={category}
            onChange={setCategory}
            ariaLabel={t("mdm.vendors.filter.category")}
            emptyLabel={t("mdm.vendors.filter.all")}
            options={categoryOptions.map(([code, count]) => ({
              value: code,
              label: `${code} (${String(count)})`,
            }))}
          />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Toggle
                checked={expiringOnly}
                onChange={setExpiringOnly}
                disabled={expiringFilterUnavailable}
                label={t("mdm.vendors.filter.expiring", { days: String(result.expiryWindowDays) })}
              />
              <span className="text-xs text-fg">
                {t("mdm.vendors.filter.expiring", { days: String(result.expiryWindowDays) })}
              </span>
            </div>
            {expiringFilterUnavailable ? (
              <span className="max-w-prose text-2xs text-fg-subtle">
                {t("mdm.vendors.filter.expiringUnavailable")}
              </span>
            ) : null}
          </div>
        </div>

        {filtered.length === 0 && vendors.length > 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.vendors.noResults.title")}
              description={t("mdm.vendors.noResults.description", { total: String(vendors.length) })}
              action={
                <Button size="sm" onClick={clearFilters}>
                  {t("action.clearFilters")}
                </Button>
              }
            />
          </div>
        ) : vendors.length === 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              title={t("mdm.vendors.empty.title")}
              description={t("mdm.vendors.empty.description")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">{t("mdm.vendors.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("mdm.vendors.column.code")}</th>
                  <th scope="col">{t("mdm.vendors.column.name")}</th>
                  <th scope="col">{t("mdm.vendors.column.type")}</th>
                  <th scope="col">{t("mdm.vendors.column.taxRegistration")}</th>
                  <th scope="col">{t("mdm.vendors.column.currency")}</th>
                  <th scope="col">{t("mdm.vendors.column.terms")}</th>
                  <th scope="col">{t("mdm.vendors.column.documents")}</th>
                  <th scope="col">{t("mdm.vendors.column.status")}</th>
                  <th scope="col">{t("mdm.vendors.column.lastChange")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((vendor) => (
                  <tr
                    key={vendor.id}
                    data-clickable="true"
                    // The whole row opens the record, and the code cell's link fills its cell
                    // so the pointer target matches the cell a reviewer measured (review S7).
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a")) return;
                      if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                      void router.navigate({
                        to: "/mdm/vendors/$vendorCode",
                        params: { vendorCode: vendor.code },
                      });
                    }}
                  >
                    <td className="font-mono text-xs">
                      <Link
                        to="/mdm/vendors/$vendorCode"
                        params={{ vendorCode: vendor.code }}
                        className="block whitespace-nowrap underline decoration-dotted underline-offset-2"
                      >
                        {vendor.code}
                      </Link>
                      {vendor.duplicateOfCode ? (
                        <span className="block text-2xs text-fg-muted">
                          {t("mdm.vendors.mergedInto", { code: vendor.duplicateOfCode })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className="block">{vendor.tradeName ?? vendor.legalName}</span>
                      {vendor.tradeName ? (
                        <span className="block text-xs text-fg-muted">{vendor.legalName}</span>
                      ) : null}
                      {vendor.tradeName && vendor.untranslated ? (
                        <span className="block text-2xs text-fg-subtle">
                          {t("mdm.vendors.untranslated", { locale: vendor.tradeNameLocale ?? "" })}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-fg-muted">
                      {t(TYPE_LABEL[vendor.vendorType] ?? "mdm.vendor.type.distributor")}
                    </td>
                    <td>
                      <TaxRegistrationCell vendor={vendor} />
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {vendor.billingCurrency === "" ? "—" : vendor.billingCurrency}
                    </td>
                    <td className="whitespace-nowrap">
                      {vendor.paymentTermsKind ? (
                        <span className="block">
                          {t(TERMS_LABEL[vendor.paymentTermsKind] ?? "mdm.vendor.terms.cod", {
                            days: String(vendor.paymentTermsDays ?? 0),
                          })}
                        </span>
                      ) : (
                        <span className="block text-fg-muted">{t("mdm.vendor.terms.none")}</span>
                      )}
                      {vendor.creditLimit ? (
                        <span className="block text-xs text-fg-muted">
                          <MoneyValue money={vendor.creditLimit} />
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <DocumentsCell vendor={vendor} windowDays={result.expiryWindowDays} />
                    </td>
                    <td className="whitespace-nowrap">
                      <Badge tone={STATUS_TONE[vendor.status] ?? "neutral"}>
                        {t(STATUS_LABEL[vendor.status] ?? "mdm.vendor.status.active")}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-fg-muted">
                      <TimestampValue value={vendor.lastChange} mode="dateTime" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
          {t("mdm.vendors.count", { shown: String(filtered.length), total: String(result.total) })}
        </p>
        {result.hasMore ? (
          <p className="border-t border-border px-4 py-2 text-xs text-warn">
            {t("mdm.vendors.truncated", {
              shown: String(vendors.length),
              total: String(result.total),
            })}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title={t("mdm.vendors.markets.title")}
          subtitle={t("mdm.vendors.scope.note")}
        />
        <ul className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
          {result.markets.length === 0 ? (
            <li>{t("mdm.vendors.markets.none")}</li>
          ) : (
            result.markets.map((requirement) => (
              <li key={`${requirement.jurisdiction}:${requirement.field}`}>
                {t("mdm.vendors.markets.row", {
                  jurisdiction: requirement.jurisdiction,
                  field: requirement.field,
                  requirement: requirement.requirement,
                })}
              </li>
            ))
          )}
          <li>
            {t("mdm.vendors.markets.verification")}
          </li>
          <li>{t("mdm.vendors.openRecord")}</li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * The tax-registration cell: one line per registration, each showing the jurisdiction, the
 * scheme's own code and the masked value, plus whether we have verified it.
 *
 * Masked rather than absent: a buyer who cannot see *that* a supplier is registered in
 * Karnataka, and against which scheme, cannot ask the question that matters. Masked rather
 * than in full: the list is not the place a registration number is read out (§9.3).
 */
function TaxRegistrationCell({ vendor }: { vendor: VendorListItem }) {
  const { t } = useI18n();
  if (vendor.taxRegistrations.length === 0) {
    return (
      <span className="text-xs text-warn" title={t("mdm.vendors.tax.noneTitle")}>
        {t("mdm.vendors.tax.none")}
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {vendor.taxRegistrations.map((registration) => (
        <li key={registration.id} className="whitespace-nowrap">
          <span className="font-mono text-2xs text-fg-muted">{registration.jurisdictionCode}</span>
          <span className="ms-1">{registration.schemeCode}</span>
          <span className="ms-2 font-mono text-xs">{registration.maskedValue}</span>
          <span className="ms-2">
            {registration.status === "retired" ? (
              <Badge tone="neutral" shape={false}>
                {t("mdm.vendors.tax.retired")}
              </Badge>
            ) : registration.verified ? (
              <Badge tone="ok" shape={false}>
                {t("mdm.vendors.tax.verified")}
              </Badge>
            ) : (
              <span title={t("mdm.vendors.tax.unverifiedTitle")}>
                <Badge tone="warn" shape={false}>
                  {t("mdm.vendors.tax.unverified")}
                </Badge>
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A compliance date that lapses silently is the failure this column exists to prevent. */
function DocumentsCell({ vendor, windowDays }: { vendor: VendorListItem; windowDays: number }) {
  const { t } = useI18n();
  if (vendor.daysToEarliestExpiry === null) {
    return <span className="text-xs text-fg-subtle">{t("mdm.vendors.documents.none")}</span>;
  }
  if (vendor.documentsExpired > 0) {
    return (
      <Badge tone="danger">
        {t("mdm.vendors.documents.expired", { count: String(vendor.documentsExpired) })}
      </Badge>
    );
  }
  if (vendor.documentsExpiringSoon > 0 && vendor.daysToEarliestExpiry <= windowDays) {
    return (
      <Badge tone="warn">
        {t("mdm.vendors.documents.expiring", { days: String(vendor.daysToEarliestExpiry) })}
      </Badge>
    );
  }
  return (
    <span className="text-xs text-fg-muted">
      {t("mdm.vendors.documents.inDays", { days: String(vendor.daysToEarliestExpiry) })}
    </span>
  );
}
