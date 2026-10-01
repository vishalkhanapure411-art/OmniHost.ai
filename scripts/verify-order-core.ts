/**
 * S-B/1 read-back, both halves.
 *
 *   bun run scripts/verify-order-core.ts        (from the site directory)
 *
 * **Half one (read-only).** The order-side capabilities, who holds them, and the tables the
 * slice writes to. It exists because "the capability is declared" and "the role holds it" are
 * two different claims and only the second one decides whether a booking can be taken —
 * `guard()` resolves the caller's role registry, so a permission row with no `role_permission`
 * row fails closed and the screen says nothing about why. The S-B/1 acceptance criterion is
 * the grant lines, not the permission lines: `db/seed.sql` section 8 declares the codes and
 * grants them in one statement, so a code that exists with no grant means the seed ran and
 * that half of it did not.
 *
 * **Half two (writes one small fixture).** S-B/1c: take a real three-line booking at the pilot
 * outlet **through the domain code** — `bookOutletOrder`, not SQL — and read every value back
 * out of the database so the pricing, the version pinning, the tax and the audit trail can be
 * checked by hand (§11.3 items 2 and 5: "S-B next, with a seeded fixture that fires three
 * lines at three stations, so routing and the audit trail can be checked by reading the
 * database before any screen exists" and "every slice ends with the database read back").
 *
 * Three properties this harness asserts rather than assumes, because each is a way the
 * booking side goes wrong silently:
 *
 *   * **The pinned price is arithmetic a reader can re-check.** Every line is re-priced here
 *     from the rows the fixture actually pinned — the `article_price` amount, the quantity,
 *     the tax class's inclusivity, the `tax_rate.rate_pct` and the site's service-charge
 *     percentage — and compared to what is stored. A mismatch is reported with both numbers
 *     and is not smoothed over: the whole point of running this against the live schema is to
 *     find out whether `priceLine`'s arithmetic and migration 0012's check constraints agree,
 *     and if they do not, **the database is right and the disagreement is the finding**.
 *   * **A validation refusal leaves no trace.** Its transaction writes nothing — the ledger's
 *     gap is deliberate — so the harness counts `order`, `outlet_order`, `order_line` and
 *     `audit_log` before and after and shows the four numbers did not move.
 *   * **A capability refusal leaves exactly one trace and changes no data.** `guard()` writes
 *     an `outcome='denied'` row naming the missing capability; the harness reads that row back
 *     verbatim and shows the data counts did not move.
 *
 * Everything it writes is named: one `order` (`service_reference = 'T-001'` at
 * `saffron-koramangala`) with its one `outlet_order` and three `order_line` rows, plus the
 * three `article_route` rows the routing worklist needs. The ids are printed so the fixture can
 * be removed in one statement of each table, and the transcript names the ids exactly.
 * The harness is re-runnable: if the fixture order already exists it is read back, not booked
 * again.
 */
import { writeFileSync } from "node:fs";

import { poolQueryable, type Queryable } from "~/db";
import { bookOutletOrder, priceArticleAtOutlet, readOutletOrder, resolveServiceChargePercent } from "~/domain/order";
import { setArticleRoute, resolveLineRoute } from "~/domain/display-routing";
import { currencyMinorUnits, priceLine, toMinorUnits } from "~/domain/order-rules";
import { Transcript, errorMessage, principalFor } from "./verify-comparison-view-lib";

const q = poolQueryable();
const out: string[] = [];
const t = new Transcript();

/** The pilot outlet, its site and its chain (§11.3 item 2). */
const OUTLET_CODE = "koramangala-restaurant";
const SITE_CODE = "saffron-koramangala";
/** The one row this fixture writes in `order`, so it can be found and removed by hand. */
const SERVICE_REFERENCE = "T-001";
/**
 * Three lines, each routed to a different station of the one pilot outlet. The article codes
 * are the seeded pilot data's own (a hot dish, a tandoor dish and a cold drink), and the two
 * stations are chosen because `outlet_section` already carries them — the routing *map* is what
 * this fixture adds, because the map is empty and §11.3 item 2 asks for three stations.
 */
const FIXTURE_LINES = [
  { articleCode: "ART-1015", quantity: 1, sectionCode: "KOR-HOT" },
  { articleCode: "ART-1006", quantity: 2, sectionCode: "KOR-GRILL" },
  { articleCode: "ART-1043", quantity: 1, sectionCode: "KOR-COLD" },
] as const;

const TRANSCRIPT_PATH = "/home/team/shared/evidence/sb1c-order-core-readback.txt";

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

/** Formatted money as the platform states it: an amount plus its ISO 4217 code. */
function money(minor: number, currency: string): string {
  const exponent = currencyMinorUnits(currency) ?? 0;
  return `${currency} ${(minor / 10 ** exponent).toFixed(exponent)} (${String(minor)} minor units)`;
}

