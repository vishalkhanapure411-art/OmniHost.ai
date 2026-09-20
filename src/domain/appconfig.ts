import "@tanstack/react-start/server-only";

import { poolQueryable, sql, type Queryable } from "~/db";
import { auditedMutation, guard } from "~/server/audit";
import { NotFound, ValidationError } from "~/server/errors";
import { isLocaleCode, LOCALES } from "~/i18n/locales";
import { accessibleChainIds, type Principal } from "~/server/session";
import { TIER_RANK, asTier, type LicenceTier, type MutationMeta } from "~/domain/chains";

/**
 * AppConfig — the delegated configuration vertical.
 *
 * Spec "Admin & Configuration Model": AppConfig holds "whatever slice of AppAdmin
 * chooses to delegate — delegation is itself a configuration action, grantable and
 * revocable per person, not a fixed second tier of roles". Nothing here is reachable
 * because the caller holds the APP_CONFIG role: every function starts with `guard()`,
 * which requires the *tool code*, and the APP_CONFIG role carries no tool codes at all
 * (see db/seed.sql — the role_permission inserts name APP_ADMIN, not APP_CONFIG).
 *
 * Two surfaces, both chain-level because the spec puts them there:
 *
 *   1. **Authentication / SSO** — capability table: "SSO / authentication setup:
 *      AppAdmin yes, AppConfig typically delegated, AppSupport no". Stored in
 *      `chain_auth_config`, one row per chain that has been configured. No secret value
 *      is ever written: `sso_client_secret_ref` is a pointer into the platform secret
 *      store, the same rule the payments decision sets for card data.
 *
 *   2. **Delegated settings** — the App layer publishes a definition with hard bounds
 *      (`setting_definition`), a chain's admin sets a value inside them
 *      (`chain_setting`). The bounds are re-read inside the write transaction and
 *      checked there, so a request cannot widen them; the *delegation* switch
 *      (`delegate_to`) is likewise re-read, so holding the tool is "may set some
 *      setting", never "may set any setting".
 *
 * Both surfaces, plus `site.locale`, write their audit row in the same transaction as
 * the change through `auditedMutation`, and a refusal is recorded by `guard`.
 */

// ── Authentication / SSO ─────────────────────────────────────────────────────

export const SSO_PROTOCOLS = ["saml", "oidc"] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];
export type AuthMode = "native" | "sso";

export interface ChainAuthConfigView {
  chainId: string;
  /** False until a row exists — the view then shows the platform defaults. */
  configured: boolean;
  authMode: AuthMode;
  ssoProtocol: SsoProtocol | null;
  idpDisplayName: string | null;
  idpEntityId: string | null;
  ssoAuthorizeUrl: string | null;
  ssoMetadataUrl: string | null;
  ssoClientId: string | null;
  /** A reference into the platform secret store — never the secret itself. */
  ssoClientSecretRef: string | null;
  jitProvisioning: boolean;
  allowedEmailDomains: string[];
  defaultRoleCode: string | null;
  sessionTtlMinutes: number;
  enforceSso: boolean;
  notes: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Licence tier, because SSO is a Gold-and-up capability (spec Licensing Tiers). */
  licenceTier: LicenceTier;
  /** The per-chain `sso` feature toggle, which the tier gates but does not replace. */
  ssoFeatureEnabled: boolean;
  ssoMinimumTier: LicenceTier;
  /** Roles a JIT-provisioned identity may receive; the write is validated against these. */
  assignableRoles: { code: string; name: string; layer: string }[];
}

interface AuthConfigRow {
  auth_mode: string;
  sso_protocol: string | null;
  idp_display_name: string | null;
  idp_entity_id: string | null;
  sso_authorize_url: string | null;
  sso_metadata_url: string | null;
  sso_client_id: string | null;
  sso_client_secret_ref: string | null;
  jit_provisioning: boolean;
  allowed_email_domains: string[] | null;
  default_role_code: string | null;
  session_ttl_minutes: number;
  enforce_sso: boolean;
  notes: string | null;
  updated_at: Date | null;
  updated_by: string | null;
}

function toProtocol(value: string | null): SsoProtocol | null {
  return (SSO_PROTOCOLS as readonly string[]).includes(value ?? "") ? (value as SsoProtocol) : null;
}

