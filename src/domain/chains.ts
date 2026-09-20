import "@tanstack/react-start/server-only";

import { sql, type Queryable } from "~/db";
import { auditedMutation, guard } from "~/server/audit";
import { NotFound, ValidationError } from "~/server/errors";
import { accessibleChainIds, type Principal } from "~/server/session";

/**
 * AppAdmin's chain lifecycle — the Phase 0a vertical slice.
 *
 * Every exported function follows the same shape, in this order:
 *   1. `guard(...)` — the server-side permission check, plus an audit row when the
 *      check refuses (a denied attempt is itself worth recording),
 *   2. an `auditedMutation(...)` for writes, so the row and its audit entry are one
 *      transaction and there is no window where a change exists unlogged.
 *
 * Nothing here trusts a `chainId`, `tier` or `role` that arrived from the browser:
 * the chain is re-read (and locked) inside the transaction, and the tier is validated
 * against the registry rather than assumed to be one of three strings.
 */

export const LICENCE_TIERS = ["silver", "gold", "platinum"] as const;
export type LicenceTier = (typeof LICENCE_TIERS)[number];

/** Spec "Licensing Tiers": each tier is a superset of the one below it. */
export const TIER_RANK: Record<LicenceTier, number> = { silver: 1, gold: 2, platinum: 3 };

export interface ChainSummary {
  id: string;
  name: string;
  code: string;
  licenceTier: LicenceTier;
  status: string;
  taxJurisdiction: string | null;
  onboardedAt: string;
  siteCount: number;
  featureCount: number;
  enabledFeatureCount: number;
}

export interface ChainFeatureState {
  code: string;
  name: string;
  module: string;
  description: string | null;
  minTier: LicenceTier;
  toggleable: boolean;
  enabled: boolean;
  /** True when the chain's current tier is below the tier the feature needs. */
  blockedByTier: boolean;
  updatedAt: string | null;
}

export interface ChainDetail extends ChainSummary {
  createdAt: string;
  updatedAt: string;
  sites: {
    id: string;
    name: string;
    code: string;
    status: string;
    timezone: string;
    outlets: { id: string; name: string; code: string; kind: string; status: string }[];
  }[];
  features: ChainFeatureState[];
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

export function asTier(value: string): LicenceTier {
  return (LICENCE_TIERS as readonly string[]).includes(value) ? (value as LicenceTier) : "silver";
}

function validateTier(value: unknown): LicenceTier {
  if (typeof value !== "string" || !(LICENCE_TIERS as readonly string[]).includes(value)) {
    throw new ValidationError(`licenceTier must be one of ${LICENCE_TIERS.join(", ")}`);
  }
  return value as LicenceTier;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

// Query columns are written out at each call site rather than composed from a shared
// string, so every statement is greppable and every bind parameter is explicit.

interface ChainRow {
  id: string;
  name: string;
  code: string;
  licence_tier: string;
  status: string;
  tax_jurisdiction: string | null;
  onboarded_at: Date;
  created_at: Date;
  updated_at: Date;
  site_count: string | number;
  feature_count: string | number;
  enabled_feature_count: string | number;
}

function toSummary(row: ChainRow): ChainSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    licenceTier: asTier(row.licence_tier),
    status: row.status,
    taxJurisdiction: row.tax_jurisdiction,
    onboardedAt: asIso(row.onboarded_at),
    siteCount: Number(row.site_count),
    featureCount: Number(row.feature_count),
    enabledFeatureCount: Number(row.enabled_feature_count),
  };
}

/**
 * Lists the chains this caller may reach. The filter comes from the caller's resolved
 * scope, never from a client-supplied parameter — an AppSupport operator holding one
 * time-boxed grant sees that chain and nothing else.
 */
