import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  PermissionDenied,
  Select,
  TextInput,
  Toggle,
} from "~/components/ui";
import { CodeLabel, NoValue, TimestampValue } from "~/components/values";
import { DISPLAY_KINDS, DISPLAY_TRANSPORTS } from "~/domain/display";
import type { DisplayEstate, DisplayRecord } from "~/domain/display-estate";
import type { OutletView } from "~/domain/mdm-sites";
import { useI18n } from "~/i18n";
import { codedMessage, codeLabel, tierLabel } from "~/i18n/labels";
import type { MessageKey } from "~/i18n/catalog-en";
import {
  deactivateDisplayFn,
  pairDisplayFn,
  registerDisplayFn,
  revokeDisplayCredentialFn,
} from "~/server-fns";
/**
 * S4 — the display estate, as a section on the site record (`DESIGN-kds-and-ticket-routing`
 * §6.1, §6.6): the screen an operator uses to see the terminals at a site's outlets, put one
 * on a station, pair it, withdraw its access and deactivate it.
 *
 * The rules this file is written to, and where each one is:
 *
 *   * **The domain decides, the screen renders.** Every mutation calls the merged domain
 *     function through its own server function: capability checks, the tenant resolved from
 *     the row, one transaction, one audit row. Nothing here computes a rule — not even the
 *     gate's precedence, which arrives as `estate.gates` from the domain so this file cannot
 *     get it wrong or collapse the two sentences into one (§6.8's discipline, applied to
 *     logic as well as words).
 *   * **The pairing code is shown once and never held.** `display.pairing.once` says so in
 *     words, a lost code is answered with "pair the terminal again", and the code leaves this
 *     component's state the moment the dialog closes. No read model in the platform returns
 *     it, so there is nothing to show a second time.
 *   * **Codes stay codes in identifier positions.** A display code and a station code are mono
 *     (`CodeLabel`), a station is *named* in words beside its code, and every state, type and
 *     transport is worded through a closed map with a worded unrecognised case — an unmapped
 *     value shows its own code, never a neighbouring word
 *     (`FINDINGS-label-fallback-sweep.md`).
 *   * **The two gates are never collapsed.** When neither gated feature is open, no write is
 *     offered and each feature names the gate holding it, in that gate's own sentence.
 *   * **The per-chain boundary is code, not RLS** (DECISIONS.md:8). The estate arrives already
 *     scoped to one outlet by the server; the station picker offers that outlet's own stations
 *     and nothing else, and the server re-checks the station against the outlet.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** A display's state, worded through a closed map with a worded case for anything else. */
type DisplayStateKey =
  | "notPaired"
  | "pairingPending"
  | "paired"
  | "accessWithdrawn"
  | "inactive"
  | "unrecognised";

const DISPLAY_STATE_LABEL: Record<DisplayStateKey, MessageKey> = {
  notPaired: "display.state.notPaired",
  pairingPending: "display.state.pairingPending",
  paired: "display.state.paired",
  accessWithdrawn: "display.state.accessWithdrawn",
  inactive: "display.state.inactive",
  unrecognised: "display.state.unrecognised",
};

const STATE_TONE: Record<DisplayStateKey, "ok" | "warn" | "neutral" | "accent"> = {
  notPaired: "neutral",
  pairingPending: "accent",
  paired: "ok",
  accessWithdrawn: "warn",
  inactive: "neutral",
  unrecognised: "warn",
};

const KIND_LABEL: Record<string, MessageKey> = {
  kds: "display.kind.kds",
  cds: "display.kind.cds",
  status: "display.kind.status",
  printer: "display.kind.printer",
};

const TRANSPORT_LABEL: Record<string, MessageKey> = {
  kds_hosted: "display.transport.kds_hosted",
  lan_escpos: "display.transport.lan_escpos",
  print_agent: "display.transport.print_agent",
};

/**
 * The state a row reads as, from the stored facts and **never defaulted**: a credential shape
 * this build does not recognise says so rather than borrowing a friendly word. `status` is
 * asked first, because a deactivated display is out of service whatever its credential says.
 */
