import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { auditedMutation, guard, recordAudit, toJsonState, type JsonState } from "~/server/audit";
import { NotFound, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import type { ErpOwnedField, ErpOwnershipRow, ErpSystemView } from "~/domain/mdm";
import type { MutationMeta } from "~/domain/mdm";

/**
 * Phase 1 master data — the VENDOR master's domain API (§9, §20.3, §21.3).
 *
 * It is a separate module from `~/domain/mdm` (the article master) for one reason that is
 * about the file rather than the design: the article master's module had already grown past
 * the point where a second master could be added to it without making either one hard to
 * read. The *shape* is deliberately identical, and that is the point — `guard(...)` first,
 * `auditedMutation(...)` for every write with the audit row in the same transaction as the
 * write, money as `{ amount, currencyCode }`, and codes shown as codes.
 *
 * Four rules from the spec that shaped the code rather than the comments:
 *
 *   1. **A vendor is not one GST number** (§9.1). Tax registrations are effective-dated rows
 *      per jurisdiction, hanging off a reference scheme (`tax_registration_scheme`), because
 *      India needs a GSTIN, the UAE a TRN and Germany a USt-IdNr./Steuernummer — a single
 *      `gstin` column would be migrated the first time a non-India chain is onboarded.
 *   2. **Financial fields have their own capability.** Payment terms and credit limit are
 *      written under `mdm.vendor.terms.update`, not the general `mdm.vendor.update`: a
 *      change to a vendor's terms changes money, and §9.1 says so.
 *   3. **Bank details are masked in every read, and the reveal is audited per reveal**
 *      (§9.1, §9.3). `remittance_account_masked` is masked at rest; the other three
 *      remittance values are masked here on the way out, and the one function that returns
 *      a full value is guarded by `mdm.vendor.bank.view` and writes an audit row naming the
 *      field it revealed.
 *   4. **The ERP is not the master of everything, and a block is not a suspension** (§20.3).
 *      ERP-owned fields come back as `ErpOwnedField` values with provenance — never as
 *      editable or disabled inputs — and `erp_blocked` is carried as its own fact, because
 *      deciding between `suspended` and `inactive` is a business decision, not a mapping.
 *
 * SPEC-GAP, flagged rather than hidden: §25.2 makes the ERP visibility rules data
 * (`erp_visibility_rule` rows). That table does not exist in the migrations, so as on the
 * article record the rule is implemented as "a group is shown when it holds a value" — the
 * part of §25.2 that is data-driven today. `erp_field_ownership` **does** exist and is read
 * here; it currently holds no rows, and the screen says "platform default" rather than
 * inventing a row, exactly as the article record does.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A value a reader may see but not read out: the last four characters, the rest masked. */
export function maskValue(value: string | null): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "";
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-4)}`;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

function asDate(value: unknown): string | null {
  const iso = asIso(value);
  return iso === "" ? null : iso.slice(0, 10);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveChainId(principal: Principal, requested?: string | null): string {
  const chainId = requested?.trim() || principal.chainId;
  if (!chainId) {
    throw new ValidationError("a chain context is required (chainId)");
  }
  return chainId;
}

/**
 * The jurisdictions a chain actually trades in — its own plus its sites' — so a vendor
 * screen shows the markets that exist rather than every market the platform knows.
 * Same rule as the article master; duplicated deliberately rather than exported from
 * `~/domain/mdm`, so that changing one master's read cannot silently change the other's.
 */
async function tradedJurisdictions(chainId: string): Promise<string[]> {
  const rows = await poolQueryable().query<{ code: string }>(
    `select distinct code from (
       select c.tax_jurisdiction as code from chain c where c.id = $1 and c.tax_jurisdiction is not null
       union
       select coalesce(s.jurisdiction_code, s.tax_jurisdiction) as code
         from site s
        where s.chain_id = $1
          and coalesce(s.jurisdiction_code, s.tax_jurisdiction) is not null
     ) t
     order by code`,
    [chainId]
  );
  return rows.map((row) => row.code);
}

/**
 * What a market's profile says about a vendor: `jurisdiction_field_rule` rows in force for
 * `entity = 'vendor'`. The profile, not the person, decides what "complete" means (§7.4's
 * discipline applied to this master), and a market that requires nothing produces no row.
 */
async function vendorFieldRules(
  tx: Queryable,
  jurisdictions: string[]
): Promise<{ jurisdiction: string; field: string; requirement: string; legalRef: string | null }[]> {
  const rules: { jurisdiction: string; field: string; requirement: string; legalRef: string | null }[] = [];
  for (const jurisdiction of jurisdictions) {
    const rows = await tx.query<{ field: string; requirement: string; legal_ref: string | null }>(
      `select distinct on (field) field, requirement, legal_ref
         from jurisdiction_field_rule
        where jurisdiction_code = $1 and entity = 'vendor' and effective_from <= current_date
        order by field, effective_from desc`,
      [jurisdiction]
    );
    for (const row of rows) {
      rules.push({
        jurisdiction,
        field: row.field,
        requirement: row.requirement,
        legalRef: row.legal_ref,
      });
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface VendorTaxRegistrationCell {
  id: string;
  jurisdictionCode: string;
  schemeCode: string;
  /** Masked on the list (§9.3). The record screen is where the value is read. */
  maskedValue: string;
  verified: boolean;
  verifiedAt: string | null;
  status: string;
}

export interface VendorListItem {
  id: string;
  code: string;
  legalName: string;
  /** The name the kitchen uses, in the viewer's locale where one exists. */
  tradeName: string | null;
  tradeNameLocale: string | null;
  untranslated: boolean;
  vendorType: string;
  status: string;
  billingCurrency: string;
  paymentTermsKind: string | null;
  paymentTermsDays: number | null;
  creditLimit: { amount: number; currencyCode: string } | null;
  taxRegistrations: VendorTaxRegistrationCell[];
  /** Negative = already expired. Null = no dated document on file. */
  daysToEarliestExpiry: number | null;
  documentsExpiringSoon: number;
  documentsExpired: number;
  categoryCount: number;
  /** What Purchase may order from them. An empty list is "not yet classified", which the
   * screen states rather than showing it as "no limit" (§9.1). */
  categoryCodes: string[];
  /** Set when MDM merged this into another record: the code it now resolves to (§9.1). */
  duplicateOfCode: string | null;
  lastChange: string;
}

export interface VendorListFilters {
  chainId?: string | null;
  query?: string | null;
  status?: string | null;
  vendorType?: string | null;
  jurisdiction?: string | null;
  currency?: string | null;
  /** Documents that expire within the window, or have already. */
  expiringWithinDays?: number | null;
  limit?: number;
}

export interface VendorListOptions {
  statuses: { code: string; count: number }[];
  types: { code: string; count: number }[];
  jurisdictions: { code: string; count: number }[];
  currencies: { code: string; count: number }[];
  expiringCount: number;
  /** How many vendors have any dated document at all. The screen uses this to disable the
   * "expiring" filter *with its reason* when it could only ever return nothing. */
  documentsDated: number;
}

export interface VendorListResult {
  items: VendorListItem[];
  total: number;
  limit: number;
  hasMore: boolean;
  /** What the supply-side profile states for this chain's markets, so the screen can show
   * whether any requirement is configured at all rather than implying "complete". */
  markets: { jurisdiction: string; field: string; requirement: string; legalRef: string | null }[];
  options: VendorListOptions;
  /** The window the expiring filter uses, named on screen so "expiring" has a number. */
  expiryWindowDays: number;
}

const MAX_LIMIT = 200;
const DEFAULT_EXPIRY_WINDOW_DAYS = 90;

interface VendorRow {
  id: string;
  code: string;
  legal_name: string;
  vendor_type: string;
  status: string;
  billing_currency: string | null;
  payment_terms_kind: string | null;
  payment_terms_days: number | null;
  credit_limit_amount: string | number | null;
  credit_limit_currency: string | null;
  trade_name: string | null;
  trade_name_locale: string | null;
  days_to_earliest_expiry: number | string | null;
  documents_expiring_soon: string | number;
  documents_expired: string | number;
  category_count: string | number;
  duplicate_of_code: string | null;
  updated_at: Date;
}

export async function listVendors(
  principal: Principal,
  filters: VendorListFilters = {}
): Promise<VendorListResult> {
  const chainId = resolveChainId(principal, filters.chainId);
  await guard({
    principal,
    action: filters.query ? "mdm.vendor.search" : "mdm.vendor.view",
    entityType: "vendor",
    chainId,
    target: `chain ${chainId}`,
  });

  const db = poolQueryable();
  const jurisdictions = await tradedJurisdictions(chainId);
  const markets = await vendorFieldRules(db, jurisdictions);

  const values: unknown[] = [chainId];
  const where: string[] = ["v.chain_id = $1"];
  const p = (value: unknown): string => {
    values.push(value);
    return "$" + String(values.length);
  };

  const text = filters.query?.trim() ?? "";
  if (text) {
    const code = p(`%${text}%`);
    const legal = p(`%${text}%`);
    const trade = p(`%${text}%`);
    // The three the search box promises: code, legal name and the trade name the kitchen
    // uses — matched where the trade name exists, so "Venkatesh" finds the vegetable vendor.
    where.push(`(v.code ilike ${code} or v.legal_name ilike ${legal} or exists (
        select 1 from vendor_text vt
         where vt.vendor_id = v.id and vt.trade_name ilike ${trade}))`);
  }
  if (filters.status?.trim()) where.push(`v.status = ${p(filters.status.trim())}`);
  if (filters.vendorType?.trim()) where.push(`v.vendor_type = ${p(filters.vendorType.trim())}`);
  if (filters.currency?.trim()) where.push(`v.billing_currency = ${p(filters.currency.trim().toUpperCase())}`);
  if (filters.jurisdiction?.trim()) {
    where.push(`exists (select 1 from vendor_tax_registration tr
                         where tr.vendor_id = v.id and tr.jurisdiction_code = ${p(filters.jurisdiction.trim())})`);
  }
  const windowDays = Math.max(
    Math.trunc(filters.expiringWithinDays ?? DEFAULT_EXPIRY_WINDOW_DAYS),
    1
  );
  if (filters.expiringWithinDays !== null && filters.expiringWithinDays !== undefined) {
    where.push(`exists (select 1 from vendor_document d
                         where d.vendor_id = v.id and d.expires_on is not null
                           and d.expires_on <= current_date + ${p(windowDays)}::int)`);
  }

  const limit = Math.min(
    Math.max(Number.isFinite(filters.limit) ? Math.trunc(filters.limit as number) : MAX_LIMIT, 1),
    MAX_LIMIT
  );
  const preferredLocale = principal.locale ?? "en-IN";
  const localeParam = p(preferredLocale);

  const rows = await db.query<VendorRow>(
    `select v.id, v.code, v.legal_name, v.vendor_type, v.status, v.billing_currency,
            v.payment_terms_kind, v.payment_terms_days, v.credit_limit_amount,
            v.credit_limit_currency, v.updated_at,
            t.trade_name, t.locale as trade_name_locale,
            dup.code as duplicate_of_code,
            (select min(d.expires_on - current_date) from vendor_document d
              where d.vendor_id = v.id and d.expires_on is not null) as days_to_earliest_expiry,
            (select count(*) from vendor_document d
              where d.vendor_id = v.id and d.expires_on is not null
                and d.expires_on >= current_date and d.expires_on <= current_date + 90) as documents_expiring_soon,
            (select count(*) from vendor_document d
              where d.vendor_id = v.id and d.expires_on is not null and d.expires_on < current_date) as documents_expired,
            (select count(*) from vendor_category vc where vc.vendor_id = v.id) as category_count
       from vendor v
       left join vendor_text t on t.vendor_id = v.id and t.locale = ${localeParam}
       left join vendor dup on dup.id = v.duplicate_of_vendor_id
      where ${where.join(" and ")}
      order by v.code asc
      limit ${p(limit)}`,
    values
  );

  const registrations = await db.query<{
    id: string;
    vendor_id: string;
    jurisdiction_code: string;
    scheme_code: string;
    value: string;
    verified_at: Date | null;
    status: string;
  }>(
    `select id, vendor_id, jurisdiction_code, scheme_code, value, verified_at, status
       from vendor_tax_registration
      where chain_id = $1 and vendor_id = any($2::uuid[])
      order by jurisdiction_code asc, scheme_code asc`,
    [chainId, rows.map((row) => row.id)]
  );
  const registrationsByVendor = new Map<string, VendorTaxRegistrationCell[]>();
  for (const registration of registrations) {
    const list = registrationsByVendor.get(registration.vendor_id) ?? [];
    list.push({
      id: registration.id,
      jurisdictionCode: registration.jurisdiction_code,
      schemeCode: registration.scheme_code,
      maskedValue: maskValue(registration.value),
      verified: registration.verified_at !== null,
      verifiedAt: registration.verified_at ? asIso(registration.verified_at) : null,
      status: registration.status,
    });
    registrationsByVendor.set(registration.vendor_id, list);
  }

  const categoryRows = await db.query<{ vendor_id: string; code: string }>(
    `select vc.vendor_id, c.code
       from vendor_category vc
       join raw_material_category c on c.id = vc.category_id
      where vc.chain_id = $1 and vc.vendor_id = any($2::uuid[])
      order by vc.vendor_id, c.code asc`,
    [chainId, rows.map((row) => row.id)]
  );
  const categoriesByVendor = new Map<string, string[]>();
  for (const category of categoryRows) {
    const list = categoriesByVendor.get(category.vendor_id) ?? [];
    list.push(category.code);
    categoriesByVendor.set(category.vendor_id, list);
  }

  const items: VendorListItem[] = rows.map((row) => ({
    id: row.id,
    code: row.code,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    tradeNameLocale: row.trade_name_locale,
    untranslated: row.trade_name_locale === null,
    vendorType: row.vendor_type,
    status: row.status,
    billingCurrency: (row.billing_currency ?? "").trim(),
    paymentTermsKind: row.payment_terms_kind,
    paymentTermsDays: row.payment_terms_days,
    creditLimit:
      row.credit_limit_amount === null || row.credit_limit_amount === undefined
        ? null
        : {
            amount: Number(row.credit_limit_amount),
            currencyCode: (row.credit_limit_currency ?? row.billing_currency ?? "").trim(),
          },
    taxRegistrations: registrationsByVendor.get(row.id) ?? [],
    daysToEarliestExpiry: asNumber(row.days_to_earliest_expiry),
    documentsExpiringSoon: Number(row.documents_expiring_soon),
    documentsExpired: Number(row.documents_expired),
    categoryCount: Number(row.category_count),
    categoryCodes: categoriesByVendor.get(row.id) ?? [],
    duplicateOfCode: row.duplicate_of_code,
    lastChange: asIso(row.updated_at),
  }));

  // Counts for the filters, taken from the same scope with no filters applied, so a filter
  // option that would return nothing is visible as "0" rather than absent (review S4).
  const options = await getVendorListOptions(chainId, db);
  const total = await db.query<{ total: string }>(
    `select count(*) as total from vendor v where ${where.join(" and ")}`,
    values.slice(0, values.length - 1)
  );
  const totalCount = Number(total[0]?.total ?? 0);

  return {
    items,
    total: totalCount,
    limit,
    hasMore: items.length < totalCount,
    markets,
    options,
    expiryWindowDays: windowDays,
  };
}

async function getVendorListOptions(chainId: string, db: Queryable): Promise<VendorListOptions> {
  const statuses = await db.query<{ code: string; count: string }>(
    `select status as code, count(*) as count from vendor where chain_id = $1 group by 1`,
    [chainId]
  );
  const types = await db.query<{ code: string; count: string }>(
    `select vendor_type as code, count(*) as count from vendor where chain_id = $1 group by 1`,
    [chainId]
  );
  const jurisdictions = await db.query<{ code: string; count: string }>(
    `select tr.jurisdiction_code as code, count(distinct tr.vendor_id) as count
       from vendor_tax_registration tr where tr.chain_id = $1 group by 1`,
    [chainId]
  );
  const currencies = await db.query<{ code: string; count: string }>(
    `select btrim(billing_currency) as code, count(*) as count
       from vendor where chain_id = $1 and billing_currency is not null group by 1`,
    [chainId]
  );
  const expiring = await db.query<{ count: string }>(
    `select count(distinct v.id) as count from vendor v
      join vendor_document d on d.vendor_id = v.id
     where v.chain_id = $1 and d.expires_on is not null
       and d.expires_on <= current_date + ${DEFAULT_EXPIRY_WINDOW_DAYS}`,
    [chainId]
  );
  const dated = await db.query<{ count: string }>(
    `select count(distinct v.id) as count from vendor v
      join vendor_document d on d.vendor_id = v.id
     where v.chain_id = $1 and d.expires_on is not null`,
    [chainId]
  );
  // Lifecycle order, so the filter reads like the record's own lifecycle rather than
  // alphabetically (§9.1: proposed → active → suspended → inactive).
  const STATUS_ORDER = ["proposed", "active", "suspended", "inactive"];
  const TYPE_ORDER = [
    "manufacturer",
    "distributor",
    "wholesaler",
    "importer",
    "service",
    "logistics",
  ];
  const byOrder = (
    rows: { code: string; count: string }[],
    order: string[]
  ): { code: string; count: number }[] => {
    const counts = new Map(rows.map((row) => [row.code, Number(row.count)]));
    const seen = new Set<string>();
    const result = order.map((code) => {
      seen.add(code);
      return { code, count: counts.get(code) ?? 0 };
    });
    for (const row of rows) {
      if (!seen.has(row.code)) result.push({ code: row.code, count: Number(row.count) });
    }
    return result;
  };
  return {
    statuses: byOrder(statuses, STATUS_ORDER),
    types: byOrder(types, TYPE_ORDER),
    jurisdictions: jurisdictions.map((row) => ({ code: row.code, count: Number(row.count) })),
    currencies: currencies.map((row) => ({ code: row.code, count: Number(row.count) })),
    expiringCount: Number(expiring[0]?.count ?? 0),
    documentsDated: Number(dated[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface VendorComplianceCell {
  jurisdiction: string;
  field: string;
  requirement: string;
  satisfied: boolean;
  /** False when this build has no way to look at the field: reported, never assumed. */
  checked: boolean;
  legalRef: string | null;
}

export interface VendorDetail {
  id: string;
  code: string;
  legalName: string;
  status: string;
  vendorType: string;
  externalRef: string | null;
  sourceSystem: string | null;
  deactivationReason: string | null;
  duplicateOfCode: string | null;
  tradeNames: { locale: string; name: string }[];
  address: {
    line1: string | null;
    line2: string | null;
    locality: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
  };
  contacts: {
    id: string;
    kind: string;
    name: string;
    email: string | null;
    phone: string | null;
    locale: string | null;
    preferred: boolean;
  }[];
  /** Full values: this is the record a permitted reader opened (§9.3 masks the list). */
  taxRegistrations: {
    id: string;
    jurisdictionCode: string;
    schemeCode: string;
    schemeLabelKey: string | null;
    value: string;
    verified: boolean;
    verifiedAt: string | null;
    verifiedByName: string | null;
    status: string;
    /** False when the scheme's own pattern does not match the stored value. */
    patternValid: boolean;
  }[];
  /** The schemes a permitted user may add a registration against, per jurisdiction. */
  taxSchemes: { code: string; jurisdictionCode: string; labelKey: string; pattern: string | null }[];
  commercial: {
    billingCurrency: string;
    paymentTermsKind: string | null;
    paymentTermsDays: number | null;
    creditLimit: { amount: number; currencyCode: string } | null;
    leadTimeDays: number | null;
    moqQty: number | null;
    moqUomCode: string | null;
  };
  /** Masked here; `revealVendorBank` is the one function that returns a full value. */
  remittance: {
    method: string | null;
    bankName: string | null;
    accountName: string | null;
    accountNumberMasked: string | null;
    ifscOrSwiftMasked: string | null;
    ibanMasked: string | null;
    upiIdMasked: string | null;
    fieldsPresent: string[];
  };
  documents: {
    id: string;
    kind: string;
    reference: string | null;
    issuedOn: string | null;
    expiresOn: string | null;
    daysToExpiry: number | null;
  }[];
  categories: { code: string; name: string | null }[];
  legalEntities: string[];
  duplicateReview: {
    candidates: { code: string; legalName: string; match: string; detail: string }[];
    /** Already-merged links out: what this record resolves to now. */
    mergesInto: { code: string; legalName: string } | null;
  };
  compliance: VendorComplianceCell[];
  /** Phase 3 owns purchase history. Stated as absent rather than faked. */
  purchaseHistory: { available: boolean; note: string };
  provenance: { externalKeyKind: string; externalKeyValue: string; lastSyncAt: string | null }[];
  erp: { system: ErpSystemView | null; fields: ErpOwnedField[]; ownership: ErpOwnershipRow[] };
  /** This master is not versioned (the article master is); changes live in the audit trail. */
  versioning: { versioned: boolean; note: string };
  history: {
    entries: {
      id: string;
      at: string;
      action: string;
      actorName: string | null;
      actorRoleCode: string | null;
      outcome: string;
      reason: string | null;
      before: JsonState;
      after: JsonState;
    }[];
    /** Set when the trail is readable in principle but not by this caller. */
    denied: { permission: string } | null;
  };
}

export async function getVendor(principal: Principal, code: string): Promise<VendorDetail> {
  const vendorCode = code?.trim();
  if (!vendorCode) throw new ValidationError("vendor code is required");
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.vendor.view",
    entityType: "vendor",
    chainId,
    target: `vendor ${vendorCode}`,
  });

  const db = poolQueryable();
  const rows = await db.query<{
    id: string;
    code: string;
    legal_name: string;
    status: string;
    vendor_type: string;
    billing_currency: string | null;
    payment_terms_kind: string | null;
    payment_terms_days: number | null;
    credit_limit_amount: string | number | null;
    credit_limit_currency: string | null;
    address_line1: string | null;
    address_line2: string | null;
    address_locality: string | null;
    address_region: string | null;
    address_postal_code: string | null;
    address_country_code: string | null;
    remittance_method: string | null;
    remittance_bank_name: string | null;
    remittance_account_name: string | null;
    remittance_account_masked: string | null;
    remittance_ifsc_swift: string | null;
    remittance_iban: string | null;
    remittance_upi_id: string | null;
    lead_time_days: number | null;
    moq_qty: string | number | null;
    moq_uom_code: string | null;
    external_ref: string | null;
    source_system: string | null;
    deactivation_reason: string | null;
    duplicate_of_vendor_id: string | null;
    erp_account_group_code: string | null;
    erp_tax_classification: string | null;
    erp_withholding_tax_type: string | null;
    erp_withholding_tax_code: string | null;
    erp_tax_jurisdiction_code: string | null;
    erp_blocked: boolean;
    erp_deletion_flag: boolean;
    erp_blocked_reason: string | null;
    incoterms_code: string | null;
    incoterms_location: string | null;
    erp_source_version: string | null;
    erp_last_sync_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `select v.*, u.code as moq_uom_code
       from vendor v
       left join uom u on u.id = v.moq_uom_id
      where v.chain_id = $1 and v.code = $2`,
    [chainId, vendorCode]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Vendor", vendorCode);

  const tradeNames = await db.query<{ locale: string; trade_name: string }>(
    `select locale, trade_name from vendor_text where vendor_id = $1 order by locale`,
    [row.id]
  );
  const contacts = await db.query<{
    id: string;
    kind: string;
    name: string;
    email: string | null;
    phone: string | null;
    locale: string | null;
    preferred: boolean;
  }>(
    `select id, kind, name, email, phone, locale, preferred
       from vendor_contact where vendor_id = $1 order by preferred desc, kind asc, name asc`,
    [row.id]
  );
  const registrations = await db.query<{
    id: string;
    jurisdiction_code: string;
    scheme_code: string;
    value: string;
    verified_at: Date | null;
    verified_by_name: string | null;
    status: string;
    label_key: string | null;
    pattern: string | null;
  }>(
    `select tr.id, tr.jurisdiction_code, tr.scheme_code, tr.value, tr.verified_at,
            u.display_name as verified_by_name, tr.status,
            sch.label_key, sch.pattern
       from vendor_tax_registration tr
       left join "user" u on u.id = tr.verified_by_user_id
       left join tax_registration_scheme sch
              on sch.jurisdiction_code = tr.jurisdiction_code and sch.scheme_code = tr.scheme_code
      where tr.vendor_id = $1
      order by tr.jurisdiction_code asc, tr.scheme_code asc, tr.value asc`,
    [row.id]
  );
  // Only the schemes that apply to a vendor: `applies_to` is the registry's own rule about
  // which entity a scheme is for, so offering a customer-number scheme here would be wrong.
  const schemes = await db.query<{
    scheme_code: string;
    jurisdiction_code: string;
    label_key: string;
    pattern: string | null;
  }>(
    `select scheme_code, jurisdiction_code, label_key, pattern
       from tax_registration_scheme
      where status = 'active' and 'vendor' = any(applies_to)
      order by jurisdiction_code asc, scheme_code asc`
  );
  const documents = await db.query<{
    id: string;
    kind: string;
    reference: string | null;
    issued_on: Date | null;
    expires_on: Date | null;
    days_to_expiry: number | null;
  }>(
    `select id, kind, reference, issued_on, expires_on,
            (expires_on - current_date) as days_to_expiry
       from vendor_document where vendor_id = $1
      order by expires_on asc nulls last, kind asc`,
    [row.id]
  );
  const categories = await db.query<{ code: string; name: string | null }>(
    `select c.code, ct.name
       from vendor_category vc
       join raw_material_category c on c.id = vc.category_id
       left join raw_material_category_text ct on ct.category_id = c.id and ct.locale = $2
      where vc.vendor_id = $1
      order by c.code asc`,
    [row.id, principal.locale ?? "en-IN"]
  );
  const legalEntities = await db.query<{ code: string }>(
    `select code from vendor_legal_entity where vendor_id = $1 order by code`,
    [row.id]
  );
  const mergesInto = row.duplicate_of_vendor_id
    ? await db.query<{ code: string; legal_name: string }>(
        `select code, legal_name from vendor where id = $1`,
        [row.duplicate_of_vendor_id]
      )
    : [];

  // De-duplication candidates (§9.2): the same registration value is a *strong* signal —
  // two records cannot both hold one GSTIN — a matching normalised legal name is weak.
  const candidates = await db.query<{ code: string; legal_name: string; match: string; detail: string }>(
    `select distinct on (other.code) other.code, other.legal_name, m.match, m.detail
       from vendor other
       join lateral (
         select 'tax_registration' as match, tr.scheme_code || ' ' || tr.jurisdiction_code as detail
           from vendor_tax_registration mine
           join vendor_tax_registration tr on tr.vendor_id = other.id
          where mine.vendor_id = $1
            and upper(btrim(tr.value)) = upper(btrim(mine.value))
            and tr.scheme_code = mine.scheme_code
         union all
         select 'legal_name' as match, other.legal_name as detail
          where lower(btrim(other.legal_name)) = lower(btrim($2))
       ) m on true
      where other.chain_id = $3 and other.id <> $1
      order by other.code, m.match asc`,
    [row.id, row.legal_name, chainId]
  );

  const jurisdictions = await tradedJurisdictions(chainId);
  const rules = await vendorFieldRules(db, jurisdictions);
  const compliance: VendorComplianceCell[] = rules.map((rule) => {
    switch (rule.field) {
      case "address":
        return {
          ...rule,
          satisfied: Boolean(row.address_line1 && row.address_locality),
          checked: true,
        };
      case "billingCurrency":
        return { ...rule, satisfied: Boolean(row.billing_currency), checked: true };
      case "taxRegistrations":
        return {
          ...rule,
          satisfied: registrations.some((registration) => registration.status === "active"),
          checked: true,
        };
      default:
        // No predicate for the field in this build: reported as unchecked rather than
        // assumed satisfied (§17's rule, and the same one the article list follows).
        return { ...rule, satisfied: false, checked: false };
    }
  });

  const externalKeys = await db.query<{
    key_type: string;
    value: string;
    last_seen_at: Date | null;
  }>(
    `select key_type, value, last_seen_at
       from external_key
      where chain_id = $1 and entity_type = 'vendor' and entity_id = $2
      order by is_primary desc, key_type asc`,
    [chainId, row.id]
  );

  const system = await db.query<{
    code: string;
    display_name: string;
    vendor: string;
    status: string;
    last_run_at: Date | null;
  }>(
    `select code, display_name, vendor, status, last_run_at
       from erp_system where chain_id = $1 order by created_at asc limit 1`,
    [chainId]
  );

  const erpFields = buildVendorErpFields(row);
  const ownershipRows =
    system[0] === undefined
      ? []
      : await db.query<{
          field_group: string;
          field: string | null;
          owner: string;
          inbound_action: string;
          outbound_action: string;
          override_allowed: boolean;
          note_key: string | null;
        }>(
          `select field_group, field, owner, inbound_action, outbound_action,
                  override_allowed, note_key
             from erp_field_ownership
            where chain_id = $1 and entity = 'vendor'
            order by field_group asc`,
          [chainId]
        );

  const canReadAudit = principal.permissions.includes("chain.audit.read");
  const history = canReadAudit
    ? await db.query<{
        id: string;
        created_at: Date;
        action: string;
        display_name: string | null;
        actor_role_code: string | null;
        outcome: string;
        reason: string | null;
        before_state: unknown;
        after_state: unknown;
      }>(
        `select a.id, a.created_at, a.action, u.display_name, a.actor_role_code, a.outcome,
                a.reason, a.before_state, a.after_state
           from audit_log a
           left join "user" u on u.id = a.actor_user_id
          where a.entity_type = 'vendor' and a.entity_id = $1
          order by a.created_at desc
          limit 25`,
        [row.id]
      )
    : [];

  return {
    id: row.id,
    code: row.code,
    legalName: row.legal_name,
    status: row.status,
    vendorType: row.vendor_type,
    externalRef: row.external_ref,
    sourceSystem: row.source_system,
    deactivationReason: row.deactivation_reason,
    duplicateOfCode: mergesInto[0]?.code ?? null,
    tradeNames: tradeNames.map((entry) => ({ locale: entry.locale, name: entry.trade_name })),
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      locality: row.address_locality,
      region: row.address_region,
      postalCode: row.address_postal_code,
      countryCode: row.address_country_code,
    },
    contacts: contacts.map((contact) => ({ ...contact })),
    taxRegistrations: registrations.map((registration) => ({
      id: registration.id,
      jurisdictionCode: registration.jurisdiction_code,
      schemeCode: registration.scheme_code,
      schemeLabelKey: registration.label_key,
      value: registration.value,
      verified: registration.verified_at !== null,
      verifiedAt: registration.verified_at ? asIso(registration.verified_at) : null,
      verifiedByName: registration.verified_by_name,
      status: registration.status,
      // A scheme publishes its own pattern; a stored value that no longer matches is a
      // fact about the record, so it is shown rather than hidden.
      patternValid: registration.pattern
        ? new RegExp(registration.pattern).test(registration.value.trim())
        : true,
    })),
    taxSchemes: schemes.map((scheme) => ({
      code: scheme.scheme_code,
      jurisdictionCode: scheme.jurisdiction_code,
      labelKey: scheme.label_key,
      pattern: scheme.pattern,
    })),
    commercial: {
      billingCurrency: (row.billing_currency ?? "").trim(),
      paymentTermsKind: row.payment_terms_kind,
      paymentTermsDays: row.payment_terms_days,
      creditLimit:
        row.credit_limit_amount === null
          ? null
          : {
              amount: Number(row.credit_limit_amount),
              currencyCode: (row.credit_limit_currency ?? row.billing_currency ?? "").trim(),
            },
      leadTimeDays: row.lead_time_days,
      moqQty: asNumber(row.moq_qty),
      moqUomCode: row.moq_uom_code,
    },
    remittance: {
      method: row.remittance_method,
      bankName: row.remittance_bank_name,
      accountName: row.remittance_account_name,
      accountNumberMasked: row.remittance_account_masked,
      ifscOrSwiftMasked: row.remittance_ifsc_swift ? maskValue(row.remittance_ifsc_swift) : null,
      ibanMasked: row.remittance_iban ? maskValue(row.remittance_iban) : null,
      upiIdMasked: row.remittance_upi_id ? maskValue(row.remittance_upi_id) : null,
      fieldsPresent: [
        row.remittance_method ? "method" : null,
        row.remittance_bank_name ? "bankName" : null,
        row.remittance_account_name ? "accountName" : null,
        row.remittance_account_masked ? "accountNumber" : null,
        row.remittance_ifsc_swift ? "ifscOrSwift" : null,
        row.remittance_iban ? "iban" : null,
        row.remittance_upi_id ? "upiId" : null,
      ].filter((value): value is string => value !== null),
    },
    documents: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      reference: document.reference,
      issuedOn: asDate(document.issued_on),
      expiresOn: asDate(document.expires_on),
      daysToExpiry: asNumber(document.days_to_expiry),
    })),
    categories: categories.map((category) => ({ code: category.code, name: category.name })),
    legalEntities: legalEntities.map((entity) => entity.code),
    duplicateReview: {
      candidates: candidates.map((candidate) => ({
        code: candidate.code,
        legalName: candidate.legal_name,
        match: candidate.match,
        detail: candidate.detail,
      })),
      mergesInto: mergesInto[0] ? { code: mergesInto[0].code, legalName: mergesInto[0].legal_name } : null,
    },
    compliance,
    purchaseHistory: {
      available: false,
      note: "vendor.purchaseHistory.note",
    },
    provenance: externalKeys.map((key) => ({
      externalKeyKind: key.key_type,
      externalKeyValue: key.value,
      lastSyncAt: key.last_seen_at ? asIso(key.last_seen_at) : null,
    })),
    erp: {
      system: system[0]
        ? {
            code: system[0].code,
            displayName: system[0].display_name,
            vendor: system[0].vendor,
            status: system[0].status,
            lastSyncAt: system[0].last_run_at ? asIso(system[0].last_run_at) : null,
          }
        : null,
      fields: erpFields,
      ownership: ownershipRows.map((ownership) => ({
        fieldGroup: ownership.field_group,
        field: ownership.field,
        owner: ownership.owner,
        inboundAction: ownership.inbound_action,
        outboundAction: ownership.outbound_action,
        overrideAllowed: ownership.override_allowed,
        noteKey: ownership.note_key,
      })),
    },
    versioning: { versioned: false, note: "vendor.versioning.note" },
    history: {
      entries: history.map((entry) => ({
        id: entry.id,
        at: asIso(entry.created_at),
        action: entry.action,
        actorName: entry.display_name,
        actorRoleCode: entry.actor_role_code,
        outcome: entry.outcome,
        reason: entry.reason,
        before: toJsonState(entry.before_state),
        after: toJsonState(entry.after_state),
      })),
      denied: canReadAudit ? null : { permission: "chain.audit.read" },
    },
  };
}

/**
 * The ERP-held vendor fields (§20.3, §21.3) as read-only values. A group with no value does
 * not appear: an empty "Tax classification" panel the operator wonders about is the thing
 * §25.1 exists to prevent.
 */
type VendorErpRow = {
  external_ref: string | null;
  source_system: string | null;
  erp_account_group_code: string | null;
  erp_tax_classification: string | null;
  erp_withholding_tax_type: string | null;
  erp_withholding_tax_code: string | null;
  erp_tax_jurisdiction_code: string | null;
  erp_blocked: boolean;
  erp_deletion_flag: boolean;
  erp_blocked_reason: string | null;
  incoterms_code: string | null;
  incoterms_location: string | null;
  erp_source_version: string | null;
  erp_last_sync_at: Date | null;
  billing_currency: string | null;
  payment_terms_kind: string | null;
  credit_limit_amount: string | number | null;
  credit_limit_currency: string | null;
};

function buildVendorErpFields(row: VendorErpRow): ErpOwnedField[] {
  const fields: ErpOwnedField[] = [];
  const text = (
    value: unknown,
    group: string,
    field: string,
    kind: ErpOwnedField["kind"] = "text"
  ): void => {
    if (value === null || value === undefined || value === "") return;
    fields.push({
      group,
      field,
      kind,
      text: String(value),
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  };
  // identity — the ERP's own account identity for this vendor.
  text(row.erp_account_group_code, "identity", "erpAccountGroup", "code");
  text(row.external_ref, "identity", "externalRef", "code");
  text(row.source_system, "identity", "sourceSystem", "code");
  text(row.erp_source_version, "identity", "erpSourceVersion", "code");
  // tax — carried, never our verification state (§20.3).
  text(row.erp_tax_classification, "tax", "erpTaxClassification", "code");
  text(row.erp_withholding_tax_type, "tax", "erpWithholdingTaxType", "code");
  text(row.erp_withholding_tax_code, "tax", "erpWithholdingTaxCode", "code");
  text(row.erp_tax_jurisdiction_code, "tax", "erpTaxJurisdictionCode", "code");
  // commercial — the ERP is the master of the financial terms (§20.3).
  text(row.billing_currency?.trim(), "commercial", "billingCurrency", "code");
  text(row.payment_terms_kind, "commercial", "paymentTerms", "code");
  if (row.credit_limit_amount !== null) {
    fields.push({
      group: "commercial",
      field: "creditLimit",
      kind: "money",
      text: null,
      amount: Number(row.credit_limit_amount),
      currencyCode: (row.credit_limit_currency ?? row.billing_currency ?? "").trim(),
      uomCode: null,
    });
  }
  // trade — customs paperwork, jurisdiction-dependent (§21.3).
  text(row.incoterms_code, "trade", "incoterms", "code");
  text(row.incoterms_location, "trade", "incotermsLocation");
  // blocking — a block is not a suspension, so it is carried as its own fact.
  if (row.erp_blocked) {
    fields.push({
      group: "blocking",
      field: "erpBlocked",
      kind: "boolean",
      text: "true",
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }
  if (row.erp_deletion_flag) {
    fields.push({
      group: "blocking",
      field: "erpDeletionFlag",
      kind: "boolean",
      text: "true",
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }
  text(row.erp_blocked_reason, "blocking", "erpBlockedReason");
  return fields;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const VENDOR_PAYMENT_TERM_KINDS = ["net_days", "eom", "cod", "prepaid"] as const;
export type VendorPaymentTermKind = (typeof VENDOR_PAYMENT_TERM_KINDS)[number];

/**
 * Payment terms and credit limit — a financial change, so its own capability
 * (`mdm.vendor.terms.update`, §9.1) rather than the general vendor update.
 */
export async function updateVendorTerms(
  principal: Principal,
  input: {
    code: string;
    paymentTermsKind: string;
    paymentTermsDays?: number | null;
    creditLimitAmount?: number | null;
    creditLimitCurrency?: string | null;
  },
  meta: MutationMeta = {}
): Promise<{ code: string; before: JsonState; after: JsonState }> {
  const code = input.code?.trim();
  if (!code) throw new ValidationError("vendor code is required");
  const kind = (input.paymentTermsKind ?? "").trim();
  if (!(VENDOR_PAYMENT_TERM_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`paymentTermsKind must be one of ${VENDOR_PAYMENT_TERM_KINDS.join(", ")}`);
  }
  let days: number | null = null;
  if (kind === "net_days") {
    const parsed = Number(input.paymentTermsDays);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
      throw new ValidationError("net_days needs a whole number of days between 0 and 365");
    }
    days = parsed;
  }
  let creditLimit: number | null = null;
  if (input.creditLimitAmount !== null && input.creditLimitAmount !== undefined) {
    const parsed = Number(input.creditLimitAmount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ValidationError("credit limit must be a number of zero or more");
    }
    creditLimit = parsed;
  }
  const creditCurrency = (input.creditLimitCurrency ?? "").trim().toUpperCase() || null;
  if (creditCurrency !== null && !/^[A-Z]{3}$/.test(creditCurrency)) {
    throw new ValidationError("creditLimitCurrency must be a three-letter ISO 4217 code");
  }

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.vendor.terms.update",
    entityType: "vendor",
    chainId,
    target: `vendor ${code} terms`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "mdm.vendor.terms.update",
    entityType: "vendor",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const existing = await tx.query<{
        id: string;
        billing_currency: string | null;
        payment_terms_kind: string | null;
        payment_terms_days: number | null;
        credit_limit_amount: string | number | null;
        credit_limit_currency: string | null;
      }>(
        `select id, billing_currency, payment_terms_kind, payment_terms_days,
                credit_limit_amount, credit_limit_currency
           from vendor where chain_id = $1 and code = $2 for update`,
        [chainId, code]
      );
      const vendor = existing[0];
      if (!vendor) throw new NotFound("Vendor", code);

      // A credit limit is money, so it carries a currency. Defaulting it to the vendor's
      // own billing currency is the only honest default; storing a bare number would not.
      const resolvedCurrency =
        creditLimit === null ? null : (creditCurrency ?? ((vendor.billing_currency ?? "").trim() || null));
      if (creditLimit !== null && resolvedCurrency === null) {
        throw new ValidationError(
          "a credit limit needs a currency: set the vendor's billing currency or send creditLimitCurrency"
        );
      }

      const before = {
        paymentTermsKind: vendor.payment_terms_kind,
        paymentTermsDays: vendor.payment_terms_days,
        creditLimitAmount: vendor.credit_limit_amount === null ? null : Number(vendor.credit_limit_amount),
        creditLimitCurrency: vendor.credit_limit_currency,
      };
      const after = {
        paymentTermsKind: kind,
        paymentTermsDays: days,
        creditLimitAmount: creditLimit,
        creditLimitCurrency: resolvedCurrency,
      };

      await tx.query(
        `update vendor
            set payment_terms_kind = $3, payment_terms_days = $4,
                credit_limit_amount = $5, credit_limit_currency = $6,
                updated_at = now()
          where id = $1 and chain_id = $2`,
        [vendor.id, chainId, kind, days, creditLimit, resolvedCurrency]
      );

      return { entityId: vendor.id, before, after };
    },
  });

  return { code, before: toJsonState(outcome.before), after: toJsonState(outcome.after) };
}

/**
 * Adds a tax registration row for a jurisdiction (§9.1). It lands **unverified**: the
 * verification date and who verified it are ours, and an unverified registration is a real
 * state the record shows rather than a blank it fills in for the operator.
 */
export async function addVendorTaxRegistration(
  principal: Principal,
  input: { code: string; jurisdictionCode: string; schemeCode: string; value: string },
  meta: MutationMeta = {}
): Promise<{ code: string; jurisdictionCode: string; schemeCode: string; verified: boolean }> {
  const code = input.code?.trim();
  const jurisdictionCode = (input.jurisdictionCode ?? "").trim().toUpperCase();
  const schemeCode = (input.schemeCode ?? "").trim().toUpperCase();
  const value = (input.value ?? "").trim();
  if (!code) throw new ValidationError("vendor code is required");
  if (!jurisdictionCode) throw new ValidationError("jurisdictionCode is required");
  if (!schemeCode) throw new ValidationError("schemeCode is required");
  if (!value) throw new ValidationError("a registration value is required");

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.vendor.update",
    entityType: "vendor_tax_registration",
    chainId,
    target: `vendor ${code} registration`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const db = poolQueryable();
  const scheme = await db.query<{ pattern: string | null; label_key: string }>(
    `select pattern, label_key from tax_registration_scheme
      where jurisdiction_code = $1 and scheme_code = $2 and status = 'active'`,
    [jurisdictionCode, schemeCode]
  );
  if (!scheme[0]) {
    throw new ValidationError(
      `${schemeCode} is not an active registration scheme for ${jurisdictionCode}`
    );
  }
  if (scheme[0].pattern && !new RegExp(scheme[0].pattern).test(value)) {
    // The scheme's own pattern is the authority on what its number looks like; refusing here
    // is the difference between a validated registration and a typo nobody notices.
    throw new ValidationError(`${value} does not match the ${schemeCode} format`);
  }

  await auditedMutation({
    principal,
    action: "mdm.vendor.update",
    entityType: "vendor_tax_registration",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const vendor = await tx.query<{ id: string }>(
        `select id from vendor where chain_id = $1 and code = $2`,
        [chainId, code]
      );
      if (!vendor[0]) throw new NotFound("Vendor", code);
      const existing = await tx.query<{ id: string }>(
        `select id from vendor_tax_registration
          where vendor_id = $1 and jurisdiction_code = $2 and scheme_code = $3
            and upper(btrim(value)) = upper(btrim($4))`,
        [vendor[0].id, jurisdictionCode, schemeCode, value]
      );
      if (existing[0]) {
        throw new ValidationError(
          `${schemeCode} ${value} is already recorded for this vendor in ${jurisdictionCode}`
        );
      }
      const inserted = await tx.query<{ id: string }>(
        `insert into vendor_tax_registration
           (chain_id, vendor_id, jurisdiction_code, scheme_code, value)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [chainId, vendor[0].id, jurisdictionCode, schemeCode, value]
      );
      return {
        entityId: inserted[0]?.id ?? vendor[0].id,
        before: null,
        after: { jurisdictionCode, schemeCode, value, verifiedAt: null },
        reason: `registration added for ${jurisdictionCode}`,
      };
    },
  });
  return {
    code,
    jurisdictionCode,
    schemeCode,
    // A new row is unverified by construction: verification is a separate, dated act.
    verified: false,
  };
}

