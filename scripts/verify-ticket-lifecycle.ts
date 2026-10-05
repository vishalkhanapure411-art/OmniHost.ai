/**
 * S-B/2b read-back: the ticket lifecycle (§2.3's T2–T7, T9) and T11, end to end.
 *
 *   bun run scripts/verify-ticket-lifecycle.ts        (from the site directory)
 *
 * **What it proves, in order, and every value is read back out of Postgres.**
 *
 *   1. **The fixture** — the pilot outlet's own booking `T-001`
 *      (`outlet_order 620dd087-ff75-4926-a97d-3e3c1b7ed5f2`) and its three tickets at
 *      KOR-HOT / KOR-GRILL / KOR-COLD, read from the tables and not assumed.
 *   2. **The capabilities and the accounts that hold them** — read from `permission`,
 *      `role_permission`, `role_assignment` and `"user"`, never from the seed file. The
 *      finding this step exists to state: **no seeded account holds `kds.ticket.advance`**,
 *      so T2 acknowledge, T3 start and T4 ready are driven by a *station terminal*, which is
 *      the principal the product gives that capability besides Site Culinary Team and Site
 *      Operations Team (§2.4). The terminal principals are constructed in this process from
 *      the outlet's own `outlet_section` rows and the capability set `displayCapabilities('kds')`
 *      returns — see HONEST LIMITS in the transcript tail for exactly what that exercises.
 *   3. **Migration 0016, read back from the database**: `ticket_transition.transition_id` and
 *      its partial unique index, and the two reason-vocabulary check constraints, compared
 *      against the arrays in `TICKET_REASON_CODES` — plus two demonstration writes that must be
 *      refused and are rolled back, so nothing is written by either.
 *   4. **A capability refusal, with the counts unmoved**: `site.head@saffron.example` — a real
 *      seeded account — does not hold `kds.ticket.advance`, so a T2 by that person writes
 *      exactly one `denied` row naming the capability and changes no data. A station terminal
 *      attempting the same act on **another station's** ticket is refused the same way through
 *      S-A's `assertDeviceMayActOn`.
 *   5. **The lifecycle itself, through the domain code** (`advanceTicket`, `recallTicket`,
 *      `rerouteTicket`, `serveTicket`, `voidTicket`, `closeOutletOrder` — never SQL):
 *      ticket A takes §2.3's full path including a recall, ticket C is re-routed (T9) and voided
 *      (T7) with a reason, ticket B takes the fast path D8 describes and its serve is the act that
 *      finishes the booking's work, after which T11 closes the booking. After **every** act the
 *      ticket's `state`, `ready_at`/`served_at`/`voided_at`, the `ticket_line` states, the
 *      `ticket_transition` row and the `audit_log` row that row points at are printed and
 *      asserted — including that all three carry one transaction's timestamp.
 *   6. **The other refusals the lifecycle can produce, all of which write nothing at all** (no
 *      audit row, no journal row, no state change): a recall with no reason, a void with no
 *      reason, and the stale-state case — `T3 start` issued after a T5 recall has already left
 *      the ticket `in_prep`, which is the state the caller's expectation was stale against.
 *
 * **What it does not do.** It writes no scratch booking, creates no display and mints no
 * credential. The only rows it leaves are the lifecycle's own (the fixture booking's tickets,
 * their journal rows and their audit rows) and one `denied` row per capability refusal per
 * database — append-only, and a re-run quotes the earlier row instead of writing a second. A
 * re-run of a database where this lifecycle already ran reads every row back and repeats no
 * act. The removal SQL for the fixture's own rows is printed at the end.
 */
import { writeFileSync } from "node:fs";

import { poolQueryable, withTransaction } from "~/db";
import type { DevicePrincipal } from "~/domain/display";
import { displayCapabilities } from "~/domain/display";
import { closeOutletOrder } from "~/domain/order";
import {
  TICKET_REASON_CODES,
  TICKET_TRANSITIONS,
  TICKET_VALIDATION_KEY,
  type TicketState,
} from "~/domain/order-rules";
import {
  advanceTicket,
  deviceActor,
  personActor,
  recallTicket,
  rerouteTicket,
  serveTicket,
  voidTicket,
  type TicketActor,
  type TicketLifecycleResult,
} from "~/domain/ticket";
import { isHttpError } from "~/server/errors";
import { Transcript, emailsHolding, errorMessage, principalFor } from "./verify-comparison-view-lib";

const q = poolQueryable();
const out: string[] = [];
const t = new Transcript();

/** The pilot outlet, its site and the fixture booking (§11.3 item 2, fired by S-B/2a). */
const OUTLET_CODE = "koramangala-restaurant";
const FIXTURE_ORDER_ID = "05d1dc81-ffaa-4677-a914-8c0c366a239b";
const FIXTURE_OUTLET_ORDER_ID = "620dd087-ff75-4926-a97d-3e3c1b7ed5f2";
/** The three stations the fixture's lines were routed to, in the order they are worked. */
const STATION_CODES = ["KOR-HOT", "KOR-GRILL", "KOR-COLD"] as const;
/** T9's target: an outlet station with no ticket for this booking (the one-ticket rule). */
const REROUTE_TARGET_CODE = "KOR-DESSERT";
/** The pilot's own Site Head — a real account, used because it holds the four person-held acts. */
const SITE_HEAD_EMAIL = "site.head@saffron.example";
/** The capability the refused account does not hold. */
const REFUSED_ACT = "kds.ticket.advance";

const TRANSCRIPT_PATH = "/home/team/shared/evidence/sb2b-ticket-lifecycle-readback.txt";
const UTC_STAMP = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

async function block(label: string, sql: string, params: unknown[] = []): Promise<void> {
  out.push(`=== ${label} ===`);
  try {
    const rows = await q.query<{ line: string }>(sql, params);
    if (rows.length === 0) out.push("(no rows)");
    for (const row of rows) out.push(row.line);
  } catch (error) {
    out.push(`ERROR ${errorMessage(error)}`);
  }
  out.push("");
}

interface Counts {
  orders: number;
  outletOrders: number;
  orderLines: number;
  tickets: number;
  ticketLines: number;
  transitions: number;
  audits: number;
}

async function counts(): Promise<Counts> {
  const rows = await q.query<{
    orders: number;
    outlet_orders: number;
    order_lines: number;
    tickets: number;
    ticket_lines: number;
    transitions: number;
    audits: number;
  }>(
    `select (select count(*) from "order")::int as orders,
            (select count(*) from outlet_order)::int as outlet_orders,
            (select count(*) from order_line)::int as order_lines,
            (select count(*) from ticket)::int as tickets,
            (select count(*) from ticket_line)::int as ticket_lines,
            (select count(*) from ticket_transition)::int as transitions,
            (select count(*) from audit_log)::int as audits`
  );
  const row = rows[0];
  if (!row) throw new Error("counts query returned no row");
  return {
    orders: row.orders,
    outletOrders: row.outlet_orders,
    orderLines: row.order_lines,
    tickets: row.tickets,
    ticketLines: row.ticket_lines,
    transitions: row.transitions,
    audits: row.audits,
  };
}

function countsLine(label: string, c: Counts): string {
  return (
    `${label}: order=${String(c.orders)} outlet_order=${String(c.outletOrders)} order_line=${String(c.orderLines)} ` +
    `ticket=${String(c.tickets)} ticket_line=${String(c.ticketLines)} ticket_transition=${String(c.transitions)} audit_log=${String(c.audits)}`
  );
}

function sameData(a: Counts, b: Counts): boolean {
  return (
    a.orders === b.orders &&
    a.outletOrders === b.outletOrders &&
    a.orderLines === b.orderLines &&
    a.tickets === b.tickets &&
    a.ticketLines === b.ticketLines &&
    a.transitions === b.transitions
  );
}

interface Ticket {
  id: string;
  ticket_no: number;
  state: string;
  routing_source: string;
  section_id: string;
  section_code: string;
  service_date: string;
}

interface TicketReadback extends Ticket {
  ready_at: string | null;
  served_at: string | null;
  voided_at: string | null;
  void_reason_code: string | null;
  updated_at: string;
  line_states: string | null;
  line_count: number;
}

async function readTicket(ticketId: string): Promise<TicketReadback> {
  const rows = await q.query<TicketReadback>(
    `select tk.id, tk.ticket_no, tk.state, tk.routing_source,
            tk.section_id, s.code as section_code,
            to_char(tk.service_date, 'YYYY-MM-DD') as service_date,
            to_char(tk.ready_at at time zone 'UTC', '${UTC_STAMP}') as ready_at,
            to_char(tk.served_at at time zone 'UTC', '${UTC_STAMP}') as served_at,
            to_char(tk.voided_at at time zone 'UTC', '${UTC_STAMP}') as voided_at,
            tk.void_reason_code,
            to_char(tk.updated_at at time zone 'UTC', '${UTC_STAMP}') as updated_at,
            (select string_agg(tl.state, ',' order by tl.position) from ticket_line tl where tl.ticket_id = tk.id) as line_states,
            (select count(*) from ticket_line tl where tl.ticket_id = tk.id)::int as line_count
       from ticket tk join outlet_section s on s.id = tk.section_id
      where tk.id = $1`,
    [ticketId]
  );
  const row = rows[0];
  if (!row) throw new Error(`no ticket ${ticketId}`);
  return row;
}

interface JournalRow {
  id: string;
  transition_code: string;
  from_state: string | null;
  to_state: string;
  reason_code: string | null;
  actor_role_code: string;
  actor_scope: string;
  display_code: string | null;
  actor_user_id: string | null;
  audit_id: string | null;
  transition_id: string | null;
  occurred_at: string;
}

