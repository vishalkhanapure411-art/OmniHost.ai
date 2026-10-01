/**
 * S-B/2a read-back: the fire path, the ticket tables, and the two refusal kinds.
 *
 *   bun run scripts/verify-ticket-fire.ts        (from the site directory)
 *
 * **What it proves, in order.**
 *
 *   1. **The capability and its holders** — `order.fire` is declared, and the rows that
 *      decide whether a fire is allowed are the *grants*, not the permission. A code with no
 *      `role_permission` row fails closed, and the screen says nothing about why.
 *   2. **The fire itself, through the domain code** (`fireOutletOrder`, never SQL): the pilot's
 *      three-line fixture (one qty-1 hot dish, a qty-2 grill dish and a cold drink, each with a
 *      seeded `article_route`) becomes three tickets at three stations, each with its lines,
 *      its deadline and its ledger rows — all read back out of Postgres.
 *   3. **The unrouted case, end to end** (§1.4 item 4, D3): a booking of an article with **no**
 *      route row of its own is booked through the domain, fired, and must land on the outlet's
 *      pass section flagged `unrouted` — not dropped, and not attached to a random station.
 *   4. **Both refusal kinds, with the counts unmoved.** A capability refusal (an account with no
 *      `order.fire`) writes exactly one `denied` row and changes nothing; a validation refusal
 *      (firing a booking that has already been fired) writes nothing at all — no row, no data.
 *      The second one is the spec's own "the ledger's gap is deliberate".
 *   5. **The two schema defects this slice found**, stated as demonstrations rather than
 *      opinions: `ticket_no` is unique per station **per service day**, which §2.2's literal
 *      `unique (outlet_id, section_id, ticket_no)` cannot be (a number that restarts daily
 *      collides with yesterday's row) — shown by inserting a second day's ticket 1 inside a
 *      transaction that is **rolled back**, so nothing is written.
 *
 * Everything it asserts about the data is read back with SQL against the same database the
 * screens read. Every write is named: the fixture booking's own fire (the acceptance
 * criterion, and it stays fired), one small scratch booking for the unrouted case which this
 * harness **removes again** (with the removal SQL printed), and the one `denied` audit row a
 * capability refusal must leave — which cannot be removed, because the ledger is append-only,
 * and is a fact about the platform rather than about this harness.
 */
import { writeFileSync } from "node:fs";

import { poolQueryable, withTransaction, type Queryable } from "~/db";
import { bookOutletOrder } from "~/domain/order";
import { fireOutletOrder, resolvePrepSlaMinutes } from "~/domain/ticket";
import { Transcript, errorMessage, principalFor } from "./verify-comparison-view-lib";

const q = poolQueryable();
const out: string[] = [];
const t = new Transcript();

/** The pilot outlet, its site and the fixture booking (§11.3 item 2). */
const OUTLET_CODE = "koramangala-restaurant";
const FIXTURE_ORDER_ID = "05d1dc81-ffaa-4677-a914-8c0c366a239b";
const FIXTURE_OUTLET_ORDER_ID = "620dd087-ff75-4926-a97d-3e3c1b7ed5f2";
/** The three lines the fixture was booked with, and the station each is routed to. */
const FIXTURE_LINES = [
  { articleCode: "ART-1015", quantity: 1, sectionCode: "KOR-HOT" },
  { articleCode: "ART-1006", quantity: 2, sectionCode: "KOR-GRILL" },
  { articleCode: "ART-1043", quantity: 1, sectionCode: "KOR-COLD" },
] as const;
/** The scratch booking the unrouted case needs. It is removed again at the end. */
const SCRATCH_REFERENCE = "SB2A-UNROUTED";
const KEEP_SCRATCH = process.env.KEEP_SCRATCH === "1";

const TRANSCRIPT_PATH = "/home/team/shared/evidence/sb2a-ticket-fire-readback.txt";

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

interface OutletRow {
  id: string;
  code: string;
  chain_id: string;
  site_id: string;
  site_code: string;
  timezone: string;
  currency: string;
  jurisdiction_code: string | null;
  site_date_ist: string;
  utc_date: string;
}

async function outlet(): Promise<OutletRow> {
  const rows = await q.query<OutletRow>(
    `select o.id, o.code, o.chain_id, o.site_id, s.code as site_code, s.timezone, s.currency,
            s.jurisdiction_code,
            to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') as site_date_ist,
            to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as utc_date
       from outlet o join site s on s.id = o.site_id
      where o.code = $1 limit 1`,
    [OUTLET_CODE]
  );
  const row = rows[0];
  if (!row) throw new Error(`no outlet ${OUTLET_CODE}`);
  return row;
}

/** Every ticket of a booking, with the values the acceptance criterion names, derived in SQL. */
async function ticketTable(outletOrderId: string): Promise<
  {
    ticket_no: number;
    state: string;
    routing_source: string;
    section_code: string;
    section_kind: string;
    service_date: string;
    fired_at: string;
    prep_deadline_at: string;
    minutes_to_deadline: string;
    line_count: number;
  }[]