/** Verification is ours, not the ERP's: an ERP does not verify a certificate (§20.3). */
export async function verifyVendorTaxRegistration(
  principal: Principal,
  input: { code: string; registrationId: string },
  meta: MutationMeta = {}
): Promise<{ code: string; registrationId: string; verifiedAt: string }> {
  const code = input.code?.trim();
  const registrationId = (input.registrationId ?? "").trim();
  if (!code) throw new ValidationError("vendor code is required");
  if (!registrationId) throw new ValidationError("registrationId is required");
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.vendor.update",
    entityType: "vendor_tax_registration",
    chainId,
    target: `vendor ${code} registration ${registrationId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "mdm.vendor.update",
    entityType: "vendor_tax_registration",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{
        id: string;
        vendor_id: string;
        value: string;
        verified_at: Date | null;
        verified_by_user_id: string | null;
      }>(
        `select tr.id, tr.vendor_id, tr.value, tr.verified_at, tr.verified_by_user_id
           from vendor_tax_registration tr
           join vendor v on v.id = tr.vendor_id
          where tr.chain_id = $1 and v.code = $2 and tr.id = $3::uuid`,
        [chainId, code, registrationId]
      );
      const registration = rows[0];
      if (!registration) throw new NotFound("Vendor tax registration", registrationId);
      if (registration.verified_at) {
        throw new ValidationError("this registration is already verified");
      }
      await tx.query(
        `update vendor_tax_registration
            set verified_at = now(), verified_by_user_id = $2
          where id = $1`,
        [registration.id, principal.userId]
      );
      return {
        entityId: registration.id,
        before: { verifiedAt: null },
        after: { verifiedAt: new Date().toISOString() },
        reason: "registration verified",
      };
    },
  });
  const after = (outcome.after ?? {}) as { verifiedAt?: string };
  return { code, registrationId, verifiedAt: after.verifiedAt ?? "" };
}

/**
 * Suspend, reinstate or deactivate (§9.2 items 4 and 5). Each is a separate capability and
 * each writes its own action code, because "who suspended this vendor" and "who deactivated
 * it" are different questions six months later. A deactivation requires a reason, and a
 * redundant transition is refused rather than logged as if it happened.
 */
export async function setVendorStatus(
  principal: Principal,
  input: { code: string; status: "active" | "suspended" | "inactive"; reason?: string | null },
  meta: MutationMeta = {}
): Promise<{ code: string; before: string; after: string }> {
  const code = input.code?.trim();
  const status = (input.status ?? "").trim();
  if (!code) throw new ValidationError("vendor code is required");
  if (status !== "active" && status !== "suspended" && status !== "inactive") {
    throw new ValidationError("status must be active, suspended or inactive");
  }
  const reason = (input.reason ?? "").trim() || null;
  if (status !== "active" && reason === null) {
    throw new ValidationError("a reason is required when suspending or deactivating");
  }
  const action =
    status === "suspended"
      ? "mdm.vendor.suspend"
      : status === "inactive"
        ? "mdm.vendor.deactivate"
        : "mdm.vendor.reactivate";

  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action,
    entityType: "vendor",
    chainId,
    target: `vendor ${code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action,
    entityType: "vendor",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{ id: string; status: string }>(
        `select id, status from vendor where chain_id = $1 and code = $2 for update`,
        [chainId, code]
      );
      const vendor = rows[0];
      if (!vendor) throw new NotFound("Vendor", code);
      if (vendor.status === status) {
        throw new ValidationError(`this vendor is already ${status}`);
      }
      await tx.query(
        `update vendor
            set status = $3,
                deactivation_reason = case when $3 = 'inactive' then $4 else deactivation_reason end,
                updated_at = now()
          where id = $1 and chain_id = $2`,
        [vendor.id, chainId, status, reason]
      );
      return {
        entityId: vendor.id,
        before: { status: vendor.status },
        after: { status },
        // `undefined` rather than `null`: the audit row writes a NULL either way, and the
        // outcome contract spells "no reason given" as absent.
        reason: reason ?? undefined,
      };
    },
  });
  const before = (outcome.before ?? {}) as { status?: string };
  return { code, before: before.status ?? "", after: status };
}