const JOURNAL_COLUMNS = `select tt.id::text as id, tt.transition_code, tt.from_state, tt.to_state, tt.reason_code,
            tt.actor_role_code, tt.actor_scope, tt.display_code,
            tt.actor_user_id::text as actor_user_id, tt.audit_id::text as audit_id,
            tt.transition_id::text as transition_id,
            to_char(tt.occurred_at at time zone 'UTC', '${UTC_STAMP}') as occurred_at
       from ticket_transition tt`;

async function readJournal(transitionId: string): Promise<JournalRow | null> {
  const rows = await q.query<JournalRow>(`${JOURNAL_COLUMNS} where tt.id = $1`, [transitionId]);
  return rows[0] ?? null;
}

/** The last journal row of an act this ticket already carries — a re-run's read-back. */
async function lastJournal(ticketId: string, transitionCode: string): Promise<JournalRow | null> {
  const rows = await q.query<JournalRow>(
    `${JOURNAL_COLUMNS} where tt.ticket_id = $1 and tt.transition_code = $2 order by tt.occurred_at desc limit 1`,
    [ticketId, transitionCode]
  );
  return rows[0] ?? null;
}

interface AuditRow {
  id: string;
  created_at: string;
  action: string;
  intent: string | null;
  outcome: string;
  entity_type: string;
  entity_id: string | null;
  actor_role_code: string;
  actor_user_id: string | null;
  source: string;
  reason: string | null;
  before_state: string | null;
  after_state: string | null;
}

async function readAudit(auditId: string): Promise<AuditRow | null> {
  const rows = await q.query<AuditRow>(
    `select a.id::text as id,
            to_char(a.created_at at time zone 'UTC', '${UTC_STAMP}') as created_at,
            a.action, a.intent, a.outcome, a.entity_type, a.entity_id::text as entity_id,
            a.actor_role_code, a.actor_user_id::text as actor_user_id, a.request_source as source, a.reason,
            a.before_state::text as before_state, a.after_state::text as after_state
       from audit_log a where a.id = $1::bigint`,
    [auditId]
  );
  return rows[0] ?? null;
}

function jsonish(value: string | null, key: string): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const found = parsed[key];
    return found === undefined || found === null ? null : String(found);
  } catch {
    return null;
  }
}

/** One act, read back: the ticket, its journal row, and the ledger row that row points at. */
async function readBackAct(args: {
  label: string;
  act: keyof typeof TICKET_TRANSITIONS;
  ticket: Ticket;
  expectedState: TicketState;
  expectedSection?: string;
  actor: TicketActor;
  result: TicketLifecycleResult | null;
  journal: JournalRow | null;
  alreadyDone: boolean;
  bookingStillFired?: boolean;
}): Promise<void> {
  const rule = TICKET_TRANSITIONS[args.act];
  t.say("");
  t.say(`--- ${args.label} ---`);
  if (!args.result && !args.journal) {
    t.failures.push(`${args.label}: neither a result nor a journal row to read back`);
    t.say("  no result and no journal row — nothing to read back");
    return;
  }
  if (args.alreadyDone) {
    t.say("  a previous run already left the ticket in this state — the existing journal row is quoted, not repeated");
  } else if (args.result) {
    t.say(
      `  the act returned: ${args.result.transitionCode} ${args.result.from} -> ${args.result.to} on ticket ${String(args.result.ticketNo)} ` +
        `at ${args.result.sectionCode} (${args.result.sectionName}); ${String(args.result.linesMoved)} ticket_line row(s) moved; ` +
        `booking ${args.result.outletOrderStatus}${args.result.outletOrderMovedToServed ? " (this act finished the booking's work)" : ""}`
    );
    t.say(
      `  returned timestamps: readyAt=${args.result.readyAt ?? "NULL"} servedAt=${args.result.servedAt ?? "NULL"} ` +
        `voidedAt=${args.result.voidedAt ?? "NULL"} voidReason=${args.result.voidReasonCode ?? "NULL"} reasonCode=${args.result.reasonCode ?? "NULL"}`
    );
  }

  const ticket = await readTicket(args.ticket.id);
  const journal = args.journal;
  t.say(
    `  ticket now: state=${ticket.state} section=${ticket.section_code} routing_source=${ticket.routing_source} ` +
      `ready_at=${ticket.ready_at ?? "NULL"} served_at=${ticket.served_at ?? "NULL"} voided_at=${ticket.voided_at ?? "NULL"} ` +
      `void_reason_code=${ticket.void_reason_code ?? "NULL"} line_states=${ticket.line_states ?? "none"}`
  );
  t.check(
    `${args.label}: the ticket's state in Postgres is ${args.expectedState}`,
    ticket.state === args.expectedState,
    ticket.state
  );
  if (args.expectedSection) {
    t.check(
      `${args.label}: the ticket's station is ${args.expectedSection}`,
      ticket.section_code === args.expectedSection,
      ticket.section_code
    );
  }
  if (!journal) {
    t.failures.push(`${args.label}: no ticket_transition row was written`);
    t.say("  NO JOURNAL ROW — the transition wrote no ticket_transition row");
    return;
  }
  t.say(
    `  journal row: id=${journal.id} code=${journal.transition_code} ${journal.from_state ?? "NULL"} -> ${journal.to_state} ` +
      `reason_code=${journal.reason_code ?? "NULL"} actor_role=${journal.actor_role_code} actor_scope=${journal.actor_scope} ` +
      `actor_user_id=${journal.actor_user_id ?? "NULL"} display_code=${journal.display_code ?? "NULL"} ` +
      `audit_id=${journal.audit_id ?? "NULL"} transition_id=${journal.transition_id ?? "NULL"} occurred_at=${journal.occurred_at}`
  );
  t.check(
    `${args.label}: the journal row is ${rule.code} and records ${args.expectedState}`,
    journal.transition_code === rule.code && journal.to_state === args.expectedState,
    `${journal.transition_code} -> ${journal.to_state}`
  );
  t.check(
    `${args.label}: the journal row carries an audit id — the ledger row written in the same transaction`,
    journal.audit_id !== null,
    journal.audit_id ?? "NULL"
  );
  if (args.actor.kind === "person") {
    t.check(
      `${args.label}: a person's act names the person and no display`,
      journal.actor_user_id === args.actor.principal.userId && journal.display_code === null,
      `actor_user_id=${journal.actor_user_id ?? "NULL"} display_code=${journal.display_code ?? "NULL"}`
    );
  } else {
    t.check(
      `${args.label}: a terminal's act names no person and names the terminal`,
      journal.actor_user_id === null && journal.display_code === args.actor.device.code,
      `actor_user_id=${journal.actor_user_id ?? "NULL"} display_code=${journal.display_code ?? "NULL"}`
    );
    t.check(
      `${args.label}: and its role is the station's operating role, not a person's role`,
      journal.actor_role_code === args.actor.device.operatingRoleCode,
      journal.actor_role_code
    );
  }

  if (!journal.audit_id) return;
  const audit = await readAudit(journal.audit_id);
  if (!audit) {
    t.failures.push(`${args.label}: the journal row points at audit id ${journal.audit_id}, which does not exist`);
    return;
  }
  t.say(
    `  the audit row it points at: id=${audit.id} action=${audit.action} intent=${audit.intent ?? "NULL"} entity=${audit.entity_type}/${audit.entity_id ?? "NULL"} ` +
      `outcome=${audit.outcome} actor_role=${audit.actor_role_code} actor_user_id=${audit.actor_user_id ?? "NULL"} source=${audit.source}`
  );
  t.say(`      reason=${audit.reason ?? "NULL"}`);
  t.say(`      before_state=${audit.before_state ?? "NULL"}`);
  t.say(`      after_state=${audit.after_state ?? "NULL"}`);
  t.check(
    `${args.label}: the ledger row names the capability as its action`,
    audit.action === rule.capability,
    `${audit.action} vs ${rule.capability}`
  );
  t.check(
    `${args.label}: the ledger row is a success row on the ticket`,
    audit.outcome === "success" && audit.entity_type === "ticket" && audit.entity_id === args.ticket.id,
    `${audit.outcome} ${audit.entity_type}/${audit.entity_id ?? "NULL"}`
  );
  t.check(
    `${args.label}: its after-state records the state the journal row records`,
    jsonish(audit.after_state, "state") === journal.to_state,
    `${jsonish(audit.after_state, "state") ?? "NULL"} vs ${journal.to_state}`
  );
  if (args.act === "reroute") {
    t.check(
      `${args.label}: the ledger row carries the station change the journal has no column for`,
      jsonish(audit.before_state, "sectionCode") !== jsonish(audit.after_state, "sectionCode") &&
        jsonish(audit.after_state, "sectionCode") === args.expectedSection,
      `${jsonish(audit.before_state, "sectionCode") ?? "NULL"} -> ${jsonish(audit.after_state, "sectionCode") ?? "NULL"}`
    );
  }
  if (args.actor.kind === "device") {
    t.check(
      `${args.label}: the ledger row is addressed by the terminal — no person, display:<code> in the reason`,
      audit.actor_user_id === null && (audit.reason ?? "").includes(`display:${args.actor.device.code}`),
      `actor_user_id=${audit.actor_user_id ?? "NULL"} reason=${audit.reason ?? "NULL"}`
    );
  } else {
    t.check(
      `${args.label}: the ledger row names the person`,
      audit.actor_user_id === args.actor.principal.userId,
      audit.actor_user_id ?? "NULL"
    );
  }
  // One transaction: the state change, the journal row and the ledger row share one `now()`.
  t.check(
    `${args.label}: ticket.updated_at, ticket_transition.occurred_at and audit_log.created_at are ONE timestamp`,
    ticket.updated_at === journal.occurred_at && journal.occurred_at === audit.created_at,
    `${ticket.updated_at} / ${journal.occurred_at} / ${audit.created_at}`
  );
  if (args.act !== "reroute") {
    t.check(
      `${args.label}: the ticket's own line states moved with it`,
      ticket.line_states !== null && ticket.line_states.split(",").every((state) => state === args.expectedState),
      ticket.line_states ?? "none"
    );
  }
}