interface Counts {
  orders: number;
  outletOrders: number;
  orderLines: number;
  audits: number;
}

async function counts(): Promise<Counts> {
  const rows = await q.query<{ orders: number; outlet_orders: number; order_lines: number; audits: number }>(
    `select (select count(*) from "order")::int as orders,
            (select count(*) from outlet_order)::int as outlet_orders,
            (select count(*) from order_line)::int as order_lines,
            (select count(*) from audit_log)::int as audits`
  );
  const row = rows[0];
  if (!row) throw new Error("counts query returned no row");
  return { orders: row.orders, outletOrders: row.outlet_orders, orderLines: row.order_lines, audits: row.audits };
}

function countsLine(label: string, c: Counts): string {
  return `${label}: order=${String(c.orders)} outlet_order=${String(c.outletOrders)} order_line=${String(c.orderLines)} audit_log=${String(c.audits)}`;
}

interface OutletRow {
  id: string;
  code: string;
  chain_id: string;
  site_id: string;
  site_code: string;
  timezone: string;
  currency: string;
  locale: string | null;
  jurisdiction_code: string | null;
  site_date: string;
}

async function outlet(): Promise<OutletRow> {
  const rows = await q.query<OutletRow>(
    `select o.id, o.code, o.chain_id, o.site_id, s.code as site_code, s.timezone, s.currency,
            s.locale, s.jurisdiction_code,
            to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') as site_date
       from outlet o join site s on s.id = o.site_id
      where o.code = $1 limit 1`,
    [OUTLET_CODE]
  );
  const row = rows[0];
  if (!row) throw new Error(`no outlet ${OUTLET_CODE}`);
  return row;
}

async function sectionIdFor(db: Queryable, outletId: string, code: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `select id from outlet_section where outlet_id = $1 and code = $2 limit 1`,
    [outletId, code]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no section ${code} at this outlet`);
  return id;
}

async function articleIdFor(db: Queryable, chainId: string, code: string): Promise<string> {
  const rows = await db.query<{ id: string }>(`select id from article where chain_id = $1 and code = $2 limit 1`, [
    chainId,
    code,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no article ${code}`);
  return id;
}

/**
 * Migration 0013's `order_line_arithmetic`, asked **one clause at a time** over a set of
 * numbers, so the clause that fails is named rather than implied. The database evaluates the
 * identities itself, which is the only authority on what the constraint accepts. The first
 * clause is the branch-dependent one: an inclusive line's menu amount is its unit price times
 * its quantity (the tax is extracted from it), an exclusive line's net is.
 */
async function arithmeticClauses(numbers: {
  unitAmountMinor: number;
  quantity: number;
  taxInclusive: boolean;
  netMinor: number;
  taxMinor: number;
  amountMinor: number;
  serviceChargeMinor: number;
  totalMinor: number;
}): Promise<string> {
  const rows = await q.query<{
    branch_identity: boolean;
    amount_is_net_plus_tax: boolean;
    total_is_amount_plus_sc: boolean;
  }>(
    `select (
              ($8::boolean and $4::int = $2::int * $3::int)
              or ((not $8::boolean) and $1::int = $2::int * $3::int)
            ) as branch_identity,
            ($4::int = $1::int + $5::int) as amount_is_net_plus_tax,
            ($6::int = $4::int + $7::int) as total_is_amount_plus_sc`,
    [
      numbers.netMinor,
      numbers.unitAmountMinor,
      numbers.quantity,
      numbers.amountMinor,
      numbers.taxMinor,
      numbers.totalMinor,
      numbers.serviceChargeMinor,
      numbers.taxInclusive,
    ]
  );
  const id = rows[0];
  const branch = numbers.taxInclusive ? "inclusive: line_amount = unit x qty" : "exclusive: net = unit x qty";
  return `${branch} -> ${String(id?.branch_identity)} | line_amount = net + tax -> ${String(
    id?.amount_is_net_plus_tax
  )} | line_total = line_amount + service_charge -> ${String(id?.total_is_amount_plus_sc)}`;
}

