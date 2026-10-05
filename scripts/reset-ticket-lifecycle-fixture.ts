/**
 * S-B/2b — put the ticket-lifecycle fixture back where the fire path left it.
 *
 *   bun run scripts/reset-ticket-lifecycle-fixture.ts        (from the site directory)
 *
 * **Why this script exists, and why it is committed.** `scripts/verify-ticket-lifecycle.ts`
 * drives the pilot's fixture booking through the whole ticket lifecycle, so a *proving* run must
 * start from the state the fire path leaves: a harness that reads back a state a previous run
 * already reached has not restated this run's result (WORKFLOW.md, "Evidence that can be
 * checked"), and the harness now fails loudly instead of skipping such a step. The first
 * session's reset script was deleted before it was committed, which left the fixture mid-flight
 * and the next reader nothing to run; this is that script, kept.
 *
 * **What it restores — the fire path's own values, not an invented "clean".** Everything below
 * is what `fireTickets` in `~/domain/ticket` writes, or what a lifecycle act changed on top of it:
 *
 *   * each ticket → `state = 'queued'`; `ready_at` / `served_at` / `voided_at` /
 *     `void_reason_code` / `held_at` / `hold_reason_code` null; and its station back to the one
 *     its order lines recorded **at fire** (`order_line.routing_section_id`, the D4 route) —
 *     that is the one column T9 re-route moves, and nothing else did;
 *   * each `ticket_line` → `state = 'queued'` (what the fire writes for a line);
 *   * the booking → `outlet_order.status = 'fired'`, `served_at` and `closed_at` null, and its
 *     parent `"order"` back to `'fired'` (the same roll-up the fire path writes);
 *   * `order_line.line_state = 'fired'` for the booking's routed lines;
 *   * the **journal rows written after the fire** are deleted, so the proving run's read-back is
 *     its own story. The fire's own `T1` rows are kept — they are part of the state the fire
 *     leaves — and every row removed is printed, code by code, with the ledger id it pointed at.
 *
 * **What it deliberately does not touch: `audit_log`.** It is append-only by trigger, so every
 * fire, transition, refusal and denial this slice has ever written stays in it, and the reset
 * writes no ledger row of its own — it is not an act. The `audit_log` count it prints before and
 * after is the measurement of that sentence, not a reading of it.
 *
 * **It is idempotent and it refuses to guess.** Running it twice changes nothing and says so. If
 * a ticket's fire-time station cannot be derived from its own order lines (an unrouted line, a
 * line with no recorded route), it stops and says which ticket, rather than inventing a station.
 */
import { writeFileSync } from "node:fs";

import { poolQueryable, withTransaction } from "~/db";

const q = poolQueryable();

const OUTLET_CODE = "koramangala-restaurant";
const FIXTURE_ORDER_ID = "05d1dc81-ffaa-4677-a914-8c0c366a239b";
const FIXTURE_OUTLET_ORDER_ID = "620dd087-ff75-4926-a97d-3e3c1b7ed5f2";
/** The three stations the fixture's lines were routed to at fire, in the order they are worked. */
const FIRE_STATION_CODES = ["KOR-HOT", "KOR-GRILL", "KOR-COLD"] as const;

const TRANSCRIPT_PATH = "/home/team/shared/evidence/sb2b-fixture-reset.txt";
const UTC_STAMP = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

const out: string[] = [];
const say = (line: string): void => {
  out.push(line);
  process.stdout.write(`${line}\n`);
};

// A `type`, not an `interface`: `pg`'s `QueryResultRow` constraint accepts the implicit index
// signature a type alias carries, and an interface does not carry one.
type Counts = {
  tickets: number;
  ticketLines: number;
  transitions: number;
  audits: number;
};

async function counts(): Promise<Counts> {
  const rows = await q.query<Counts>(
    `select (select count(*) from ticket)::int as tickets,
            (select count(*) from ticket_line)::int as "ticketLines",
            (select count(*) from ticket_transition)::int as transitions,
            (select count(*) from audit_log)::int as audits`
  );
  const row = rows[0];
  if (!row) throw new Error("counts query returned no row");
  return row;
}

function countsLine(label: string, c: Counts): string {
  return `${label}: ticket=${String(c.tickets)} ticket_line=${String(c.ticketLines)} ticket_transition=${String(c.transitions)} audit_log=${String(c.audits)}`;
}

type FixtureTicket = {
  id: string;
  ticket_no: number;
  state: string;
  section_code: string;
  fire_section_id: string | null;
  fire_section_code: string | null;
  fire_station_count: number;
  line_states: string | null;
};

