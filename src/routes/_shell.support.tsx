import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "~/components/DataTable";
import { DetailHeader, ListToolbar, MasterDetail } from "~/components/MasterDetail";
import { SeverityBadge } from "~/components/status";
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
  Textarea,
  TextInput,
} from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { useI18n } from "~/i18n";
import type { SupportTicketView } from "~/domain/support";
import {
  assignSupportTicketFn,
  listSupportTicketsFn,
  requestSupportAccessFn,
  resolveSupportTicketFn,
  useSupportAccessFn,
} from "~/server-fns";

/**
 * The AppSupport queue.
 *
 * Three claims this screen has to make visible rather than assert:
 *   1. Ticket actions are scoped to a chain, and the scope comes from the caller's
 *      grants — a ticket for a chain outside them is shown with its actions withdrawn
 *      and the reason stated, because the server refuses those actions either way.
 *   2. Assignment and resolution are separate capabilities, each with its own audit row.
 *   3. Time-boxed access is a *use*, recorded when an operator opens a chain under it —
 *      not an assumption made from the fact that a grant exists.
 *
 * Every write goes through the same domain function the HTTP API and the future chatbot
 * tool will call, then re-reads from the server rather than trusting the response.
 */
export const Route = createFileRoute("/_shell/support")({
  staticData: { titleKey: "support.title" },
  loader: async () => listSupportTicketsFn({ data: {} }),
  component: SupportQueueScreen,
});

const STATUS_FILTERS = ["", "new", "triaged", "assigned", "waiting", "resolved"] as const;