/** Drives one act, or reads the previous run's row back if the ticket is already there. */
async function perform(args: {
  label: string;
  act: keyof typeof TICKET_TRANSITIONS;
  ticket: Ticket;
  expectedState: TicketState;
  expectedSection?: string;
  actor: TicketActor;
  call: () => Promise<TicketLifecycleResult>;
}): Promise<void> {
  const rule = TICKET_TRANSITIONS[args.act];
  const current = await readTicket(args.ticket.id);
  const sectionAlready = args.expectedSection ? current.section_code === args.expectedSection : true;
  if (current.state === args.expectedState && sectionAlready) {
    const journal = await lastJournal(args.ticket.id, rule.code);
    // **A skipped step proves nothing.** This state is in the table because an *earlier* run
    // reached it, so quoting its journal row back would restate that run and not this one
    // (WORKFLOW.md, "Evidence that can be checked" — the rule this harness itself breached once).
    // It is therefore a FAILURE with the fix named, and the fix is a committed script rather than
    // a different reading of the same row.
    t.failures.push(
      `${args.label}: SKIPPED — the ticket is already ${args.expectedState}, reached by an earlier run; ` +
        `reset the fixture first (bun run scripts/reset-ticket-lifecycle-fixture.ts), then run this harness once`
    );
    await readBackAct({
      label: args.label,
      act: args.act,
      ticket: args.ticket,
      expectedState: args.expectedState,
      expectedSection: args.expectedSection,
      actor: args.actor,
      result: null,
      journal,
      alreadyDone: true,
    });
    return;
  }
  let result: TicketLifecycleResult | null = null;
  try {
    result = await args.call();
  } catch (error) {
    t.say("");
    t.say(`--- ${args.label} ---`);
    t.say(`  UNEXPECTED REFUSAL: ${errorMessage(error)}`);
    t.failures.push(`${args.label}: refused — ${errorMessage(error)}`);
    return;
  }
  const journal = result.transitionId ? await readJournal(result.transitionId) : null;
  await readBackAct({
    label: args.label,
    act: args.act,
    expectedState: args.expectedState,
    expectedSection: args.expectedSection,
    ticket: args.ticket,
    actor: args.actor,
    result,
    journal,
    alreadyDone: false,
  });
}

/** A validation refusal: nothing at all is written — no audit row, no journal row, no change. */
async function validationRefusal(args: {
  label: string;
  expectKey: string;
  call: () => Promise<unknown>;
  ticketIds: string[];
}): Promise<void> {
  t.say("");
  t.say(`--- ${args.label} ---`);
  const before = await counts();
  const beforeTickets = await Promise.all(args.ticketIds.map((id) => readTicket(id)));
  let message = "";
  let key = "";
  try {
    await args.call();
    t.say("  UNEXPECTED: the act was accepted");
    t.failures.push(`${args.label}: the act was accepted`);
    return;
  } catch (error) {
    message = errorMessage(error);
    key = isHttpError(error) ? String(error.details?.code ?? "") : "";
    t.say(`  refused with: ${message}`);
    t.say(`  catalog key: ${key || "none"}`);
  }
  const after = await counts();
  const afterTickets = await Promise.all(args.ticketIds.map((id) => readTicket(id)));
  t.say(countsLine("  before the refusal", before));
  t.say(countsLine("  after the refusal ", after));
  t.check(
    `${args.label}: the refusal names the check that failed`,
    key === args.expectKey,
    `${key || "none"} vs ${args.expectKey}`
  );
  t.check(
    `${args.label}: it wrote NO ticket, NO ticket_line, NO journal row`,
    after.tickets === before.tickets &&
      after.ticketLines === before.ticketLines &&
      after.transitions === before.transitions,
    `tickets ${String(before.tickets)}->${String(after.tickets)} lines ${String(before.ticketLines)}->${String(after.ticketLines)} journal ${String(before.transitions)}->${String(after.transitions)}`
  );
  t.check(
    `${args.label}: and NO audit row — the ledger's gap is deliberate`,
    after.audits === before.audits,
    `${String(before.audits)} -> ${String(after.audits)}`
  );
  t.check(
    `${args.label}: and the ticket is exactly where it was`,
    beforeTickets.every(
      (row, index) => row.state === afterTickets[index]?.state && row.updated_at === afterTickets[index]?.updated_at
    ),
    beforeTickets
      .map(
        (row, index) =>
          `${row.state}->${afterTickets[index]?.state ?? "MISSING"}${row.updated_at === afterTickets[index]?.updated_at ? "" : " (updated_at MOVED)"}`
      )
      .join(",")
  );
}

