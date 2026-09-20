import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { DataTable, type Column } from "~/components/DataTable";
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
  Note,
  PageHeader,
  PermissionDenied,
  Select,
  TextInput,
} from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { SupportAccessRequestView } from "~/domain/support";
import {
  decideSupportAccessRequestFn,
  listSupportAccessFn,
  requestSupportAccessFn,
} from "~/server-fns";

/**
 * Time-boxed chain access.
 *
 * The whole point of this screen is that access is *asked for*, *decided by someone with
 * the authority*, and *stops on its own*: a request grants nothing, an approval writes a
 * scope grant with an expiry, and the resolver refuses an expired grant on the next
 * request rather than relying on a cleanup job. It is also readable by the chain, who can
 * see who at OmniHost.ai has access to their data and why — which is why the reason field
 * is copied onto the grant.
 */
export const Route = createFileRoute("/_shell/support/access")({
  staticData: { titleKey: "support.access.title" },
  loader: async () => listSupportAccessFn(),
  component: SupportAccessScreen,
});

function SupportAccessScreen() {
  const result = Route.useLoaderData();
  const { t, format } = useI18n();
  const router = useRouter();

  const [chainId, setChainId] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<{ request: SupportAccessRequestView; approve: boolean } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const access = result.ok ? result.access : null;

  async function submitRequest() {
    if (!chainId) {
      setFormError(t("validation.required", { field: t("support.access.request.chain.label") }));
      return;
    }
    if (reason.trim().length < 10) {
      setFormError(t("validation.tooShort", { field: t("support.access.request.reason.label"), min: 10 }));
      return;
    }
    setBusy(true);
    const response = await requestSupportAccessFn({
      data: { chainId, reason, requestedHours: Number(hours) },
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    const chain = access?.chains.find((entry) => entry.id === chainId);
    setError(null);
    setFormError(null);
    setReason("");
    setNotice(t("support.access.request.saved", { chain: chain?.name ?? t("common.unknown") }));
    await router.invalidate();
  }

  async function decide() {
    if (!decision) return;
    setBusy(true);
    const response = await decideSupportAccessRequestFn({
      data: { requestId: decision.request.id, approve: decision.approve, note: decisionNote },
    });
    setBusy(false);
    setDecision(null);
    setDecisionNote("");
    if (!response.ok) {
      setError(response.message);
      return;
    }
    setError(null);
    setNotice(t("support.access.decide.saved"));
    await router.invalidate();
  }

  if (!result.ok && result.status === 403) {
    return (
      <PermissionDenied
        title={t("error.forbidden.title")}
        description={t("error.forbidden.description")}
        requiredPermission="support.access.request"
      />
    );
  }

  const columns: Column<SupportAccessRequestView>[] = [
    {
      key: "requester",
      header: t("support.access.column.requester"),
      sortValue: (row) => row.requestedBy,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-xs text-fg">{row.requestedBy}</span>
          <span className="text-2xs text-fg-subtle">
            <TimestampValue value={row.createdAt} mode="relative" />
          </span>
        </span>
      ),
    },
    {
      key: "chain",
      header: t("support.access.column.chain"),
      sortValue: (row) => row.chainName,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-xs text-fg">{row.chainName}</span>
          <span className="text-2xs text-fg-subtle">
            {row.ticketReference
              ? t("support.access.ticket", { reference: row.ticketReference })
              : t("support.access.noTicket")}
          </span>
        </span>
      ),
    },
    {
      key: "reason",
      header: t("support.access.column.reason"),
      sortValue: (row) => row.reason,
      render: (row) => <span className="text-xs text-fg-muted">{row.reason}</span>,
    },
    {
      key: "hours",
      header: t("support.access.column.hours"),
      sortValue: (row) => row.requestedHours,
      render: (row) => <span className="text-xs text-fg-muted">{format.integer(row.requestedHours)}h</span>,
    },
    {
      key: "status",
      header: t("support.access.column.status"),
      sortValue: (row) => row.status,
      render: (row) => (
        <span className="flex flex-col gap-1">
          <Badge tone={row.status === "approved" ? "ok" : row.status === "denied" ? "danger" : "info"}>
            {t(`support.access.status.${row.status}` as never)}
          </Badge>
          {row.decidedBy ? (
            <span className="text-2xs text-fg-subtle">
              {t("support.access.decidedAt", { when: "", who: row.decidedBy })}
            </span>
          ) : (
            <span className="text-2xs text-fg-subtle">{t("support.access.awaitingDecision")}</span>
          )}
        </span>
      ),
    },
    {
      key: "grant",
      header: t("support.access.column.grant"),
      sortValue: (row) => row.grantExpiresAt ?? "",
      render: (row) => <TimestampValue value={row.grantExpiresAt} mode="dateTime" className="text-xs" />,
    },
    {
      key: "actions",
      header: t("common.actions"),
      render: (row) =>
        access?.canDecide && row.status === "pending" ? (
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDecision({ request: row, approve: true });
                setDecisionNote("");
              }}
            >
              {t("support.access.decide.approve")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDecision({ request: row, approve: false });
                setDecisionNote("");
              }}
            >
              {t("support.access.decide.deny")}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t("support.access.eyebrow")}
        title={t("support.access.title")}
        description={t("support.access.description")}
      />

      <div className="flex flex-col gap-4">
        {notice ? <Banner tone="ok" compact>{notice}</Banner> : null}
        {error ? <Banner tone="danger" compact>{error}</Banner> : null}
        {!result.ok ? (
          <ErrorState title={t("error.title")} description={t("error.description")} detail={result.message} />
        ) : null}

        <Card>
          <CardHeader title={t("support.access.grants.title")} />
          <div className="p-4">
            {access && access.grants.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {access.grants.map((grant) => (
                  <li key={grant.grantId} className="flex flex-col gap-1 border-s-2 border-accent ps-3">
                    <span className="text-sm text-fg">
                      {t("support.access.grants.line", {
                        chain: grant.chainName ?? grant.chainId,
                        when: "",
                      })}
                      <TimestampValue value={grant.expiresAt} mode="dateTime" className="ms-2 text-xs text-fg-subtle" />
                    </span>
                    <span className="text-2xs text-fg-muted">{grant.reason}</span>
                    <code className="font-mono text-2xs text-fg-subtle">{grant.permissions.join(" ")}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title={t("support.access.grants.title")}
                description={t("support.access.grants.empty")}
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("support.access.request.title")}
            subtitle={t("support.access.request.subtitle")}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <Field
              id="access-chain"
              label={t("support.access.request.chain.label")}
              error={formError && !chainId ? formError : null}
              required
            >
              <Select
                value={chainId}
                onChange={setChainId}
                emptyLabel={t("support.access.request.chain.placeholder")}
                options={(access?.chains ?? []).map((chain) => ({ value: chain.id, label: chain.name }))}
              />
            </Field>
            <Field
              id="access-hours"
              label={t("support.access.request.hours.label")}
              hint={t("support.access.request.hours.hint")}
              required
            >
              <TextInput value={hours} onChange={setHours} inputMode="numeric" />
            </Field>
            <Field
              id="access-reason"
              label={t("support.access.request.reason.label")}
              hint={t("support.access.request.reason.hint")}
              error={formError && chainId ? formError : null}
              required
            >
              <TextInput value={reason} onChange={setReason} />
            </Field>
            <div className="sm:col-span-3">
              <Button variant="primary" disabled={busy} onClick={() => { void submitRequest(); }}>
                {t("support.access.request.submit")}
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("support.access.requests.title")}
            subtitle={access && !access.canDecide ? t("support.access.notDecider") : undefined}
          />
          <div className="p-0">
            <DataTable
              columns={columns}
              rows={access?.requests ?? []}
              getRowId={(row) => row.id}
              caption={t("support.access.requests.title")}
              empty={
                <EmptyState
                  title={t("support.access.requests.empty")}
                  description={t("support.access.request.subtitle")}
                />
              }
            />
          </div>
        </Card>

        {access?.canDecide ? (
          <Note tone="info" title={t("support.access.decide.title", { who: "" })}>
            {t("support.access.decide.body")}
          </Note>
        ) : null}
      </div>

      <Dialog
        open={decision !== null}
        onClose={() => { setDecision(null); }}
        title={
          decision?.approve
            ? t("support.access.decide.title", { who: decision.request.requestedBy })
            : t("support.access.decide.deny")
        }
        description={decision ? t("support.access.decide.body") : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setDecision(null); }}>
              {t("action.cancel")}
            </Button>
            <Button
              variant={decision?.approve ? "primary" : "danger"}
              disabled={busy}
              onClick={() => { void decide(); }}
            >
              {decision?.approve ? t("support.access.decide.cta") : t("support.access.decide.denyCta")}
            </Button>
          </>
        }
      >
        {decision ? (
          <div className="flex flex-col gap-3">
            <DescriptionList
              columns={1}
              items={[
                { label: t("support.access.column.requester"), value: decision.request.requestedBy },
                { label: t("support.access.column.chain"), value: decision.request.chainName },
                { label: t("support.access.column.reason"), value: decision.request.reason },
                {
                  label: t("support.access.column.hours"),
                  value: `${format.integer(decision.request.requestedHours)}h`,
                },
              ]}
            />
            <Field id="decision-note" label={t("support.access.decide.note.label")}>
              <TextInput value={decisionNote} onChange={setDecisionNote} />
            </Field>
            <ConfirmSummary
              items={[
                {
                  label: t("support.access.column.status"),
                  value: decision.approve
                    ? t("support.access.status.approved")
                    : t("support.access.status.denied"),
                },
              ]}
            />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
