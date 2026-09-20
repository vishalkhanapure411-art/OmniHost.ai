import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ChainMaster } from "~/components/ChainMaster";
import { MasterDetail, MasterHeader } from "~/components/MasterDetail";
import { Badge, Button, Card, CardHeader, Field, Note, PageHeader, Select, TextInput } from "~/components/ui";
import type { LicenceTier } from "~/domain/chains";
import { listChainsFn, onboardChainFn } from "~/server-fns";

/**
 * Chains — the AppAdmin slice's list and its onboarding action.
 * Spec example intent: "Onboard chain X on Platinum".
 */
export const Route = createFileRoute("/_shell/chains/")({
  staticData: { title: "Chains" },
  loader: async () => listChainsFn(),
  component: ChainsScreen,
});

function ChainsScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const router = useRouter();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [tier, setTier] = useState<LicenceTier>("gold");
  const [jurisdiction, setJurisdiction] = useState("IN-KA");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canOnboard = principal.permissions.includes("chain.onboard");
  const canRead = principal.permissions.includes("chain.read");
  const chains = result.ok ? result.chains : [];

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await onboardChainFn({
      data: { name, code, licenceTier: tier, taxJurisdiction: jurisdiction },
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    setName("");
    setCode("");
    await router.invalidate();
    await router.navigate({ to: "/chains/$chainId", params: { chainId: response.chain.id } });
  }

  return (
    <>
      <PageHeader
        eyebrow="App layer · Licensing"
        title="Chains"
        description="Onboard a tenant, set its licence tier and switch its features. Tier is per chain — every site in a chain runs the same tier."
      />
      <MasterDetail
        masterLabel="Chain list"
        master={
          <>
            <MasterHeader title="Chains in your scope" count={chains.length} />
            {result.ok ? (
              <ChainMaster chains={chains} canRead={canRead} />
            ) : (
              <p className="px-3 py-6 text-xs text-danger">{result.message}</p>
            )}
          </>
        }
        detail={
          <div className="flex flex-col gap-4 p-4">
            <Card>
              <CardHeader
                title="Onboard a chain"
                subtitle="Creates the tenant, its tier and its feature toggles in one audited transaction."
              />
              <div className="flex flex-col gap-3 p-4">
                {!canOnboard ? (
                  <Note tone="warn">
                    Your resolved registry does not include <code className="font-mono">chain.onboard</code>
                    , so this form is shown for reference only — the server would refuse the call with a
                    403. Spec capability table: chain onboarding is AppAdmin's, and AppSupport never
                    holds it.
                  </Note>
                ) : null}
                <Field label="Chain name">
                  <TextInput value={name} onChange={setName} placeholder="e.g. Saffron Table Hospitality" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Code" hint="Lowercase slug; derived from the name if left blank.">
                    <TextInput value={code} onChange={setCode} placeholder="saffron-table" />
                  </Field>
                  <Field label="Tax jurisdiction">
                    <TextInput value={jurisdiction} onChange={setJurisdiction} placeholder="IN-KA" />
                  </Field>
                </div>
                <Field
                  label="Licence tier"
                  hint="Silver / Gold / Platinum gate module depth and AI variants, never which roles exist."
                >
                  <Select
                    ariaLabel="Licence tier"
                    value={tier}
                    onChange={setTier}
                    options={[
                      { value: "silver", label: "Silver" },
                      { value: "gold", label: "Gold" },
                      { value: "platinum", label: "Platinum" },
                    ]}
                  />
                </Field>
                {error ? <Note tone="danger">{error}</Note> : null}
                <div className="flex items-center justify-between">
                  <p className="text-2xs text-fg-subtle">
                    Every registry feature gets a row, so the detail screen shows the whole picture.
                  </p>
                  <Button variant="primary" disabled={busy || !canOnboard} onClick={() => void submit()}>
                    {busy ? "Onboarding…" : "Onboard chain"}
                  </Button>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="What your identity holds" subtitle="Resolved server-side on every request." />
              <ul className="flex flex-wrap gap-1 p-4">
                {principal.permissions.map((code) => (
                  <li key={code}>
                    <Badge tone={code.startsWith("chain.") ? "accent" : "neutral"}>{code}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        }
      />
    </>
  );
}