/** A capability refusal: one `denied` row naming the capability, and no data change. */
async function capabilityRefusal(args: {
  label: string;
  actorDescription: string;
  /** The capability the actor does not hold — `kds.ticket.advance` unless an act says otherwise. */
  capability?: string;
  priorDenialSql: string;
  priorDenialParams: unknown[];
  /** How to find the denial's own row: the generic path does not always name the ticket. */
  rowWhere: string;
  rowParams: unknown[];
  call: () => Promise<unknown>;
  entityId: string;
}): Promise<void> {
  const capability = args.capability ?? REFUSED_ACT;
  t.say("");
  t.say(`--- ${args.label} ---`);
  t.say(`  ${args.actorDescription}`);
  const before = await counts();
  const prior = await q.query<{ id: string; created_at: string; reason: string | null }>(
    args.priorDenialSql,
    args.priorDenialParams
  );
  if (prior[0]) {
    t.say(
      `  already in the ledger from an earlier run (audit id ${prior[0].id}, ${prior[0].created_at}): ${prior[0].reason ?? "NULL"} — not repeated`
    );
  } else {
    try {
      await args.call();
      t.say("  UNEXPECTED: the act was accepted");
      t.failures.push(`${args.label}: the act was accepted`);
      return;
    } catch (error) {
      t.say(`  refused with: ${errorMessage(error)}`);
    }
  }
  const after = await counts();
  t.say(countsLine("  before the refusal", before));
  t.say(countsLine("  after the refusal ", after));
  t.check(`${args.label}: no data changed`, sameData(before, after));
  t.check(
    `${args.label}: exactly one denied row was written (or was already there)`,
    after.audits === before.audits + (prior[0] ? 0 : 1),
    `${String(before.audits)} -> ${String(after.audits)}`
  );
  const denied = await q.query<{
    id: string;
    action: string;
    intent: string | null;
    entity_type: string;
    entity_id: string | null;
    actor_role_code: string;
    actor_user_id: string | null;
    request_source: string;
    reason: string | null;
    before_state: string | null;
    after_state: string | null;
    created_at: string;
  }>(
    `select id::text as id, action, intent, entity_type, entity_id::text as entity_id, actor_role_code,
            actor_user_id::text as actor_user_id, request_source, reason,
            before_state::text as before_state, after_state::text as after_state,
            to_char(created_at at time zone 'UTC', '${UTC_STAMP}') as created_at
       from audit_log
      where action = $1 and outcome = 'denied' and entity_type = 'ticket' and ${args.rowWhere}
      order by created_at desc limit 1`,
    [capability, ...args.rowParams]
  );
  const row = denied[0];
  t.say(
    `  its own ledger row: id=${row?.id ?? "none"} action=${row?.action ?? "none"} entity_type=${row?.entity_type ?? "none"} ` +
      `entity_id=${row?.entity_id ?? "NULL"} actor_user_id=${row?.actor_user_id ?? "NULL"} role=${row?.actor_role_code ?? "none"} ` +
      `source=${row?.request_source ?? "none"} at=${row?.created_at ?? "none"}`
  );
  t.say(`      intent=${row?.intent ?? "NULL"} reason=${row?.reason ?? "NULL"}`);
  t.say(`      before_state=${row?.before_state ?? "NULL"} after_state=${row?.after_state ?? "NULL"}`);
  t.check(
    `${args.label}: the denied row names the capability as its action`,
    row?.action === capability,
    row?.action ?? "none"
  );
  t.check(
    `${args.label}: and it records no before/after state — a capability refusal changes nothing`,
    row?.before_state === null && row?.after_state === null,
    `before=${row?.before_state ?? "NULL"} after=${row?.after_state ?? "NULL"}`
  );
  t.say(`  the ticket this refusal was about: ${args.entityId}`);
  if (row && row.entity_id === null) {
    t.say(
      "  FINDING (DECISIONS.md, 1 October, item 8 — fixed in the 2b remainder): a person's refused transition writes entity_id NULL, so"
    );
    t.say(
      "  \"which tickets were refused at this station\" is not answerable from the ledger by id. The ticket was read first, so the refusal is"
    );
    t.say("  correct; only its ledger row is unaddressed. Not asserted here because the fix is another session's, and reported so it cannot be lost.");
  } else {
    t.check(
      `${args.label}: and its ledger row names the ticket`,
      row?.entity_id === args.entityId,
      row?.entity_id ?? "NULL"
    );
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------------------
  // 1. The fixture, read from the tables.
  // ---------------------------------------------------------------------------------------
  t.heading("the fixture booking and its three tickets, read from Postgres");
  const outletRows = await q.query<{
    id: string;
    code: string;
    chain_id: string;
    site_id: string;
    site_code: string;
    timezone: string;
    currency: string;
  }>(
    `select o.id, o.code, o.chain_id, o.site_id, s.code as site_code, s.timezone, s.currency
       from outlet o join site s on s.id = o.site_id where o.code = $1 limit 1`,
    [OUTLET_CODE]
  );
  const outlet = outletRows[0];
  if (!outlet) throw new Error(`no outlet ${OUTLET_CODE}`);
  t.say(
    `outlet ${outlet.code} (${outlet.id}) chain ${outlet.chain_id} site ${outlet.site_code} (${outlet.site_id}) ` +
      `${outlet.timezone} ${outlet.currency.trim()}`
  );
  await block(
    "the booking",
    `select 'order ' || o.status || ' (' || o.id::text || ') | outlet_order ' || oo.status || ' (' || oo.id::text || ')'
            || ' | fired_at=' || coalesce(to_char(oo.fired_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | served_at=' || coalesce(to_char(oo.served_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | closed_at=' || coalesce(to_char(oo.closed_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL') as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );
  const tickets = await q.query<Ticket>(
    `select tk.id, tk.ticket_no, tk.state, tk.routing_source, tk.section_id, s.code as section_code,
            to_char(tk.service_date, 'YYYY-MM-DD') as service_date
       from ticket tk join outlet_section s on s.id = tk.section_id
      where tk.outlet_order_id = $1 order by s.sort_order`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say("");
  t.say("the booking's tickets:");
  for (const row of tickets) {
    t.say(
      `  ticket ${String(row.ticket_no)} at ${row.section_code} (${row.id}) state=${row.state} routing_source=${row.routing_source} service_date=${row.service_date}`
    );
  }
  t.equal("three tickets, one per station", tickets.length, 3);
  t.check(
    "the three stations are the fixture's three (KOR-HOT, KOR-GRILL, KOR-COLD)",
    JSON.stringify(tickets.map((row) => row.section_code)) === JSON.stringify([...STATION_CODES]),
    tickets.map((row) => row.section_code).join(",")
  );
  const byStation = new Map(tickets.map((row) => [row.section_code, row]));
  const hot = byStation.get("KOR-HOT");
  const grill = byStation.get("KOR-GRILL");
  const cold = byStation.get("KOR-COLD");
  if (!hot || !grill || !cold) throw new Error("the fixture's three stations are not all present");
  const targetRows = await q.query<{ id: string; code: string; name: string }>(
    `select id, code, name from outlet_section where outlet_id = $1 and code = $2`,
    [outlet.id, REROUTE_TARGET_CODE]
  );
  const rerouteTarget = targetRows[0];
  if (!rerouteTarget) throw new Error(`no station ${REROUTE_TARGET_CODE} at this outlet`);
  t.say(`T9's target station: ${rerouteTarget.code} (${rerouteTarget.name}, ${rerouteTarget.id})`);
  const alreadyTerminal = tickets.every((row) => row.state === "served" || row.state === "voided");
  t.say(
    alreadyTerminal
      ? "every ticket is already terminal, so a previous run drove this lifecycle — this run reads it back and repeats no act"
      : "the tickets are not all terminal yet, so this run drives the lifecycle"
  );

  // ---------------------------------------------------------------------------------------
  // 2. The capabilities and the accounts that hold them.
  // ---------------------------------------------------------------------------------------
  t.heading("kds.ticket.* — the capabilities, and who actually holds them (read from the rows)");
  await block(
    "the five act capabilities, and the one that stays S-A's",
    `select p.code || ' | ' || p.action_kind || ' | layer=' || p.layer || ' | site_scope=' || p.requires_site_scope::text
            || ' | financial_or_stock=' || p.financial_or_stock::text || ' | implemented_in=' || coalesce(p.implemented_in, 'NULL') as line
       from permission p where p.code like 'kds.ticket%' order by p.code`
  );
  await block(
    "the roles each act capability is granted to (§2.4's holders)",
    `select p.code || ' -> ' || r.code as line
       from role_permission rp join permission p on p.id = rp.permission_id join role r on r.id = rp.role_id
      where p.code like 'kds.ticket%' and rp.effect = 'allow' order by p.code, r.code`
  );
  const actCapabilities = [
    TICKET_TRANSITIONS.acknowledge.capability,
    TICKET_TRANSITIONS.start.capability,
    TICKET_TRANSITIONS.ready.capability,
    TICKET_TRANSITIONS.recall.capability,
    TICKET_TRANSITIONS.serve.capability,
    TICKET_TRANSITIONS.void.capability,
    TICKET_TRANSITIONS.reroute.capability,
  ];
  const holdersByCapability = new Map<string, string[]>();
  for (const code of [...new Set(actCapabilities)]) {
    holdersByCapability.set(code, await emailsHolding(q, code));
  }
  t.say("");
  for (const [code, holders] of holdersByCapability) {
    t.say(`  ${code}: ${holders.length === 0 ? "NO active account holds it" : holders.join(", ")}`);
  }
  const head = await principalFor(q, SITE_HEAD_EMAIL, outlet.chain_id);
  t.say(
    `the pilot's own Site Head: ${head.email} roles ${head.roles.map((role) => role.code).join(",")} site ${head.siteId ?? "NULL"}`
  );
  for (const code of [...new Set(actCapabilities)]) {
    t.say(`  holds ${code}: ${String(head.permissions.includes(code))}`);
  }
  t.check(
    "the Site Head holds the four person-held acts (recall, serve, void, re-route)",
    ["kds.ticket.recall", "kds.ticket.serve", "kds.ticket.void", "kds.ticket.reroute"].every((code) =>
      head.permissions.includes(code)
    )
  );
  t.check(
    "and does NOT hold kds.ticket.advance — which is why T2/T3/T4 need a station terminal",
    !head.permissions.includes("kds.ticket.advance")
  );
  const advanceHolders = holdersByCapability.get("kds.ticket.advance") ?? [];
  t.say("");
  if (advanceHolders.length === 0) {
    t.say(
      "FINDING: no active seeded account holds kds.ticket.advance. §2.4 grants it to Site Culinary Team and Site Operations Team, and the"
    );
    t.say(
      "pilot has neither account, so T2 acknowledge, T3 start and T4 ready are driven here by a STATION TERMINAL — the other principal §2.4"
    );
    t.say(
      "names for the act. Demo-data debt of the same class as S-A's missing display.view-only account: reported, not worked around."
    );
  } else {
    t.say(`a seeded account does hold it (${advanceHolders.join(", ")}) — the advance actor below is that person, not a terminal`);
  }

  /**
   * The station terminals. Built in process, from the outlet's own rows: the scope is read
   * from `outlet_section`, the acting role is the one S-A's pairing writes for a KDS
   * (`SITE_CULINARY_TEAM`, asserted by `verify-display-foundation`), and the capability set is
   * `displayCapabilities('kds')` — the product's own function. **No credential row backs these
   * principals and no pairing code is redeemed**: the token path is S-A's verified ground and is
   * out of this slice. See HONEST LIMITS at the end.
   */
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";
  const deviceFor = (section: { id: string; code: string }): DevicePrincipal => ({
    credentialId: NIL_UUID,
    displayId: NIL_UUID,
    code: `verify-kds-${section.code.toLowerCase()}`,
    name: `Read-back terminal at ${section.code}`,
    kind: "kds",
    chainId: outlet.chain_id,
    siteId: outlet.site_id,
    outletId: outlet.id,
    sectionId: section.id,
    operatingRoleCode: "SITE_CULINARY_TEAM",
    capabilities: displayCapabilities("kds"),
  });
  const advancePerson = advanceHolders[0] ? await principalFor(q, advanceHolders[0], outlet.chain_id) : null;
  const advanceActor = (ticket: Ticket): TicketActor =>
    advancePerson ? personActor(advancePerson) : deviceActor(deviceFor({ id: ticket.section_id, code: ticket.section_code }));
  t.say(
    `the advance actor this harness uses: ${advancePerson ? `person ${advancePerson.email}` : "a station terminal (kds, displayCapabilities('kds'))"}`
  );
  t.say(
    `a kds terminal's capability set, from the product's own registry: ${displayCapabilities("kds").join(", ")} — so it may advance (T2/T3/T4) and read, and may not serve, recall, void or re-route; those four are people's acts in this run`
  );
  // **Which actor path each act has, measured rather than left to a reader's inference.** Every
  // act in this run has exactly one path, and the other path is a refusal the product's own
  // registry produces — not an untested branch:
  //   * T2/T3/T4 (`kds.ticket.advance`): the station terminal. No seeded account holds the
  //     capability (above), so the person path is the Site Head's refusal in step 4.
  //   * T5 recall, T6 serve, T7 void, T9 re-route: a person, the Site Head. `displayCapabilities`
  //     gives a KDS terminal view and advance only, so no terminal in this build can hold any of
  //     the four; the terminal path is the refusal in step 4b, made on a ticket in the state the
  //     act would otherwise apply to.
  const personOnlyActs = [
    TICKET_TRANSITIONS.recall.capability,
    TICKET_TRANSITIONS.serve.capability,
    TICKET_TRANSITIONS.void.capability,
    TICKET_TRANSITIONS.reroute.capability,
  ];
  t.check(
    "a kds terminal's registry gives it no person-only act — which is why recall, serve, void and re-route have one path",
    personOnlyActs.every((code) => !displayCapabilities("kds").includes(code)),
    displayCapabilities("kds").join(", ")
  );
  t.say(`  the four acts a terminal may not hold, from the registry: ${personOnlyActs.join(", ")}`);

  // ---------------------------------------------------------------------------------------
  // 3. Migration 0016, read back.
  // ---------------------------------------------------------------------------------------
  t.heading("migration 0016 in the database: the replay key and the reason vocabulary");
  await block(
    "ticket_transition.transition_id",
    `select column_name || ' | ' || data_type || ' | nullable=' || is_nullable as line
       from information_schema.columns where table_name = 'ticket_transition' and column_name = 'transition_id'`
  );
  await block(
    "the unique indexes on ticket_transition (the replay key among them)",
    `select i.relname || ' | unique=' || ix.indisunique::text || ' | ' || pg_get_indexdef(ix.indexrelid) as line
       from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class tb on tb.oid = ix.indrelid
      where tb.relname = 'ticket_transition' and ix.indisunique order by i.relname`
  );
  const replayIndex = await q.query<{ def: string }>(
    `select pg_get_indexdef(ix.indexrelid) as def
       from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class tb on tb.oid = ix.indrelid
      where tb.relname = 'ticket_transition' and i.relname = 'ticket_transition_replay_key'`
  );
  t.check(
    "the replay key exists, is unique and is PARTIAL (online transitions carry NULL and are not in it)",
    (replayIndex[0]?.def ?? "").includes("transition_id") && (replayIndex[0]?.def ?? "").includes("IS NOT NULL"),
    replayIndex[0]?.def ?? "MISSING"
  );
  await block(
    "the reason-vocabulary constraints and 0014's non-empty rules, from the catalogue",
    `select con.conname || ' | ' || pg_get_constraintdef(con.oid) as line
       from pg_constraint con join pg_class c on c.oid = con.conrelid
      where c.relname = 'ticket' and con.conname in ('ticket_void_reason_vocabulary','ticket_hold_reason_vocabulary',
                                                      'ticket_void_reason','ticket_hold_reason')
      order by con.conname`
  );
  const constraintDefs = await q.query<{ conname: string; def: string }>(
    `select con.conname, pg_get_constraintdef(con.oid) as def
       from pg_constraint con join pg_class c on c.oid = con.conrelid
      where c.relname = 'ticket' and con.conname in ('ticket_void_reason_vocabulary','ticket_hold_reason_vocabulary',
                                                      'ticket_void_reason','ticket_hold_reason')`
  );
  const defByName = new Map(constraintDefs.map((row) => [row.conname, row.def]));
  for (const code of TICKET_REASON_CODES.void) {
    t.check(
      `the database accepts the void reason code the code offers: ${code}`,
      (defByName.get("ticket_void_reason_vocabulary") ?? "").includes(`'${code}'`),
      defByName.get("ticket_void_reason_vocabulary") ?? "MISSING"
    );
  }
  t.check(
    "the database accepts a recall's and a re-route's reason codes on the hold column (T8 has no list of its own yet)",
    TICKET_REASON_CODES.recall.every((code) => (defByName.get("ticket_hold_reason_vocabulary") ?? "").includes(`'${code}'`)) &&
      TICKET_REASON_CODES.reroute.every((code) =>
        (defByName.get("ticket_hold_reason_vocabulary") ?? "").includes(`'${code}'`)
      ),
    defByName.get("ticket_hold_reason_vocabulary") ?? "MISSING"
  );
  t.check(
    "and the existing non-empty rule for a voided / held ticket is still there, unchanged",
    (defByName.get("ticket_void_reason") ?? "").includes("length(btrim") &&
      (defByName.get("ticket_hold_reason") ?? "").includes("length(btrim"),
    `${defByName.get("ticket_void_reason") ?? "MISSING"} | ${defByName.get("ticket_hold_reason") ?? "MISSING"}`
  );
  // Migration 0017 widened both checks to the union of TWO vocabularies, because the ruling's set
  // and the code's set disagree (DECISIONS.md 1 Oct, the audit, item 2). Both halves are asserted
  // here, so neither can be dropped silently and the tightening has a test ready to fail loudly.
  const RULED_REASON_CODES = ["dropped", "wrong_item", "remade", "guest_changed", "quality", "other"] as const;
  for (const code of RULED_REASON_CODES) {
    t.check(
      `the database accepts ruling 4's reason code: ${code}`,
      (defByName.get("ticket_void_reason_vocabulary") ?? "").includes(`'${code}'`) &&
        (defByName.get("ticket_hold_reason_vocabulary") ?? "").includes(`'${code}'`),
      defByName.get("ticket_void_reason_vocabulary") ?? "MISSING"
    );
  }
  t.say("");
  t.say(
    "NOTE: the ruled set and the code's set still disagree (`quality` vs the code's `quality_check_failed`, and the code carries"
  );
  t.say(
    "`guest_cancelled`, `article_unavailable`, `duplicate_ticket`, `marked_ready_in_error`, `wrong_station`, `station_unavailable`)."
  );
  t.say(
    "Both constraints therefore accept the UNION, so nothing the shipped code can write is refused by the database while the code is"
  );
  t.say(
    "reconciled with the ruling — migration 0017's header carries the one-statement tightening for the remainder."
  );
  await block(
    "every reason code any ticket row currently holds (the pre-check that the new checks reject no row)",
    `select 'void_reason_code=' || coalesce(void_reason_code, 'NULL') || ' hold_reason_code=' || coalesce(hold_reason_code, 'NULL')
            || ' state=' || state || ' rows=' || count(*)::text as line
       from ticket group by 1, 2, 3 order by 1`
  );

  // Two demonstration writes that must be refused, each inside a transaction that is rolled
  // back **whatever happens**, so the table is unchanged either way (the S-B/2a harness's pattern).
  class RolledBack extends Error {}
  const demonstration = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    let accepted = false;
    try {
      await withTransaction(async (tx) => {
        await tx.query(sql, params);
        accepted = true;
        throw new RolledBack(`roll back ${label}`);
      });
    } catch (error) {
      if (!(error instanceof RolledBack)) {
        const code = (error as { code?: string }).code ?? "";
        const first = errorMessage(error).split("\n")[0] ?? "";
        t.say(`  ${label}: refused by the database (SQLSTATE ${code || "?"}): ${first}`);
        t.check(`${label}: refused by a check constraint (23514)`, code === "23514", code);
        return;
      }
    }
    if (accepted) {
      t.say(`  ${label}: ACCEPTED (then rolled back) — the constraint did not fire`);
      t.failures.push(`${label}: the write was accepted`);
    }
  };
  t.say("");
  t.say("two writes the new constraints must refuse — each rolled back, so nothing is written either way:");
  await demonstration(
    "a void carrying a reason code no act offers",
    `update ticket set state = 'voided', voided_at = now(), void_reason_code = 'because_i_said_so' where id = $1`,
    [hot.id]
  );
  await demonstration(
    "a hold carrying a reason code no act offers",
    `update ticket set state = 'held_unavailable', held_at = now(), hold_reason_code = 'something_else' where id = $1`,
    [hot.id]
  );
  const unchanged = await readTicket(hot.id);
  t.check(
    "and the ticket those two writes targeted is untouched by either",
    unchanged.state !== "voided" && unchanged.state !== "held_unavailable",
    unchanged.state
  );

  // ---------------------------------------------------------------------------------------
  // 4. The two capability refusals.
  // ---------------------------------------------------------------------------------------
  t.heading("a capability refusal: a real account that does not hold the act's capability");
  const beforeAll = await counts();
  t.say(countsLine("before everything", beforeAll));
  await capabilityRefusal({
    label: `${SITE_HEAD_EMAIL} attempts T2 acknowledge on ticket ${String(hot.ticket_no)} (it does not hold ${REFUSED_ACT})`,
    actorDescription: `${head.email} roles ${head.roles.map((role) => role.code).join(",")} — holds ${REFUSED_ACT}: ${String(head.permissions.includes(REFUSED_ACT))}`,
    priorDenialSql: `select id::text, to_char(created_at at time zone 'UTC', '${UTC_STAMP}') as created_at, reason
                       from audit_log
                      where action = $1 and outcome = 'denied' and entity_type = 'ticket'
                        and actor_user_id = (select id from "user" where email = $2)
                      order by created_at desc limit 1`,
    priorDenialParams: [REFUSED_ACT, SITE_HEAD_EMAIL],
    // The generic `guard()` denial carries no entity id (DECISIONS.md 1 Oct, item 8), so the
    // row is found by actor rather than by ticket — the transcript says so where it reports it.
    rowWhere: `actor_user_id = (select id from "user" where email = $2)`,
    rowParams: [SITE_HEAD_EMAIL],
    entityId: hot.id,
    call: () => advanceTicket(personActor(head), { ticketId: hot.id, to: "acknowledged" }),
  });
  const hotDevice = deviceFor({ id: hot.section_id, code: hot.section_code });
  await capabilityRefusal({
    label: `the ${hot.section_code} terminal attempts T2 on the ${grill.section_code} ticket (another station's work)`,
    actorDescription: `display ${hotDevice.code} is attached to ${hot.section_code} (${hotDevice.sectionId}); the ticket is at ${grill.section_code} (${grill.section_id})`,
    priorDenialSql: `select id::text, to_char(created_at at time zone 'UTC', '${UTC_STAMP}') as created_at, reason
                       from audit_log
                      where action = $1 and outcome = 'denied' and entity_type = 'ticket' and entity_id = $2
                        and actor_user_id is null and reason like $3
                      order by created_at desc limit 1`,
    priorDenialParams: [REFUSED_ACT, grill.id, `display:${hotDevice.code}%`],
    rowWhere: `actor_user_id is null and reason like $2`,
    rowParams: [`display:${hotDevice.code}%`],
    entityId: grill.id,
    call: () => advanceTicket(deviceActor(hotDevice), { ticketId: grill.id, to: "acknowledged" }),
  });

  // ---------------------------------------------------------------------------------------
  // 5. Ticket A — §2.3's full path, and the refusals it can produce on the way.
  // ---------------------------------------------------------------------------------------
  t.heading(`ticket A (${hot.section_code}, ticket ${String(hot.ticket_no)}) — §2.3's full path, with a recall`);
  await perform({
    label: "T2 acknowledge — the station terminal claims the ticket",
    act: "acknowledge",
    ticket: hot,
    expectedState: "acknowledged",
    actor: advanceActor(hot),
    call: () => advanceTicket(advanceActor(hot), { ticketId: hot.id, to: "acknowledged" }),
  });
  await perform({
    label: "T3 start — the kitchen begins the dish",
    act: "start",
    ticket: hot,
    expectedState: "in_prep",
    actor: advanceActor(hot),
    call: () => advanceTicket(advanceActor(hot), { ticketId: hot.id, to: "in_prep" }),
  });
  await perform({
    label: "T4 ready — the dish is on the pass",
    act: "ready",
    ticket: hot,
    expectedState: "ready",
    actor: advanceActor(hot),
    call: () => advanceTicket(advanceActor(hot), { ticketId: hot.id, to: "ready" }),
  });
  // Step 4b: the terminal half of the four person-only acts. The ticket is `ready`, which is
  // exactly the state a recall applies to, and the KOR-HOT terminal is the device that could
  // otherwise advance it — so this is the refusal that would otherwise have been a missing branch.
  await capabilityRefusal({
    label: `the ${hot.section_code} terminal attempts T5 recall (a person's act — a terminal holds no ${TICKET_TRANSITIONS.recall.capability})`,
    actorDescription: `display ${hotDevice.code} capabilities ${displayCapabilities("kds").join(",")} — holds ${TICKET_TRANSITIONS.recall.capability}: false`,
    capability: TICKET_TRANSITIONS.recall.capability,
    priorDenialSql: `select id::text, to_char(created_at at time zone 'UTC', '${UTC_STAMP}') as created_at, reason
                       from audit_log
                      where action = $1 and outcome = 'denied' and entity_type = 'ticket' and entity_id = $2
                        and actor_user_id is null and reason like $3
                      order by created_at desc limit 1`,
    priorDenialParams: [TICKET_TRANSITIONS.recall.capability, hot.id, `display:${hotDevice.code}%`],
    rowWhere: `actor_user_id is null and reason like $2`,
    rowParams: [`display:${hotDevice.code}%`],
    entityId: hot.id,
    call: () =>
      recallTicket(deviceActor(hotDevice), { ticketId: hot.id, reasonCode: "marked_ready_in_error" }),
  });

  await validationRefusal({
    label: "T5 recall with NO reason",
    expectKey: TICKET_VALIDATION_KEY.reasonRequired,
    ticketIds: [hot.id],
    call: () => recallTicket(personActor(head), { ticketId: hot.id, reasonCode: "" }),
  });
  await perform({
    label: "T5 recall WITH a reason (marked_ready_in_error) — the ticket goes back to in_prep",
    act: "recall",
    ticket: hot,
    expectedState: "in_prep",
    actor: personActor(head),
    call: () => recallTicket(personActor(head), { ticketId: hot.id, reasonCode: "marked_ready_in_error" }),
  });
  const afterRecall = await readTicket(hot.id);
  t.check(
    "T5 recall cleared ready_at — a recalled ticket is not a ready ticket",
    afterRecall.ready_at === null,
    afterRecall.ready_at ?? "NULL"
  );
  await validationRefusal({
    label: "T3 start again after the recall — the state moved on (the brief's own sequence, corrected by the database)",
    expectKey: TICKET_VALIDATION_KEY.movedOn,
    ticketIds: [hot.id],
    call: () => advanceTicket(advanceActor(hot), { ticketId: hot.id, to: "in_prep" }),
  });
  await perform({
    label: "T4 ready again — the honest next act after a recall",
    act: "ready",
    ticket: hot,
    expectedState: "ready",
    actor: advanceActor(hot),
    call: () => advanceTicket(advanceActor(hot), { ticketId: hot.id, to: "ready" }),
  });
  await perform({
    label: "T6 serve — a person at the pass, and the booking must NOT be served yet (two tickets are still open)",
    act: "serve",
    ticket: hot,
    expectedState: "served",
    actor: personActor(head),
    call: () => serveTicket(personActor(head), { ticketId: hot.id }),
  });
  const bookingAfterFirstServe = await q.query<{ outlet_order_status: string; order_status: string }>(
    `select oo.status as outlet_order_status, o.status as order_status
       from outlet_order oo join "order" o on o.id = oo.order_id where oo.id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say(
    `  the booking after one ticket is served: outlet_order ${bookingAfterFirstServe[0]?.outlet_order_status ?? "MISSING"}, order ${bookingAfterFirstServe[0]?.order_status ?? "MISSING"}`
  );
  t.check(
    "the booking is NOT served while two of its three tickets are still open",
    bookingAfterFirstServe[0]?.outlet_order_status === "fired",
    bookingAfterFirstServe[0]?.outlet_order_status ?? "MISSING"
  );

  // ---------------------------------------------------------------------------------------
  // 6. Ticket C — the fast path to in_prep, then T9, then T7 with a reason.
  // ---------------------------------------------------------------------------------------
  t.heading(`ticket C (${cold.section_code}, ticket ${String(cold.ticket_no)}) — T9 re-route, then T7 void`);
  await perform({
    label: "T2 acknowledge",
    act: "acknowledge",
    ticket: cold,
    expectedState: "acknowledged",
    actor: advanceActor(cold),
    call: () => advanceTicket(advanceActor(cold), { ticketId: cold.id, to: "acknowledged" }),
  });
  await perform({
    label: "T3 start",
    act: "start",
    ticket: cold,
    expectedState: "in_prep",
    actor: advanceActor(cold),
    call: () => advanceTicket(advanceActor(cold), { ticketId: cold.id, to: "in_prep" }),
  });
  const routingSourceBeforeReroute = (await readTicket(cold.id)).routing_source;
  await perform({
    label: `T9 re-route — ${cold.section_code} -> ${REROUTE_TARGET_CODE} (wrong_station); the state must NOT move`,
    act: "reroute",
    ticket: cold,
    expectedState: "in_prep",
    expectedSection: REROUTE_TARGET_CODE,
    actor: personActor(head),
    call: () =>
      rerouteTicket(personActor(head), {
        ticketId: cold.id,
        sectionId: rerouteTarget.id,
        reasonCode: "wrong_station",
      }),
  });
  const afterReroute = await readTicket(cold.id);
  t.check(
    "T9 left routing_source alone — it says why the line was routed AT FIRE (D4, confirmed by the lead)",
    afterReroute.routing_source === routingSourceBeforeReroute && afterReroute.routing_source === "article_route",
    `${afterReroute.routing_source} vs ${routingSourceBeforeReroute}`
  );
  const orderLineAfterReroute = await q.query<{ line_state: string; routing_source: string | null }>(
    `select ol.line_state, ol.routing_source
       from ticket_line tl join order_line ol on ol.id = tl.order_line_id
      where tl.ticket_id = $1`,
    [cold.id]
  );
  t.say(
    `  the order_line behind this ticket: line_state=${orderLineAfterReroute[0]?.line_state ?? "MISSING"} routing_source=${orderLineAfterReroute[0]?.routing_source ?? "NULL"}`
  );
  t.check(
    "and the order line's own line_state is still 'fired' — a ticket transition does not move it (confirmed by the lead)",
    orderLineAfterReroute[0]?.line_state === "fired",
    orderLineAfterReroute[0]?.line_state ?? "MISSING"
  );
  await validationRefusal({
    label: "T7 void with NO reason",
    expectKey: TICKET_VALIDATION_KEY.reasonRequired,
    ticketIds: [cold.id],
    call: () => voidTicket(personActor(head), { ticketId: cold.id, reasonCode: "   " }),
  });
  await perform({
    label: "T7 void WITH a reason (dropped)",
    act: "void",
    ticket: cold,
    expectedState: "voided",
    actor: personActor(head),
    call: () => voidTicket(personActor(head), { ticketId: cold.id, reasonCode: "dropped" }),
  });
  const afterVoid = await readTicket(cold.id);
  t.check(
    "T7 void stamped voided_at and stored the reason code",
    afterVoid.voided_at !== null && afterVoid.void_reason_code === "dropped",
    `voided_at=${afterVoid.voided_at ?? "NULL"} code=${afterVoid.void_reason_code ?? "NULL"}`
  );
  const bookingAfterVoid = await q.query<{ status: string }>(`select status from outlet_order where id = $1`, [
    FIXTURE_OUTLET_ORDER_ID,
  ]);
  t.check(
    "a served and a voided ticket do not make a served booking while the third is open",
    bookingAfterVoid[0]?.status === "fired",
    bookingAfterVoid[0]?.status ?? "MISSING"
  );

  // ---------------------------------------------------------------------------------------
  // 7. Ticket B — the fast path, and the serve that finishes the booking's work.
  // ---------------------------------------------------------------------------------------
  t.heading(
    `ticket B (${grill.section_code}, ticket ${String(grill.ticket_no)}) — the fast path, and the serve that finishes the booking`
  );
  await perform({
    label: "T2 acknowledge",
    act: "acknowledge",
    ticket: grill,
    expectedState: "acknowledged",
    actor: advanceActor(grill),
    call: () => advanceTicket(advanceActor(grill), { ticketId: grill.id, to: "acknowledged" }),
  });
  await perform({
    label: "T3 start (start takes queued OR acknowledged — D8's fast path)",
    act: "start",
    ticket: grill,
    expectedState: "in_prep",
    actor: advanceActor(grill),
    call: () => advanceTicket(advanceActor(grill), { ticketId: grill.id, to: "in_prep" }),
  });
  await perform({
    label: "T4 ready",
    act: "ready",
    ticket: grill,
    expectedState: "ready",
    actor: advanceActor(grill),
    call: () => advanceTicket(advanceActor(grill), { ticketId: grill.id, to: "ready" }),
  });
  await perform({
    label: "T5 recall WITH a reason (quality_check_failed) — the second ticket's recall",
    act: "recall",
    ticket: grill,
    expectedState: "in_prep",
    actor: personActor(head),
    call: () => recallTicket(personActor(head), { ticketId: grill.id, reasonCode: "quality_check_failed" }),
  });
  await perform({
    label: "T4 ready again",
    act: "ready",
    ticket: grill,
    expectedState: "ready",
    actor: advanceActor(grill),
    call: () => advanceTicket(advanceActor(grill), { ticketId: grill.id, to: "ready" }),
  });
  const beforeLastServe = await counts();
  await perform({
    label: "T6 serve — the last open ticket, which must move the booking to served",
    act: "serve",
    ticket: grill,
    expectedState: "served",
    actor: personActor(head),
    call: () => serveTicket(personActor(head), { ticketId: grill.id }),
  });
  const afterLastServe = await counts();
  const servedJournal = await q.query<{ audit_id: string | null }>(
    `select audit_id::text as audit_id from ticket_transition
      where ticket_id = $1 and transition_code = 'T6' order by occurred_at desc limit 1`,
    [grill.id]
  );
  const servedAudit = servedJournal[0]?.audit_id ? await readAudit(servedJournal[0].audit_id) : null;
  t.say(`  the T6 ledger row's after-state: ${servedAudit?.after_state ?? "NULL"}`);
  // **The decision this assertion's owner asked for (2 October 2026): the assertion is RIGHT and
  // it was unreachable, not wrong.** `~/domain/ticket` records the booking's move in the serve
  // act's own after-state — `outletOrder: { status: "served", because: "…" }` — and this serve is
  // the one that finishes the booking, because the KOR-COLD ticket is voided and the KOR-HOT one
  // served. It could never pass before the void reason-code placeholder was fixed: the third
  // ticket stayed open, the booking never reached `served`, and the ledger had no `outletOrder`
  // field to read. The check reads that field rather than a substring, so it says which booking
  // moved and why, and a missing `because` fails it.
  let bookingMovedTo: { status?: string; because?: string } | undefined;
  try {
    bookingMovedTo = (
      JSON.parse(servedAudit?.after_state ?? "{}") as {
        outletOrder?: { status?: string; because?: string };
      }
    ).outletOrder;
  } catch {
    bookingMovedTo = undefined;
  }
  t.check(
    "the ledger row records WHY the booking moved, in the after-state",
    bookingMovedTo?.status === "served" && (bookingMovedTo.because ?? "").length > 0,
    servedAudit?.after_state ?? "NULL"
  );
  t.say(
    `  the booking's move as the ledger records it: outletOrder.status=${bookingMovedTo?.status ?? "MISSING"} ` +
      `because="${bookingMovedTo?.because ?? "MISSING"}"`
  );
  t.say(countsLine("  before the last serve", beforeLastServe));
  t.say(countsLine("  after the last serve ", afterLastServe));
  await block(
    "the booking after the last serve",
    `select 'order ' || o.status || ' | outlet_order ' || oo.status
            || ' | served_at=' || coalesce(to_char(oo.served_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | prep_deadline_at=' || coalesce(to_char(oo.prep_deadline_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL') as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );
  const servedBooking = await q.query<{ outlet_order_status: string; order_status: string }>(
    `select oo.status as outlet_order_status, o.status as order_status
       from outlet_order oo join "order" o on o.id = oo.order_id where oo.id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.check(
    "every ticket terminal and at least one served => the booking is served (T6's own rule)",
    servedBooking[0]?.outlet_order_status === "served" && servedBooking[0]?.order_status === "served",
    `outlet_order=${servedBooking[0]?.outlet_order_status ?? "MISSING"} order=${servedBooking[0]?.order_status ?? "MISSING"}`
  );

  // ---------------------------------------------------------------------------------------
  // 8. T11 — close the booking.
  // ---------------------------------------------------------------------------------------
  t.heading("T11 close the booking (order.close)");
  const terminalNow = await q.query<{ state: string; n: number }>(
    `select state, count(*)::int as n from ticket where outlet_order_id = $1 group by state order by state`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say(`the tickets' states before the close: ${terminalNow.map((row) => `${row.state}=${String(row.n)}`).join(" ")}`);
  t.check(
    "every ticket is terminal before T11 is attempted",
    terminalNow.every((row) => row.state === "served" || row.state === "voided"),
    terminalNow.map((row) => row.state).join(",")
  );
  const closeCountsBefore = await counts();
  if (servedBooking[0]?.outlet_order_status === "closed") {
    t.say("a previous run already closed this booking — read back, not repeated");
  } else {
    const closed = await closeOutletOrder(
      head,
      { outletOrderId: FIXTURE_OUTLET_ORDER_ID, reasonCode: "the booking's work is finished and the guest has gone" },
      { source: "system", intent: "order.close" }
    );
    t.say(`closed: booking ${closed.outletOrderId} ${closed.from} -> ${closed.to}`);
  }
  const afterClose = await counts();
  t.say(countsLine("  before the close", closeCountsBefore));
  t.say(countsLine("  after the close ", afterClose));
  await block(
    "the booking after T11",
    `select 'order ' || o.status || ' | outlet_order ' || oo.status
            || ' | closed_at=' || coalesce(to_char(oo.closed_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | served_at=' || coalesce(to_char(oo.served_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL') as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );
  const closedBooking = await q.query<{ outlet_order_status: string; order_status: string; closed_at: string | null }>(
    `select oo.status as outlet_order_status, o.status as order_status,
            to_char(oo.closed_at at time zone 'UTC', '${UTC_STAMP}') as closed_at
       from outlet_order oo join "order" o on o.id = oo.order_id where oo.id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.check(
    "the booking reaches 'closed' on both rows, with a closed_at",
    closedBooking[0]?.outlet_order_status === "closed" &&
      closedBooking[0]?.order_status === "closed" &&
      closedBooking[0]?.closed_at !== null,
    `outlet_order=${closedBooking[0]?.outlet_order_status ?? "MISSING"} order=${closedBooking[0]?.order_status ?? "MISSING"} closed_at=${closedBooking[0]?.closed_at ?? "NULL"}`
  );

  // ---------------------------------------------------------------------------------------
  // 9. Everything the lifecycle wrote, read back at once.
  // ---------------------------------------------------------------------------------------
  t.heading("every row this lifecycle wrote, read back at once");
  await block(
    "the booking's tickets, with the values the acceptance criterion names",
    `select 'ticket ' || tk.ticket_no::text || ' at ' || s.code || ' (' || s.kind || ') | state=' || tk.state
            || ' | routing_source=' || tk.routing_source
            || ' | ready_at=' || coalesce(to_char(tk.ready_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | served_at=' || coalesce(to_char(tk.served_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | voided_at=' || coalesce(to_char(tk.voided_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | void_reason_code=' || coalesce(tk.void_reason_code, 'NULL')
            || ' | lines=' || coalesce((select string_agg(tl.state, ',' order by tl.position) from ticket_line tl where tl.ticket_id = tk.id), 'none') as line
       from ticket tk join outlet_section s on s.id = tk.section_id
      where tk.outlet_order_id = $1 order by s.sort_order`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  await block(
    "the whole journal of this booking, every row pointing at its ledger row",
    `select tt.transition_code || ' | ' || coalesce(tt.from_state, 'NULL') || ' -> ' || tt.to_state
            || ' | ticket ' || tk.ticket_no::text || ' | reason=' || coalesce(tt.reason_code, 'NULL')
            || ' | actor=' || coalesce(tt.actor_user_id::text, 'device ' || coalesce(tt.display_code, '?')) || ' role=' || tt.actor_role_code
            || ' | audit_id=' || coalesce(tt.audit_id::text, 'NULL')
            || ' | transition_id=' || coalesce(tt.transition_id::text, 'NULL')
            || ' | occurred_at=' || to_char(tt.occurred_at at time zone 'UTC', '${UTC_STAMP}') as line
       from ticket_transition tt join ticket tk on tk.id = tt.ticket_id
      where tk.outlet_order_id = $1 order by tt.occurred_at`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  await block(
    "every journal row's ledger row, joined, with the action and the state it recorded",
    `select 'journal ' || tt.id::text || ' ' || tt.transition_code || ' -> audit ' || a.id::text
            || ' | action=' || a.action || ' | intent=' || coalesce(a.intent, 'NULL')
            || ' | outcome=' || a.outcome || ' | after.state=' || coalesce(a.after_state->>'state', 'NULL')
            || ' | one transaction: ' || (tt.occurred_at = a.created_at)::text
            || ' | actor_user_id=' || coalesce(a.actor_user_id::text, 'NULL') || ' role=' || a.actor_role_code as line
       from ticket_transition tt join ticket tk on tk.id = tt.ticket_id join audit_log a on a.id = tt.audit_id
      where tk.outlet_order_id = $1 order by tt.occurred_at`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  const journalLedger = await q.query<{ rows: number; orphaned: number; mismatched: number; same_stamp: number; mapped: number }>(
    `select count(*)::int as rows,
            count(*) filter (where tt.audit_id is null)::int as orphaned,
            count(*) filter (where a.id is null or a.after_state->>'state' is distinct from tt.to_state)::int as mismatched,
            count(*) filter (where tt.occurred_at = a.created_at)::int as same_stamp,
            count(*) filter (where a.action in ('kds.ticket.advance','kds.ticket.recall','kds.ticket.serve','kds.ticket.void','kds.ticket.reroute','order.fire'))::int as mapped
       from ticket_transition tt join ticket tk on tk.id = tt.ticket_id left join audit_log a on a.id = tt.audit_id
      where tk.outlet_order_id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  const jl = journalLedger[0];
  t.say(
    `journal rows of this booking: ${String(jl?.rows ?? 0)} (audit_id null: ${String(jl?.orphaned ?? 0)}, action not a lifecycle capability: ${String((jl?.rows ?? 0) - (jl?.mapped ?? 0))}, after-state disagreeing with to_state: ${String(jl?.mismatched ?? 0)}, same timestamp as the ledger row: ${String(jl?.same_stamp ?? 0)})`
  );
  t.check("every journal row of this booking carries an audit id", (jl?.orphaned ?? 1) === 0, String(jl?.orphaned ?? -1));
  t.check(
    "every journal row's ledger row records the state the journal records",
    (jl?.mismatched ?? 1) === 0,
    String(jl?.mismatched ?? -1)
  );
  t.check(
    "every journal row and its ledger row share one timestamp — one transaction per transition",
    (jl?.same_stamp ?? 0) === (jl?.rows ?? -1),
    `${String(jl?.same_stamp ?? -1)} of ${String(jl?.rows ?? -1)}`
  );
  t.check(
    "every journal row's ledger row names a lifecycle capability",
    (jl?.mapped ?? 0) === (jl?.rows ?? -1),
    `${String(jl?.mapped ?? -1)} of ${String(jl?.rows ?? -1)}`
  );
  const journalCounts = await q.query<{ transition_code: string; n: number }>(
    `select tt.transition_code, count(*)::int as n
       from ticket_transition tt join ticket tk on tk.id = tt.ticket_id
      where tk.outlet_order_id = $1 group by tt.transition_code order by tt.transition_code`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say(`journal rows by code: ${journalCounts.map((row) => `${row.transition_code}=${String(row.n)}`).join(" ")}`);
  const t11Rows = await q.query<{ n: number }>(
    `select count(*)::int as n from audit_log where action = 'order.close' and entity_type = 'outlet_order' and entity_id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say(
    `T11's own ledger rows on the booking: ${String(t11Rows[0]?.n ?? 0)} — the journal is per ticket and T11 is the booking's act, so it has no ticket_transition row. Stated rather than assumed.`
  );
  await block(
    "the ledger rows this lifecycle wrote on the booking's tickets",
    `select 'audit ' || a.id::text || ' | ' || a.action || ' | ' || coalesce(a.intent, 'NULL')
            || ' | ' || a.outcome || ' | ticket ' || coalesce((select tk.ticket_no::text from ticket tk where tk.id::text = a.entity_id), '?')
            || ' | before.state=' || coalesce(a.before_state->>'state', 'NULL')
            || ' -> after.state=' || coalesce(a.after_state->>'state', 'NULL')
            || ' | actor=' || coalesce(a.actor_user_id::text, 'display') || ' role=' || a.actor_role_code
            || ' | at=' || to_char(a.created_at at time zone 'UTC', '${UTC_STAMP}') as line
       from audit_log a
      where a.entity_type = 'ticket' and a.entity_id = any(select id::text from ticket where outlet_order_id = $1)
      order by a.created_at`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  await block(
    "final counts of the tables this slice writes",
    `select 'order=' || (select count(*) from "order")
            || ' outlet_order=' || (select count(*) from outlet_order)
            || ' order_line=' || (select count(*) from order_line)
            || ' ticket=' || (select count(*) from ticket)
            || ' ticket_line=' || (select count(*) from ticket_line)
            || ' ticket_transition=' || (select count(*) from ticket_transition)
            || ' audit_log=' || (select count(*) from audit_log) as line`
  );
  await block(
    "the migrations this branch's migrations ledger now carries",
    `select filename || ' | applied_at=' || to_char(applied_at at time zone 'UTC', '${UTC_STAMP}') as line
       from schema_migration where filename like '001%' order by filename`
  );

  // ---------------------------------------------------------------------------------------
  // 10. Verdict and what was written.
  // ---------------------------------------------------------------------------------------
  out.push("");
  out.push(...t.lines);
  out.push("");
  out.push("=".repeat(78));
  out.push(`failures: ${String(t.failures.length)}`);
  for (const failure of t.failures) out.push(`  FAILED  ${failure}`);
  out.push(
    t.failures.length === 0
      ? "VERDICT: S-B/2b ticket lifecycle verified — T2-T7, T9 and T11 driven through the domain, every state, timestamp, line state, journal row and ledger row read back from Postgres; two capability refusals each writing one denied row and changing nothing; three validation refusals writing nothing at all; migration 0016's replay key and reason vocabulary proven in the database; 0 failures."
      : `VERDICT: ${String(t.failures.length)} FAILURE(S) — see above.`
  );
  const report = [
    out.join("\n"),
    "",
    "=".repeat(78),
    "WHAT THIS RUN WROTE, AND WHAT IT LEFT BEHIND",
    "=".repeat(78),
    `* The fixture booking ${FIXTURE_ORDER_ID} (outlet_order ${FIXTURE_OUTLET_ORDER_ID}, service reference T-001): its three tickets are now terminal — the KOR-HOT and KOR-GRILL tickets served, the KOR-COLD ticket re-routed to KOR-DESSERT and voided — the booking is ${closedBooking[0]?.outlet_order_status ?? "unknown"}, and its journal carries one row per transition.`,
    "* One `denied` audit_log row per capability refusal per database — two if this run was the first: the Site Head's T2 without `kds.ticket.advance`, and the KOR-HOT terminal's T2 on the KOR-GRILL ticket. Append-only, so they cannot be removed, and a re-run quotes them instead of adding more.",
    "* NOTHING ELSE: no booking created, no display registered, no credential minted, no row edited. The two constraint demonstrations and every refusal wrote nothing at all.",
    "* The three device principals this run acts as (`verify-kds-hot`, `verify-kds-grill`, `verify-kds-cold`) exist only in this process — no `display` or `display_credential` row backs them (see HONEST LIMITS).",
    "",
    "RE-RUNNING THIS HARNESS: run `bun run scripts/reset-ticket-lifecycle-fixture.ts` (committed, and it writes",
    "evidence/sb2b-fixture-reset.txt) and then run this harness ONCE. It FAILS rather than skipping a step whose",
    "state an earlier run already reached, because a skipped step proves nothing.",
    "",
    "REMOVAL SQL (the fixture booking's lifecycle, if it ever needs reversing — it does not while the display work is in flight):",
    "-- delete from ticket_transition where ticket_id in (select id from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2');",
    "-- delete from ticket_line where ticket_id in (select id from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2');",
    "-- delete from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    "-- update order_line set routing_section_id = null, routing_source = null, line_state = 'placed' where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    "-- update outlet_order set status = 'fired', served_at = null, closed_at = null where id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    `-- update "order" set status = 'fired' where id = '05d1dc81-ffaa-4677-a914-8c0c366a239b';`,
    "-- (the audit rows stay: append-only by trigger. Migration 0016's column, index and constraints are not reversible by design.)",
    "",
    "HONEST LIMITS — what this run does NOT exercise:",
    "1. The station terminals are constructed in this process (scope from the outlet's own `outlet_section` rows, capability set from the product's `displayCapabilities('kds')`). The TOKEN path — register, pair, redeem, `resolveDevicePrincipal` — is NOT exercised here: S-A's verifier covers it, and the pilot's only seeded display (`hot-kds-01`) is `inactive`, so a live terminal for this station does not exist yet (S-C pairs one).",
    "2. No account holds `kds.ticket.advance` in this database, so T2/T3/T4 have no person-driven read-back: the acts run the same code path, but the person half of `guard()` for those three capabilities is proven only by the refusal it produces for the Site Head.",
    "3. T8 (`held_unavailable`) and T10 (print) are not in this slice: no hold and no print job ran, and the `hold_reason_code` constraint could only be compared against the union of the code's vocabulary rather than a hold-only list.",
    "4. `transition_id` is dormant by design: the column and the partial index are proven from the catalogue, and S-F is the slice that writes it. No journal row in this run carries one.",
    "5. **Actor paths: each act has exactly ONE, and the other is refused rather than untested.** T2/T3/T4 are driven by a station terminal because no seeded account holds `kds.ticket.advance`; their person half is the Site Head's refusal (step 4). T5 recall, T6 serve, T7 void and T9 re-route are driven by a person (the Site Head) because `displayCapabilities('kds')` gives a terminal view and advance only; their terminal half is the KOR-HOT terminal's refused recall (step 4b). **T7 void's parameter path therefore exists only on the person side** — no terminal in this build can reach it — and that is also the path the missing `$` broke.",
  ].join("\n");
  writeFileSync("/tmp/ticket-lifecycle-readback.txt", report);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${report}\n`);
  } catch (error) {
    process.stdout.write(`could not write ${TRANSCRIPT_PATH}: ${errorMessage(error)}\n`);
  }
  process.stdout.write(`${report}\n`);
  process.exit(t.failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  const text = `${out.join("\n")}\n${t.lines.join("\n")}\nFATAL ${String(error)}\n${(error as Error).stack ?? ""}`;
  writeFileSync("/tmp/ticket-lifecycle-readback.txt", text);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${text}\n`);
  } catch {
    // best effort on a fatal error
  }
  process.stdout.write(`${text}\n`);
  process.exit(1);
});