/**
 * The one function that returns a bank value in full.
 *
 * It is a *read*, and it is still audited: `mdm.vendor.bank.view` is a separate capability
 * from `mdm.vendor.view` precisely because reading an account number is an event (§9.1,
 * §9.3). The audit row names which field was revealed, so "who looked at the IBAN" has an
 * answer.
 */
export async function revealVendorBank(
  principal: Principal,
  input: { code: string; field: "accountNumber" | "ifscOrSwift" | "iban" | "upiId" },
  meta: MutationMeta = {}
): Promise<{ code: string; field: string; value: string; audited: boolean }> {
  const code = input.code?.trim();
  const field = input.field;
  const ALLOWED = ["accountNumber", "ifscOrSwift", "iban", "upiId"] as const;
  if (!code) throw new ValidationError("vendor code is required");
  if (!(ALLOWED as readonly string[]).includes(field)) {
    throw new ValidationError(`field must be one of ${ALLOWED.join(", ")}`);
  }
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.vendor.bank.view",
    entityType: "vendor_remittance",
    chainId,
    target: `vendor ${code} ${field}`,
    source: meta.source,
    intent: meta.intent ?? "bank detail reveal",
  });

  const db = poolQueryable();
  const rows = await db.query<{
    id: string;
    account_name: string | null;
    account_masked: string | null;
    ifsc_swift: string | null;
    iban: string | null;
    upi_id: string | null;
  }>(
    `select id, remittance_account_name as account_name, remittance_account_masked as account_masked,
            remittance_ifsc_swift as ifsc_swift, remittance_iban as iban,
            remittance_upi_id as upi_id
       from vendor where chain_id = $1 and code = $2`,
    [chainId, code]
  );
  const vendor = rows[0];
  if (!vendor) throw new NotFound("Vendor", code);
  const value =
    field === "accountNumber"
      ? // The full account number is deliberately not stored: the column holds the masked
        // form, and this is the honest answer rather than a fabricated one.
        (vendor.account_masked ?? "")
      : field === "ifscOrSwift"
        ? (vendor.ifsc_swift ?? "")
        : field === "iban"
          ? (vendor.iban ?? "")
          : (vendor.upi_id ?? "");

  // `recordAudit` rather than `auditedMutation`: nothing about the record changes, so there
  // is no transaction to join — but the reveal is written to the trail either way.
  await recordAudit({
    principal,
    action: "mdm.vendor.bank.view",
    entityType: "vendor_remittance",
    entityId: vendor.id,
    chainId,
    outcome: "success",
    reason: `revealed ${field}`,
    intent: meta.intent ?? "bank detail reveal",
    source: meta.source ?? "screen",
  });

  return { code, field, value, audited: true };
}
