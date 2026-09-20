import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { TierBadge } from "~/components/status";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  ConfirmSummary,
  Dialog,
  ErrorState,
  Field,
  PageHeader,
  PermissionDenied,
  SegmentedControl,
  Select,
  TextInput,
  Textarea,
  Toggle,
} from "~/components/ui";
import type { ChainAuthConfigView, ChainSettingView, ChainSettingsView } from "~/domain/appconfig";
import { useI18n } from "~/i18n";
import {
  getChainConfigFn,
  updateChainAuthConfigFn,
  updateChainSettingFn,
  updateSiteLocaleFn,
} from "~/server-fns";

/**
 * Chain configuration — the AppConfig console screen (`/chains/$chainId/settings`).
 *
 * Three surfaces, all of them chain-level because the spec puts them there:
 *
 *   1. **Authentication / SSO.** Stored per chain; no secret value is ever typed here,
 *      only a reference into the platform secret store.
 *   2. **Delegated settings.** The App layer publishes each key with its bounds and its
 *      delegation; this screen offers a control only where the definition allows it and
 *      says why where it does not, because a control that is simply missing never tells
 *      an operator whether the value is not theirs to move or the product forgot it.
 *   3. **Site language.** The site hop of the resolution order
 *      (user → site → chain → platform).
 *
 * Everything is gated **server-side**: `getChainSettings` needs `chain.settings.read` and
 * `getChainAuthConfig` needs `chain.auth.read`, both read from the session by the domain
 * layer. A caller without the first gets a permission-denied state naming the capability
 * rather than an empty screen; a caller with the first but not the second loses the auth
 * section alone. The list of what this screen may offer is never taken from a client
 * parameter — the chain id in the URL is only ever *asked about*, and the server answers
 * for the identity it resolved itself.
 *
 * Reads and writes are never optimistic: every write re-reads through the loader, so what
 * is on screen is what the database holds. Each write is audited by the domain function
 * in the same transaction as the change.
 */
export const Route = createFileRoute("/_shell/chains/$chainId_/settings")({
  staticData: { titleKey: "chains.settings.titleFallback" },
  loader: async ({ params }) => getChainConfigFn({ data: { chainId: params.chainId } }),
  component: ChainConfigScreen,
});

function ChainConfigScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!result.ok) {
    // A refusal is a state like any other: translated, naming the capability, with a way
    // back. Nothing is rendered that implies the caller could see this chain's config.
    if (result.status === 403) {
      return (
        <PermissionDenied
          title={t("chains.settings.denied.settings.title")}
          description={t("chains.settings.denied.settings.body")}
          requiredPermission={result.permission ?? "chain.settings.read"}
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
      );
    }
    if (result.status === 404) {
      return (
        <div className="p-4">
          <Card>
            <ErrorState
              title={t("config.notFound.title")}
              description={t("config.notFound.description")}
              detail={result.message}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    void router.navigate({ to: "/chains" });
                  }}
                >
                  {t("action.back")}
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
            title={t("error.title")}
            description={t("error.description")}
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

  const settings: ChainSettingsView = result.settings;
  const canWriteAuth = principal.permissions.includes("auth.sso.configure");
  const mayMoveSomething =
    canWriteAuth ||
    settings.maySetSiteLocale ||
    settings.settings.some((setting) => setting.maySet);

  async function afterWrite(
    response: { ok: boolean; message?: string },
    success: string
  ): Promise<void> {
    setBusy(false);
    if (!response.ok) {
      setError(response.message ?? t("error.description"));
      return;
    }
    setError(null);
    setNotice(success);
    await router.invalidate();
  }

  const delegatedCount = settings.settings.filter((setting) => setting.delegatable).length;
  const appLayerCount = settings.settings.length - delegatedCount;

  return (
    <>
      <PageHeader
        eyebrow={t("chains.settings.eyebrow")}
        title={settings.chainName}
        description={t("chains.settings.description")}
        meta={
          <>
            <TierBadge tier={settings.licenceTier} />
            <Badge tone={result.auth?.configured ? "accent" : "neutral"}>
              {result.auth?.configured
                ? t("chains.settings.status.configured")
                : t("chains.settings.status.platformDefaults")}
            </Badge>
          </>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void router.navigate({
                to: "/chains/$chainId",
                params: { chainId: settings.chainId },
              });
            }}
          >
            {t("action.back")}
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
        {!mayMoveSomething ? <Banner tone="info">{t("config.readOnly")}</Banner> : null}

        <Card>
          <CardHeader
            title={t("chains.settings.boundary.title")}
            subtitle={t("chains.settings.boundary.body")}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone="accent">
                  {t("chains.settings.boundary.delegated")} · {delegatedCount}
                </Badge>
                <Badge tone="neutral">
                  {t("chains.settings.boundary.appLayer")} · {appLayerCount}
                </Badge>
              </div>
            }
          />
        </Card>

        <AuthSection
          key={result.auth?.updatedAt ?? "unconfigured"}
          chainName={settings.chainName}
          auth={result.auth}
          authDenied={result.authDenied}
          canWrite={canWriteAuth}
          busy={busy}
          onWrite={async (input) => {
            setBusy(true);
            const response = await updateChainAuthConfigFn({
              data: { chainId: settings.chainId, config: input },
            });
            await afterWrite(response, t("chains.settings.auth.saved"));
          }}
        />

        <SettingsSection
          settings={settings}
          chainName={settings.chainName}
          busy={busy}
          onWrite={async (key, value, siteId, success) => {
            setBusy(true);
            const response = await updateChainSettingFn({
              data: { chainId: settings.chainId, key, value, siteId },
            });
            await afterWrite(response, success);
          }}
        />

        <LocaleSection
          settings={settings}
          busy={busy}
          onWrite={async (siteId, siteName, locale) => {
            setBusy(true);
            const response = await updateSiteLocaleFn({
              data: { chainId: settings.chainId, siteId, locale },
            });
            await afterWrite(
              response,
              t("config.locale.saved", {
                site: siteName,
                locale: locale ?? t("config.locale.unset"),
              })
            );
          }}
        />
      </div>
    </>
  );
}