/** Every audit row this harness's own acts wrote, read back field by field. */
async function fixtureAuditRows(entityIds: string[]): Promise<void> {
  out.push("=== the audit rows for every mutation of this fixture ===");
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
      where (a.entity_id::text = any($1::text[]))
         or (a.action = 'order.book' and a.outcome = 'denied')
         or (a.action like 'order.%' and a.created_at >= $2::timestamptz)
      order by a.created_at, a.action, a.entity_type`,
    [entityIds, RUN_STARTED_AT]
  );
  if (rows.length === 0) out.push("(no rows)");
  for (const row of rows) {
    out.push(
      [
        `audit_log id=${row.audit_id}`,
        `created_at=${row.created_at}`,
        `action=${row.action}`,
        `entity_type=${row.entity_type}`,
        `entity_id=${row.entity_id ?? "NULL"}`,
        `outcome=${row.outcome}`,
        `intent=${row.intent ?? "NULL"}`,
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

const RUN_STARTED_AT = new Date().toISOString();

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------------------
  // Half one: the capabilities, read-only.
  // ---------------------------------------------------------------------------------------
  await block(
    "order capabilities declared (permission)",
    `select p.code || ' | ' || p.module || ' | kind=' || p.action_kind || ' | layer=' || p.layer
            || ' | siteScope=' || p.requires_site_scope || ' | financial_or_stock=' || p.financial_or_stock
            || ' | implemented_in=' || coalesce(p.implemented_in, '-') as line
       from permission p
      where p.code like 'order.%'
      order by p.code`
  );
  await block(
    "who holds each order capability (role_permission)",
    `select p.code || ' -> ' || r.code
            || ' (' || r.layer || ')' as line
       from role_permission rp
       join permission p on p.id = rp.permission_id
       join role r on r.id = rp.role_id
      where p.code like 'order.%'
      order by p.code, r.code`
  );
  await block(
    "order capability with no holder (the fail-closed case)",
    `select p.code || ' | no role holds it' as line
       from permission p
      where p.code like 'order.%'
        and not exists (select 1 from role_permission rp where rp.permission_id = p.id)
      order by p.code`
  );
  await block(
    "the code the spec leaves unregistered (order.close)",
    `select case when count(*) = 1 then 'order.close is declared when db/seed.sql section 8 has been applied'
                 else 'order.close is MISSING - the seed section has not been applied' end as line
       from permission where code = 'order.close'`
  );

  // ---------------------------------------------------------------------------------------
  // Half two: the fixture, through the domain code.
  // ---------------------------------------------------------------------------------------
  t.heading("S-B/1c — the priced three-line fixture and its read-back");
  const o = await outlet();
  t.say(`outlet ${o.code} (${o.id})`);
  t.say(`chain ${o.chain_id}  site ${o.site_code} (${o.site_id})  timezone ${o.timezone}  currency ${o.currency}`);
  t.say(`jurisdiction ${o.jurisdiction_code ?? "NULL"}  site's own calendar date ${o.site_date}`);
  const before = await counts();
  t.say(countsLine("before", before));

  const author = await principalFor(q, "site.head@saffron.example", o.chain_id);
  t.say(
    `booking principal ${author.email} role(s) ${author.roles.map((r) => r.code).join(",")} site ${author.siteId ?? "NULL"}`
  );
  t.check("the booking principal holds order.book", author.permissions.includes("order.book"));
  t.check("the fixture's outlet really is at the pilot site", o.site_code === SITE_CODE, o.site_code);

  const serviceChargePercent = await resolveServiceChargePercent(q, { chainId: o.chain_id, siteId: o.site_id });
  t.say(`service charge resolved by the domain: ${String(serviceChargePercent)} per cent`);

  // The constraint the booking is up against, read from the catalog rather than described: the
  // branch-dependent clause was the defect S-B/1c found (0012 -> 0013).
  await block(
    "the order_line_arithmetic the database actually enforces",
    `select pg_get_constraintdef(c.oid) as line
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = 'order_line' and c.conname = 'order_line_arithmetic'`
  );

  // (a) the routing map — empty at the start of this session, and §11.3 item 2 needs three stations.
  const routeIds: string[] = [];
  for (const line of FIXTURE_LINES) {
    const articleId = await articleIdFor(q, o.chain_id, line.articleCode);
    const sectionId = await sectionIdFor(q, o.id, line.sectionCode);
    const beforeRoute = await resolveLineRoute(q, { chainId: o.chain_id, outletId: o.id, articleId });
    const existing = await q.query<{ id: string }>(
      `select id from article_route where outlet_id = $1 and article_id = $2 and section_id = $3`,
      [o.id, articleId, sectionId]
    );
    let routeId = existing[0]?.id ?? "";
    if (!routeId) {
      const written = await setArticleRoute(
        author,
        { outletId: o.id, articleId, sectionId, isPrimary: true, position: 0 },
        { source: "system", intent: "route.fixture" }
      );
      // `RouteWriteResult` deliberately carries no id (it reports the pair it wrote), so the id
      // this fixture has to name is read back from the row that write produced.
      const writtenRows = await q.query<{ id: string }>(
        `select id from article_route where outlet_id = $1 and article_id = $2 and section_id = $3`,
        [o.id, articleId, sectionId]
      );
      routeId = writtenRows[0]?.id ?? "";
      t.say(
        `  routed ${written.articleCode} to ${written.sectionCode} (primary=${String(written.isPrimary)}), article_route id ${routeId}`
      );
    }
    routeIds.push(routeId);
    const afterRoute = await resolveLineRoute(q, { chainId: o.chain_id, outletId: o.id, articleId });
    t.say(
      `${line.articleCode} -> ${line.sectionCode}: before=${beforeRoute.unrouted ? "unrouted" : beforeRoute.targets
        .map((x) => x.routeSource)
        .join(",")} (${String(beforeRoute.targets.length)} target(s)) after=${afterRoute.targets
        .map((x) => `${x.routeSource}${x.isPrimary ? " (primary)" : ""}`)
        .join(",")} section_id=${afterRoute.targets[0]?.sectionId ?? "none"}`
    );
    t.check(
      `${line.articleCode} now resolves to exactly one station through article_route`,
      afterRoute.targets.length === 1 && afterRoute.targets[0]?.routeSource === "article_route",
      `targets=${String(afterRoute.targets.length)}`
    );
    t.check(
      `${line.articleCode}'s resolved station is ${line.sectionCode}`,
      afterRoute.targets[0]?.sectionId === sectionId,
      `read ${afterRoute.targets[0]?.sectionId ?? "none"}`
    );
  }

  // (b) the booking itself, or the fixture read back if it already exists.
  const existingOrder = await q.query<{ id: string; outlet_order_id: string }>(
    `select o.id, oo.id as outlet_order_id
       from "order" o join outlet_order oo on oo.order_id = o.id
      where o.chain_id = $1 and o.site_id = $2 and o.service_reference = $3`,
    [o.chain_id, o.site_id, SERVICE_REFERENCE]
  );
  let booked = existingOrder[0] ?? null;
  if (booked) {
    t.say(`the fixture booking ${SERVICE_REFERENCE} already exists — read back, not booked again`);
  } else {
    try {
      const result = await bookOutletOrder(
        author,
        {
          outletId: o.id,
          origin: "pos",
          serviceReference: SERVICE_REFERENCE,
          tableLabel: "Table 7",
          lines: FIXTURE_LINES.map((line) => ({ articleCode: line.articleCode, quantity: line.quantity })),
        },
        { source: "system", intent: "order.place" }
      );
      booked = { id: result.orderId, outlet_order_id: result.outletOrderId };
      t.say(`booked: order ${result.orderId} outlet_order ${result.outletOrderId} reference ${result.serviceReference}`);
    } catch (error) {
      const e = error as { code?: string; constraint?: string; table?: string; detail?: string };
      t.say(`BOOKING REFUSED by the database or the domain.`);
      t.say(`  message      ${errorMessage(error)}`);
      t.say(`  sqlstate     ${e.code ?? "(none)"}`);
      t.say(`  constraint   ${e.constraint ?? "(none)"}`);
      t.say(`  table        ${e.table ?? "(none)"}`);
      t.say(`  detail       ${e.detail ?? "(none)"}`);
      t.failures.push(`the fixture booking was refused: ${errorMessage(error)}`);
    }
  }

  const after = await counts();
  t.say(countsLine("after the booking attempt", after));

  // (c-bis) nothing was stored, so there is no `order_line` row to read back. What the code
  // RESOLVED and COMPUTED is read instead, through the domain's own pricing read — which
  // writes nothing — so the pins, the tax and the arithmetic are still on the record, and
  // each line's numbers are tested against each clause of the constraint that refused them.
  if (!booked) {
    t.check(
      "the refused booking wrote no order, no outlet order and no line",
      after.orders === before.orders &&
        after.outletOrders === before.outletOrders &&
        after.orderLines === before.orderLines,
      `${countsLine("before", before)} / ${countsLine("after", after)}`
    );
    t.check(
      "and it wrote no audit row of its own — its transaction rolled back whole",
      after.audits === before.audits + routeIds.length,
      `audit_log ${String(before.audits)} + ${String(routeIds.length)} route row(s) -> ${String(after.audits)}`
    );
    t.say("");
    t.say(
      "no row was stored, so the pricing is read back from the resolution the code performs (read-only) and each line's arithmetic is tested clause by clause against the order_line_arithmetic the database enforces:"
    );
    let sumNet = 0;
    let sumTax = 0;
    let sumAmount = 0;
    let sumServiceCharge = 0;
    for (const line of FIXTURE_LINES) {
      const facts = await priceArticleAtOutlet(q, {
        chainId: o.chain_id,
        outletId: o.id,
        jurisdictionCode: o.jurisdiction_code,
        siteDate: o.site_date,
        locale: o.locale ?? "en-IN",
        articleCode: line.articleCode,
      });
      const unit = toMinorUnits(facts.priceAmount, facts.currencyCode);
      if (unit === null) {
        t.failures.push(`line ${line.articleCode}: no minor-unit rule for ${facts.currencyCode}`);
        continue;
      }
      const a = priceLine({
        unitAmountMinor: unit,
        quantity: line.quantity,
        taxRatePct: facts.taxRatePct,
        taxInclusive: facts.taxInclusive,
        serviceChargePct: serviceChargePercent,
      });
      sumNet += a.netMinor;
      sumTax += a.taxMinor;
      sumAmount += a.amountMinor;
      sumServiceCharge += a.serviceChargeMinor;
      t.say(`  line ${line.articleCode} (${facts.articleName ?? "(no name)"}) -> ${line.sectionCode}`);
      t.say(
        `    pinned version: id ${facts.articleVersionId} v${String(facts.articleVersion)} status ${facts.versionStatus}`
      );
      t.say(
        `    pinned price : id ${facts.articlePriceId} amount ${String(facts.priceAmount)} ${facts.currencyCode} window ${facts.priceEffectiveFrom} -> ${facts.priceEffectiveTo ?? "(open)"} => unit ${money(unit, facts.currencyCode)}`
      );
      t.say(
        `    pinned tax   : class ${facts.taxClassCode ?? "(none)"} inclusive=${String(facts.taxInclusive)} rate id ${facts.taxRateId ?? "(none)"} ${String(facts.taxRatePct)}%`
      );
      t.say(
        `    arithmetic   : qty ${String(line.quantity)} x unit ${String(unit)} = ${String(unit * line.quantity)} | net ${String(a.netMinor)} | tax ${String(a.taxMinor)} | line amount ${String(a.amountMinor)} | service charge ${String(a.serviceChargeMinor)} | line total ${String(a.totalMinor)}`
      );
      t.say(`    constraint   : ${await arithmeticClauses({ ...a, quantity: line.quantity, taxInclusive: facts.taxInclusive })}`);
    }
    t.say(
      `  the outlet_order the code would have written: subtotal ${money(sumAmount, o.currency)} (sum of line amounts), tax ${money(sumTax, o.currency)}, service charge ${money(sumServiceCharge, o.currency)}, total ${money(sumAmount + sumServiceCharge, o.currency)}; net of tax ${money(sumNet, o.currency)}`
    );
  }

  // (c) the read-back, line by line, with the arithmetic a reader can re-check.
  if (booked) {
    const readback = await readOutletOrder(author, booked.outlet_order_id, { source: "system" });
    t.say("");
    t.say("the order row, read back through the domain read:");
    await block(
      "the order row (raw)",
      `select '"order" id=' || o.id::text || ' | chain_id=' || o.chain_id::text || ' | site_id=' || o.site_id::text
              || ' | service_reference=' || o.service_reference || ' | origin=' || o.origin
              || ' | status=' || o.status || ' | table_label=' || coalesce(o.table_label, 'NULL')
              || ' | placed_by_user_id=' || coalesce(o.placed_by_user_id::text, 'NULL')
              || ' | placed_at(UTC)=' || to_char(o.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              || ' | cancelled_at=' || coalesce(o.cancelled_at::text, 'NULL')
              || ' | cancel_reason_code=' || coalesce(o.cancel_reason_code, 'NULL') as line
         from "order" o where o.id = $1`,
      [readback.orderId]
    );
    await block(
      "the outlet_order row (raw)",
      `select 'outlet_order id=' || oo.id::text || ' | outlet_id=' || oo.outlet_id::text
              || ' | order_id=' || oo.order_id::text || ' | status=' || oo.status
              || ' | request_source=' || oo.request_source
              || ' | accepted_at(UTC)=' || to_char(oo.accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              || ' | accepted_by_user_id=' || coalesce(oo.accepted_by_user_id::text, 'NULL')
              || ' | fired_at=' || coalesce(oo.fired_at::text, 'NULL')
              || ' | prep_deadline_at=' || coalesce(oo.prep_deadline_at::text, 'NULL')
              || ' | currency_code=' || oo.currency_code
              || ' | service_charge_percent=' || oo.service_charge_percent::text
              || ' | subtotal_minor=' || oo.subtotal_minor::text
              || ' | tax_minor=' || oo.tax_minor::text
              || ' | service_charge_minor=' || oo.service_charge_minor::text
              || ' | total_minor=' || oo.total_minor::text as line
         from outlet_order oo where oo.id = $1`,
      [booked.outlet_order_id]
    );
    await block(
      "the order_line rows with the rows they pinned (raw)",
      `select 'line ' || ol.position::text
              || ' | order_line_id=' || ol.id::text
              || ' | article=' || a.code
              || ' | pinned_version_id=' || ol.article_version_id::text || ' (v' || v.version::text || ', status ' || v.status || ')'
              || ' | current_version_id=' || a.current_version_id::text
              || ' | pinned_price_id=' || coalesce(ol.article_price_id::text, 'NULL')
              || ' | price_row=' || coalesce('amount ' || p.amount::text || ' ' || p.currency_code
                   || ' window ' || p.effective_from::text || ' -> ' || coalesce(p.effective_to::text, 'open'), 'NULL')
              || ' | tax_class=' || coalesce(tc.code, 'NULL') || ' inclusive=' || coalesce(tc.inclusive::text, 'NULL')
              || ' | pinned_tax_rate_id=' || coalesce(ol.tax_rate_id::text, 'NULL')
              || ' | rate_pct=' || ol.tax_rate_pct::text
              || ' | rate_row=' || coalesce(tr.supply_type || ' ' || tr.rate_pct::text || '% window ' || tr.effective_from::text
                   || ' -> ' || coalesce(tr.effective_to::text, 'open'), 'NULL')
              || ' | qty=' || ol.quantity::text
              || ' | unit_minor=' || ol.unit_amount_minor::text
              || ' | net_minor=' || ol.net_amount_minor::text
              || ' | tax_minor=' || ol.tax_amount_minor::text
              || ' | line_amount_minor=' || ol.line_amount_minor::text
              || ' | service_charge_minor=' || ol.service_charge_amount_minor::text
              || ' | line_total_minor=' || ol.line_total_minor::text
              || ' | currency=' || ol.currency_code
              || ' | routing_section_id=' || coalesce(ol.routing_section_id::text, 'NULL')
              || ' | routing_source=' || coalesce(ol.routing_source, 'NULL')
              || ' | line_state=' || ol.line_state as line
         from order_line ol
         join article a on a.id = ol.article_id
         join article_version v on v.id = ol.article_version_id
         left join article_price p on p.id = ol.article_price_id
         left join tax_class tc on tc.id = ol.tax_class_id
         left join tax_rate tr on tr.id = ol.tax_rate_id
        where ol.outlet_order_id = $1
        order by ol.position`,
      [booked.outlet_order_id]
    );

    t.say("the arithmetic, re-checked from the rows that were pinned:");
    for (const line of readback.lines) {
      const pinned = await q.query<{ amount: string; currency_code: string; effective_from: string; effective_to: string | null; inclusive: boolean; rate_pct: string; supply_type: string; rate_from: string }>(
        `select p.amount::text as amount, p.currency_code, p.effective_from::text as effective_from,
                p.effective_to::text as effective_to, tc.inclusive, tr.rate_pct::text as rate_pct,
                tr.supply_type, tr.effective_from::text as rate_from
           from order_line ol
           join article_price p on p.id = ol.article_price_id
           left join tax_class tc on tc.id = ol.tax_class_id
           left join tax_rate tr on tr.id = ol.tax_rate_id
          where ol.id = $1`,
        [line.orderLineId]
      );
      const facts = pinned[0];
      if (!facts) {
        t.failures.push(`line ${String(line.position)}: could not read the pinned price row`);
        continue;
      }
      const unitFromMaster = toMinorUnits(Number(facts.amount), facts.currency_code);
      const expected = priceLine({
        unitAmountMinor: line.unitAmountMinor,
        quantity: line.quantity,
        taxRatePct: line.taxRatePct,
        taxInclusive: line.taxInclusive,
        serviceChargePct: readback.serviceChargePercent,
      });
      t.say(`  line ${String(line.position)} ${line.articleCode}`);
      t.say(
        `    pinned: unit ${money(line.unitAmountMinor, readback.currencyCode)} | qty ${String(line.quantity)}`
      );
      t.say(
        `    the pinned price row says ${facts.amount} ${facts.currency_code.trim()} from ${facts.effective_from} to ${facts.effective_to ?? "(open)"}; unit in minor units = ${String(unitFromMaster)}`
      );
      t.say(
        `    the pinned tax rate row says ${facts.supply_type} ${facts.rate_pct}% from ${facts.rate_from}; class inclusive=${String(facts.inclusive)}`
      );
      t.say(
        `    quantity x unit = ${String(line.unitAmountMinor * line.quantity)} minor units; code's net ${String(line.netAmountMinor)}, its tax ${String(line.taxAmountMinor)}, line amount (menu) ${String(line.amountMinor)}, service charge ${String(line.serviceChargeMinor)}, line total ${String(line.totalMinor)}`
      );
      t.check(
        `line ${String(line.position)}: what is stored is what priceLine recomputes`,
        JSON.stringify(expected) ===
          JSON.stringify({
            unitAmountMinor: line.unitAmountMinor,
            netMinor: line.netAmountMinor,
            taxMinor: line.taxAmountMinor,
            amountMinor: line.amountMinor,
            serviceChargeMinor: line.serviceChargeMinor,
            totalMinor: line.totalMinor,
          }),
        `stored ${JSON.stringify(line)} vs recomputed ${JSON.stringify(expected)}`
      );
      t.check(
        `line ${String(line.position)}: the pinned pure unit price equals the master-data amount converted once`,
        unitFromMaster === line.unitAmountMinor,
        `master ${String(unitFromMaster)} vs pinned ${String(line.unitAmountMinor)}`
      );
      // The identities the constraint makes structural, asked one at a time against the
      // numbers the database actually stored — so the failing clause is named, not implied.
      t.say(
        `    the order_line_arithmetic the database enforces, clause by clause: ${await arithmeticClauses({
          unitAmountMinor: line.unitAmountMinor,
          quantity: line.quantity,
          taxInclusive: line.taxInclusive,
          netMinor: line.netAmountMinor,
          taxMinor: line.taxAmountMinor,
          amountMinor: line.amountMinor,
          serviceChargeMinor: line.serviceChargeMinor,
          totalMinor: line.totalMinor,
        })}`
      );
    }
    t.say(
      `the outlet_order's own money: subtotal ${money(readback.subtotalMinor, readback.currencyCode)}, tax ${money(readback.taxMinor, readback.currencyCode)}, service charge ${money(readback.serviceChargeMinor, readback.currencyCode)}, total ${money(readback.totalMinor, readback.currencyCode)}`
    );
    t.check(
      "outlet_order.total_minor is its subtotal plus its service charge",
      readback.totalMinor === readback.subtotalMinor + readback.serviceChargeMinor,
      `${String(readback.subtotalMinor)} + ${String(readback.serviceChargeMinor)} vs ${String(readback.totalMinor)}`
    );
    t.check(
      "outlet_order.subtotal_minor is the sum of the lines' amounts",
      readback.subtotalMinor === readback.lines.reduce((sum, line) => sum + line.amountMinor, 0)
    );
    t.check("the order row is accepted", readback.orderStatus === "accepted", readback.orderStatus);
    t.check("the outlet_order row is accepted", readback.outletOrderStatus === "accepted", readback.outletOrderStatus);
    t.check("routing is still unresolved, as S-B/1 left it (S-B/2 fires)", readback.lines.every((line) => line.routingSectionId === null && line.routingSource === null));
    t.say(`origin ${readback.origin} | table_label ${readback.tableLabel ?? "NULL"} | placed_at(UTC) ${readback.placedAt}`);
  }

  // (d) a VALIDATION refusal: a second line that cannot be priced. It must leave nothing.
  const beforeValidation = await counts();
  t.say("");
  t.say("a validation refusal (the second line names an article this chain does not have):");
  try {
    await bookOutletOrder(author, {
      outletId: o.id,
      origin: "pos",
      serviceReference: "SB1C-REFUSED",
      lines: [
        { articleCode: FIXTURE_LINES[0].articleCode, quantity: 1 },
        { articleCode: "ART-NO-SUCH-DISH", quantity: 1 },
      ],
    });
    t.failures.push("the unknown-article booking was NOT refused");
    t.say("  UNEXPECTED: it was accepted");
  } catch (error) {
    t.say(`  refused with: ${errorMessage(error)}`);
  }
  const afterValidation = await counts();
  t.say(countsLine("  before the refusal", beforeValidation));
  t.say(countsLine("  after the refusal ", afterValidation));
  t.check(
    "the validation refusal wrote no order, no outlet order and no line",
    afterValidation.orders === beforeValidation.orders &&
      afterValidation.outletOrders === beforeValidation.outletOrders &&
      afterValidation.orderLines === beforeValidation.orderLines
  );
  t.check(
    "and no audit row either — the ledger's gap is deliberate",
    afterValidation.audits === beforeValidation.audits,
    `${String(beforeValidation.audits)} -> ${String(afterValidation.audits)}`
  );

  // (d-bis) the same refusal, in its bluntest form: an order with NO lines at all. `order.ts`
  // refuses it at the door (`A booking needs at least one line.`), so nothing is resolved, no
  // insert is attempted and the ledger must not move.
  const beforeEmpty = await counts();
  t.say("");
  t.say("a validation refusal (a booking with no lines at all):");
  try {
    await bookOutletOrder(author, {
      outletId: o.id,
      origin: "pos",
      serviceReference: "SB1C-NO-LINES",
      lines: [],
    });
    t.failures.push("the empty booking was NOT refused");
    t.say("  UNEXPECTED: it was accepted");
  } catch (error) {
    t.say(`  refused with: ${errorMessage(error)}`);
  }
  const afterEmpty = await counts();
  t.say(countsLine("  before the refusal", beforeEmpty));
  t.say(countsLine("  after the refusal ", afterEmpty));
  t.check(
    "the empty booking wrote no order, no outlet order and no line",
    afterEmpty.orders === beforeEmpty.orders &&
      afterEmpty.outletOrders === beforeEmpty.outletOrders &&
      afterEmpty.orderLines === beforeEmpty.orderLines
  );
  t.check(
    "and no audit row either — a zero-line booking is refused before the first insert",
    afterEmpty.audits === beforeEmpty.audits,
    `${String(beforeEmpty.audits)} -> ${String(afterEmpty.audits)}`
  );

  // (e) a CAPABILITY refusal: a real account that does not hold order.book.
  const beforeDenied = await counts();
  const stranger = await principalFor(q, "culinary.team@saffron.example", o.chain_id);
  t.say("");
  t.say(
    `a capability refusal from ${stranger.email} (roles ${stranger.roles.map((r) => r.code).join(",")}, holds order.book=${String(stranger.permissions.includes("order.book"))})`
  );
  // Re-runnable: a second run of this harness must not keep adding `denied` rows to the
  // owner's ledger, so an earlier refusal by this same account is quoted instead of repeated.
  const priorDenial = await q.query<{ created_at: string; reason: string | null }>(
    `select to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, a.reason
       from audit_log a
      where a.action = 'order.book' and a.outcome = 'denied'
        and a.actor_user_id = (select id from "user" where email = 'culinary.team@saffron.example')
      order by a.created_at desc limit 1`
  );
  if (priorDenial[0]) {
    t.say(
      `  already in the ledger from an earlier run of this harness (${priorDenial[0].created_at}): ${priorDenial[0].reason ?? "NULL"} — not repeated, so this harness adds no rows it does not have to`
    );
  } else {
    try {
      await bookOutletOrder(
        stranger,
        {
          outletId: o.id,
          origin: "pos",
          serviceReference: "SB1C-DENIED",
          lines: [{ articleCode: FIXTURE_LINES[0].articleCode, quantity: 1 }],
        },
        { source: "system", intent: "order.place" }
      );
      t.failures.push("the capability refusal did not happen");
      t.say("  UNEXPECTED: the booking went through");
    } catch (error) {
      t.say(`  refused with: ${errorMessage(error)}`);
    }
  }
  const afterDenied = await counts();
  t.say(countsLine("  before the refusal", beforeDenied));
  t.say(countsLine("  after the refusal ", afterDenied));
  t.check(
    "the capability refusal changed no data",
    afterDenied.orders === beforeDenied.orders &&
      afterDenied.outletOrders === beforeDenied.outletOrders &&
      afterDenied.orderLines === beforeDenied.orderLines
  );
  t.check(
    "the capability refusal wrote (or had already written) exactly one audit row",
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
      where action = 'order.book' and outcome = 'denied' and created_at >= $1::timestamptz
      order by created_at desc limit 1`,
    [RUN_STARTED_AT]
  );

  // (f) the ledger for the fixture's own mutations.
  const ids = [booked?.id ?? "", booked?.outlet_order_id ?? "", ...routeIds].filter(Boolean);
  await fixtureAuditRows(ids);

  // (g) the pre-existing read-only blocks, so this file still answers the question it was written for.
  await block(
    "S-B/1 tables (counts now)",
    `select 'order=' || (select count(*) from "order")
            || ' outlet_order=' || (select count(*) from outlet_order)
            || ' order_line=' || (select count(*) from order_line) as line`
  );
  await block(
    "migration ledger",
    `select filename || ' | applied_at=' || applied_at::text as line
       from schema_migration where filename like '001%.sql' order by filename`
  );
  await block(
    "how to remove this fixture (the rows it created, by id)",
    `select 'article_route id=' || id::text || ' outlet=' || outlet_id::text || ' article=' || article_id::text
            || ' section=' || section_id::text as line
       from article_route where id = any($1::uuid[])`,
    [routeIds]
  );

  for (const line of t.lines) out.push(line);
  out.push("");
  out.push(
    `fixture ids: order=${booked?.id ?? "NOT CREATED"} outlet_order=${booked?.outlet_order_id ?? "NOT CREATED"} article_route=${routeIds.join(",")}`
  );
  out.push(
    "cleanup: delete from order_line where outlet_order_id in (select id from outlet_order where order_id = '<order id>'); " +
      "delete from outlet_order where order_id = '<order id>'; delete from \"order\" where id = '<order id>'; " +
      "delete from article_route where id in (<article_route ids>)"
  );
  out.push(`failures: ${String(t.failures.length)}`);

  const text = out.join("\n");
  writeFileSync("/tmp/order-core-readback.txt", text);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${text}\n`);
  } catch (error) {
    process.stdout.write(`could not write ${TRANSCRIPT_PATH}: ${errorMessage(error)}\n`);
  }
  process.stdout.write(text);
  process.exit(t.failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  const text = `${out.join("\n")}\nFATAL ${String(error)}\n${(error as Error).stack ?? ""}`;
  writeFileSync("/tmp/order-core-readback.txt", text);
  try {
    writeFileSync(TRANSCRIPT_PATH, `${text}\n`);
  } catch {
    // the transcript path is best-effort on a fatal error
  }
  process.stdout.write(text);
  process.exit(1);
});
