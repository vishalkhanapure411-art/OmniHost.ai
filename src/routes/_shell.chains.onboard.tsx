import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Banner, Button, Card, CardHeader, Dialog, Field, ConfirmSummary, PageHeader, Select, TextInput, ValidationSummary } from "~/components/ui";
import { PermissionDenied } from "~/components/ui";
import { Layers, Lock } from "~/components/icons";
import { TierBadge } from "~/components/status";
import { useI18n } from "~/i18n";
import type { LicenceTier } from "~/domain/chains";
import { onboardChainFn } from "~/server-fns";

/**
 * Chain onboarding — AppAdmin's write path, and the reference for every create form
 * that follows (a site, an article, a vendor, a PO header).
 *
 * Three things it does that a form usually does not:
 *
 *   1. **Validation is a state, not a gate.** Submit is never disabled by a validation
 *      error; pressing it before the form is valid reveals the errors, moves focus to
 *      the summary and tells a screen reader how many fields are wrong. A disabled
 *      submit button is the most common way a form refuses to say what is wrong.
 *   2. **Confirm before commit.** The tier and jurisdiction decisions affect every site
 *      in the chain, so the last step is a summary of exactly what will be written, not
 *      a silent POST.
 *   3. **Permission denial is shown, not hidden.** An operator without `chain.onboard`
 *      sees the form read-only with the reason — which is the honest version of "this
 *      screen is not for you", and matches the server, which would refuse anyway.
 *
 * The feature-toggle step from the earlier list-only screen is deliberately not
 * repeated here: onboarding writes one `chain_feature` row per registry feature, with
 * gated features off until their tier is met, and the chain screen is where they are
 * switched individually — one place that owns toggles, not two.
 */
export const Route = createFileRoute("/_shell/chains/onboard")({
  staticData: { titleKey: "chains.onboard.title" },
  component: OnboardScreen,
});

const JURISDICTION_PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface FormErrors {
  name?: string;
  code?: string;
  jurisdiction?: string;
}