async function readAuthContext(
  tx: Queryable,
  chainId: string
): Promise<{
  row: AuthConfigRow | null;
  licenceTier: string;
  ssoMinTier: string;
  ssoFeatureEnabled: boolean;
}> {
  const chainRows = await tx.query<{ licence_tier: string }>(
    `select licence_tier from chain where id = $1`,
    [chainId]
  );
  if (!chainRows[0]) throw new NotFound("Chain", chainId);

  const rows = await tx.query<AuthConfigRow>(
    `select c.auth_mode, c.sso_protocol, c.idp_display_name, c.idp_entity_id,
            c.sso_authorize_url, c.sso_metadata_url, c.sso_client_id, c.sso_client_secret_ref,
            c.jit_provisioning, c.allowed_email_domains, c.default_role_code,
            c.session_ttl_minutes, c.enforce_sso, c.notes, c.updated_at,
            u.display_name as updated_by
       from chain_auth_config c
       left join "user" u on u.id = c.updated_by_user_id
      where c.chain_id = $1`,
    [chainId]
  );

  const featureRows = await tx.query<{ min_tier: string; enabled: boolean | null }>(
    `select f.min_tier, cf.enabled
       from feature f
       left join chain_feature cf on cf.chain_id = $1 and cf.feature_code = f.code
      where f.code = 'sso'`,
    [chainId]
  );

  return {
    row: rows[0] ?? null,
    licenceTier: chainRows[0].licence_tier,
    ssoMinTier: featureRows[0]?.min_tier ?? "gold",
    ssoFeatureEnabled: featureRows[0]?.enabled ?? false,
  };
}

/** Reads a chain's authentication configuration. Requires `chain.auth.read`. */
export async function getChainAuthConfig(
  principal: Principal,
  chainId: string
): Promise<ChainAuthConfigView> {
  if (!chainId) throw new ValidationError("chainId is required");
  await guard({
    principal,
    action: "chain.auth.read",
    entityType: "chain_auth_config",
    chainId,
    target: `chain ${chainId}`,
  });

  const context = await readAuthContext(poolQueryable(), chainId);
  const row = context.row;
  const roles = await sql()<{ code: string; name: string; layer: string }>`
    select code, name, layer from role where layer in ('central', 'site') order by layer asc, name asc
  `;

  return {
    chainId,
    configured: row !== null,
    authMode: row === null || row.auth_mode !== "sso" ? "native" : "sso",
    ssoProtocol: toProtocol(row?.sso_protocol ?? null),
    idpDisplayName: row?.idp_display_name ?? null,
    idpEntityId: row?.idp_entity_id ?? null,
    ssoAuthorizeUrl: row?.sso_authorize_url ?? null,
    ssoMetadataUrl: row?.sso_metadata_url ?? null,
    ssoClientId: row?.sso_client_id ?? null,
    ssoClientSecretRef: row?.sso_client_secret_ref ?? null,
    jitProvisioning: row?.jit_provisioning ?? true,
    allowedEmailDomains: row?.allowed_email_domains ?? [],
    defaultRoleCode: row?.default_role_code ?? null,
    sessionTtlMinutes: row?.session_ttl_minutes ?? 720,
    enforceSso: row?.enforce_sso ?? false,
    notes: row?.notes ?? null,
    updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
    updatedBy: row?.updated_by ?? null,
    licenceTier: asTier(context.licenceTier),
    ssoFeatureEnabled: context.ssoFeatureEnabled,
    ssoMinimumTier: asTier(context.ssoMinTier),
    assignableRoles: roles,
  };
}

export interface UpdateChainAuthInput {
  authMode: AuthMode;
  ssoProtocol?: SsoProtocol | null;
  idpDisplayName?: string | null;
  idpEntityId?: string | null;
  ssoAuthorizeUrl?: string | null;
  ssoMetadataUrl?: string | null;
  ssoClientId?: string | null;
  /** A reference into the platform secret store. A value that looks like a secret is refused. */
  ssoClientSecretRef?: string | null;
  jitProvisioning?: boolean;
  allowedEmailDomains?: string[];
  defaultRoleCode?: string | null;
  sessionTtlMinutes?: number;
  enforceSso?: boolean;
  notes?: string | null;
}