// ── Authentication & SSO ─────────────────────────────────────────────────────

interface AuthDraft {
  authMode: "native" | "sso";
  ssoProtocol: "saml" | "oidc" | "";
  idpDisplayName: string;
  idpEntityId: string;
  ssoAuthorizeUrl: string;
  ssoMetadataUrl: string;
  ssoClientId: string;
  ssoClientSecretRef: string;
  jitProvisioning: boolean;
  allowedEmailDomains: string;
  defaultRoleCode: string;
  sessionTtlMinutes: string;
  enforceSso: boolean;
  notes: string;
}

function draftFrom(auth: ChainAuthConfigView | null): AuthDraft {
  return {
    authMode: auth?.authMode ?? "native",
    ssoProtocol: auth?.ssoProtocol ?? "",
    idpDisplayName: auth?.idpDisplayName ?? "",
    idpEntityId: auth?.idpEntityId ?? "",
    ssoAuthorizeUrl: auth?.ssoAuthorizeUrl ?? "",
    ssoMetadataUrl: auth?.ssoMetadataUrl ?? "",
    ssoClientId: auth?.ssoClientId ?? "",
    ssoClientSecretRef: auth?.ssoClientSecretRef ?? "",
    jitProvisioning: auth?.jitProvisioning ?? true,
    allowedEmailDomains: (auth?.allowedEmailDomains ?? []).join(", "),
    defaultRoleCode: auth?.defaultRoleCode ?? "",
    sessionTtlMinutes: String(auth?.sessionTtlMinutes ?? 720),
    enforceSso: auth?.enforceSso ?? false,
    notes: auth?.notes ?? "",
  };
}

const HTTPS = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SECRET_REF = /^[A-Za-z0-9._:/@-]{3,200}$/;

