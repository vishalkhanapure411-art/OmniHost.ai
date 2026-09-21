import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { guard, toJsonState, type JsonState } from "~/server/audit";
import { NotFound, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import type { ErpOwnedField, ErpOwnershipRow, ErpSystemView, MutationMeta } from "~/domain/mdm";

/**
 * Phase 1 master data — the SITE and OUTLET master's domain API (§12, §20.6, §21.6).
 *
 * The hierarchy is the schema's: **chain → site → outlet**. The site is the master record
 * this slab builds screens for; the outlet is a child of the site and is shown as the site
 * record's *Outlets* pane, which is what §12.4 specifies ("a pane with inline add"). There is
 * no separate outlet record screen in this build, and nothing here pretends otherwise.
 *
 * Three rules from the spec that shaped the code:
 *
 *   1. **There is no licence tier on a site** (§12.1, and the locked owner decision that the
 *      tier is per chain). The chain's tier is *read* here and shown once per chain, in the
 *      section header. There is no tier column, no tier write, and no per-site gating — the
 *      PRD's "assigned license tier" on the site record is the deviation the lead asked to
 *      be flagged, and this module is where it is decided.
 *   2. **An outlet carries no jurisdiction and no currency** (§12.2). It belongs to a site,
 *      and a jurisdiction on an outlet would create a second source of truth for tax. The
 *      outlet rows therefore *report* their site's jurisdiction, currency, timezone and
 *      locale as inherited values, labelled as inherited — which is why `OutletView` has
 *      those fields under `inherited`, not at the top level.
 *   3. **Operating values are not master data.** Prep-time SLA, stock-out reset and the
 *      service-charge default are written through the delegated setting mechanism, which
 *      already exists (§12.3 item 3). This module *resolves* them for display — site row
 *      first, chain row second, the definition's own default last — and adds **no second
 *      write path**. The one write the site record does offer is the site's interface locale,
 *      and it goes through `updateSiteLocale` in `~/domain/appconfig`: the function that
 *      already exists, not a parallel route.
 */

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

function resolveChainId(principal: Principal, requested?: string | null): string {
  const chainId = requested?.trim() || principal.chainId;
  if (!chainId) throw new ValidationError("a chain context is required (chainId)");
  return chainId;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface OutletView {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  closureReason: string | null;
  serviceModes: string[];
  externalRef: string | null;
  sourceSystem: string | null;
  sections: { code: string; name: string; kind: string; sortOrder: number; status: string }[];
  /** Articles with an open price at this outlet: the master data that actually reaches it. */
  pricedArticleCount: number;
  pricedArticleCodes: string[];
  /**
   * Displays are not a master in this build: the KDS/CDS/KOT topology and per-product-line
   * routing is its own spec, scheduled after this slab. Stated as absent rather than shown
   * as an empty panel that implies zero displays exist.
   */
  displays: { available: boolean; note: string };
  /** Everything the outlet does not own. Reported so the pane cannot read as a second source. */
  inherited: {
    siteCode: string;
    siteName: string;
    jurisdictionCode: string | null;
    currency: string;
    timezone: string;
    locale: string | null;
  };
  operatingHours: {
    dayOfWeek: number;
    dayKey: string;
    opensAt: string | null;
    closesAt: string | null;
    closed: boolean;
    note: string | null;
  }[];
  lastChange: string;
}

export interface SiteListItem {
  id: string;
  chainId: string;
  chainCode: string;
  chainName: string;
  chainTier: string;
  code: string;
  name: string;
  jurisdictionCode: string | null;
  timezone: string;
  currency: string;
  /** Null = the site inherits its locale rather than setting one (§12.1). */
  locale: string | null;
  effectiveLocale: string;
  localeInherited: boolean;
  status: string;
  closureReason: string | null;
  serviceModes: string[];
  outletCount: number;
  outletKinds: { kind: string; count: number }[];
  pricedArticleCount: number;
  lastChange: string;
}

export interface SiteListResult {
  /** Grouped by chain: the tier appears once per section, never on a row (§12.4). */
  sections: {
    chainId: string;
    chainCode: string;
    chainName: string;
    chainTier: string;
    sites: SiteListItem[];
  }[];
  items: SiteListItem[];
  total: number;
  limit: number;
  hasMore: boolean;
  /** What the market's profile states for a site, so the screen never implies "complete". */
  requirements: { jurisdiction: string; field: string; requirement: string; legalRef: string | null }[];
  options: {
    statuses: { code: string; count: number }[];
    jurisdictions: { code: string; count: number }[];
    outletKinds: { code: string; count: number }[];
  };
}

export interface SiteListFilters {
  chainId?: string | null;
  query?: string | null;
  status?: string | null;
  jurisdiction?: string | null;
  limit?: number;
}

const MAX_LIMIT = 200;
const SITE_STATUS_ORDER = ["onboarding", "active", "suspended", "closed"];
const OUTLET_KIND_ORDER = [
  "restaurant",
  "bar",
  "qsr",
  "kiosk",
  "cloud_kitchen",
  "hotel_outlet",
  "banquet",
  "room_service",
  "kitchen",
];

export async function listSites(
  principal: Principal,
  filters: SiteListFilters = {}
): Promise<SiteListResult> {
  const chainId = resolveChainId(principal, filters.chainId);
  // The search capability is separate for vendors (§3's registry); for sites the spec defines
  // no `mdm.site.search`, so a query is the same read under the same capability.
  await guard({
    principal,
    action: "mdm.site.view",
    entityType: "site",
    chainId,
    target: `chain ${chainId}`,
  });

  const db = poolQueryable();
  const values: unknown[] = [chainId];
  const where: string[] = ["s.chain_id = $1"];
  const p = (value: unknown): string => {
    values.push(value);
    return "$" + String(values.length);
  };
  const text = filters.query?.trim() ?? "";
  if (text) {
    const code = p(`%${text}%`);
    const name = p(`%${text}%`);
    where.push(`(s.code ilike ${code} or s.name ilike ${name})`);
  }
  if (filters.status?.trim()) where.push(`s.status = ${p(filters.status.trim())}`);
  if (filters.jurisdiction?.trim()) {
    where.push(`coalesce(s.jurisdiction_code, s.tax_jurisdiction) = ${p(filters.jurisdiction.trim())}`);
  }
  const limit = Math.min(
    Math.max(Number.isFinite(filters.limit) ? Math.trunc(filters.limit as number) : MAX_LIMIT, 1),
    MAX_LIMIT
  );

  const rows = await db.query<{
    id: string;
    chain_id: string;
    chain_code: string;
    chain_name: string;
    licence_tier: string;
    code: string;
    name: string;
    jurisdiction_code: string | null;
    tax_jurisdiction: string | null;
    timezone: string;
    currency: string | null;
    locale: string | null;
    status: string;
    closure_reason: string | null;
    service_modes: string[] | null;
    updated_at: Date;
    outlet_count: string | number;
    priced_article_count: string | number;
  }>(
    `select s.id, s.chain_id, c.code as chain_code, c.name as chain_name, c.licence_tier,
            s.code, s.name, s.jurisdiction_code, s.tax_jurisdiction, s.timezone, s.currency,
            s.locale, s.status, s.closure_reason, s.service_modes, s.updated_at,
            (select count(*) from outlet o where o.site_id = s.id) as outlet_count,
            (select count(distinct ap.article_id)
               from outlet o
               join article_price ap on ap.outlet_id = o.id and ap.effective_to is null
              where o.site_id = s.id) as priced_article_count
       from site s
       join chain c on c.id = s.chain_id
      where ${where.join(" and ")}
      order by c.code asc, s.code asc
      limit ${p(limit)}`,
    values
  );

  const kinds = await db.query<{ site_id: string; kind: string; count: string }>(
    `select o.site_id, o.kind, count(*) as count
       from outlet o
      where o.chain_id = $1 and o.site_id = any($2::uuid[])
      group by 1, 2`,
    [chainId, rows.map((row) => row.id)]
  );
  const kindsBySite = new Map<string, { kind: string; count: number }[]>();
  for (const kind of kinds) {
    const list = kindsBySite.get(kind.site_id) ?? [];
    list.push({ kind: kind.kind, count: Number(kind.count) });
    kindsBySite.set(kind.site_id, list);
  }

  const preferredLocale = principal.locale ?? "en-IN";
  const items: SiteListItem[] = rows.map((row) => {
    const byKind = kindsBySite.get(row.id) ?? [];
    byKind.sort(
      (a, b) => OUTLET_KIND_ORDER.indexOf(a.kind) - OUTLET_KIND_ORDER.indexOf(b.kind)
    );
    return {
      id: row.id,
      chainId: row.chain_id,
      chainCode: row.chain_code,
      chainName: row.chain_name,
      chainTier: row.licence_tier,
      code: row.code,
      name: row.name,
      jurisdictionCode: row.jurisdiction_code ?? row.tax_jurisdiction,
      timezone: row.timezone,
      currency: (row.currency ?? "").trim(),
      locale: row.locale,
      effectiveLocale: row.locale ?? preferredLocale,
      localeInherited: row.locale === null,
      status: row.status,
      closureReason: row.closure_reason,
      serviceModes: row.service_modes ?? [],
      outletCount: Number(row.outlet_count),
      outletKinds: byKind,
      pricedArticleCount: Number(row.priced_article_count),
      lastChange: asIso(row.updated_at),
    };
  });

  const sections: SiteListResult["sections"] = [];
  for (const item of items) {
    const existing = sections.find((section) => section.chainId === item.chainId);
    if (existing) existing.sites.push(item);
    else
      sections.push({
        chainId: item.chainId,
        chainCode: item.chainCode,
        chainName: item.chainName,
        chainTier: item.chainTier,
        sites: [item],
      });
  }

  const total = await db.query<{ total: string }>(
    `select count(*) as total from site s join chain c on c.id = s.chain_id where ${where.join(" and ")}`,
    values.slice(0, values.length - 1)
  );

  return {
    sections,
    items,
    total: Number(total[0]?.total ?? 0),
    limit,
    hasMore: items.length < Number(total[0]?.total ?? 0),
    requirements: await siteFieldRules(db, [
      ...new Set(items.map((item) => item.jurisdictionCode).filter((code): code is string => code !== null)),
    ]),
    options: await getSiteListOptions(chainId, db),
  };
}

async function siteFieldRules(
  tx: Queryable,
  jurisdictions: string[]
): Promise<{ jurisdiction: string; field: string; requirement: string; legalRef: string | null }[]> {
  const rules: { jurisdiction: string; field: string; requirement: string; legalRef: string | null }[] = [];
  for (const jurisdiction of jurisdictions) {
    const rows = await tx.query<{ field: string; requirement: string; legal_ref: string | null }>(
      `select distinct on (field) field, requirement, legal_ref
         from jurisdiction_field_rule
        where jurisdiction_code = $1 and entity = 'site' and effective_from <= current_date
        order by field, effective_from desc`,
      [jurisdiction]
    );
    for (const row of rows) {
      rules.push({ jurisdiction, field: row.field, requirement: row.requirement, legalRef: row.legal_ref });
    }
  }
  return rules;
}

async function getSiteListOptions(
  chainId: string,
  db: Queryable
): Promise<SiteListResult["options"]> {
  const statuses = await db.query<{ code: string; count: string }>(
    `select status as code, count(*) as count from site where chain_id = $1 group by 1`,
    [chainId]
  );
  const jurisdictions = await db.query<{ code: string; count: string }>(
    `select coalesce(jurisdiction_code, tax_jurisdiction) as code, count(*) as count
       from site where chain_id = $1 and coalesce(jurisdiction_code, tax_jurisdiction) is not null
      group by 1`,
    [chainId]
  );
  const kinds = await db.query<{ code: string; count: string }>(
    `select kind as code, count(*) as count from outlet where chain_id = $1 group by 1`,
    [chainId]
  );
  const ordered = (rows: { code: string; count: string }[], order: string[]) => {
    const counts = new Map(rows.map((row) => [row.code, Number(row.count)]));
    const seen = new Set<string>();
    const result = order.map((code) => {
      seen.add(code);
      return { code, count: counts.get(code) ?? 0 };
    });
    for (const row of rows) if (!seen.has(row.code)) result.push({ code: row.code, count: Number(row.count) });
    return result;
  };
  return {
    statuses: ordered(statuses, SITE_STATUS_ORDER),
    jurisdictions: jurisdictions.map((row) => ({ code: row.code, count: Number(row.count) })),
    outletKinds: ordered(kinds, OUTLET_KIND_ORDER),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface SiteComplianceCell {
  jurisdiction: string;
  field: string;
  requirement: string;
  satisfied: boolean;
  checked: boolean;
  legalRef: string | null;
}

export interface SiteDetail {
  id: string;
  code: string;
  name: string;
  status: string;
  closureReason: string | null;
  jurisdictionCode: string | null;
  timezone: string;
  currency: string;
  locale: string | null;
  effectiveLocale: string;
  localeInherited: boolean;
  serviceModes: string[];
  externalRef: string | null;
  sourceSystem: string | null;
  /** Read-only, derived from the chain — never writable here (§12.1). */
  chain: { id: string; code: string; name: string; licenceTier: string; status: string };
  address: {
    line1: string | null;
    line2: string | null;
    locality: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
  };
  /**
   * The raw `address` jsonb, unflattened, as JSON text. Not an object type for the same
   * reason as `JsonState`: a nested untyped value inside a returned interface fails
   * TanStack Start's serialisability check. Nothing reads it yet — it is here so the
   * unprojected keys are not silently lost.
   */
  addressRaw: JsonState;
  outlets: OutletView[];
  operatingHours: {
    dayOfWeek: number;
    dayKey: string;
    opensAt: string | null;
    closesAt: string | null;
    closed: boolean;
    note: string | null;
    scope: "site" | "outlet";
    outletCode: string | null;
  }[];
  /** Resolved through the existing delegated setting mechanism; read-only here. */
  configuration: {
    key: string;
    labelKey: string;
    helpKey: string | null;
    valueType: string;
    unit: string | null;
    min: number | null;
    max: number | null;
    /** Where the value in force comes from: this site, the chain, or the definition. */
    source: "site" | "chain" | "definition";
    value: string | null;
  }[];
  compliance: SiteComplianceCell[];
  /** The market's article requirements — the profile, with the per-article verdict elsewhere. */
  articleRequirements: { field: string; requirement: string; legalRef: string | null }[];
  /** §21.6: the site↔plant map, many-to-many, and which one is primary. */
  erpOrgUnits: {
    id: string;
    systemCode: string;
    orgUnitType: string;
    erpCode: string;
    isPrimary: boolean;
    outletCode: string | null;
  }[];
  erpCompanyCode: string | null;
  erpTaxJurisdictionCode: string | null;
  provenance: { externalKeyKind: string; externalKeyValue: string; lastSyncAt: string | null }[];
  erp: { system: ErpSystemView | null; fields: ErpOwnedField[]; ownership: ErpOwnershipRow[] };
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
    denied: { permission: string } | null;
  };
}

export async function getSite(principal: Principal, code: string): Promise<SiteDetail> {
  const siteCode = code?.trim();
  if (!siteCode) throw new ValidationError("site code is required");
  const chainId = resolveChainId(principal, null);
  await guard({
    principal,
    action: "mdm.site.view",
    entityType: "site",
    chainId,
    target: `site ${siteCode}`,
  });

  const db = poolQueryable();
  const rows = await db.query<{
    id: string;
    chain_id: string;
    chain_code: string;
    chain_name: string;
    licence_tier: string;
    chain_status: string;
    code: string;
    name: string;
    jurisdiction_code: string | null;
    tax_jurisdiction: string | null;
    timezone: string;
    currency: string | null;
    locale: string | null;
    status: string;
    closure_reason: string | null;
    service_modes: string[] | null;
    external_ref: string | null;
    source_system: string | null;
    address: Record<string, unknown> | null;
    erp_company_code: string | null;
    erp_tax_jurisdiction_code: string | null;
    erp_source_version: string | null;
    erp_last_sync_at: Date | null;
    updated_at: Date;
  }>(
    `select s.id, s.chain_id, c.code as chain_code, c.name as chain_name,
            c.licence_tier, c.status as chain_status,
            s.code, s.name, s.jurisdiction_code, s.tax_jurisdiction, s.timezone, s.currency,
            s.locale, s.status, s.closure_reason, s.service_modes, s.external_ref, s.source_system,
            s.address, s.erp_company_code, s.erp_tax_jurisdiction_code, s.erp_source_version,
            s.erp_last_sync_at, s.updated_at
       from site s
       join chain c on c.id = s.chain_id
      where s.chain_id = $1 and s.code = $2`,
    [chainId, siteCode]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Site", siteCode);

  const outletRows = await db.query<{
    id: string;
    code: string;
    name: string;
    kind: string;
    status: string;
    closure_reason: string | null;
    service_modes: string[] | null;
    external_ref: string | null;
    source_system: string | null;
    updated_at: Date;
    priced_article_count: string | number;
  }>(
    `select o.id, o.code, o.name, o.kind, o.status, o.closure_reason, o.service_modes,
            o.external_ref, o.source_system, o.updated_at,
            (select count(distinct ap.article_id) from article_price ap
              where ap.outlet_id = o.id and ap.effective_to is null) as priced_article_count
       from outlet o
      where o.site_id = $1
      order by o.code asc`,
    [row.id]
  );
  const sections = await db.query<{
    outlet_id: string;
    code: string;
    name: string;
    kind: string;
    sort_order: number;
    status: string;
  }>(
    `select outlet_id, code, name, kind, sort_order, status
       from outlet_section where site_id = $1 order by outlet_id, sort_order asc, code asc`,
    [row.id]
  );
  const pricedCodes = await db.query<{ outlet_id: string; code: string }>(
    `select distinct ap.outlet_id, a.code
       from article_price ap
       join article a on a.id = ap.article_id
      where ap.outlet_id = any($1::uuid[]) and ap.effective_to is null
      order by ap.outlet_id, a.code asc`,
    [outletRows.map((outlet) => outlet.id)]
  );
  const hours = await db.query<{
    outlet_id: string | null;
    day_of_week: number;
    opens_at: string | null;
    closes_at: string | null;
    closed: boolean;
    note: string | null;
  }>(
    `select outlet_id, day_of_week, to_char(opens_at, 'HH24:MI') as opens_at,
            to_char(closes_at, 'HH24:MI') as closes_at, closed, note
       from site_operating_hours
      where site_id = $1
      order by outlet_id nulls first, day_of_week asc`,
    [row.id]
  );

  const outletCodeById = new Map(outletRows.map((outlet) => [outlet.id, outlet.code]));
  const jurisdictionCode = row.jurisdiction_code ?? row.tax_jurisdiction;
  const currency = (row.currency ?? "").trim();
  const preferredLocale = principal.locale ?? "en-IN";

  const outlets: OutletView[] = outletRows.map((outlet) => ({
    id: outlet.id,
    code: outlet.code,
    name: outlet.name,
    kind: outlet.kind,
    status: outlet.status,
    closureReason: outlet.closure_reason,
    serviceModes: outlet.service_modes ?? [],
    externalRef: outlet.external_ref,
    sourceSystem: outlet.source_system,
    sections: sections
      .filter((section) => section.outlet_id === outlet.id)
      .map((section) => ({
        code: section.code,
        name: section.name,
        kind: section.kind,
        sortOrder: section.sort_order,
        status: section.status,
      })),
    pricedArticleCount: Number(outlet.priced_article_count),
    pricedArticleCodes: pricedCodes
      .filter((price) => price.outlet_id === outlet.id)
      .map((price) => price.code),
    displays: { available: false, note: "mdm.outlet.displays.note" },
    inherited: {
      siteCode: row.code,
      siteName: row.name,
      jurisdictionCode,
      currency,
      timezone: row.timezone,
      locale: row.locale,
    },
    operatingHours: hours
      .filter((entry) => entry.outlet_id === outlet.id)
      .map((entry) => ({
        dayOfWeek: entry.day_of_week,
        dayKey: DAY_NAMES[entry.day_of_week] ?? String(entry.day_of_week),
        opensAt: entry.opens_at,
        closesAt: entry.closes_at,
        closed: entry.closed,
        note: entry.note,
      })),
    lastChange: asIso(outlet.updated_at),
  }));

  const definitions = await db.query<{
    key: string;
    label_key: string;
    help_key: string | null;
    value_type: string;
    unit: string | null;
    min_value: string | number | null;
    max_value: string | number | null;
    default_value: unknown;
  }>(
    `select key, label_key, help_key, value_type, unit, min_value, max_value, default_value
       from setting_definition where scope = 'site' order by sort_order asc, key asc`
  );
  const settings = await db.query<{ setting_key: string; site_id: string | null; value: unknown }>(
    `select setting_key, site_id, value from chain_setting
      where chain_id = $1 and setting_key = any($2::text[])`,
    [chainId, definitions.map((definition) => definition.key)]
  );
  const configuration: SiteDetail["configuration"] = definitions.map((definition) => {
    const siteValue = settings.find(
      (setting) => setting.setting_key === definition.key && setting.site_id === row.id
    );
    const chainValue = settings.find(
      (setting) => setting.setting_key === definition.key && setting.site_id === null
    );
    const raw =
      siteValue?.value ?? chainValue?.value ?? (definition.default_value as unknown) ?? null;
    return {
      key: definition.key,
      labelKey: definition.label_key,
      helpKey: definition.help_key,
      valueType: definition.value_type,
      unit: definition.unit,
      min: definition.min_value === null ? null : Number(definition.min_value),
      max: definition.max_value === null ? null : Number(definition.max_value),
      source: siteValue ? "site" : chainValue ? "chain" : "definition",
      value: raw === null || raw === undefined ? null : String(raw).replace(/^"|"$/g, ""),
    };
  });

  const rules = await siteFieldRules(db, jurisdictionCode ? [jurisdictionCode] : []);
  const address = row.address ?? {};
  const addressValue = (key: string): string | null => {
    const raw = address[key];
    return raw === null || raw === undefined || raw === "" ? null : String(raw);
  };
  const compliance: SiteComplianceCell[] = rules.map((rule) => {
    switch (rule.field) {
      case "address":
        return {
          ...rule,
          satisfied: Boolean(addressValue("line1") && addressValue("locality")),
          checked: true,
        };
      case "currency":
        return { ...rule, satisfied: currency !== "", checked: true };
      case "jurisdiction":
        return { ...rule, satisfied: Boolean(jurisdictionCode), checked: true };
      default:
        return { ...rule, satisfied: false, checked: false };
    }
  });

  const articleRules = jurisdictionCode
    ? await db.query<{ field: string; requirement: string; legal_ref: string | null }>(
        `select distinct on (field) field, requirement, legal_ref
           from jurisdiction_field_rule
          where jurisdiction_code = $1 and entity = 'article' and effective_from <= current_date
          order by field, effective_from desc`,
        [jurisdictionCode]
      )
    : [];

  const orgUnits = await db.query<{
    id: string;
    org_unit_type: string;
    erp_code: string;
    is_primary: boolean;
    system_code: string;
    outlet_id: string | null;
  }>(
    `select u.id, u.org_unit_type, u.erp_code, u.is_primary, sys.code as system_code, u.outlet_id
       from site_erp_org_unit u
       join erp_system sys on sys.id = u.system_id
      where u.site_id = $1
      order by u.org_unit_type asc, u.erp_code asc`,
    [row.id]
  );

  const externalKeys = await db.query<{ key_type: string; value: string; last_seen_at: Date | null }>(
    `select key_type, value, last_seen_at from external_key
      where chain_id = $1 and entity_type = 'site' and entity_id = $2
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
    `select code, display_name, vendor, status, last_run_at from erp_system
      where chain_id = $1 order by created_at asc limit 1`,
    [chainId]
  );
  const ownership = system[0]
    ? await db.query<{
        field_group: string;
        field: string | null;
        owner: string;
        inbound_action: string;
        outbound_action: string;
        override_allowed: boolean;
        note_key: string | null;
      }>(
        `select field_group, field, owner, inbound_action, outbound_action, override_allowed, note_key
           from erp_field_ownership where chain_id = $1 and entity = 'site' order by field_group asc`,
        [chainId]
      )
    : [];
  const erpFields: ErpOwnedField[] = [];
  if (row.erp_company_code) {
    erpFields.push({
      group: "org",
      field: "erpCompanyCode",
      kind: "code",
      text: row.erp_company_code,
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }
  if (row.erp_tax_jurisdiction_code) {
    erpFields.push({
      group: "org",
      field: "erpTaxJurisdictionCode",
      kind: "code",
      text: row.erp_tax_jurisdiction_code,
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }
  for (const unit of orgUnits) {
    erpFields.push({
      group: "org",
      field: `erpOrgUnit.${unit.org_unit_type}`,
      kind: "code",
      text: unit.erp_code,
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }
  if (row.erp_source_version) {
    erpFields.push({
      group: "admin",
      field: "erpSourceVersion",
      kind: "code",
      text: row.erp_source_version,
      amount: null,
      currencyCode: null,
      uomCode: null,
    });
  }

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
          where a.entity_type = 'site' and a.entity_id = $1
          order by a.created_at desc limit 25`,
        [row.id]
      )
    : [];

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    closureReason: row.closure_reason,
    jurisdictionCode,
    timezone: row.timezone,
    currency,
    locale: row.locale,
    effectiveLocale: row.locale ?? preferredLocale,
    localeInherited: row.locale === null,
    serviceModes: row.service_modes ?? [],
    externalRef: row.external_ref,
    sourceSystem: row.source_system,
    chain: {
      id: row.chain_id,
      code: row.chain_code,
      name: row.chain_name,
      licenceTier: row.licence_tier,
      status: row.chain_status,
    },
    address: {
      line1: addressValue("line1"),
      line2: addressValue("line2"),
      locality: addressValue("locality"),
      region: addressValue("region"),
      postalCode: addressValue("postalCode") ?? addressValue("postal_code"),
      countryCode: addressValue("countryCode") ?? addressValue("country_code"),
    },
    addressRaw: toJsonState(address),
    outlets,
    operatingHours: hours.map((entry) => ({
      dayOfWeek: entry.day_of_week,
      dayKey: DAY_NAMES[entry.day_of_week] ?? String(entry.day_of_week),
      opensAt: entry.opens_at,
      closesAt: entry.closes_at,
      closed: entry.closed,
      note: entry.note,
      scope: entry.outlet_id === null ? "site" : "outlet",
      outletCode: entry.outlet_id === null ? null : (outletCodeById.get(entry.outlet_id) ?? null),
    })),
    configuration,
    compliance,
    articleRequirements: articleRules.map((rule) => ({
      field: rule.field,
      requirement: rule.requirement,
      legalRef: rule.legal_ref,
    })),
    erpOrgUnits: orgUnits.map((unit) => ({
      id: unit.id,
      systemCode: unit.system_code,
      orgUnitType: unit.org_unit_type,
      erpCode: unit.erp_code,
      isPrimary: unit.is_primary,
      outletCode: unit.outlet_id === null ? null : (outletCodeById.get(unit.outlet_id) ?? null),
    })),
    erpCompanyCode: row.erp_company_code,
    erpTaxJurisdictionCode: row.erp_tax_jurisdiction_code,
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
      ownership: ownership.map((entry) => ({
        fieldGroup: entry.field_group,
        field: entry.field,
        owner: entry.owner,
        inboundAction: entry.inbound_action,
        outboundAction: entry.outbound_action,
        overrideAllowed: entry.override_allowed,
        noteKey: entry.note_key,
      })),
    },
    versioning: { versioned: false, note: "mdm.site.versioning.note" },
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
 * Nothing in this module writes a site or an outlet, and that is deliberate.
 *
 * §12.3 defines a site-creation wizard, `mdm.outlet.create` / `mdm.outlet.propose` and
 * `mdm.site.deactivate`; the lead scoped this slab to the screens and the reads behind them,
 * and the outlet master is read-mostly for Phase 1. So rather than half-building a create
 * wizard with no maker-checker behind it, the record screen states which capability each
 * action would need and where it will live. The one write the site record offers is the
 * locale hop, and it calls the function that already exists (`updateSiteLocale`).
 */
export const SITE_WRITE_PATH_NOTE = "mdm.site.writePath.note" as const;

/** Kept for the screens' type imports; no site mutation is exported in this slab. */
export type SiteMutationMeta = MutationMeta;