const SECRET_REF_PATTERN = /^[A-Za-z0-9._:/@-]{3,200}$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function optionalText(value: string | null | undefined, max = 200): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`value must be ${String(max)} characters or fewer`);
  return trimmed;
}

function validateUrl(value: string | null, field: string): string {
  if (!value) throw new ValidationError(`${field} is required when authentication is SSO`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${field} must be an absolute URL`);
  }
  // An identity provider endpoint over plain HTTP would leak assertions or tokens.
  if (parsed.protocol !== "https:") throw new ValidationError(`${field} must use https`);
  return value;
}

/**
 * Writes a chain's authentication configuration. Requires `auth.sso.configure` — the
 * permission the capability table calls "SSO / authentication setup", held by AppAdmin
 * and (typically) delegated to AppConfig as a per-chain, time-boxed grant.
 *
 * Two rules the spec sets are enforced here rather than in the screen:
 *   * SSO is a **Gold-and-up** capability ("Authentication: Native login only →
 *     configurable SSO"), and the per-chain `sso` toggle has to be on, so a Silver
 *     chain cannot be switched to SSO by hand;
 *   * a default role for JIT-provisioned identities must exist in the role registry,
 *     so no configuration can invent one.
 */
export async function updateChainAuthConfig(
  principal: Principal,
  chainId: string,
  input: UpdateChainAuthInput,
  meta: MutationMeta = {}
): Promise<{ authMode: AuthMode }> {
  if (!chainId) throw new ValidationError("chainId is required");
  await guard({
    principal,
    action: "auth.sso.configure",
    entityType: "chain_auth_config",
    chainId,
    target: `chain ${chainId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  if (input.authMode !== "native" && input.authMode !== "sso") {
    throw new ValidationError("authMode must be 'native' or 'sso'");
  }

  const protocol = input.ssoProtocol ?? null;
  const entityId = optionalText(input.idpEntityId);
  const authorizeUrl = optionalText(input.ssoAuthorizeUrl, 500);
  const metadataUrl = optionalText(input.ssoMetadataUrl, 500);
  const clientId = optionalText(input.ssoClientId);
  const secretRef = optionalText(input.ssoClientSecretRef);
  const secretRefPresent = secretRef !== null;
  const idpName = optionalText(input.idpDisplayName);
  const notes = optionalText(input.notes, 1000);
  const ttl = input.sessionTtlMinutes ?? 720;
  if (!Number.isInteger(ttl) || ttl < 15 || ttl > 4320) {
    throw new ValidationError("sessionTtlMinutes must be a whole number between 15 and 4320");
  }
  const domains = (input.allowedEmailDomains ?? []).map((domain) => domain.trim().toLowerCase());
  for (const domain of domains) {
    if (!DOMAIN_PATTERN.test(domain)) throw new ValidationError(`"${domain}" is not an email domain`);
  }
  if (secretRefPresent && !SECRET_REF_PATTERN.test(secretRef)) {
    throw new ValidationError(
      "ssoClientSecretRef must name a place in the platform secret store, not hold a secret value"
    );
  }

  if (input.authMode === "native") {
    if (input.enforceSso) {
      throw new ValidationError("enforceSso cannot be set while authentication is native");
    }
  } else {
    if (!(SSO_PROTOCOLS as readonly string[]).includes(protocol ?? "")) {
      throw new ValidationError("ssoProtocol must be 'saml' or 'oidc' when authMode is 'sso'");
    }
    if (!entityId) throw new ValidationError("idpEntityId is required when authMode is 'sso'");
    validateUrl(authorizeUrl, "ssoAuthorizeUrl");
    if (metadataUrl) validateUrl(metadataUrl, "ssoMetadataUrl");
  }

  const outcome = await auditedMutation({
    principal,
    action: "auth.sso.configure",
    entityType: "chain_auth_config",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      // Re-read inside the transaction: the tier, the toggle and the previous state are
      // decided here, not from anything the caller sent.
      const context = await readAuthContext(tx, chainId);
      if (input.authMode === "sso") {
        if (TIER_RANK[asTier(context.licenceTier)] < TIER_RANK[asTier(context.ssoMinTier)]) {
          throw new ValidationError(
            `SSO needs the ${context.ssoMinTier} tier; ${context.licenceTier} was requested elsewhere`
          );
        }
        if (!context.ssoFeatureEnabled) {
          throw new ValidationError(
            "the sso feature is switched off for this chain; enable it before configuring SSO"
          );
        }
        if (input.defaultRoleCode) {
          const role = await tx.query<{ code: string }>(
            `select code from role where code = $1 and layer in ('central', 'site')`,
            [input.defaultRoleCode]
          );
          if (!role[0]) {
            throw new ValidationError(`defaultRoleCode ${input.defaultRoleCode} is not a chain-side role`);
          }
        }
      }

      await tx.query(
        `insert into chain_auth_config (
           chain_id, auth_mode, sso_protocol, idp_display_name, idp_entity_id, sso_authorize_url,
           sso_metadata_url, sso_client_id, sso_client_secret_ref, jit_provisioning,
           allowed_email_domains, default_role_code, session_ttl_minutes, enforce_sso, notes,
           updated_by_user_id
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         on conflict (chain_id) do update set
           auth_mode = excluded.auth_mode,
           sso_protocol = excluded.sso_protocol,
           idp_display_name = excluded.idp_display_name,
           idp_entity_id = excluded.idp_entity_id,
           sso_authorize_url = excluded.sso_authorize_url,
           sso_metadata_url = excluded.sso_metadata_url,
           sso_client_id = excluded.sso_client_id,
           sso_client_secret_ref = excluded.sso_client_secret_ref,
           jit_provisioning = excluded.jit_provisioning,
           allowed_email_domains = excluded.allowed_email_domains,
           default_role_code = excluded.default_role_code,
           session_ttl_minutes = excluded.session_ttl_minutes,
           enforce_sso = excluded.enforce_sso,
           notes = excluded.notes,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = now()`,
        [
          chainId,
          input.authMode,
          input.authMode === "sso" ? protocol : null,
          idpName,
          input.authMode === "sso" ? entityId : null,
          input.authMode === "sso" ? authorizeUrl : null,
          input.authMode === "sso" ? metadataUrl : null,
          input.authMode === "sso" ? clientId : null,
          input.authMode === "sso" ? secretRef : null,
          input.jitProvisioning ?? true,
          domains,
          input.authMode === "sso" ? optionalText(input.defaultRoleCode) : null,
          ttl,
          input.authMode === "sso" ? (input.enforceSso ?? false) : false,
          notes,
          principal.userId,
        ]
      );

      const before = context.row
        ? {
            authMode: context.row.auth_mode,
            ssoProtocol: context.row.sso_protocol,
            idpEntityId: context.row.idp_entity_id,
            ssoAuthorizeUrl: context.row.sso_authorize_url,
            jitProvisioning: context.row.jit_provisioning,
            allowedEmailDomains: context.row.allowed_email_domains ?? [],
            defaultRoleCode: context.row.default_role_code,
            sessionTtlMinutes: context.row.session_ttl_minutes,
            enforceSso: context.row.enforce_sso,
          }
        : null;

      return {
        entityId: chainId,
        before,
        after: {
          authMode: input.authMode,
          ssoProtocol: input.authMode === "sso" ? protocol : null,
          idpEntityId: input.authMode === "sso" ? entityId : null,
          ssoAuthorizeUrl: input.authMode === "sso" ? authorizeUrl : null,
          // Recorded separately from the reference: the trail says whether a credential
          // is bound, and where it lives, without ever holding it.
          clientSecretBound: input.authMode === "sso" && secretRefPresent,
          jitProvisioning: input.jitProvisioning ?? true,
          allowedEmailDomains: domains,
          defaultRoleCode: input.authMode === "sso" ? optionalText(input.defaultRoleCode) : null,
          sessionTtlMinutes: ttl,
          enforceSso: input.authMode === "sso" ? (input.enforceSso ?? false) : false,
        },
      };
    },
  });

  return { authMode: (outcome.after as { authMode: AuthMode }).authMode };
}

// ── Delegated chain settings ─────────────────────────────────────────────────

export type SettingValueType = "integer" | "decimal" | "text" | "boolean" | "enum";
export type SettingValue = string | number | boolean;
export type SettingDelegation = "none" | "chain_head" | "site_head";

export interface ChainSettingView {
  key: string;
  module: string;
  scope: "chain" | "site";
  valueType: SettingValueType;
  minValue: number | null;
  maxValue: number | null;
  enumOptions: string[] | null;
  unit: string | null;
  labelKey: string;
  helpKey: string | null;
  /** Who the App layer allows to set it. */
  delegateTo: SettingDelegation;
  /** True when the value is fixed by policy (a regulator) and nobody may change it. */
  fixedByPolicy: boolean;
  defaultValue: SettingValue;
  /** The chain's stored value, or null when it is still running on the default. */
  storedValue: SettingValue | null;
  effectiveValue: SettingValue;
  /** Whether a chain-side admin may set it at all (the App layer's delegation). */
  delegatable: boolean;
  /** Whether *this caller* may set it, given the delegation and their own scope. */
  maySet: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ChainSiteView {
  id: string;
  name: string;
  code: string;
  status: string;
  timezone: string;
  /** The site hop of the language resolution order; null falls through to the chain. */
  locale: string | null;
}

export interface ChainSettingsView {
  chainId: string;
  chainName: string;
  licenceTier: LicenceTier;
  settings: ChainSettingView[];
  sites: ChainSiteView[];
  /** The locales this build can render; a site may only be set to one of them. */
  availableLocales: { code: string; label: string; englishLabel: string; pseudo: boolean }[];
  maySetSiteLocale: boolean;
}

function coerceValue(raw: unknown): SettingValue {
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  return JSON.stringify(raw);
}

/**
 * Validates a value against the definition's type and bounds. Deliberately takes the
 * definition as an argument so it is always the row read inside the write transaction
 * that decides, never a bound the caller sent along with the value.
 */
export function validateSettingValue(
  definition: {
    value_type: string;
    min_value: string | number | null;
    max_value: string | number | null;
    enum_options: string[] | null;
    key: string;
  },
  value: unknown
): SettingValue {
  const min = definition.min_value === null ? null : Number(definition.min_value);
  const max = definition.max_value === null ? null : Number(definition.max_value);

  switch (definition.value_type) {
    case "boolean": {
      if (typeof value !== "boolean") throw new ValidationError(`${definition.key} expects true or false`);
      return value;
    }
    case "integer": {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(numeric)) throw new ValidationError(`${definition.key} expects a whole number`);
      if (min !== null && numeric < min) throw new ValidationError(`${definition.key} cannot be below ${String(min)}`);
      if (max !== null && numeric > max) throw new ValidationError(`${definition.key} cannot be above ${String(max)}`);
      return numeric;
    }
    case "decimal": {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) throw new ValidationError(`${definition.key} expects a number`);
      if (min !== null && numeric < min) throw new ValidationError(`${definition.key} cannot be below ${String(min)}`);
      if (max !== null && numeric > max) throw new ValidationError(`${definition.key} cannot be above ${String(max)}`);
      return numeric;
    }
    case "enum": {
      const text = typeof value === "string" ? value : String(value);
      const options = definition.enum_options ?? [];
      if (!options.includes(text)) {
        throw new ValidationError(`${definition.key} must be one of ${options.join(", ")}`);
      }
      return text;
    }
    default: {
      const text = typeof value === "string" ? value : String(value);
      const trimmed = text.trim();
      if (!trimmed) throw new ValidationError(`${definition.key} cannot be empty`);
      if (trimmed.length > 200) throw new ValidationError(`${definition.key} must be 200 characters or fewer`);
      return trimmed;
    }
  }
}