function AuthSection({
  chainName,
  auth,
  authDenied,
  canWrite,
  busy,
  onWrite,
}: {
  chainName: string;
  auth: ChainAuthConfigView | null;
  authDenied: { permission: string } | null;
  canWrite: boolean;
  busy: boolean;
  onWrite: (input: {
    authMode: "native" | "sso";
    ssoProtocol: "saml" | "oidc" | null;
    idpDisplayName: string | null;
    idpEntityId: string | null;
    ssoAuthorizeUrl: string | null;
    ssoMetadataUrl: string | null;
    ssoClientId: string | null;
    ssoClientSecretRef: string | null;
    jitProvisioning: boolean;
    allowedEmailDomains: string[];
    defaultRoleCode: string | null;
    sessionTtlMinutes: number;
    enforceSso: boolean;
    notes: string | null;
  }) => Promise<void>;
}) {
  const { t, format } = useI18n();
  const [draftState, setDraft] = useState<AuthDraft | null>(auth ? draftFrom(auth) : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  if (authDenied) {
    return (
      <Card>
        <CardHeader title={t("chains.settings.auth.title")} />
        <PermissionDenied
          title={t("chains.settings.denied.auth.title")}
          description={t("chains.settings.denied.auth.body")}
          requiredPermission={authDenied.permission}
        />
      </Card>
    );
  }
  if (!auth || !draftState) return null;
  // A narrower const, so the helpers below and the JSX agree on the type.
  const draft: AuthDraft = draftState;

  const ssoOffered = auth.ssoFeatureEnabled && auth.ssoMinimumTier === auth.licenceTier;
  const readOnly = !canWrite;

  function update<K extends keyof AuthDraft>(key: K, value: AuthDraft[K]): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (draft.authMode !== "sso") return found;
    if (draft.ssoProtocol !== "saml" && draft.ssoProtocol !== "oidc") {
      found.ssoProtocol = t("chains.settings.validation.protocol");
    }
    if (!draft.idpEntityId.trim()) found.idpEntityId = t("chains.settings.validation.entityId");
    if (!draft.ssoClientId.trim()) found.ssoClientId = t("chains.settings.validation.clientId");
    if (!HTTPS(draft.ssoAuthorizeUrl.trim())) found.ssoAuthorizeUrl = t("chains.settings.validation.url");
    if (draft.ssoMetadataUrl.trim() && !HTTPS(draft.ssoMetadataUrl.trim())) {
      found.ssoMetadataUrl = t("chains.settings.validation.url");
    }
    if (draft.ssoClientSecretRef.trim() && !SECRET_REF.test(draft.ssoClientSecretRef.trim())) {
      found.ssoClientSecretRef = t("chains.settings.validation.secretRef");
    }
    const ttl = Number(draft.sessionTtlMinutes);
    if (!Number.isInteger(ttl) || ttl < 15 || ttl > 4320) {
      found.sessionTtlMinutes = t("chains.settings.validation.ttl");
    }
    const domains = draft.allowedEmailDomains
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    for (const domain of domains) {
      if (!DOMAIN.test(domain)) {
        found.allowedEmailDomains = t("chains.settings.validation.domains", { domain });
        break;
      }
    }
    return found;
  }

  function submit(): void {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setConfirming(true);
  }

  async function commit(): Promise<void> {
    const sso = draft.authMode === "sso";
    const domains = draft.allowedEmailDomains
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    setConfirming(false);
    await onWrite({
      authMode: draft.authMode,
      ssoProtocol: sso ? (draft.ssoProtocol === "saml" ? "saml" : "oidc") : null,
      idpDisplayName: draft.idpDisplayName.trim() || null,
      idpEntityId: draft.idpEntityId.trim() || null,
      ssoAuthorizeUrl: draft.ssoAuthorizeUrl.trim() || null,
      ssoMetadataUrl: draft.ssoMetadataUrl.trim() || null,
      ssoClientId: draft.ssoClientId.trim() || null,
      ssoClientSecretRef: draft.ssoClientSecretRef.trim() || null,
      jitProvisioning: draft.jitProvisioning,
      allowedEmailDomains: domains,
      defaultRoleCode: draft.defaultRoleCode || null,
      sessionTtlMinutes: Number(draft.sessionTtlMinutes),
      enforceSso: sso ? draft.enforceSso : false,
      notes: draft.notes.trim() || null,
    });
  }

  return (
    <Card>
      <CardHeader
        title={t("chains.settings.auth.title")}
        subtitle={t("chains.settings.auth.description")}
        actions={
          auth.configured ? (
            <Badge tone="accent">{t("chains.settings.status.configured")}</Badge>
          ) : (
            <Badge tone="neutral">{t("chains.settings.status.platformDefaults")}</Badge>
          )
        }
      />
      <div className="flex flex-col gap-3 p-4">
        {auth.updatedAt ? (
          <p className="text-2xs text-fg-subtle">
            {t("chains.settings.auth.updated", {
              when: format.dateTime(auth.updatedAt),
              who: auth.updatedBy ?? t("common.unknown"),
            })}
          </p>
        ) : (
          <p className="text-2xs text-fg-subtle">{t("chains.settings.auth.notConfigured")}</p>
        )}
        {!auth.ssoFeatureEnabled ? (
          <Banner tone="warn">{t("chains.settings.auth.fixedFeature.off")}</Banner>
        ) : (
          <Banner tone="info">{t("chains.settings.auth.fixedFeature.on")}</Banner>
        )}
        {!ssoOffered && auth.ssoFeatureEnabled ? (
          <Banner tone="info">
            {t("chains.settings.auth.fixedTier", { tier: t(`chains.tier.${auth.ssoMinimumTier}` as never) })}
          </Banner>
        ) : null}
        {readOnly ? (
          <Banner tone="warn" title={t("config.auth.denied.title")}>
            {t("config.auth.denied.description")}
          </Banner>
        ) : null}

        <Field id="auth-mode" label={t("chains.settings.auth.mode.label")}>
          <SegmentedControl
            ariaLabel={t("chains.settings.auth.mode.label")}
            value={draft.authMode}
            onChange={(value) => {
              update("authMode", value);
            }}
            options={[
              { value: "native", label: t("chains.settings.auth.mode.native") },
              { value: "sso", label: t("chains.settings.auth.mode.sso") },
            ]}
          />
        </Field>

        {draft.authMode === "sso" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="auth-protocol"
              label={t("chains.settings.auth.protocol.label")}
              error={errors.ssoProtocol ?? null}
            >
              <Select
                value={draft.ssoProtocol}
                onChange={(value) => {
                  update("ssoProtocol", value);
                }}
                emptyLabel={t("chains.settings.auth.protocol.choose")}
                options={[
                  { value: "saml", label: t("chains.settings.auth.protocol.saml") },
                  { value: "oidc", label: t("chains.settings.auth.protocol.oidc") },
                ]}
              />
            </Field>
            <Field id="auth-idp" label={t("chains.settings.auth.idpName.label")}>
              <TextInput
                value={draft.idpDisplayName}
                onChange={(value) => {
                  update("idpDisplayName", value);
                }}
              />
            </Field>
            <Field
              id="auth-entity"
              label={t("chains.settings.auth.entityId.label")}
              error={errors.idpEntityId ?? null}
            >
              <TextInput
                value={draft.idpEntityId}
                onChange={(value) => {
                  update("idpEntityId", value);
                }}
              />
            </Field>
            <Field
              id="auth-authorize"
              label={t("chains.settings.auth.authorizeUrl.label")}
              error={errors.ssoAuthorizeUrl ?? null}
            >
              <TextInput
                value={draft.ssoAuthorizeUrl}
                onChange={(value) => {
                  update("ssoAuthorizeUrl", value);
                }}
              />
            </Field>
            <Field
              id="auth-metadata"
              label={t("chains.settings.auth.metadataUrl.label")}
              error={errors.ssoMetadataUrl ?? null}
            >
              <TextInput
                value={draft.ssoMetadataUrl}
                onChange={(value) => {
                  update("ssoMetadataUrl", value);
                }}
              />
            </Field>
            <Field
              id="auth-client"
              label={t("chains.settings.auth.clientId.label")}
              error={errors.ssoClientId ?? null}
            >
              <TextInput
                value={draft.ssoClientId}
                onChange={(value) => {
                  update("ssoClientId", value);
                }}
              />
            </Field>
            <Field
              id="auth-secret"
              label={t("chains.settings.auth.secretRef.label")}
              hint={t("chains.settings.auth.secretRef.hint")}
              error={errors.ssoClientSecretRef ?? null}
            >
              <TextInput
                value={draft.ssoClientSecretRef}
                onChange={(value) => {
                  update("ssoClientSecretRef", value);
                }}
              />
            </Field>
            <Field
              id="auth-domains"
              label={t("chains.settings.auth.domains.label")}
              hint={t("chains.settings.auth.domains.hint")}
              error={errors.allowedEmailDomains ?? null}
            >
              <TextInput
                value={draft.allowedEmailDomains}
                onChange={(value) => {
                  update("allowedEmailDomains", value);
                }}
              />
            </Field>
            <Field id="auth-default-role" label={t("chains.settings.auth.defaultRole.label")}>
              <Select
                value={draft.defaultRoleCode}
                onChange={(value) => {
                  update("defaultRoleCode", value);
                }}
                emptyLabel={t("config.auth.defaultRole.none")}
                options={auth.assignableRoles.map((role) => ({
                  value: role.code,
                  label: role.name,
                }))}
              />
            </Field>
            <Field
              id="auth-ttl"
              label={t("chains.settings.auth.ttl.label")}
              hint={t("chains.settings.auth.ttl.hint")}
              error={errors.sessionTtlMinutes ?? null}
            >
              <TextInput
                value={draft.sessionTtlMinutes}
                inputMode="numeric"
                onChange={(value) => {
                  update("sessionTtlMinutes", value);
                }}
              />
            </Field>
          </div>
        ) : null}

        <Field id="auth-jit" label={t("chains.settings.auth.jit.label")} hint={t("chains.settings.auth.jit.hint")}>
          <Toggle
            checked={draft.jitProvisioning}
            disabled={readOnly}
            label={t("chains.settings.auth.jit.label")}
            onChange={(next) => {
              update("jitProvisioning", next);
            }}
          />
        </Field>
        {draft.authMode === "sso" ? (
          <Field
            id="auth-enforce"
            label={t("chains.settings.auth.enforce.label")}
            hint={t("chains.settings.auth.enforce.hint")}
          >
            <Toggle
              checked={draft.enforceSso}
              disabled={readOnly}
              label={t("chains.settings.auth.enforce.label")}
              onChange={(next) => {
                update("enforceSso", next);
              }}
            />
          </Field>
        ) : null}
        <Field id="auth-notes" label={t("chains.settings.auth.notes.label")}>
          <Textarea
            value={draft.notes}
            rows={2}
            onChange={(value) => {
              update("notes", value);
            }}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={readOnly || busy} loading={busy} onClick={submit}>
            {busy ? t("config.auth.saving") : t("chains.settings.auth.confirmCta")}
          </Button>
        </div>
      </div>

      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("chains.settings.auth.confirmTitle")}
        description={t("chains.settings.auth.confirmBody", { chain: chainName })}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                void commit();
              }}
            >
              {t("chains.settings.auth.confirmCta")}
            </Button>
          </>
        }
      >
        <ConfirmSummary
          items={[
            { label: t("chains.settings.auth.mode.label"), value: t(`chains.settings.auth.mode.${draft.authMode}` as never) },
            { label: t("chains.settings.auth.protocol.label"), value: draft.ssoProtocol ? t(`chains.settings.auth.protocol.${draft.ssoProtocol}` as never) : t("common.none") },
            { label: t("chains.settings.auth.ttl.label"), value: format.integer(Number(draft.sessionTtlMinutes)) },
          ]}
        />
      </Dialog>
    </Card>
  );
}