function displayState(display: DisplayRecord): DisplayStateKey {
  const credential = display.credential;
  if (display.status === "inactive") return "inactive";
  if (display.status !== "active") return "unrecognised";
  if (!credential) return "notPaired";
  if (credential.pairingPending) return "pairingPending";
  if (credential.revokedAt) return "accessWithdrawn";
  if (credential.redeemedAt) return "paired";
  return "unrecognised";
}

function kindLabel(t: Translate, kind: string): string {
  return codeLabel(t, KIND_LABEL[kind] ?? "display.kind.unrecognised", kind);
}

function transportLabel(t: Translate, transport: string): string {
  return codeLabel(t, TRANSPORT_LABEL[transport] ?? "display.transport.unrecognised", transport);
}

interface RefusalEnvelope {
  code: string | null;
  params: Record<string, string | number> | null;
  message: string;
}

/** A refusal in words: the server's coded sentence when the catalog has it, else its own. */
function refusalText(t: Translate, response: RefusalEnvelope): string {
  return response.code ? codedMessage(t, response.code, response.params ?? undefined) : response.message;
}

type DialogState =
  | { kind: "register"; outletId: string; outletCode: string; outletName: string; estate: DisplayEstate }
  | { kind: "pair"; display: DisplayRecord; windowMinutes: number }
  | { kind: "revoke"; display: DisplayRecord }
  | { kind: "deactivate"; display: DisplayRecord };