interface DefinitionRow {
  key: string;
  module: string;
  scope: string;
  value_type: string;
  min_value: string | number | null;
  max_value: string | number | null;
  enum_options: string[] | null;
  default_value: unknown;
  unit: string | null;
  label_key: string;
  help_key: string | null;
  delegate_to: string;
  set_by: string;
  sort_order: number;
}

/**
 * Reads the App-layer definitions and this chain's values. Requires
 * `chain.settings.read`.
 *
 * `maySet` is computed from the caller's resolved scope *and* the definition, so the
 * screen shows an operator what they can change and, where they cannot, why — the
 * server refuses either way on the write path.
 */
export async function getChainSettings(
  principal: Principal,
  chainId: string
): Promise<ChainSettingsView> {
  if (!chainId) throw new ValidationError("chainId is required");
  await guard({
    principal,
    action: "chain.settings.read",
    entityType: "chain_setting",
    chainId,
    target: `chain ${chainId}`,
  });

  const chainRows = await sql()<{ name: string; licence_tier: string }>`
    select name, licence_tier from chain where id = ${chainId} limit 1
  `;
  const chain = chainRows[0];
  if (!chain) throw new NotFound("Chain", chainId);

  const definitions = await sql()<DefinitionRow>`
    select key, module, scope, value_type, min_value, max_value, enum_options, default_value,
           unit, label_key, help_key, delegate_to, set_by, sort_order
      from setting_definition
     order by sort_order asc, key asc
  `;

  const values = await sql()<{
    setting_key: string;
    value: unknown;
    updated_at: Date;
    updated_by: string | null;
  }>`
    select cs.setting_key, cs.value, cs.updated_at, u.display_name as updated_by
      from chain_setting cs
      left join "user" u on u.id = cs.updated_by_user_id
     where cs.chain_id = ${chainId}
  `;
  const byKey = new Map(values.map((row) => [row.setting_key, row]));

  const maySetTool = principal.permissions.includes("chain.setting.update");

  const settings: ChainSettingView[] = definitions.map((definition) => {
    const stored = byKey.get(definition.key) ?? null;
    const delegation = definition.delegate_to as SettingDelegation;
    const fixedByPolicy = definition.set_by === "regulator" || delegation === "none";
    const delegatedToCaller =
      principal.scope === "app"
        ? true
        : delegation === "chain_head"
          ? principal.scope === "central"
          : delegation === "site_head"
            ? principal.scope === "site"
            : false;
    return {
      key: definition.key,
      module: definition.module,
      scope: definition.scope === "site" ? "site" : "chain",
      valueType: definition.value_type as SettingValueType,
      minValue: definition.min_value === null ? null : Number(definition.min_value),
      maxValue: definition.max_value === null ? null : Number(definition.max_value),
      enumOptions: definition.enum_options,
      unit: definition.unit,
      labelKey: definition.label_key,
      helpKey: definition.help_key,
      delegateTo: delegation,
      fixedByPolicy,
      defaultValue: coerceValue(definition.default_value),
      storedValue: stored ? coerceValue(stored.value) : null,
      effectiveValue: stored ? coerceValue(stored.value) : coerceValue(definition.default_value),
      delegatable: !fixedByPolicy,
      // `fixedByPolicy` already covers delegate_to = 'none', so this is the whole rule:
      // the tool, a delegatable key, and a delegation that names the caller's own scope.
      maySet: maySetTool && !fixedByPolicy && delegatedToCaller,
      updatedAt: stored ? stored.updated_at.toISOString() : null,
      updatedBy: stored?.updated_by ?? null,
    };
  });

  const sites = await sql()<{
    id: string;
    name: string;
    code: string;
    status: string;
    timezone: string;
    locale: string | null;
  }>`
    select id, name, code, status, timezone, locale
      from site
     where chain_id = ${chainId}
     order by name asc
  `;

  return {
    chainId,
    chainName: chain.name,
    licenceTier: asTier(chain.licence_tier),
    settings,
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      code: site.code,
      status: site.status,
      timezone: site.timezone,
      locale: site.locale,
    })),
    availableLocales: LOCALES.map((locale) => ({
      code: locale.code,
      label: locale.label,
      englishLabel: locale.englishLabel,
      pseudo: locale.pseudo,
    })),
    maySetSiteLocale: principal.permissions.includes("site.locale.update"),
  };
}