export async function listChains(principal: Principal): Promise<ChainSummary[]> {
  await guard({ principal, action: "chain.list", entityType: "chain" });
  const allowed = accessibleChainIds(principal);
  const rows = await sql()<ChainRow>`
    select c.id, c.name, c.code, c.licence_tier, c.status, c.tax_jurisdiction,
           c.onboarded_at, c.created_at, c.updated_at,
           (select count(*) from site s where s.chain_id = c.id) as site_count,
           (select count(*) from chain_feature cf where cf.chain_id = c.id) as feature_count,
           (select count(*) from chain_feature cf where cf.chain_id = c.id and cf.enabled) as enabled_feature_count
      from chain c
     where (${allowed}::uuid[] is null or c.id = any(${allowed}::uuid[]))
     order by c.onboarded_at desc, c.name asc
  `;
  return rows.map(toSummary);
}

export async function getChain(principal: Principal, chainId: string): Promise<ChainDetail> {
  if (!chainId) throw new ValidationError("chainId is required");
  await guard({
    principal,
    action: "chain.read",
    entityType: "chain",
    chainId,
    target: `chain ${chainId}`,
  });

  const [chain] = await sql()<ChainRow>`
    select c.id, c.name, c.code, c.licence_tier, c.status, c.tax_jurisdiction,
           c.onboarded_at, c.created_at, c.updated_at,
           (select count(*) from site s where s.chain_id = c.id) as site_count,
           (select count(*) from chain_feature cf where cf.chain_id = c.id) as feature_count,
           (select count(*) from chain_feature cf where cf.chain_id = c.id and cf.enabled) as enabled_feature_count
      from chain c
     where c.id = ${chainId}
     limit 1
  `;
  if (!chain) throw new NotFound("Chain", chainId);

  const siteRows = await sql()<{
    id: string;
    name: string;
    code: string;
    status: string;
    timezone: string;
    outlet_id: string | null;
    outlet_name: string | null;
    outlet_code: string | null;
    outlet_kind: string | null;
    outlet_status: string | null;
  }>`
    select s.id, s.name, s.code, s.status, s.timezone,
           o.id as outlet_id, o.name as outlet_name, o.code as outlet_code,
           o.kind as outlet_kind, o.status as outlet_status
      from site s
      left join outlet o on o.site_id = s.id
     where s.chain_id = ${chainId}
     order by s.name asc, o.name asc
  `;

  const sites = new Map<string, ChainDetail["sites"][number]>();
  for (const row of siteRows) {
    let site = sites.get(row.id);
    if (!site) {
      site = { id: row.id, name: row.name, code: row.code, status: row.status, timezone: row.timezone, outlets: [] };
      sites.set(row.id, site);
    }
    if (row.outlet_id) {
      site.outlets.push({
        id: row.outlet_id,
        name: row.outlet_name ?? "",
        code: row.outlet_code ?? "",
        kind: row.outlet_kind ?? "",
        status: row.outlet_status ?? "",
      });
    }
  }

  const features = await sql()<{
    code: string;
    name: string;
    module: string;
    description: string | null;
    min_tier: string;
    toggleable: boolean;
    enabled: boolean | null;
    updated_at: Date | null;
  }>`
    select f.code, f.name, f.module, f.description, f.min_tier, f.toggleable, cf.enabled, cf.updated_at
      from feature f
      left join chain_feature cf on cf.chain_id = ${chainId} and cf.feature_code = f.code
     order by f.module asc, f.name asc
  `;

  const tier = asTier(chain.licence_tier);

  return {
    ...toSummary(chain),
    createdAt: asIso(chain.created_at),
    updatedAt: asIso(chain.updated_at),
    sites: [...sites.values()],
    features: features.map((row) => {
      const minTier = asTier(row.min_tier);
      return {
        code: row.code,
        name: row.name,
        module: row.module,
        description: row.description,
        minTier,
        toggleable: row.toggleable,
        enabled: row.enabled ?? false,
        blockedByTier: TIER_RANK[minTier] > TIER_RANK[tier],
        updatedAt: row.updated_at ? asIso(row.updated_at) : null,
      };
    }),
  };
}