// ── Delegated settings ───────────────────────────────────────────────────────

function unitLabel(unit: string | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (!unit) return "";
  const key = `settings.unit.${unit}`;
  const label = t(key as never);
  return label === key ? unit : label;
}

function settingOptionLabel(
  setting: ChainSettingView,
  value: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  const key = `settings.${setting.key}.option.${value}`;
  const label = t(key as never);
  return label === key ? value : label;
}

function SettingsSection({
  settings,
  chainName,
  busy,
  onWrite,
}: {
  settings: ChainSettingsView;
  chainName: string;
  busy: boolean;
  onWrite: (
    key: string,
    value: string | number | boolean,
    siteId: string | null,
    success: string
  ) => Promise<void>;
}) {
  const { t, format } = useI18n();
  const [editing, setEditing] = useState<{
    setting: ChainSettingView;
    siteId: string | null;
    siteName: string | null;
  } | null>(null);
  const [raw, setRaw] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  function renderValue(
    setting: ChainSettingView,
    stored: string | number | boolean | null,
    effective: string | number | boolean
  ): string {
    if (stored === null) {
      return `${t("config.settings.unset")} · ${valueLabel(setting, effective, t, format)}`;
    }
    return valueLabel(setting, effective, t, format);
  }

  function valueLabel(
    setting: ChainSettingView,
    value: string | number | boolean,
    translate: ReturnType<typeof useI18n>["t"],
    formatter: ReturnType<typeof useI18n>["format"]
  ): string {
    switch (setting.valueType) {
      case "integer":
        return `${formatter.integer(Number(value))}${setting.unit ? ` ${unitLabel(setting.unit, translate)}` : ""}`;
      case "decimal": {
        const digits = 2;
        return `${formatter.number(Number(value), {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}${setting.unit ? ` ${unitLabel(setting.unit, translate)}` : ""}`;
      }
      case "boolean":
        return value === true ? translate("chains.settings.value.on") : translate("chains.settings.value.off");
      case "enum":
        return settingOptionLabel(setting, String(value), translate);
      default:
        return String(value);
    }
  }

  function boundsLabel(setting: ChainSettingView): string {
    if (setting.valueType === "enum" && setting.enumOptions) {
      return t("config.settings.bounds.options", {
        options: format.list(setting.enumOptions.map((option) => settingOptionLabel(setting, option, t))),
      });
    }
    if (setting.minValue !== null && setting.maxValue !== null) {
      return t("config.settings.bounds.between", {
        min: format.integer(setting.minValue),
        max: format.integer(setting.maxValue),
      });
    }
    if (setting.minValue !== null) {
      return t("config.settings.bounds.min", { min: format.integer(setting.minValue) });
    }
    if (setting.maxValue !== null) {
      return t("config.settings.bounds.max", { max: format.integer(setting.maxValue) });
    }
    return t("config.settings.bounds.none");
  }

  function delegationLabel(setting: ChainSettingView): string {
    if (setting.fixedByPolicy) return t("chains.settings.owner.regulator");
    switch (setting.delegateTo) {
      case "chain_head":
        return t("config.settings.delegation.chain_head");
      case "site_head":
        return t("config.settings.delegation.site_head");
      default:
        return t("chains.settings.owner.appOnly");
    }
  }

  function openEditor(
    setting: ChainSettingView,
    siteId: string | null,
    siteName: string | null,
    current: string | number | boolean
  ): void {
    setFieldError(null);
    setRaw(typeof current === "boolean" ? String(current) : String(current));
    setEditing({ setting, siteId, siteName });
  }

  function coerce(setting: ChainSettingView): string | number | boolean | null {
    if (setting.valueType === "boolean") return raw === "true";
    if (setting.valueType === "integer" || setting.valueType === "decimal") {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        setFieldError(t("chains.settings.validation.number"));
        return null;
      }
      if (setting.valueType === "integer" && !Number.isInteger(numeric)) {
        setFieldError(t("chains.settings.validation.number"));
        return null;
      }
      const min = setting.minValue;
      const max = setting.maxValue;
      if ((min !== null && numeric < min) || (max !== null && numeric > max)) {
        setFieldError(
          t("chains.settings.validation.range", {
            min: min === null ? "" : format.integer(min),
            max: max === null ? "" : format.integer(max),
          })
        );
        return null;
      }
      return numeric;
    }
    if (!raw.trim()) {
      setFieldError(t("validation.required"));
      return null;
    }
    return raw.trim();
  }

  async function commit(): Promise<void> {
    if (!editing) return;
    const { setting, siteId } = editing;
    const value = coerce(setting);
    if (value === null) return;
    setEditing(null);
    await onWrite(
      setting.key,
      value,
      siteId,
      t("config.settings.saved", {
        setting: t(setting.labelKey as never),
        value: valueLabel(setting, value, t, format),
      })
    );
  }

  return (
    <Card>
      <CardHeader
        title={t("chains.settings.settings.title")}
        subtitle={t("chains.settings.settings.description")}
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-2xs tracking-wide text-fg-subtle uppercase">
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.setting")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.module")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.scope")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.owner")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.value")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.column.updated")}</th>
              <th className="px-3 py-2 text-end font-semibold">{t("common.actions")}</th>
            </tr>
          </thead>
          {settings.settings.map((setting) => (
            <tbody key={setting.key} className="border-b border-border last:border-b-0">
              <tr>
                <td className="px-3 py-2 align-top">
                  <span className="flex flex-col">
                    <span className="text-xs font-semibold text-fg">{t(setting.labelKey as never)}</span>
                    {setting.helpKey ? (
                      <span className="text-2xs text-fg-subtle">{t(setting.helpKey as never)}</span>
                    ) : null}
                    <span className="font-mono text-2xs text-fg-subtle">{setting.key}</span>
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-fg-muted">{setting.module}</td>
                <td className="px-3 py-2 align-top text-xs text-fg-muted">
                  {setting.scope === "site"
                    ? t("chains.settings.scope.site")
                    : t("chains.settings.scope.chain")}
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="flex flex-col gap-1">
                    <span className="text-xs text-fg-muted">{delegationLabel(setting)}</span>
                    <span className="text-2xs text-fg-subtle">{boundsLabel(setting)}</span>
                    {!setting.delegatable ? (
                      <span className="text-2xs text-fg-subtle">{t("config.settings.notDelegatable")}</span>
                    ) : null}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-fg">
                  {setting.scope === "site"
                    ? t("chains.settings.scope.site")
                    : renderValue(setting, setting.storedValue, setting.effectiveValue)}
                </td>
                <td className="px-3 py-2 align-top text-2xs text-fg-subtle">
                  {setting.updatedAt
                    ? t("chains.settings.updated.by", {
                        who: setting.updatedBy ?? t("common.unknown"),
                        when: format.dateTime(setting.updatedAt),
                      })
                    : t("chains.settings.updated.never")}
                </td>
                <td className="px-3 py-2 align-top text-end">
                  {setting.scope === "chain" ? (
                    <Button
                      variant="secondary"
                      disabled={busy || !setting.maySet}
                      onClick={() => {
                        openEditor(setting, null, null, setting.effectiveValue);
                      }}
                    >
                      {setting.maySet ? t("config.settings.edit") : t("chains.settings.edit.readOnly")}
                    </Button>
                  ) : (
                    <span className="text-2xs text-fg-subtle">{t("chains.settings.scope.site")}</span>
                  )}
                </td>
              </tr>
              {setting.scope === "site"
                ? setting.siteValues.map((siteValue) => (
                    <tr key={`${setting.key}:${siteValue.siteId}`} className="bg-surface-sunken">
                      <td className="px-3 py-1.5 ps-6 align-top text-2xs text-fg-muted" colSpan={4}>
                        {siteValue.siteName}
                      </td>
                      <td className="px-3 py-1.5 align-top text-xs text-fg">
                        {renderValue(setting, siteValue.storedValue, siteValue.effectiveValue)}
                      </td>
                      <td className="px-3 py-1.5 align-top text-2xs text-fg-subtle">
                        {siteValue.updatedAt
                          ? t("chains.settings.updated.by", {
                              who: siteValue.updatedBy ?? t("common.unknown"),
                              when: format.dateTime(siteValue.updatedAt),
                            })
                          : t("chains.settings.updated.never")}
                      </td>
                      <td className="px-3 py-1.5 align-top text-end">
                        <Button
                          variant="ghost"
                          disabled={busy || !setting.maySet}
                          onClick={() => {
                            openEditor(setting, siteValue.siteId, siteValue.siteName, siteValue.effectiveValue);
                          }}
                        >
                          {setting.maySet ? t("config.settings.edit") : t("chains.settings.edit.readOnly")}
                        </Button>
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          ))}
        </table>
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        title={t("chains.settings.edit.title", {
          setting: editing ? t(editing.setting.labelKey as never) : "",
        })}
        description={t("config.settings.review.body")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              loading={busy}
              onClick={() => {
                void commit();
              }}
            >
              {t("chains.settings.edit.cta")}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <Field
              id={`setting-${editing.setting.key}`}
              label={t(editing.setting.labelKey as never)}
              hint={
                editing.setting.helpKey
                  ? t(editing.setting.helpKey as never)
                  : t("chains.settings.bounds", {
                      min: editing.setting.minValue === null ? "" : format.integer(editing.setting.minValue),
                      max: editing.setting.maxValue === null ? "" : format.integer(editing.setting.maxValue),
                    })
              }
              aside={editing.siteName ?? chainName}
              error={fieldError}
            >
              {editing.setting.valueType === "enum" && editing.setting.enumOptions ? (
                <Select
                  value={raw}
                  onChange={(value) => {
                    setRaw(value);
                  }}
                  options={editing.setting.enumOptions.map((option) => ({
                    value: option,
                    label: settingOptionLabel(editing.setting, option, t),
                  }))}
                />
              ) : editing.setting.valueType === "boolean" ? (
                <Toggle
                  checked={raw === "true"}
                  label={t(editing.setting.labelKey as never)}
                  onChange={(next) => {
                    setRaw(next ? "true" : "false");
                  }}
                />
              ) : (
                <TextInput
                  value={raw}
                  inputMode={
                    editing.setting.valueType === "integer"
                      ? "numeric"
                      : editing.setting.valueType === "decimal"
                        ? "decimal"
                        : "text"
                  }
                  onChange={(value) => {
                    setRaw(value);
                  }}
                />
              )}
            </Field>
            <ConfirmSummary
              items={[
                {
                  label: t("config.settings.review.before"),
                  value:
                    editing.setting.storedValue === null
                      ? t("chains.settings.source.default")
                      : valueLabel(editing.setting, editing.setting.storedValue, t, format),
                },
                {
                  label: t("config.settings.review.after"),
                  value: (() => {
                    const preview = coerceForPreview(editing.setting, raw);
                    return preview === null
                      ? t("chains.settings.value.unset")
                      : valueLabel(editing.setting, preview, t, format);
                  })(),
                },
              ]}
            />
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

/** A best-effort preview of what the raw input means, for the confirm summary only. */
function coerceForPreview(setting: ChainSettingView, raw: string): string | number | boolean | null {
  if (setting.valueType === "boolean") return raw === "true";
  if (setting.valueType === "integer" || setting.valueType === "decimal") {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return raw.trim() ? raw.trim() : null;
}

// ── Site language ────────────────────────────────────────────────────────────

function LocaleSection({
  settings,
  busy,
  onWrite,
}: {
  settings: ChainSettingsView;
  busy: boolean;
  onWrite: (siteId: string, siteName: string, locale: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ siteId: string; siteName: string } | null>(null);
  const [draftLocale, setDraftLocale] = useState<string>("");

  const options = settings.availableLocales.map((locale) => ({
    value: locale.code,
    label: locale.pseudo ? `${locale.label} · ${t("config.locale.pseudo")}` : locale.label,
  }));

  return (
    <Card>
      <CardHeader
        title={t("chains.settings.locale.title")}
        subtitle={t("chains.settings.locale.description")}
        actions={
          settings.maySetSiteLocale ? undefined : (
            <Badge tone="neutral">{t("common.readOnly")}</Badge>
          )
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-2xs tracking-wide text-fg-subtle uppercase">
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.locale.column.site")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.locale.column.locale")}</th>
              <th className="px-3 py-2 text-start font-semibold">{t("chains.settings.locale.column.timezone")}</th>
              <th className="px-3 py-2 text-end font-semibold">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {settings.sites.map((site) => (
              <tr key={site.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2 align-top">
                  <span className="flex flex-col">
                    <span className="text-xs font-semibold text-fg">{site.name}</span>
                    <span className="font-mono text-2xs text-fg-subtle">{site.code}</span>
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-fg">
                  {site.locale ?? t("chains.settings.locale.inherited")}
                </td>
                <td className="px-3 py-2 align-top text-xs text-fg-muted">{site.timezone}</td>
                <td className="px-3 py-2 align-top text-end">
                  <Button
                    variant="secondary"
                    disabled={busy || !settings.maySetSiteLocale}
                    onClick={() => {
                      setDraftLocale(site.locale ?? "");
                      setEditing({ siteId: site.id, siteName: site.name });
                    }}
                  >
                    {t("chains.settings.locale.action")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {settings.maySetSiteLocale ? null : (
        <div className="border-t border-border p-3">
          <Banner tone="info">{t("config.locale.denied")}</Banner>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        title={t("config.locale.review.title", { site: editing?.siteName ?? "" })}
        description={t("config.locale.review.body")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              loading={busy}
              onClick={() => {
                if (!editing) return;
                const target = editing;
                setEditing(null);
                void onWrite(target.siteId, target.siteName, draftLocale === "" ? null : draftLocale);
              }}
            >
              {t("chains.settings.locale.action")}
            </Button>
          </>
        }
      >
        <Field
          id="site-locale"
          label={t("chains.settings.locale.column.locale")}
          hint={t("config.locale.subtitle")}
        >
          <Select
            value={draftLocale}
            onChange={setDraftLocale}
            emptyLabel={t("chains.settings.locale.inherited")}
            options={options}
          />
        </Field>
      </Dialog>
    </Card>
  );
}