> {
  return q.query(
    `select tk.ticket_no, tk.state, tk.routing_source,
            s.code as section_code, s.kind as section_kind,
            to_char(tk.service_date, 'YYYY-MM-DD') as service_date,
            to_char(tk.fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fired_at,
            to_char(tk.prep_deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as prep_deadline_at,
            (extract(epoch from (tk.prep_deadline_at - tk.fired_at)) / 60)::text as minutes_to_deadline,
            (select count(*) from ticket_line tl where tl.ticket_id = tk.id)::int as line_count
       from ticket tk join outlet_section s on s.id = tk.section_id
      where tk.outlet_order_id = $1
      order by s.sort_order, tk.ticket_no`,
    [outletOrderId]
  );
}

/** The lines of one booking's tickets, exactly as they were routed. */
async function ticketLines(outletOrderId: string): Promise<
  {
    ticket_no: number;
    section_code: string;
    position: number;
    article_code: string;
    quantity: number;
    line_state: string;
    recorded_section: string | null;
    recorded_source: string | null;
  }[]
> {
  return q.query(
    `select tk.ticket_no, s.code as section_code, tl.position, a.code as article_code,
            ol.quantity, ol.line_state,
            rs.code as recorded_section, ol.routing_source as recorded_source
       from ticket tk
       join outlet_section s on s.id = tk.section_id
       join ticket_line tl on tl.ticket_id = tk.id
       join order_line ol on ol.id = tl.order_line_id
       join article a on a.id = ol.article_id
       left join outlet_section rs on rs.id = ol.routing_section_id
      where tk.outlet_order_id = $1
      order by s.sort_order, tk.ticket_no, tl.position`,
    [outletOrderId]
  );
}