export function DisplaysCard({
  outlets,
  canManage,
}: {
  outlets: OutletView[];
  /** `display.manage`, read from the resolved registry the server sent with the page. */
  canManage: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [issue, setIssue] = useState<{
    pairingCode: string;
    expiresAt: string;
    rotated: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader title={t("display.list.title")} subtitle={t("display.list.subtitle")} />

      {notice ? (
        <div className="border-b border-border p-4 pb-0">
          <Banner tone="ok" compact>
            {notice}
          </Banner>
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-border p-4 pb-0">
          <Banner tone="danger" compact title={t("display.error.load")}>
            {error}
          </Banner>
        </div>
      ) : null}
      {canManage ? (
        <p className="border-b border-border px-4 py-2 text-xs text-fg-subtle">
          {t("display.manage.hint", { permission: "display.manage" })}
        </p>
      ) : (
        <div className="border-b border-border p-4">
          <Banner tone="info" compact>
            {t("display.manage.readOnly", { permission: "display.manage" })}
          </Banner>
        </div>
      )}

      {outlets.length === 0 ? (
        <div className="p-4">
          <EmptyState
            compact
            title={t("mdm.site.outlets.empty.title")}
            description={t("mdm.site.outlets.empty.description")}
          />
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {outlets.map((outlet) => (
            <OutletDisplays
              key={outlet.id}
              outlet={outlet}
              canManage={canManage}
              onAdd={(estate) => {
                setError(null);
                setNotice(null);
                setDialog({
                  kind: "register",
                  outletId: outlet.id,
                  outletCode: outlet.code,
                  outletName: outlet.name,
                  estate,
                });
              }}
              onPair={(display, windowMinutes) => {
                setError(null);
                setNotice(null);
                setIssue(null);
                setDialog({ kind: "pair", display, windowMinutes });
              }}
              onRevoke={(display) => {
                setError(null);
                setNotice(null);
                setDialog({ kind: "revoke", display });
              }}
              onDeactivate={(display) => {
                setError(null);
                setNotice(null);
                setDialog({ kind: "deactivate", display });
              }}
            />
          ))}
        </div>
      )}

      {dialog && dialog.kind === "register" ? (
        <RegisterDialog
          outletName={dialog.outletName}
          stations={dialog.estate.stations}
          busy={busy}
          onClose={() => setDialog(null)}
          onRegister={async (input) => {
            setBusy(true);
            const response = await registerDisplayFn({
              data: { outletId: dialog.outletId, ...input },
            });
            setBusy(false);
            if (!response.ok) {
              setError(refusalText(t, response));
              return;
            }
            setDialog(null);
            setError(null);
            setNotice(t("display.notice.registered", { name: input.name, outlet: dialog.outletCode }));
            await router.invalidate();
          }}
        />
      ) : null}

      {dialog && dialog.kind === "pair" ? (
        <PairDialog
          display={dialog.display}
          windowMinutes={dialog.windowMinutes}
          issue={issue}
          busy={busy}
          onClose={() => {
            // The code leaves this component's state here, and nothing can bring it back.
            setIssue(null);
            setDialog(null);
          }}
          onIssue={async () => {
            setBusy(true);
            const response = await pairDisplayFn({ data: { displayId: dialog.display.id } });
            setBusy(false);
            if (!response.ok) {
              setError(refusalText(t, response));
              setDialog(null);
              return;
            }
            setError(null);
            setIssue({
              pairingCode: response.issue.pairingCode,
              expiresAt: response.issue.expiresAt,
              rotated: response.issue.revokedCredentialId !== null,
            });
            setNotice(t("display.notice.paired", { display: dialog.display.code }));
            await router.invalidate();
          }}
        />
      ) : null}

      {dialog && dialog.kind === "revoke" ? (
        <ReasonDialog
          title={t("display.revoke")}
          body={t("display.revoke.confirm")}
          reasonLabel={t("display.revoke.reason")}
          reasonHint={t("display.revoke.reason.hint")}
          confirmLabel={t("display.revoke")}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            const response = await revokeDisplayCredentialFn({
              data: { displayId: dialog.display.id, reason },
            });
            setBusy(false);
            if (!response.ok) {
              setError(refusalText(t, response));
              return;
            }
            setDialog(null);
            setNotice(t("display.notice.revoked", { display: dialog.display.code }));
            await router.invalidate();
          }}
        />
      ) : null}

      {dialog && dialog.kind === "deactivate" ? (
        <ReasonDialog
          title={t("display.deactivate")}
          body={t("display.deactivate.confirm")}
          reasonLabel={t("display.deactivate.reason")}
          reasonHint={t("display.deactivate.reason.hint")}
          confirmLabel={t("display.deactivate")}
          tone="danger"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            const response = await deactivateDisplayFn({
              data: { displayId: dialog.display.id, reason },
            });
            setBusy(false);
            if (!response.ok) {
              setError(refusalText(t, response));
              return;
            }
            setDialog(null);
            setNotice(t("display.notice.deactivated", { display: dialog.display.code }));
            await router.invalidate();
          }}
        />
      ) : null}
    </Card>
  );
}