/** The fixture's tickets, each with the station its own order lines recorded at fire (D4). */
async function readTickets(): Promise<FixtureTicket[]> {
  return q.query<FixtureTicket>(
    `select tk.id, tk.ticket_no, tk.state, s.code as section_code,
            (select ol.routing_section_id from ticket_line tl
               join order_line ol on ol.id = tl.order_line_id
              where tl.ticket_id = tk.id limit 1) as fire_section_id,
            (select fs.code from ticket_line tl
               join order_line ol on ol.id = tl.order_line_id
               join outlet_section fs on fs.id = ol.routing_section_id
              where tl.ticket_id = tk.id limit 1) as fire_section_code,
            (select count(distinct ol.routing_section_id) from ticket_line tl
               join order_line ol on ol.id = tl.order_line_id
              where tl.ticket_id = tk.id)::int as fire_station_count,
            (select string_agg(tl.state, ',' order by tl.position) from ticket_line tl
              where tl.ticket_id = tk.id) as line_states
       from ticket tk join outlet_section s on s.id = tk.section_id
      where tk.outlet_order_id = $1
      order by s.sort_order`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
}

async function readBooking(): Promise<string> {
  const rows = await q.query<{ line: string }>(
    `select 'order ' || o.status || ' | outlet_order ' || oo.status
            || ' | fired_at=' || coalesce(to_char(oo.fired_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | served_at=' || coalesce(to_char(oo.served_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL')
            || ' | closed_at=' || coalesce(to_char(oo.closed_at at time zone 'UTC', '${UTC_STAMP}'), 'NULL') as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );
  return rows[0]?.line ?? "MISSING";
}

async function main(): Promise<void> {
  say("=".repeat(78));
  say("S-B/2b FIXTURE RESET — the ticket lifecycle's fixture booking, back where the fire left it");
  say(`run at ${new Date().toISOString()}`);
  say("=".repeat(78));

  const outletRows = await q.query<{ id: string; chain_id: string; site_id: string }>(
    `select id, chain_id, site_id from outlet where code = $1 limit 1`,
    [OUTLET_CODE]
  );
  const outlet = outletRows[0];
  if (!outlet) throw new Error(`no outlet ${OUTLET_CODE}`);

  const bookingBefore = await readBooking();
  const tickets = await readTickets();
  say("");
  say(`the booking before: ${bookingBefore}`);
  say("its tickets before:");
  for (const ticket of tickets) {
    say(
      `  ticket ${String(ticket.ticket_no)} at ${ticket.section_code} (${ticket.id}) state=${ticket.state} ` +
        `lines=${ticket.line_states ?? "none"} fire-time station=${ticket.fire_section_code ?? "UNKNOWN"} ` +
        `(recorded on ${String(ticket.fire_station_count)} order line route(s))`
    );
  }

  // The two guards. Neither is a formality: without the fire-time station there is nothing
  // honest to restore a re-routed ticket to, and without the fixture's three tickets there is
  // nothing to reset at all.
  if (tickets.length !== 3) {
    throw new Error(`expected the fixture's 3 tickets, found ${String(tickets.length)} — refusing to guess`);
  }
  const underivable = tickets.filter((ticket) => ticket.fire_section_id === null || ticket.fire_station_count !== 1);
  if (underivable.length > 0) {
    throw new Error(
      `these tickets' fire-time station cannot be derived from their own order lines (an unrouted line, or a ` +
        `line whose route was never recorded): ${underivable.map((ticket) => ticket.id).join(", ")} — refusing to invent one`
    );
  }
  const fireStations = tickets.map((ticket) => ticket.fire_section_code ?? "UNKNOWN").sort();
  const expected = [...FIRE_STATION_CODES].sort();
  if (JSON.stringify(fireStations) !== JSON.stringify(expected)) {
    throw new Error(
      `the fixture's tickets were fired to ${fireStations.join(",")}, not ${expected.join(",")} — this is not the S-B/2b fixture (wrong booking?)`
    );
  }

  const alreadyThere = tickets.every(
    (ticket) => ticket.state === "queued" && ticket.section_code === ticket.fire_section_code && ticket.line_states === "queued"
  );
  const bookingRow = await q.query<{ outlet_order_status: string; order_status: string; journal: number }>(
    `select oo.status as outlet_order_status, o.status as order_status,
            (select count(*) from ticket_transition tt join ticket tk on tk.id = tt.ticket_id
              where tk.outlet_order_id = $2 and tt.transition_code <> 'T1')::int as journal
       from outlet_order oo join "order" o on o.id = oo.order_id where oo.id = $1`,
    [FIXTURE_OUTLET_ORDER_ID, FIXTURE_OUTLET_ORDER_ID]
  );
  const alreadyBooking = bookingRow[0];

  const before = await counts();
  say("");
  say(countsLine("before", before));

  if (alreadyThere && alreadyBooking?.outlet_order_status === "fired" && (alreadyBooking.journal ?? 0) === 0) {
    say("");
    say("NOTHING TO DO — the fixture is already where the fire path leaves it (queued tickets, one per station,");
    say("the booking fired, and no journal row after the fire). This is the state a proving run starts from.");
    await finish();
    return;
  }

  const result = await withTransaction(async (tx) => {
    const resetTickets: string[] = [];
    const resetLines: string[] = [];
    for (const ticket of tickets) {
      const updated = await tx.query<{ id: string }>(
        `update ticket
            set state = 'queued', section_id = $2, ready_at = null, served_at = null,
                voided_at = null, void_reason_code = null, held_at = null, hold_reason_code = null,
                updated_at = now()
          where id = $1 and outlet_order_id = $3 and chain_id = $4
          returning id`,
        [ticket.id, ticket.fire_section_id, FIXTURE_OUTLET_ORDER_ID, outlet.chain_id]
      );
      resetTickets.push(...updated.map((row) => row.id));
      const lines = await tx.query<{ id: string }>(
        `update ticket_line set state = 'queued', updated_at = now() where ticket_id = $1 and chain_id = $2 returning id`,
        [ticket.id, outlet.chain_id]
      );
      resetLines.push(...lines.map((row) => row.id));
    }

    // The journal after the fire goes, so the next run's read-back is its own story; the fire's
    // own T1 rows stay (they are part of the state the fire leaves), and the ledger rows are
    // untouched — audit_log is append-only and the run quotes them.
    const removed = await tx.query<{ line: string }>(
      `delete from ticket_transition
        where ticket_id = any($1::uuid[]) and transition_code <> 'T1'
        returning transition_code || ' | ' || coalesce(from_state, 'NULL') || ' -> ' || to_state
                  || ' | audit_id=' || coalesce(audit_id::text, 'NULL') || ' | at ' ||
                  to_char(occurred_at at time zone 'UTC', '${UTC_STAMP}') as line`,
      [tickets.map((ticket) => ticket.id)]
    );

    const orderLines = await tx.query<{ id: string }>(
      `update order_line set line_state = 'fired', updated_at = now()
        where outlet_order_id = $1 and chain_id = $2 and routing_section_id is not null
        returning id`,
      [FIXTURE_OUTLET_ORDER_ID, outlet.chain_id]
    );

    const booking = await tx.query<{ id: string }>(
      `update outlet_order set status = 'fired', served_at = null, closed_at = null, updated_at = now()
        where id = $1 and chain_id = $2 and order_id = $3
        returning id`,
      [FIXTURE_OUTLET_ORDER_ID, outlet.chain_id, FIXTURE_ORDER_ID]
    );
    if (booking.length !== 1) throw new Error("the fixture's outlet_order was not updated — wrong id?");

    const parent = await tx.query<{ id: string }>(
      `update "order" set status = 'fired', updated_at = now()
        where id = $1 and chain_id = $2 returning id`,
      [FIXTURE_ORDER_ID, outlet.chain_id]
    );
    if (parent.length !== 1) throw new Error("the fixture's order was not updated — wrong id?");

    return {
      tickets: resetTickets,
      lines: resetLines,
      orderLines: orderLines.length,
      journalRemoved: removed.map((row) => row.line),
    };
  });

  const after = await counts();
  say("");
  say(
    `restored: ${String(result.tickets.length)} ticket(s), ${String(result.lines.length)} ticket_line row(s), ` +
      `${String(result.orderLines)} routed order line(s); the booking and its parent order back to 'fired'`
  );
  say(`removed ${String(result.journalRemoved.length)} journal row(s) written after the fire:`);
  for (const line of result.journalRemoved) say(`  - ${line}`);
  say("");
  say(countsLine("after ", after));
  say(
    after.audits === before.audits
      ? `the ledger is untouched: audit_log ${String(before.audits)} -> ${String(after.audits)} — the reset is not an act and writes no row`
      : `WARNING: audit_log moved ${String(before.audits)} -> ${String(after.audits)}; the reset must not write a ledger row`
  );
  await finish();
}

async function finish(): Promise<void> {
  say("");
  say(`the booking after: ${await readBooking()}`);
  say("its tickets after (this is the state a proving run starts from):");
  for (const ticket of await readTickets()) {
    say(
      `  ticket ${String(ticket.ticket_no)} at ${ticket.section_code} (${ticket.id}) state=${ticket.state} ` +
        `lines=${ticket.line_states ?? "none"} fire-time station=${ticket.fire_section_code ?? "UNKNOWN"}`
    );
  }
  const journal = await q.query<{ code: string; n: number }>(
    `select tt.transition_code as code, count(*)::int as n from ticket_transition tt
       join ticket tk on tk.id = tt.ticket_id where tk.outlet_order_id = $1
      group by tt.transition_code order by tt.transition_code`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  say(
    `journal rows left on the booking: ${
      journal.length === 0 ? "none" : journal.map((row) => `${row.code}=${String(row.n)}`).join(" ")
    }`
  );
  say("");
  say("next: bun run scripts/verify-ticket-lifecycle.ts — it drives the lifecycle from this state to T11.");
  const report = out.join("\n");
  writeFileSync("/tmp/reset-fixture.txt", report);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${report}\n`);
  } catch (error) {
    process.stdout.write(`could not write ${TRANSCRIPT_PATH}: ${String(error)}\n`);
  }
  process.exit(0);
}

main().catch((error) => {
  const text = `${out.join("\n")}\nFATAL ${String(error)}\n${(error as Error).stack ?? ""}`;
  writeFileSync("/tmp/reset-fixture.txt", text);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${text}\n`);
  } catch {
    // best effort on a fatal error
  }
  process.stdout.write(`${text}\n`);
  process.exit(1);
});