function OnboardScreen() {
  const { principal } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useI18n();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [jurisdiction, setJurisdiction] = useState("IN-KA");
  const [tier, setTier] = useState<LicenceTier>("gold");
  const [errors, setErrors] = useState<FormErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const canOnboard = principal.permissions.includes("chain.onboard");
  const summaryId = "onboard-validation-summary";

  function validate(): FormErrors {
    const next: FormErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) next.name = t("validation.required", { field: t("chains.onboard.name.label") });
    else if (trimmedName.length < 3)
      next.name = t("validation.tooShort", { field: t("chains.onboard.name.label"), min: 3 });

    const trimmedCode = code.trim();
    if (trimmedCode && !CODE_PATTERN.test(trimmedCode)) {
      next.code = t("validation.pattern", { field: t("chains.onboard.code.label") });
    }
    const trimmedJurisdiction = jurisdiction.trim().toUpperCase();
    if (trimmedJurisdiction && !JURISDICTION_PATTERN.test(trimmedJurisdiction)) {
      next.jurisdiction = t("validation.pattern", { field: t("chains.onboard.jurisdiction.label") });
    }
    return next;
  }

  const liveErrors = validate();
  const shown: FormErrors = attempted ? { ...liveErrors, ...errors } : {};
  const errorList = Object.values(shown).filter((value): value is string => Boolean(value));

  async function submit() {
    const found = validate();
    setErrors(found);
    setAttempted(true);
    if (Object.keys(found).length > 0) {
      setConfirming(false);
      document.getElementById(summaryId)?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    const response = await onboardChainFn({
      data: {
        name: name.trim(),
        code: code.trim().toLowerCase(),
        licenceTier: tier,
        taxJurisdiction: jurisdiction.trim().toUpperCase(),
      },
    });
    setBusy(false);
    setConfirming(false);
    if (!response.ok) {
      setServerError(response.message);
      return;
    }
    await router.invalidate();
    await router.navigate({ to: "/chains/$chainId", params: { chainId: response.chain.id } });
  }

  if (!canOnboard) {
    return (
      <>
        <PageHeader eyebrow={t("chains.onboard.eyebrow")} title={t("chains.onboard.title")} description={t("chains.onboard.description")} />
        <div className="p-4">
          <Card>
            <PermissionDenied
              title={t("chains.onboard.denied.title")}
              description={t("chains.onboard.denied.description")}
              requiredPermission="chain.onboard"
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
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={t("chains.onboard.eyebrow")}
        title={t("chains.onboard.title")}
        description={t("chains.onboard.description")}
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              void router.navigate({ to: "/chains" });
            }}
          >
            {t("action.cancel")}
          </Button>
        }
      />

      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        {serverError ? (
          <Banner tone="danger" title={t("error.title")}>
            {serverError}
          </Banner>
        ) : null}

        {errorList.length > 0 ? (
          <div tabIndex={-1} id={summaryId}>
            <ValidationSummary
              id={`${summaryId}-inner`}
              title={errorList.length === 1 ? t("validation.summary.one") : t("validation.summary.other", { count: errorList.length })}
              items={errorList}
            />
          </div>
        ) : null}

        <Card>
          <CardHeader title={t("chains.onboard.section.identity")} />
          <div className="flex flex-col gap-3 p-4">
            <Field
              id="chain-name"
              label={t("chains.onboard.name.label")}
              hint={t("chains.onboard.name.hint")}
              error={shown.name ?? null}
              required
            >
              <TextInput
                value={name}
                onChange={setName}
                placeholder={t("chains.onboard.name.placeholder")}
                autoComplete="off"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="chain-code"
                label={t("chains.onboard.code.label")}
                hint={t("chains.onboard.code.hint")}
                error={shown.code ?? null}
                aside={t("common.optional")}
              >
                <TextInput
                  value={code}
                  onChange={(value) => {
                    setCode(value.toLowerCase());
                  }}
                  placeholder={t("chains.onboard.code.placeholder")}
                />
              </Field>

              <Field
                id="chain-jurisdiction"
                label={t("chains.onboard.jurisdiction.label")}
                hint={t("chains.onboard.jurisdiction.hint")}
                error={shown.jurisdiction ?? null}
              >
                <TextInput
                  value={jurisdiction}
                  onChange={(value) => {
                    setJurisdiction(value.toUpperCase());
                  }}
                  placeholder="IN-KA"
                  maxLength={6}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("chains.onboard.section.licence")} subtitle={t("chains.tier.help")} />
          <div className="flex flex-col gap-3 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="chain-tier" label={t("chains.onboard.tier.label")}>
                <Select<LicenceTier>
                  id="chain-tier"
                  ariaLabel={t("chains.onboard.tier.label")}
                  value={tier}
                  onChange={setTier}
                  options={[
                    { value: "silver", label: t("chains.tier.silver") },
                    { value: "gold", label: t("chains.tier.gold") },
                    { value: "platinum", label: t("chains.tier.platinum") },
                  ]}
                />
              </Field>
              <div className="flex items-end gap-2 pb-1">
                <TierBadge tier={tier} />
                <span className="text-xs text-fg-muted">{t("chains.tier.help")}</span>
              </div>
            </div>

            <div className="grid gap-2 rounded-md border border-border bg-surface-sunken p-3 text-xs text-fg-muted">
              <p className="flex items-start gap-1.5">
                <span className="mt-px shrink-0 text-fg-subtle" aria-hidden="true">
                  <Layers size={13} />
                </span>
                {t("chains.onboard.features.hint")}
              </p>
              <p className="flex items-start gap-1.5">
                <span className="mt-px shrink-0 text-fg-subtle" aria-hidden="true">
                  <Lock size={13} />
                </span>
                {t("chains.detail.tier.subtitle")}
              </p>
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-2xs text-fg-subtle">{t("chains.onboard.description")}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void router.navigate({ to: "/chains" });
              }}
            >
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              aria-describedby={errorList.length > 0 ? summaryId : undefined}
              onClick={() => {
                const found = validate();
                setErrors(found);
                setAttempted(true);
                if (Object.keys(found).length > 0) {
                  document.getElementById(summaryId)?.focus();
                  return;
                }
                setConfirming(true);
              }}
            >
              {t("chains.onboard.submit")}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("chains.onboard.review.title")}
        description={t("chains.onboard.review.body")}
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
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {busy ? t("chains.onboard.submitting") : t("chains.onboard.review.confirm")}
            </Button>
          </>
        }
      >
        <ConfirmSummary
          items={[
            { label: t("chains.onboard.name.label"), value: name.trim() || t("common.none") },
            { label: t("chains.onboard.code.label"), value: code.trim() || slugPreview(name) },
            { label: t("chains.onboard.tier.label"), value: <TierBadge tier={tier} /> },
            { label: t("chains.onboard.jurisdiction.label"), value: jurisdiction.trim().toUpperCase() || t("common.none") },
          ]}
        />
      </Dialog>
    </>
  );
}

/** Mirrors the domain's slug rule so the confirm dialog shows the code that will exist. */
function slugPreview(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