function SupportQueueScreen() {
  const result = Route.useLoaderData();
  const { principal } = Route.useRouteContext();
  const { t, format } = useI18n();
  const router = useRouter();

  const [status, setStatus] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pendingAssign, setPendingAssign] = useState<string | null | undefined>(undefined);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestReason, setRequestReason] = useState("");
  const [requestHours, setRequestHours] = useState("24");

  const queue = result.ok ? result.queue : null;
  const tickets = queue?.tickets ?? [];
  const filtered = useMemo(
    () => (status === "" ? tickets : tickets.filter((ticket) => ticket.status === status)),
    [status, tickets]
  );
  const selected = filtered.find((ticket) => ticket.id === selectedId) ?? filtered[0] ?? null;

  async function afterWrite(response: { ok: boolean; message?: string }, success: string) {
    setBusy(false);
    if (!response.ok) {
      setError(response.message ?? t("error.description"));
      return;
    }
    setError(null);
    setNotice(success);
    await router.invalidate();
  }

  async function applyAssignment() {
    if (!selected || pendingAssign === undefined) return;
    setBusy(true);
    const response = await assignSupportTicketFn({
      data: { ticketId: selected.id, assignToUserId: pendingAssign },
    });
    setPendingAssign(undefined);
    await afterWrite(response, t("support.detail.assignment.saved"));
  }

  async function applyResolution() {
    if (!selected) return;
    if (resolveNote.trim().length < 10) {
      setResolveError(t("validation.tooShort", { field: t("support.detail.resolve.note.label"), min: 10 }));
      return;
    }
    setBusy(true);
    const response = await resolveSupportTicketFn({ data: { ticketId: selected.id, note: resolveNote } });
    setResolveOpen(false);
    setResolveNote("");
    setResolveError(null);
    await afterWrite(response, t("support.detail.resolve.saved", { reference: selected.reference }));
  }

  async function openUnderAccess() {
    if (!selected?.chainId) return;
    setBusy(true);
    const response = await useSupportAccessFn({ data: { chainId: selected.chainId } });
    if (response.ok) {
      setNotice(
        t("support.detail.access.opened", {
          chain: selected.chainName ?? t("common.unknown"),
          when: "",
        })
      );
      setError(null);
      setBusy(false);
      await router.invalidate();
      return;
    }
    setError(response.message);
    setBusy(false);
  }

  async function submitAccessRequest() {
    if (!selected?.chainId) return;
    if (requestReason.trim().length < 10) {
      setError(t("validation.tooShort", { field: t("support.access.request.reason.label"), min: 10 }));
      return;
    }
    setBusy(true);
    const response = await requestSupportAccessFn({
      data: {
        chainId: selected.chainId,
        reason: requestReason,
        requestedHours: Number(requestHours),
        ticketId: selected.id,
      },
    });
    if (response.ok) {
      setRequestOpen(false);
      setRequestReason("");
      await afterWrite(
        response,
        t("support.access.request.saved", { chain: selected.chainName ?? t("common.unknown") })
      );
      return;
    }
    setBusy(false);
    setError(response.message);
  }

  if (!result.ok && result.status === 403) {
    return (
      <PermissionDenied
        title={t("error.forbidden.title")}
        description={t("error.forbidden.description")}
        requiredPermission="support.ticket.read"
        action={
          <Button variant="secondary" onClick={() => { void router.invalidate(); }}>
            {t("action.retry")}
          </Button>
        }
      />
    );
  }

  const columns: Column<SupportTicketView>[] = [
    {
      key: "reference",
      header: t("support.column.reference"),
      sortValue: (row) => row.reference,
      render: (row) => (
        <span className="flex flex-col">
          <code className="font-mono text-xs text-fg">{row.reference}</code>
          <span className="text-2xs text-fg-subtle">
            <TimestampValue value={row.createdAt} mode="relative" />
          </span>
        </span>
      ),
    },
    {
      key: "subject",
      header: t("support.column.subject"),
      sortValue: (row) => row.subject,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-xs text-fg">{row.subject}</span>
          <span className="text-2xs text-fg-subtle">
            {row.chainName ?? t("audit.platform")}
            {row.siteName ? ` · ${row.siteName}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "severity",
      header: t("support.column.severity"),
      sortValue: (row) => row.severity,
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    {
      key: "status",
      header: t("support.column.status"),
      sortValue: (row) => row.status,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={row.status === "resolved" || row.status === "closed" ? "ok" : "info"}>
            {t(`support.status.${row.status}` as never)}
          </Badge>
          {row.overdue ? <Badge tone="danger">{t("support.overdue")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "assigned",
      header: t("support.column.assigned"),
      sortValue: (row) => row.assignedTo ?? "",
      render: (row) => (
        <span className="text-xs text-fg-muted">
          {row.assignedTo ?? t("support.detail.assignment.unassigned")}
        </span>
      ),
    },
    {
      key: "due",
      header: t("support.column.due"),
      sortValue: (row) => row.responseDueAt ?? "",
      render: (row) => <TimestampValue value={row.responseDueAt} mode="dateTime" className="text-xs" />,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t("support.eyebrow")}
        title={t("support.title")}
        description={t("support.description")}
        meta={
          queue ? (
            <>
              <span className="text-2xs text-fg-subtle">{t("support.count.open", { count: format.integer(queue.counts.open) })}</span>
              <span className="text-2xs text-fg-subtle">{t("support.count.overdue", { count: format.integer(queue.counts.overdue) })}</span>
              <span className="text-2xs text-fg-subtle">{t("support.count.resolved", { count: format.integer(queue.counts.resolved) })}</span>
            </>
          ) : undefined
        }
      />

      <MasterDetail
        masterLabel={t("a11y.masterPane")}
        master={
          <>
            <ListToolbar
              filter={
                <Field id="support-status-filter" label={t("support.filter.status.label")}>
                  <Select
                    value={status}
                    onChange={setStatus}
                    options={STATUS_FILTERS.map((value) => ({
                      value,
                      label: value === "" ? t("support.filter.all") : t(`support.status.${value}` as never),
                    }))}
                  />
                </Field>
              }
              meta={queue ? format.integer(filtered.length) : undefined}
              actions={
                <Button size="sm" variant="quiet" onClick={() => { void router.invalidate(); }}>
                  {t("action.refresh")}
                </Button>
              }
            />
            {!result.ok ? (
              <ErrorState
                title={t("error.title")}
                description={t("error.description")}
                detail={result.message}
                action={
                  <Button variant="secondary" onClick={() => { void router.invalidate(); }}>
                    {t("action.retry")}
                  </Button>
                }
              />
            ) : (
              <DataTable
                columns={columns}
                rows={filtered}
                getRowId={(row) => row.id}
                caption={t("support.title")}
                selectedId={selected?.id}
                onSelect={(row) => { setSelectedId(row.id); }}
                stickyHeader={false}
                empty={
                  <EmptyState
                    title={t("support.queue.empty.title")}
                    description={t("support.queue.empty.description")}
                  />
                }
              />
            )}
          </>
        }
        detail={
          !selected ? (
            <div className="p-4">
              <EmptyState
                title={t("support.detail.noSelection.title")}
                description={t("support.detail.noSelection.description")}
              />
            </div>
          ) : (
            <div className="flex flex-col">
              <DetailHeader
                eyebrow={t("support.detail.eyebrow")}
                title={selected.subject}
                meta={
                  <>
                    <code className="font-mono text-2xs text-fg-subtle">{selected.reference}</code>
                    <SeverityBadge severity={selected.severity} />
                    <Badge tone={selected.status === "resolved" ? "ok" : "info"}>
                      {t(`support.status.${selected.status}` as never)}
                    </Badge>
                    {selected.overdue ? <Badge tone="danger">{t("support.overdue")}</Badge> : null}
                  </>
                }
              />

              <div className="flex flex-col gap-4 p-4">
                {notice ? <Banner tone="ok" compact>{notice}</Banner> : null}
                {error ? <Banner tone="danger" compact>{error}</Banner> : null}

                {!selected.reachable ? (
                  <Note tone="warn" title={t("support.detail.unreachable.title")}>
                    {t("support.detail.unreachable.description")}
                  </Note>
                ) : null}

                <Card>
                  <CardHeader title={t("support.detail.summary")} />
                  <div className="flex flex-col gap-3 p-4">
                    <p className="text-sm text-fg-muted">{selected.detail}</p>
                    <DescriptionList
                      columns={2}
                      items={[
                        {
                          label: t("support.column.chain"),
                          value: selected.chainName ?? <span>{t("audit.platform")}</span>,
                        },
                        {
                          label: t("support.column.source"),
                          value: t(`support.source.${selected.source}` as never),
                        },
                        {
                          label: t("audit.column.actor"),
                          value: selected.raisedBy ?? selected.raisedByLabel ?? t("common.unknown"),
                        },
                        {
                          label: t("support.column.due"),
                          value: <TimestampValue value={selected.responseDueAt} mode="dateTime" />,
                        },
                      ]}
                    />
                    <p className="text-2xs text-fg-subtle">
                      {selected.chainId === null ? t("support.detail.noChain") : t("support.detail.chainScoped")}
                    </p>
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    title={t("support.detail.assignment.title")}
                    subtitle={t("support.detail.assignment.subtitle")}
                  />
                  <div className="flex flex-col gap-3 p-4">
                    <Field
                      id="support-assignee"
                      label={t("support.detail.assignment.label")}
                      hint={queue?.canAssign ? undefined : t("error.forbidden.needs", { permission: "support.ticket.assign" })}
                    >
                      <Select
                        value={selected.assignedUserId ?? ""}
                        disabled={!selected.reachable || !queue?.canAssign}
                        onChange={(value) => { setPendingAssign(value === "" ? null : value); }}
                        emptyLabel={t("support.detail.assignment.unassigned")}
                        options={(queue?.agents ?? []).map((agent) => ({
                          value: agent.userId,
                          label: agent.displayName,
                        }))}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      {queue?.canAssign ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy || !selected.reachable}
                          onClick={() => { setPendingAssign(principal.userId); }}
                        >
                          {t("support.detail.assignment.take")}
                        </Button>
                      ) : null}
                      {queue?.canAssign && selected.assignedUserId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !selected.reachable}
                          onClick={() => { setPendingAssign(null); }}
                        >
                          {t("support.detail.assignment.release")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </Card>

                <Card>
                  <CardHeader title={t("support.detail.sla.title")} />
                  <div className="p-4">
                    <DescriptionList
                      columns={2}
                      items={[
                        {
                          label: t("support.detail.sla.response"),
                          value: <TimestampValue value={selected.responseDueAt} mode="dateTime" />,
                        },
                        {
                          label: t("support.detail.sla.resolve"),
                          value: <TimestampValue value={selected.resolveDueAt} mode="dateTime" />,
                        },
                      ]}
                    />
                    <Note tone="info" compact>
                      {t("support.detail.escalation.pending")}
                    </Note>
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    title={t("support.detail.access.title")}
                    subtitle={t("support.detail.access.subtitle")}
                  />
                  <div className="flex flex-col gap-2 p-4">
                    {selected.chainId ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy || !selected.reachable}
                          onClick={() => { void openUnderAccess(); }}
                        >
                          {t("support.detail.access.open")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => { setRequestOpen(true); }}
                        >
                          {t("support.detail.access.request")}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-fg-muted">{t("support.detail.noChain")}</p>
                    )}
                  </div>
                </Card>

                {selected.status !== "resolved" && selected.status !== "closed" ? (
                  <Card>
                    <CardHeader
                      title={t("support.detail.resolve.title")}
                      subtitle={t("support.detail.resolve.subtitle")}
                    />
                    <div className="flex flex-col gap-3 p-4">
                      <Field
                        id="support-resolution"
                        label={t("support.detail.resolve.note.label")}
                        hint={t("support.detail.resolve.note.hint")}
                        error={resolveError}
                      >
                        <Textarea
                          value={resolveNote}
                          onChange={(value) => {
                            setResolveNote(value);
                            setResolveError(null);
                          }}
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="primary"
                          disabled={busy || !selected.reachable || !queue?.canResolve}
                          onClick={() => { setResolveOpen(true); }}
                        >
                          {t("support.detail.resolve.submit")}
                        </Button>
                        {!queue?.canResolve ? (
                          <Note tone="warn" compact>
                            {t("error.forbidden.needs", { permission: "support.ticket.resolve" })}
                          </Note>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                ) : (
                  <Card>
                    <CardHeader title={t("support.detail.resolutionNote")} />
                    <div className="flex flex-col gap-1 p-4 text-xs text-fg-muted">
                      <p>{selected.resolutionNote ?? t("common.none")}</p>
                      <p className="text-2xs text-fg-subtle">
                        {selected.resolvedAt ? (
                          <TimestampValue value={selected.resolvedAt} mode="weekday" />
                        ) : null}
                      </p>
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )
        }
      />

      <Dialog
        open={pendingAssign !== undefined}
        onClose={() => { setPendingAssign(undefined); }}
        title={t("support.detail.assignment.title")}
        description={selected?.subject}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPendingAssign(undefined); }}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" onClick={() => { void applyAssignment(); }}>
              {t("action.confirm")}
            </Button>
          </>
        }
      >
        <ConfirmSummary
          items={[
            { label: t("support.column.reference"), value: selected?.reference ?? t("common.none") },
            {
              label: t("support.detail.assignment.label"),
              value: pendingAssign
                ? ((queue?.agents ?? []).find((agent) => agent.userId === pendingAssign)?.displayName ??
                    t("common.unknown"))
                : t("support.detail.assignment.unassigned"),
            },
          ]}
        />
      </Dialog>

      <Dialog
        open={resolveOpen}
        onClose={() => { setResolveOpen(false); }}
        title={t("support.detail.resolve.submit")}
        description={selected?.subject}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setResolveOpen(false); }}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => { void applyResolution(); }}>
              {t("support.detail.resolve.cta")}
            </Button>
          </>
        }
      >
        <ConfirmSummary
          items={[
            { label: t("support.column.reference"), value: selected?.reference ?? t("common.none") },
            { label: t("support.detail.resolve.note.label"), value: resolveNote || t("common.none") },
          ]}
        />
      </Dialog>

      <Dialog
        open={requestOpen}
        onClose={() => { setRequestOpen(false); }}
        title={t("support.detail.access.request")}
        description={selected?.chainName ?? undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setRequestOpen(false); }}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => { void submitAccessRequest(); }}>
              {t("support.access.request.submit")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            id="support-request-reason"
            label={t("support.access.request.reason.label")}
            hint={t("support.access.request.reason.hint")}
            required
          >
            <TextInput value={requestReason} onChange={setRequestReason} />
          </Field>
          <Field
            id="support-request-hours"
            label={t("support.access.request.hours.label")}
            hint={t("support.access.request.hours.hint")}
            required
          >
            <TextInput value={requestHours} onChange={setRequestHours} inputMode="numeric" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