/** One outlet: the licence report, its displays, and what may be done to each. */
function OutletDisplays({
  outlet,
  canManage,
  onAdd,
  onPair,
  onRevoke,
  onDeactivate,
}: {
  outlet: OutletView;
  canManage: boolean;
  onAdd: (estate: DisplayEstate) => void;
  onPair: (display: DisplayRecord, windowMinutes: number) => void;
  onRevoke: (display: DisplayRecord) => void;
  onDeactivate: (display: DisplayRecord) => void;
}) {
  const { t } = useI18n();

  if (outlet.displays.state !== "available") {
    // The read was refused: the server's `guard()` wrote a `denied` audit row and no data
    // changed. The capability the server refused on is named, never guessed here.
    return (
      <section className="p-4">
        <PermissionDenied
          title={t("display.list.title")}
          description={t("display.manage.readOnly", { permission: "display.manage" })}
          requiredPermission={outlet.displays.permission}
        />
      </section>
    );
  }

  const estate = outlet.displays.estate;
  const writable = canManage && estate.licensed;

  return (
    <section className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{outlet.name}</h3>
        <code className="font-mono text-2xs text-fg-muted">{outlet.code}</code>
        {writable ? (
          <Button size="sm" variant="secondary" onClick={() => onAdd(estate)}>
            {t("display.add")}
          </Button>
        ) : null}
      </div>

      <GateReport estate={estate} />

      {estate.licensed ? null : (
        <Banner tone="warn" compact title={t("display.gate.title")}>
          {t("display.gate.readOnly")}
        </Banner>
      )}

      {estate.displays.length === 0 ? (
        <EmptyState compact title={t("display.empty.title")} description={t("display.empty.body")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("display.list.title")}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-fg-muted uppercase">
                <th className="px-3 py-2 text-start font-medium">{t("display.column.name")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.code")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.kind")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.station")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.connection")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.state")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("display.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {estate.displays.map((display) => (
                <DisplayRow
                  key={display.id}
                  display={display}
                  writable={writable}
                  windowMinutes={estate.pairingWindowMinutes}
                  onPair={onPair}
                  onRevoke={onRevoke}
                  onDeactivate={onDeactivate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The two gated features, each with the gate holding it — reported, never assumed, and never
 * one collapsed sentence: the licence and the chain's own switch are different facts with
 * different remedies (§11.5.6, lead ruling 29 Sept 2026).
 */
function GateReport({ estate }: { estate: DisplayEstate }) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
        {t("display.entitlement.title")}
      </p>
      <p className="mt-1 text-xs text-fg-muted">{t("display.entitlement.subtitle")}</p>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {estate.gates.map((gate) => (
          <li key={gate.featureCode} className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg">
              {gate.featureName ||
                codedMessage(t, "labels.unrecognised.named", { code: gate.featureCode })}
            </span>
            <code className="font-mono text-2xs text-fg-subtle">{gate.featureCode}</code>
            <span className="text-fg-muted">
              {t("display.entitlement.tier", {
                minTier: tierLabel(t, gate.minTier),
                tier: tierLabel(t, gate.storedTier),
              })}
            </span>
            <span className="text-fg-muted">
              {gate.toggleEnabled
                ? t("display.entitlement.switchOn")
                : t("display.entitlement.switchOff")}
            </span>
            {gate.entitled ? (
              <Badge tone="ok">{t("display.entitlement.open")}</Badge>
            ) : (
              <>
                <Badge tone="warn">
                  {t("display.entitlement.held", {
                    gate: t(
                      gate.holding === "switch"
                        ? "display.entitlement.gate.switch"
                        : "display.entitlement.gate.tier"
                    ),
                  })}
                </Badge>
                {gate.refusal ? (
                  <span className="text-fg-muted" role="status">
                    {codedMessage(t, gate.refusal.code, gate.refusal.params)}
                  </span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One terminal: what it is, what it serves, and whether anything may be done to it. */
function DisplayRow({
  display,
  writable,
  windowMinutes,
  onPair,
  onRevoke,
  onDeactivate,
}: {
  display: DisplayRecord;
  writable: boolean;
  windowMinutes: number;
  onPair: (display: DisplayRecord, windowMinutes: number) => void;
  onRevoke: (display: DisplayRecord) => void;
  onDeactivate: (display: DisplayRecord) => void;
}) {
  const { t, format } = useI18n();
  const state = displayState(display);
  const credential = display.credential;
  const liveCredential = Boolean(credential && credential.redeemedAt && !credential.revokedAt);

  return (
    <tr className="border-b border-border last:border-b-0 align-top">
      <td className="px-3 py-2">
        <span className="text-sm text-fg">{display.name}</span>
        {display.requireOperatorPin ? (
          <span className="mt-0.5 block text-2xs text-fg-subtle">{t("display.operatorPin")}</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {/* Identifier position: a code stays a code, in mono, and is never translated. */}
        <code className="font-mono text-xs">{display.code}</code>
      </td>
      <td className="px-3 py-2">{kindLabel(t, display.kind)}</td>
      <td className="px-3 py-2">
        {display.sectionId ? (
          <CodeLabel
            label={display.sectionName ?? t("labels.unrecognised")}
            code={display.sectionCode ?? display.sectionId}
          />
        ) : (
          <span className="text-xs text-fg-muted">{t("display.station.outletScope")}</span>
        )}
      </td>
      <td className="px-3 py-2">
        {display.transport ? (
          <span className="text-xs">
            {transportLabel(t, display.transport)}
            {display.address ? (
              <code className="mt-0.5 block font-mono text-2xs text-fg-subtle">
                {display.address}
              </code>
            ) : null}
          </span>
        ) : (
          <NoValue />
        )}
      </td>
      <td className="px-3 py-2">
        <Badge tone={STATE_TONE[state]}>{t(DISPLAY_STATE_LABEL[state])}</Badge>
        <span className="mt-1 block text-2xs text-fg-muted">
          {state === "pairingPending" && credential?.pairingExpiresAt
            ? t("display.state.pendingExpires", {
                time: format.dateTime(credential.pairingExpiresAt),
              })
            : null}
          {state === "paired" && credential?.redeemedAt
            ? t("display.state.pairedSince", { time: format.dateTime(credential.redeemedAt) })
            : null}
          {state === "accessWithdrawn" && credential?.revokeReason
            ? t("display.state.withdrawnReason", { reason: credential.revokeReason })
            : null}
          {state === "inactive" ? t("display.state.inactiveNote") : null}
          <span className="mt-1 block">
            {display.lastSeenAt
              ? t("display.lastSeen", { time: format.dateTime(display.lastSeenAt) })
              : t("display.lastSeen.never")}
          </span>
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {writable ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onPair(display, windowMinutes)}
              >
                {credential?.pairingPending
                  ? t("display.pairing.action.again")
                  : t("display.pairing.action")}
              </Button>
              {liveCredential ? (
                <Button size="sm" variant="secondary" onClick={() => onRevoke(display)}>
                  {t("display.revoke")}
                </Button>
              ) : null}
              <Button size="sm" variant="danger" onClick={() => onDeactivate(display)}>
                {t("display.deactivate")}
              </Button>
            </>
          ) : (
            <span className="text-xs text-fg-subtle">{t("common.readOnly")}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Registering a display: exactly the fields the domain validates.
 *
 * **Not offered, and deliberately:** language and time zone. Both columns exist
 * (`display.locale`, `display.timezone`) and `RegisterDisplayInput` accepts both, but nothing
 * validates either against a reference, and a free-text time zone an operator can mistype is
 * worse than no field — it is a value the display layer would later read as fact. Stated here
 * and in the session's report rather than grown into the schema quietly.
 */
function RegisterDialog({
  outletName,
  stations,
  busy,
  onClose,
  onRegister,
}: {
  outletName: string;
  stations: DisplayEstate["stations"];
  busy: boolean;
  onClose: () => void;
  onRegister: (input: {
    code: string;
    name: string;
    kind: string;
    sectionId: string | null;
    transport: string | null;
    address: string | null;
    requireOperatorPin: boolean;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("kds");
  const [sectionId, setSectionId] = useState<string>("");
  const [transport, setTransport] = useState<string>("kds_hosted");
  const [address, setAddress] = useState<string>("");
  const [requirePin, setRequirePin] = useState(false);

  const isPrinter = kind === "printer";

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("display.register.title")}
      description={t("display.register.description", { outlet: outletName })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void onRegister({
                code,
                name,
                kind,
                sectionId: sectionId === "" ? null : sectionId,
                transport: isPrinter ? transport : null,
                address: isPrinter && address !== "" ? address : null,
                requireOperatorPin: requirePin,
              })
            }
          >
            {t("display.register.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          id="display-code"
          label={t("display.field.code")}
          hint={t("display.field.code.hint")}
          required
        >
          <TextInput id="display-code" value={code} onChange={setCode} />
        </Field>
        <Field id="display-name" label={t("display.field.name")} required>
          <TextInput id="display-name" value={name} onChange={setName} />
        </Field>
        <Field id="display-kind" label={t("display.field.kind")}>
          <Select
            id="display-kind"
            value={kind}
            onChange={setKind}
            ariaLabel={t("display.field.kind")}
            options={DISPLAY_KINDS.map((value) => ({ value, label: t(KIND_LABEL[value]) }))}
          />
        </Field>
        <Field
          id="display-section"
          label={t("display.field.section")}
          hint={t("display.field.section.hint")}
          required={isPrinter}
        >
          <Select
            id="display-section"
            value={sectionId}
            onChange={setSectionId}
            ariaLabel={t("display.field.section")}
            emptyLabel={t("display.field.section.outletScope")}
            options={stations.map((station) => ({
              value: station.id,
              label: `${station.name} · ${station.code}`,
            }))}
          />
        </Field>
        {isPrinter ? (
          <>
            <Field
              id="display-transport"
              label={t("display.field.transport")}
              hint={t("display.field.transport.hint")}
            >
              <Select
                id="display-transport"
                value={transport}
                onChange={setTransport}
                ariaLabel={t("display.field.transport")}
                options={DISPLAY_TRANSPORTS.map((value) => ({
                  value,
                  label: t(TRANSPORT_LABEL[value]),
                }))}
              />
            </Field>
            <Field
              id="display-address"
              label={t("display.field.address")}
              hint={t("display.field.address.hint")}
            >
              <TextInput id="display-address" value={address} onChange={setAddress} />
            </Field>
          </>
        ) : null}
        <Field
          id="display-pin"
          label={t("display.field.requirePin")}
          hint={t("display.field.requirePin.hint")}
        >
          <Toggle checked={requirePin} onChange={setRequirePin} label={t("display.field.requirePin")} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Pairing. The confirm step says what the code is for and how long it lives; the issued step
 * is the only place the code ever appears, and it says in words that there will not be
 * another.
 */
function PairDialog({
  display,
  windowMinutes,
  issue,
  busy,
  onClose,
  onIssue,
}: {
  display: DisplayRecord;
  windowMinutes: number;
  issue: { pairingCode: string; expiresAt: string; rotated: boolean } | null;
  busy: boolean;
  onClose: () => void;
  onIssue: () => Promise<void>;
}) {
  const { t } = useI18n();
  const pending = display.credential?.pairingPending === true;

  return (
    <Dialog
      open
      onClose={onClose}
      title={issue ? t("display.pairing.issued.title") : t("display.pairing.title")}
      description={`${display.name} · ${display.code}`}
      footer={
        issue ? (
          <Button onClick={onClose}>{t("display.pairing.done")}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("action.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void onIssue()}>
              {t("display.pairing.action.again")}
            </Button>
          </>
        )
      }
    >
      {issue ? (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-2xl tracking-widest text-fg">{issue.pairingCode}</p>
          <p className="text-xs text-fg-muted">{t("display.pairing.once")}</p>
          <p className="text-xs text-fg-muted">
            {t("display.pairing.expiresAt", { time: "" })}
            <TimestampValue value={issue.expiresAt} mode="dateTime" />
          </p>
          <p className="text-xs text-fg-subtle">{t("display.pairing.singleUse")}</p>
          <p className="text-xs text-fg-subtle">
            {issue.rotated ? t("display.pairing.reissued") : t("display.pairing.reissuedNone")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">
            {t("display.pairing.body", { minutes: windowMinutes })}
          </p>
          {pending ? <p className="text-xs text-fg-muted">{t("display.pairing.pending")}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

/** A reason is required by the domain, so the dialog cannot submit without one. */
function ReasonDialog({
  title,
  body,
  reasonLabel,
  reasonHint,
  confirmLabel,
  tone = "default",
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  reasonLabel: string;
  reasonHint: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      tone={tone}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy || reason.trim() === ""}
            onClick={() => void onConfirm(reason)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">{body}</p>
        <Field id="display-reason" label={reasonLabel} hint={reasonHint} required>
          <TextInput id="display-reason" value={reason} onChange={setReason} />
        </Field>
      </div>
    </Dialog>
  );
}