/**
 * Sets one chain setting inside the bounds the App layer published.
 *
 * Requires `chain.setting.update` (a tenant-layer tool). The scope check, the bounds
 * check and the delegation check all happen against rows re-read inside the write
 * transaction, so a value that arrives from a crafted request or a future chatbot tool
 * call is judged by exactly the same rule as one typed into the screen.
 */
export async function updateChainSetting(
  principal: Principal,
  chainId: string,
  key: string,
  value: unknown,
  meta: MutationMeta = {}
): Promise<{ key: string; before: SettingValue | null; after: SettingValue }> {
  if (!chainId) throw new ValidationError("chainId is required");
  const settingKey = (key ?? "").trim();
  if (!settingKey) throw new ValidationError("setting key is required");

  await guard({
    principal,
    action: "chain.setting.update",
    entityType: "chain_setting",
    chainId,
    target: `chain ${chainId} setting ${settingKey}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "chain.setting.update",
    entityType: "chain_setting",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<DefinitionRow>(
        `select key, module, scope, value_type, min_value, max_value, enum_options, default_value,
                unit, label_key, help_key, delegate_to, set_by, sort_order
           from setting_definition
          where key = $1`,
        [settingKey]
      );
      const definition = rows[0];
      if (!definition) throw new NotFound("Setting", settingKey);

      if (definition.set_by === "regulator") {
        throw new ValidationError(`${settingKey} is fixed by policy and cannot be changed`);
      }
      // Holding the tool is "may set some setting"; this is what makes it not "any".
      if (principal.scope !== "app") {
        const expected = principal.scope === "central" ? "chain_head" : "site_head";
        if (definition.delegate_to !== expected) {
          throw new ValidationError(
            `${settingKey} is delegated to the ${definition.delegate_to === "site_head" ? "site head" : "chain head"}, not to your scope`
          );
        }
      }

      const validated = validateSettingValue(definition, value);

      const existing = await tx.query<{ value: unknown }>(
        `select value from chain_setting where chain_id = $1 and setting_key = $2 for update`,
        [chainId, settingKey]
      );

      await tx.query(
        `insert into chain_setting (chain_id, setting_key, value, updated_by_user_id)
         values ($1, $2, $3::jsonb, $4)
         on conflict (chain_id, setting_key) do update set
           value = excluded.value,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = now()`,
        [chainId, settingKey, JSON.stringify(validated), principal.userId]
      );

      return {
        entityId: `${chainId}:${settingKey}`,
        before: { key: settingKey, value: existing[0] ? coerceValue(existing[0].value) : null },
        after: { key: settingKey, value: validated },
      };
    },
  });

  return {
    key: settingKey,
    before: (outcome.before as { value: SettingValue | null }).value,
    after: (outcome.after as { value: SettingValue }).value,
  };
}

// ── site.locale ──────────────────────────────────────────────────────────────

export interface SiteLocaleChange {
  siteId: string;
  before: string | null;
  after: string | null;
}

/**
 * Sets a site's default interface language — the second hop of the owner-set
 * resolution order (user → **site** → chain → platform), stored in `site.locale`.
 *
 * Only a locale this build actually ships a catalog for is accepted. A tag we cannot
 * render would be *skipped* by the resolver rather than used with an English fallback,
 * so accepting one would make the column look ineffective; the honest behaviour is to
 * refuse it and say which tags exist. Adding a market is a catalog plus a row in
 * `src/i18n/locales.ts`, not a schema change.
 *
 * NULL is a valid value and means "no site default": the chain hop then applies.
 */
export async function updateSiteLocale(
  principal: Principal,
  chainId: string,
  siteId: string,
  locale: string | null,
  meta: MutationMeta = {}
): Promise<SiteLocaleChange> {
  if (!chainId || !siteId) throw new ValidationError("chainId and siteId are required");
  const next = locale === null || locale === "" ? null : locale;
  if (next !== null && !isLocaleCode(next)) {
    throw new ValidationError(
      `locale must be one of ${LOCALES.map((entry) => entry.code).join(", ")}, or empty to follow the chain`
    );
  }

  await guard({
    principal,
    action: "site.locale.update",
    entityType: "site",
    chainId,
    siteId,
    target: `site ${siteId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "site.locale.update",
    entityType: "site",
    chainId,
    siteId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      // chain_id in the predicate as well as the id: a site id from another chain is a
      // miss, not a cross-tenant write.
      const rows = await tx.query<{ locale: string | null }>(
        `select locale from site where id = $1 and chain_id = $2 for update`,
        [siteId, chainId]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Site", siteId);
      await tx.query(`update site set locale = $2, updated_at = now() where id = $1 and chain_id = $3`, [
        siteId,
        next,
        chainId,
      ]);
      return {
        entityId: siteId,
        before: { locale: row.locale },
        after: { locale: next },
      };
    },
  });

  return {
    siteId,
    before: (outcome.before as { locale: string | null }).locale,
    after: next,
  };
}

/**
 * The chains this identity may configure. Exported so an AppConfig screen can offer the
 * same set the server will accept — the list comes from the resolved principal, never
 * from a client parameter.
 */
export function configurableChainIds(principal: Principal): string[] | null {
  return accessibleChainIds(principal);
}