export interface OnboardChainInput {
  name: string;
  code?: string | null;
  licenceTier: LicenceTier;
  taxJurisdiction?: string | null;
  /** Optional initial overrides; anything omitted keeps its registry default. */
  features?: { code: string; enabled: boolean }[];
}

export interface MutationMeta {
  source?: "screen" | "chatbot" | "api";
  intent?: string | null;
}

/**
 * Onboards a chain: creates the tenant, its licence tier and its feature toggles.
 * Spec example intent: "Onboard chain X on Platinum".
 */
export async function onboardChain(
  principal: Principal,
  input: OnboardChainInput,
  meta: MutationMeta = {}
): Promise<{ id: string; code: string; name: string; licenceTier: LicenceTier }> {
  await guard({
    principal,
    action: "chain.onboard",
    entityType: "chain",
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const name = input.name?.trim();
  if (!name) throw new ValidationError("name is required");
  const tier = validateTier(input.licenceTier);
  const code = slug(input.code?.trim() || name);
  if (!code) throw new ValidationError("code is required (or derivable from name)");

  const overrides = new Map((input.features ?? []).map((f) => [f.code, f.enabled]));

  let outcome;
  try {
    outcome = await auditedMutation({
      principal,
      action: "chain.onboard",
      entityType: "chain",
      source: meta.source ?? "api",
      intent: meta.intent ?? null,
      run: async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `insert into chain (name, code, licence_tier, tax_jurisdiction)
           values ($1, $2, $3, $4) returning id`,
          [name, code, tier, input.taxJurisdiction ?? null]
        );
        const chainId = inserted[0]?.id;
        if (!chainId) throw new Error("chain insert returned no row");

        // Every registry feature gets a row, so the chain screen shows the whole
        // picture instead of a silently missing toggle. Operational features
        // (toggleable = false) arrive switched on.
        const registry = await tx.query<{ code: string; min_tier: string; toggleable: boolean }>(
          `select code, min_tier, toggleable from feature order by code`
        );
        const codes: string[] = [];
        const values: boolean[] = [];
        for (const feature of registry) {
          const requested = overrides.get(feature.code);
          if (requested !== undefined) {
            if (!feature.toggleable) {
              throw new ValidationError(`${feature.code} is not a toggleable feature`);
            }
            if (requested && TIER_RANK[asTier(feature.min_tier)] > TIER_RANK[tier]) {
              throw new ValidationError(
                `${feature.code} needs the ${feature.min_tier} tier; ${tier} was requested`
              );
            }
          }
          codes.push(feature.code);
          values.push(requested ?? !feature.toggleable);
        }
        await tx.query(
          `insert into chain_feature (chain_id, feature_code, enabled, updated_by_user_id)
           select $1, t.code, t.enabled, $4
             from unnest($2::text[], $3::boolean[]) as t(code, enabled)`,
          [chainId, codes, values, principal.userId]
        );

        return {
          entityId: chainId,
          before: null,
          after: {
            name,
            code,
            licenceTier: tier,
            taxJurisdiction: input.taxJurisdiction ?? null,
            features: Object.fromEntries(codes.map((c, i) => [c, values[i]])),
          },
        };
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError(`chain code "${code}" is already taken`);
    throw error;
  }

  return { id: outcome.entityId ?? "", code, name, licenceTier: tier };
}

/** Changes a chain's licence tier. Tier is per chain, never per site. */
export async function updateChainTier(
  principal: Principal,
  chainId: string,
  licenceTier: LicenceTier,
  meta: MutationMeta = {}
): Promise<{ before: LicenceTier; after: LicenceTier }> {
  const tier = validateTier(licenceTier);
  await guard({
    principal,
    action: "chain.tier.update",
    entityType: "chain",
    chainId,
    target: `chain ${chainId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "chain.tier.update",
    entityType: "chain",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const before = await tx.query<{ licence_tier: string }>(
        `select licence_tier from chain where id = $1 for update`,
        [chainId]
      );
      if (!before[0]) throw new NotFound("Chain", chainId);
      await tx.query(`update chain set licence_tier = $2, updated_at = now() where id = $1`, [
        chainId,
        tier,
      ]);
      return {
        entityId: chainId,
        before: { licenceTier: before[0].licence_tier },
        after: { licenceTier: tier },
      };
    },
  });

  const before = outcome.before as { licenceTier: string };
  return { before: asTier(before.licenceTier), after: tier };
}

/**
 * Switches one per-chain feature on or off.
 * Spec capability table: "Feature toggles per chain — AppAdmin: yes; AppConfig
 * (delegated): typically delegated; AppSupport: no."
 */
export async function setChainFeature(
  principal: Principal,
  chainId: string,
  featureCode: string,
  enabled: boolean,
  meta: MutationMeta = {}
): Promise<{ featureCode: string; before: boolean; after: boolean }> {
  await guard({
    principal,
    action: "chain.feature.update",
    entityType: "chain_feature",
    chainId,
    target: `chain ${chainId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "chain.feature.update",
    entityType: "chain_feature",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{
        enabled: boolean | null;
        min_tier: string;
        toggleable: boolean;
        licence_tier: string;
      }>(
        `select cf.enabled, f.min_tier, f.toggleable, c.licence_tier
           from chain c
           join feature f on f.code = $2
           left join chain_feature cf on cf.chain_id = c.id and cf.feature_code = f.code
          where c.id = $1`,
        [chainId, featureCode]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Chain or feature", `${chainId}/${featureCode}`);
      if (!row.toggleable) throw new ValidationError(`${featureCode} is not a toggleable feature`);

      // Spec "Licensing Tiers": the tier gates module depth and whether an AI-assisted
      // variant is switched on, so a Platinum-only capability cannot be enabled for a
      // Silver chain. Changing the tier is the deliberate act that makes it legitimate.
      const tier = asTier(row.licence_tier);
      if (enabled && TIER_RANK[asTier(row.min_tier)] > TIER_RANK[tier]) {
        throw new ValidationError(
          `${featureCode} needs the ${row.min_tier} tier; this chain is on ${tier}`
        );
      }

      const before = row.enabled ?? false;
      await tx.query(
        `insert into chain_feature (chain_id, feature_code, enabled, updated_by_user_id)
         values ($1, $2, $3, $4)
         on conflict (chain_id, feature_code)
         do update set enabled = excluded.enabled,
                       updated_by_user_id = excluded.updated_by_user_id,
                       updated_at = now()`,
        [chainId, featureCode, enabled, principal.userId]
      );

      return {
        entityId: `${chainId}:${featureCode}`,
        before: { featureCode, enabled: before },
        after: { featureCode, enabled },
      };
    },
  });

  return {
    featureCode,
    before: Boolean((outcome.before as { enabled: boolean }).enabled),
    after: enabled,
  };
}

/**
 * The chain a single-chain identity belongs to, used once at login to stamp the
 * session's tenant context. App-layer identities get no chain here: what they may
 * reach comes from their delegations.
 */
export async function primaryScopeForUser(
  tx: Queryable,
  userId: string
): Promise<{ chainId: string | null; siteId: string | null }> {
  const rows = await tx.query<{ chain_id: string | null; site_id: string | null }>(
    `select ra.chain_id, ra.site_id
       from role_assignment ra
       join role r on r.id = ra.role_id
      where ra.user_id = $1 and ra.status = 'active'
        and ra.revoked_at is null
        and (ra.expires_at is null or ra.expires_at > now())
        and r.layer in ('central', 'site')
      order by (ra.site_id is not null) desc
      limit 1`,
    [userId]
  );
  return { chainId: rows[0]?.chain_id ?? null, siteId: rows[0]?.site_id ?? null };
}