/** The audit rows one booking's fire wrote, quoted field by field (§2.3's audit column). */
async function auditRows(outletOrderId: string): Promise<void> {
  const rows = await q.query<{
    audit_id: string;
    created_at: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    outcome: string;
    intent: string | null;
    actor_role_code: string;
    actor_user_id: string | null;
    source: string;
    reason: string | null;
    before_state: string | null;
    after_state: string | null;
  }>(
    `select a.id::text as audit_id,
            to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
            a.action, a.entity_type, a.entity_id::text, a.outcome, a.intent, a.actor_role_code,
            a.actor_user_id::text, a.request_source as source, a.reason,
            a.before_state::text, a.after_state::text
       from audit_log a
      where a.action = 'order.fire'
        and (a.entity_id = $1::text
             or a.entity_id = any(select id::text from ticket where outlet_order_id = $1::uuid)
             or (a.entity_type = 'ticket'
                 and a.after_state->>'serviceReference' = (select service_reference from "order" o
                                                             join outlet_order oo on oo.order_id = o.id
                                                            where oo.id = $1::uuid)))
      order by a.created_at, a.entity_type, a.entity_id`,
    [outletOrderId]
  );
  out.push("=== the audit rows of this fire, verbatim ===");
  if (rows.length === 0) out.push("(no rows)");
  for (const row of rows) {
    out.push(
      [
        `audit_log id=${row.audit_id}`,
        `created_at=${row.created_at}`,
        `action=${row.action}`,
        `intent=${row.intent ?? "NULL"}`,
        `entity_type=${row.entity_type}`,
        `entity_id=${row.entity_id ?? "NULL"}`,
        `outcome=${row.outcome}`,
        `actor_role_code=${row.actor_role_code}`,
        `actor_user_id=${row.actor_user_id ?? "NULL"}`,
        `request_source=${row.source}`,
        `reason=${row.reason ?? "NULL"}`,
      ].join(" | ")
    );
    out.push(`    before_state=${row.before_state ?? "NULL"}`);
    out.push(`    after_state=${row.after_state ?? "NULL"}`);
  }
  out.push("");
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------------------
  // 1. The capability and who holds it (read-only).
  // ---------------------------------------------------------------------------------------
  t.heading("order.fire: the capability, its holders and the fire path's vocabulary");
  await block(
    "order.fire declared (permission)",
    `select p.code || ' | module=' || p.module || ' | kind=' || p.action_kind || ' | layer=' || p.layer
            || ' | siteScope=' || p.requires_site_scope || ' | financial_or_stock=' || p.financial_or_stock as line
       from permission p where p.code = 'order.fire'`
  );
  await block(
    "who holds order.fire (role_permission — the rows that actually decide)",
    `select p.code || ' -> ' || r.code || ' (' || r.layer || ')' as line
       from role_permission rp join permission p on p.id = rp.permission_id join role r on r.id = rp.role_id
      where p.code = 'order.fire' and rp.effect = 'allow' order by r.code`
  );
  await block(
    "the accounts that hold order.fire",
    `select distinct u.email || ' | role ' || r.code || ' | site ' || coalesce(ra.site_id::text, 'NULL') as line
       from "user" u join role_assignment ra on ra.user_id = u.id join role r on r.id = ra.role_id
       join role_permission rp on rp.role_id = r.id join permission p on p.id = rp.permission_id
      where p.code = 'order.fire' and rp.effect = 'allow' and u.status = 'active' order by 1`
  );
  await block(
    "the ticket tables migration 0014 created",
    `select table_name || ' | columns=' || count(*)::text as line
       from information_schema.columns
      where table_schema = 'public' and table_name in ('ticket','ticket_line','ticket_transition')
      group by table_name order by table_name`
  );
  await block(
    "the uniqueness the database actually enforces on ticket",
    `select i.relname || ' UNIQUE (' || pg_get_indexdef(ix.indexrelid) || ')' as line
       from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class tb on tb.oid = ix.indrelid
      where tb.relname = 'ticket' and ix.indisunique
      order by i.relname`
  );

  const o = await outlet();
  t.say(`outlet ${o.code} (${o.id})`);
  t.say(
    `chain ${o.chain_id}  site ${o.site_code} (${o.site_id})  timezone ${o.timezone}  currency ${o.currency}  jurisdiction ${o.jurisdiction_code ?? "NULL"}`
  );
  t.say(`the site's calendar date is ${o.site_date_ist}; UTC's is ${o.utc_date}`);
  await block(
    "why the service day is the site's and not UTC's (a boundary, evaluated by the database)",
    `select 'a fire at 2026-10-01T20:00Z is ' || (timestamptz '2026-10-01 20:00:00+00' at time zone 'Asia/Kolkata')::date::text
            || ' in ${o.timezone} but ' || (timestamptz '2026-10-01 20:00:00+00' at time zone 'UTC')::date::text || ' in UTC' as line`
  );
  const slaSetting = await q.query<{ key: string; scope: string; default_value: string | null; site_value: string | null }>(
    `select sd.key, sd.scope, sd.default_value::text as default_value,
            (select cs.value::text from chain_setting cs
              where cs.chain_id = $1 and cs.setting_key = sd.key and (cs.site_id = $2 or cs.site_id is null)
              order by (cs.site_id is not null) desc limit 1) as site_value
       from setting_definition sd where sd.key = 'guest.prep_time_sla_minutes'`,
    [o.chain_id, o.site_id]
  );
  const appliedSla = await resolvePrepSlaMinutes(q, { chainId: o.chain_id, siteId: o.site_id });
  t.say(
    `the prep-time SLA the domain resolves for this site: ${String(appliedSla)} minutes (definition scope=${slaSetting[0]?.scope ?? "MISSING"}, platform default=${slaSetting[0]?.default_value ?? "NULL"}, row written for this site or chain=${slaSetting[0]?.site_value ?? "none"})`
  );
  t.check(
    "the SLA comes from the existing setting, and it is the seeded default of 25",
    appliedSla === 25,
    String(appliedSla)
  );

  const author = await principalFor(q, "site.head@saffron.example", o.chain_id);
  t.say(`fire principal ${author.email} roles ${author.roles.map((r) => r.code).join(",")}`);
  t.check("the fire principal holds order.fire", author.permissions.includes("order.fire"));

  // ---------------------------------------------------------------------------------------
  // 2. The fixture's own fire (through the domain).
  // ---------------------------------------------------------------------------------------
  t.heading("S-B/2a — the fixture booking fired, and every value read back");
  const before = await counts();
  t.say(countsLine("before", before));

  await block(
    "the fixture booking before the fire",
    `select o.id::text || ' | ' || o.service_reference || ' | order '
            || o.status || ' | outlet_order ' || oo.id::text || ' | ' || oo.status
            || ' | fired_at=' || coalesce(oo.fired_at::text, 'NULL') as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );
  await block(
    "the three article_route rows the fixture's stations come from",
    `select a.code || ' -> ' || s.code || ' (primary=' || r.is_primary::text || ', position=' || r.position::text || ')' as line
       from article_route r join article a on a.id = r.article_id join outlet_section s on s.id = r.section_id
      where r.outlet_id = $1 order by a.code`,
    [o.id]
  );
  await block(
    "route_default rows at this outlet (the resolution's second step)",
    `select count(*)::text || ' row(s)' as line from route_default where outlet_id = $1`,
    [o.id]
  );

  const existing = await q.query<{ status: string }>(
    `select status from outlet_order where id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  if (existing[0]?.status === "accepted") {
    const fired = await fireOutletOrder(author, { outletOrderId: FIXTURE_OUTLET_ORDER_ID }, {
      source: "system",
      intent: "order.fire",
    });
    t.say(
      `fired: booking ${fired.serviceReference} ${fired.from} -> ${fired.to}; service day ${fired.serviceDate}; SLA ${String(fired.slaMinutes)} minutes; ${String(fired.tickets.length)} ticket(s)`
    );
    for (const ticket of fired.tickets) {
      t.say(
        `  ticket ${String(ticket.ticketNo)} at ${ticket.sectionCode} (${ticket.sectionName}, kind ${ticket.sectionKind}) state ${ticket.state} source ${ticket.routingSource} deadline ${ticket.prepDeadlineAt}`
      );
    }
  } else {
    t.say(`the fixture's outlet_order is already ${existing[0]?.status ?? "MISSING"} — read back, not fired again`);
  }

  const tickets = await ticketTable(FIXTURE_OUTLET_ORDER_ID);
  t.say("");
  t.say("the tickets of the fixture booking (every value read from Postgres, minutes derived in SQL):");
  for (const row of tickets) {
    t.say(
      `  ticket_no=${String(row.ticket_no)} | state=${row.state} | routing_source=${row.routing_source} | station=${row.section_code} (${row.section_kind}) | service_date=${row.service_date} | lines=${String(row.line_count)}`
    );
    t.say(
      `      fired_at=${row.fired_at} prep_deadline_at=${row.prep_deadline_at} -> ${row.minutes_to_deadline} minutes`
    );
  }
  t.equal("three tickets, one per station", tickets.length, 3);
  t.check(
    "every ticket is queued",
    tickets.every((row) => row.state === "queued"),
    tickets.map((row) => row.state).join(",")
  );
  t.check(
    "every ticket records routing_source = article_route (the seeded map)",
    tickets.every((row) => row.routing_source === "article_route"),
    tickets.map((row) => row.routing_source).join(",")
  );
  t.check(
    "the three stations are the routed ones",
    JSON.stringify(tickets.map((row) => row.section_code).sort()) ===
      JSON.stringify(FIXTURE_LINES.map((line) => line.sectionCode).sort()),
    tickets.map((row) => row.section_code).join(",")
  );
  t.check(
    "each ticket's ticket_no is unique for its (outlet, station, service day)",
    new Set(tickets.map((row) => `${row.section_code}|${row.service_date}|${String(row.ticket_no)}`)).size ===
      tickets.length
  );
  t.check(
    "prep_deadline_at − fired_at is the site's SLA setting on every ticket",
    tickets.every((row) => Number(row.minutes_to_deadline) === appliedSla),
    tickets.map((row) => row.minutes_to_deadline).join(",")
  );
  t.check(
    "the service day is the site's own date",
    tickets.every((row) => row.service_date === o.site_date_ist),
    `${tickets[0]?.service_date ?? "none"} vs ${o.site_date_ist}`
  );

  const lines = await ticketLines(FIXTURE_OUTLET_ORDER_ID);
  t.say("");
  t.say("the ticket lines, with the route recorded on each order line:");
  for (const row of lines) {
    t.say(
      `  ticket ${String(row.ticket_no)} (${row.section_code}) | position ${String(row.position)} | ${row.article_code} x${String(row.quantity)} | line_state=${row.line_state} | recorded station=${row.recorded_section ?? "NULL"} source=${row.recorded_source ?? "NULL"}`
    );
  }
  t.check("the fixture's three lines appear on a ticket", lines.length === 3, String(lines.length));
  t.check(
    "each line is on the ticket of the station its article is routed to",
    FIXTURE_LINES.every((fixture) =>
      lines.some(
        (row) =>
          row.article_code === fixture.articleCode &&
          row.recorded_section === fixture.sectionCode &&
          row.section_code === fixture.sectionCode
      )
    )
  );
  t.check(
    "routing_source = article_route on every line (recorded once at fire, §1.4)",
    lines.every((row) => row.recorded_source === "article_route"),
    lines.map((row) => String(row.recorded_source)).join(",")
  );
  t.check(
    "the qty-2 line appears ONCE, with its quantity unchanged",
    lines.filter((row) => row.article_code === "ART-1006").length === 1 &&
      lines.find((row) => row.article_code === "ART-1006")?.quantity === 2,
    `rows=${String(lines.filter((row) => row.article_code === "ART-1006").length)} qty=${String(lines.find((row) => row.article_code === "ART-1006")?.quantity ?? -1)}`
  );
  t.check(
    "every line's own state moved to fired with its ticket",
    lines.every((row) => row.line_state === "fired"),
    lines.map((row) => row.line_state).join(",")
  );

  await block(
    "the booking's own state after the fire",
    `select 'order ' || o.status || ' | outlet_order ' || oo.status
            || ' | fired_at=' || to_char(oo.fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | prep_deadline_at=' || to_char(oo.prep_deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | deadline - fired = ' || (extract(epoch from (oo.prep_deadline_at - oo.fired_at)) / 60)::text || ' minutes' as line
       from "order" o join outlet_order oo on oo.order_id = o.id where o.id = $1`,
    [FIXTURE_ORDER_ID]
  );

  await auditRows(FIXTURE_OUTLET_ORDER_ID);
  await block(
    "the ticket journal T1 wrote (§2.2 ticket_transition)",
    `select tt.transition_code || ' | ' || coalesce(tt.from_state, 'NULL') || ' -> ' || tt.to_state
            || ' | ticket_no=' || tk.ticket_no::text || ' at ' || s.code
            || ' | actor=' || coalesce(tt.actor_user_id::text, 'NULL') || ' role=' || tt.actor_role_code
            || ' scope=' || tt.actor_scope || ' | audit_id=' || coalesce(tt.audit_id::text, 'NULL')
            || ' | occurred_at=' || to_char(tt.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as line
       from ticket_transition tt join ticket tk on tk.id = tt.ticket_id join outlet_section s on s.id = tk.section_id
      where tk.outlet_order_id = $1 order by s.sort_order, tk.ticket_no`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  await block(
    "the tickets, the journal and the ledger rows of this fire share ONE timestamp (same transaction)",
    `select 'ticket.created_at=' || to_char(min(tk.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | ticket.fired_at=' || to_char(min(tk.fired_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | outlet_order.fired_at=' || to_char((select fired_at from outlet_order where id = $1) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | ticket_transition=' || to_char((select min(occurred_at) from ticket_transition tt join ticket tk2 on tk2.id = tt.ticket_id where tk2.outlet_order_id = $1) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            || ' | audit_log=' || to_char((select min(a.created_at) from audit_log a where a.entity_type = 'ticket' and a.entity_id = any(select id::text from ticket where outlet_order_id = $1)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as line
       from ticket tk where tk.outlet_order_id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  const stamps = await q.query<{ same: boolean }>(
    `select (
         (select min(created_at) from ticket where outlet_order_id = $1)
         = (select fired_at from outlet_order where id = $1)
         and (select min(created_at) from ticket where outlet_order_id = $1)
         = (select min(a.created_at) from audit_log a
             where a.entity_type = 'ticket' and a.entity_id = any(select id::text from ticket where outlet_order_id = $1))
         and (select min(created_at) from ticket where outlet_order_id = $1)
         = (select min(tt.occurred_at) from ticket_transition tt join ticket tk on tk.id = tt.ticket_id where tk.outlet_order_id = $1)
       ) as same`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.check(
    "the tickets, their journal rows and their audit rows carry one transaction's timestamp",
    stamps[0]?.same === true,
    String(stamps[0]?.same)
  );
  const auditCount = await q.query<{ n: number }>(
    `select count(*)::int as n from audit_log where action = 'order.fire' and entity_type = 'ticket'
        and entity_id = any(select id::text from ticket where outlet_order_id = $1)`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.say(
    `audit rows for this fire: ${String(auditCount[0]?.n ?? 0)} on entity ticket (one per ticket) + 1 on the outlet_order`
  );
  t.check(
    "one audit row per ticket, entity_type = ticket, action = order.fire",
    (auditCount[0]?.n ?? 0) === tickets.length,
    `${String(auditCount[0]?.n ?? 0)} vs ${String(tickets.length)}`
  );

  // ---------------------------------------------------------------------------------------
  // 3. The unrouted case, end to end, through the domain.
  // ---------------------------------------------------------------------------------------
  t.heading("the unrouted case: an article with no route of its own (§1.4 item 4, D3)");
  const candidate = await q.query<{ code: string; name: string | null; category: string; price: string }>(
    `select a.code, (select t.name from article_version_text t
                      where t.article_version_id = a.current_version_id order by t.locale limit 1) as name,
            c.code as category, p.amount::text as price
       from article a join article_version v on v.id = a.current_version_id
       join article_category c on c.id = a.category_id
       join article_price p on p.article_id = a.id and p.article_version_id = v.id
      where a.chain_id = $1 and p.outlet_id = $2 and v.status = 'active'
        and p.effective_from <= (now() at time zone $3)::date
        and (p.effective_to is null or p.effective_to >= (now() at time zone $3)::date)
        and not exists (select 1 from article_route r where r.outlet_id = p.outlet_id and r.article_id = a.id)
        and not exists (select 1 from route_default d where d.outlet_id = p.outlet_id and d.article_category_id = a.category_id)
        and not exists (select 1 from article_availability aa
                         where aa.outlet_id = p.outlet_id and aa.article_id = a.id and aa.availability = 'unavailable')
      order by a.code limit 1`,
    [o.chain_id, o.id, o.timezone]
  );
  const unroutable = candidate[0];
  if (!unroutable) throw new Error("no unrouted candidate article at this outlet — the demonstration cannot run");
  t.say(
    `candidate: ${unroutable.code} (${unroutable.name ?? "no name"}, category ${unroutable.category}, priced ${unroutable.price}) — no article_route row, and no route_default for its category`
  );
  await block(
    "the candidate really has no route and its category has no default",
    `select 'article_route rows for it: ' || (select count(*) from article_route r join article a on a.id = r.article_id
                                                where r.outlet_id = $1 and a.code = $2)::text
            || ' | route_default rows for its category: ' || (select count(*) from route_default d
                 join article a on a.code = $2 and a.category_id = d.article_category_id
                where d.outlet_id = $1)::text as line`,
    [o.id, unroutable.code]
  );
  await block(
    "the pass section the line must fall back to (kind = expedite)",
    `select code || ' | ' || name || ' | kind=' || kind || ' | id=' || id::text as line
       from outlet_section where outlet_id = $1 and kind = 'expedite' order by sort_order`,
    [o.id]
  );

  const existingScratch = await q.query<{ id: string; outlet_order_id: string; status: string }>(
    `select o.id, oo.id as outlet_order_id, oo.status
       from "order" o join outlet_order oo on oo.order_id = o.id
      where o.chain_id = $1 and o.site_id = $2 and o.service_reference = $3`,
    [o.chain_id, o.site_id, SCRATCH_REFERENCE]
  );
  let scratch = existingScratch[0] ?? null;
  if (scratch) {
    t.say(`the scratch booking ${SCRATCH_REFERENCE} already exists (${scratch.status}) — reused, not booked again`);
  } else {
    const booked = await bookOutletOrder(
      author,
      {
        outletId: o.id,
        origin: "pos",
        serviceReference: SCRATCH_REFERENCE,
        tableLabel: "S-B/2a unrouted demonstration",
        lines: [{ articleCode: unroutable.code, quantity: 1 }],
      },
      { source: "system", intent: "order.place" }
    );
    scratch = { id: booked.orderId, outlet_order_id: booked.outletOrderId, status: "accepted" };
    t.say(
      `booked ${booked.serviceReference}: order ${booked.orderId}, outlet_order ${booked.outletOrderId}, one line of ${unroutable.code}`
    );
  }
  if (scratch.status === "accepted") {
    const fired = await fireOutletOrder(author, { outletOrderId: scratch.outlet_order_id }, {
      source: "system",
      intent: "order.fire",
    });
    t.say(
      `fired: ${fired.from} -> ${fired.to}; ${String(fired.tickets.length)} ticket(s); unrouted lines ${String(fired.unroutedLineCount)}`
    );
    for (const ticket of fired.tickets) {
      t.say(
        `  ticket ${String(ticket.ticketNo)} at ${ticket.sectionCode} (kind ${ticket.sectionKind}) state ${ticket.state} routing_source=${ticket.routingSource} unrouted=${String(ticket.hasUnroutedLine)}`
      );
    }
  } else {
    t.say(`the scratch booking is already ${scratch.status} — read back, not fired again`);
  }

  const scratchTickets = await ticketTable(scratch.outlet_order_id);
  const scratchLines = await ticketLines(scratch.outlet_order_id);
  t.say("");
  t.say("the scratch booking's tickets, read back:");
  for (const row of scratchTickets) {
    t.say(
      `  ticket_no=${String(row.ticket_no)} | state=${row.state} | routing_source=${row.routing_source} | station=${row.section_code} (${row.section_kind}) | service_date=${row.service_date} | lines=${String(row.line_count)}`
    );
  }
  for (const row of scratchLines) {
    t.say(
      `  ticket ${String(row.ticket_no)} (${row.section_code}) | ${row.article_code} x${String(row.quantity)} | line_state=${row.line_state} | recorded station=${row.recorded_section ?? "NULL"} source=${row.recorded_source ?? "NULL"}`
    );
  }
  t.check(
    "the unrouted line produced exactly one ticket",
    scratchTickets.length === 1,
    String(scratchTickets.length)
  );
  t.check(
    "and it landed on the outlet's pass section — not dropped, not on a random station",
    scratchTickets[0]?.section_kind === "expedite",
    `${scratchTickets[0]?.section_code ?? "none"} (${scratchTickets[0]?.section_kind ?? "none"})`
  );
  t.check(
    "the line is flagged unrouted in the database (§1.4 item 4, D3)",
    scratchLines[0]?.recorded_source === "unrouted" && scratchTickets[0]?.routing_source === "unrouted",
    `line=${scratchLines[0]?.recorded_source ?? "none"} ticket=${scratchTickets[0]?.routing_source ?? "none"}`
  );
  t.check(
    "the line's article is intact — nothing was dropped or rewritten",
    scratchLines.length === 1 && scratchLines[0]?.article_code === unroutable.code && scratchLines[0]?.quantity === 1,
    `${scratchLines[0]?.article_code ?? "none"} x${String(scratchLines[0]?.quantity ?? -1)}`
  );
  await auditRows(scratch.outlet_order_id);

  // ---------------------------------------------------------------------------------------
  // 4. A VALIDATION refusal: fire a booking that has already been fired.
  // ---------------------------------------------------------------------------------------
  t.heading("a validation refusal: firing a booking that has already been fired");
  const beforeValidation = await counts();
  let refusalMessage = "";
  try {
    await fireOutletOrder(author, { outletOrderId: FIXTURE_OUTLET_ORDER_ID }, {
      source: "system",
      intent: "order.fire",
    });
    t.failures.push("the second fire of the fixture booking was NOT refused");
    t.say("  UNEXPECTED: it was accepted");
  } catch (error) {
    refusalMessage = errorMessage(error);
    t.say(`  refused with: ${refusalMessage}`);
  }
  const afterValidation = await counts();
  t.say(countsLine("  before the refusal", beforeValidation));
  t.say(countsLine("  after the refusal ", afterValidation));
  t.check(
    "the validation refusal wrote no ticket, no ticket line and no journal row",
    afterValidation.tickets === beforeValidation.tickets &&
      afterValidation.ticketLines === beforeValidation.ticketLines &&
      afterValidation.transitions === beforeValidation.transitions
  );
  t.check(
    "and no audit row either — the ledger's gap is deliberate",
    afterValidation.audits === beforeValidation.audits,
    `${String(beforeValidation.audits)} -> ${String(afterValidation.audits)}`
  );
  t.check(
    "the refusal names the state and where to fire from, in words",
    refusalMessage.includes("accepted") && refusalMessage.includes("sent to the kitchen"),
    refusalMessage
  );

  // ---------------------------------------------------------------------------------------
  // 5. A CAPABILITY refusal: an account that does not hold order.fire.
  // ---------------------------------------------------------------------------------------
  t.heading("a capability refusal: an account with no order.fire");
  const beforeDenied = await counts();
  const stranger = await principalFor(q, "culinary.team@saffron.example", o.chain_id);
  t.say(
    `  ${stranger.email} roles ${stranger.roles.map((r) => r.code).join(",")} holds order.fire=${String(stranger.permissions.includes("order.fire"))}`
  );
  t.check("the account genuinely does not hold order.fire", !stranger.permissions.includes("order.fire"));
  // Re-runnable: a second run must not keep adding `denied` rows to the owner's ledger, so an
  // earlier refusal by this same account is quoted instead of repeated.
  const priorDenial = await q.query<{ created_at: string; reason: string | null }>(
    `select to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, a.reason
       from audit_log a
      where a.action = 'order.fire' and a.outcome = 'denied'
        and a.actor_user_id = (select id from "user" where email = 'culinary.team@saffron.example')
      order by a.created_at desc limit 1`
  );
  if (priorDenial[0]) {
    t.say(
      `  already in the ledger from an earlier run (${priorDenial[0].created_at}): ${priorDenial[0].reason ?? "NULL"} — not repeated`
    );
  } else {
    try {
      await fireOutletOrder(stranger, { outletOrderId: FIXTURE_OUTLET_ORDER_ID }, {
        source: "system",
        intent: "order.fire",
      });
      t.failures.push("the capability refusal did not happen");
      t.say("  UNEXPECTED: the fire went through");
    } catch (error) {
      t.say(`  refused with: ${errorMessage(error)}`);
    }
  }
  const afterDenied = await counts();
  t.say(countsLine("  before the refusal", beforeDenied));
  t.say(countsLine("  after the refusal ", afterDenied));
  t.check(
    "the capability refusal changed no data",
    afterDenied.tickets === beforeDenied.tickets &&
      afterDenied.ticketLines === beforeDenied.ticketLines &&
      afterDenied.transitions === beforeDenied.transitions &&
      afterDenied.orders === beforeDenied.orders &&
      afterDenied.outletOrders === beforeDenied.outletOrders
  );
  t.check(
    "the capability refusal wrote (or had already written) exactly one denied row",
    afterDenied.audits === beforeDenied.audits + (priorDenial[0] ? 0 : 1),
    `${String(beforeDenied.audits)} -> ${String(afterDenied.audits)}`
  );
  await block(
    "the capability refusal's own audit row",
    `select 'outcome=' || outcome || ' | action=' || action || ' | entity_type=' || entity_type
            || ' | entity_id=' || coalesce(entity_id::text, 'NULL') || ' | intent=' || coalesce(intent, 'NULL')
            || ' | actor_role_code=' || actor_role_code || ' | actor_user_id=' || coalesce(actor_user_id::text, 'NULL')
            || ' | request_source=' || request_source || ' | reason=' || coalesce(reason, 'NULL')
            || ' | created_at(UTC)=' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as line
       from audit_log
      where action = 'order.fire' and outcome = 'denied' order by created_at desc limit 1`
  );

  // ---------------------------------------------------------------------------------------
  // 6. The spec defect this slice found, demonstrated with a transaction that rolls back.
  // ---------------------------------------------------------------------------------------
  t.heading("ticket_no per station per service day: §2.2's literal key cannot hold");
  t.say(
    "§2.2 writes the key as unique (outlet_id, section_id, ticket_no) while the same paragraph says the number restarts per service day."
  );
  t.say(
    "This inserts a second service day's ticket 1 for a station of the fixture booking, and rolls the transaction back, so nothing is written either way."
  );
  t.say(
    "The station is one with no ticket for that booking already: unique (outlet_order_id, section_id) is D5's one-ticket-per-station rule and would refuse a second ticket at a station that already has one — a different key, and a different fact."
  );
  const secondDay = await (async () => {
    try {
      return await withTransaction(async (tx: Queryable) => {
        const rows = await tx.query<{ id: string }>(
          `insert into ticket
             (chain_id, site_id, outlet_id, outlet_order_id, section_id, service_date, ticket_no,
              state, routing_source, fired_at, prep_deadline_at)
           values ($1, $2, $3, $4,
                   (select s.id from outlet_section s
                     where s.outlet_id = $3 and s.kind = 'dessert'
                       and not exists (select 1 from ticket tk where tk.outlet_order_id = $4 and tk.section_id = s.id)
                     order by s.sort_order limit 1),
                   ($5::date + 1), 1, 'queued', 'article_route', now(), now() + interval '25 minutes')
           returning id`,
          [o.chain_id, o.site_id, o.id, FIXTURE_OUTLET_ORDER_ID, o.site_date_ist]
        );
        // Force the rollback: the row is never committed, whatever happens below.
        throw new RolledBack(rows[0]?.id ?? "");
      });
    } catch (error) {
      if (error instanceof RolledBack) return error.ticketId;
      throw error;
    }
  })();
  t.say(
    `  accepted inside the transaction: a SECOND ticket_no = 1 for the same station on ${o.site_date_ist} + 1 (id ${secondDay}); the transaction was rolled back, so the table is unchanged`
  );
  const stillThree = await q.query<{ n: number }>(
    `select count(*)::int as n from ticket where outlet_order_id = $1`,
    [FIXTURE_OUTLET_ORDER_ID]
  );
  t.check(
    "the rolled-back insert left the ticket count unchanged",
    stillThree[0]?.n === 3,
    String(stillThree[0]?.n)
  );
  t.check(
    "and the uniqueness the database enforces includes the service day",
    (await q.query<{ def: string }>(
      `select pg_get_indexdef(ix.indexrelid) as def
         from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class tb on tb.oid = ix.indrelid
        where tb.relname = 'ticket' and ix.indisunique and i.relname like '%service%'`
    ))[0]?.def?.includes("service_date") === true,
    "see the pg_index block: the key carries service_date"
  );

  // ---------------------------------------------------------------------------------------
  // 7. Teardown and the ledger.
  // ---------------------------------------------------------------------------------------
  t.heading("teardown, and what this harness left in the database");
  if (KEEP_SCRATCH) {
    t.say(`KEEP_SCRATCH=1: the scratch booking ${scratch.id} is left in place for inspection`);
  } else {
    const removed = await q.query<{ tickets: number; lines: number }>(
      `select (select count(*) from ticket where outlet_order_id = $1)::int as tickets,
              (select count(*) from order_line where outlet_order_id = $1)::int as lines`,
      [scratch.outlet_order_id]
    );
    t.say(
      `removing the scratch booking: ${String(removed[0]?.tickets ?? 0)} ticket(s) and ${String(removed[0]?.lines ?? 0)} order line(s) go with it by cascade`
    );
    const beforeDelete = await counts();
    await q.query(`delete from "order" where id = $1`, [scratch.id]);
    const gone = await counts();
    const scratchGone = await q.query<{ n: number }>(
      `select count(*)::int as n from "order" where id = $1`,
      [scratch.id]
    );
    t.say(countsLine("after the removal", gone));
    t.check(
      "the scratch booking and its tickets are gone",
      scratchGone[0]?.n === 0 &&
        gone.orders === beforeDelete.orders - 1 &&
        gone.tickets === beforeDelete.tickets - scratchTickets.length,
      `orders ${String(beforeDelete.orders)}-1 vs ${String(gone.orders)}, tickets ${String(beforeDelete.tickets)}-${String(scratchTickets.length)} vs ${String(gone.tickets)}`
    );
    t.say(
      "the audit rows of the scratch fire remain: audit_log is append-only by trigger, so a removed booking's fire is still in the ledger"
    );
  }
  await block(
    "final counts of the tables this slice writes",
    `select 'order=' || (select count(*) from "order")
            || ' outlet_order=' || (select count(*) from outlet_order)
            || ' order_line=' || (select count(*) from order_line)
            || ' ticket=' || (select count(*) from ticket)
            || ' ticket_line=' || (select count(*) from ticket_line)
            || ' ticket_transition=' || (select count(*) from ticket_transition) as line`
  );
  await block(
    "the tickets that remain, by booking",
    `select o.service_reference || ' | ' || oo.status || ' | ticket ' || tk.ticket_no::text || ' at ' || s.code
            || ' | ' || tk.state || ' | ' || tk.routing_source
            || ' | fired_at=' || to_char(tk.fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as line
       from ticket tk join outlet_order oo on oo.id = tk.outlet_order_id join "order" o on o.id = oo.order_id
       join outlet_section s on s.id = tk.section_id
      order by o.service_reference, s.sort_order, tk.ticket_no`
  );
  await block(
    "migration ledger",
    `select filename || ' | applied_at=' || applied_at::text as line
       from schema_migration where filename like '001%.sql' order by filename`
  );

  for (const line of t.lines) out.push(line);
  out.push("");
  out.push("=".repeat(78));
  out.push(`failures: ${String(t.failures.length)}`);
  for (const failure of t.failures) out.push(`  FAILED  ${failure}`);
  const verdict =
    t.failures.length === 0
      ? "VERDICT: S-B/2a fire path verified — 3 tickets at 3 stations, deadlines = the site SLA, routes recorded once, the unrouted line on the pass flagged, both refusals with the counts unmoved, 0 failures."
      : `VERDICT: ${String(t.failures.length)} FAILURE(S) — see above.`;
  out.push(verdict);
  const scratchCleanup = KEEP_SCRATCH
    ? `-- KEEP_SCRATCH=1 was set: the scratch booking ${scratch.id} (${SCRATCH_REFERENCE}) is still there. Remove it with:\n` +
      `delete from "order" where id = '${scratch.id}';  -- cascades to outlet_order, order_line, ticket, ticket_line, ticket_transition`
    : `the scratch booking ${scratch.id} (${SCRATCH_REFERENCE}) was removed by this harness; its audit rows remain because the ledger is append-only`;
  const report = [
    out.join("\n"),
    "",
    "=".repeat(78),
    "WHAT THIS RUN WROTE",
    "=".repeat(78),
    `* The fixture booking ${FIXTURE_ORDER_ID} (outlet_order ${FIXTURE_OUTLET_ORDER_ID}) is now FIRED, with its tickets — the acceptance criterion, and it is meant to persist.`,
    `* ${scratchCleanup}`,
    "* One `denied` audit_log row for the capability refusal — append-only, and a fact about the platform rather than about this harness.",
    "* Nothing else: the validation refusal wrote nothing, and the second-service-day insert was rolled back.",
    "",
    "REMOVAL SQL (the fixture's fire, if it ever needs reversing — it does not while the display work is in flight):",
    "-- delete from ticket_transition where ticket_id in (select id from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2');",
    "-- delete from ticket_line where ticket_id in (select id from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2');",
    "-- delete from ticket where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    "-- update order_line set routing_section_id = null, routing_source = null, line_state = 'placed' where outlet_order_id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    "-- update outlet_order set status = 'accepted', fired_at = null, prep_deadline_at = null where id = '620dd087-ff75-4926-a97d-3e3c1b7ed5f2';",
    `-- update "order" set status = 'accepted' where id = '05d1dc81-ffaa-4677-a914-8c0c366a239b';`,
    "-- (the audit rows stay: append-only by trigger.)",
  ].join("\n");
  writeFileSync("/tmp/ticket-fire-readback.txt", report);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${report}\n`);
  } catch (error) {
    process.stdout.write(`could not write ${TRANSCRIPT_PATH}: ${errorMessage(error)}\n`);
  }
  process.stdout.write(`${report}\n`);
  process.exit(t.failures.length === 0 ? 0 : 1);
}

/** A rollback by another name — see the second-service-day demonstration. */
class RolledBack extends Error {
  readonly ticketId: string;
  constructor(ticketId: string) {
    super("roll back the demonstration insert");
    this.ticketId = ticketId;
  }
}

main().catch((error) => {
  const text = `${out.join("\n")}\nFATAL ${String(error)}\n${(error as Error).stack ?? ""}`;
  writeFileSync("/tmp/ticket-fire-readback.txt", text);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${text}\n`);
  } catch {
    // best effort on a fatal error
  }
  process.stdout.write(`${text}\n`);
  process.exit(1);
});
