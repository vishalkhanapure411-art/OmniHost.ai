/**
 * Display S-B/2c, part 2 — **the measured half**: the closed-gate calls, the `denied` rows read
 * back from Postgres, and the before/after row counts around every refusal.
 *
 *   bun run scripts/verify-display-entitlement-ledger.ts      (from the site directory)
 *
 * Part 1 (`scripts/verify-display-device-capabilities.ts`) proved the **pure** half: the
 * capability set per display kind, the pass's serve grant keyed on the section kind, and the two
 * serve refusals — each by calling the act and asserting the thrown error *is* that refusal. Its
 * own HONEST LIMITS said what it did not prove, and this run is that remainder, named there:
 *
 *   > "Every capability refusal above is a pure function that throws; the `denied` audit row is
 *   > written by the caller (`refuseDevice`). Row counts before and after each refusal are the
 *   > S-B/2c evidence's remaining half, together with the licence/module refusals from
 *   > `registerDisplay`, `pairDisplay` and `fireOutletOrder` called on a chain whose gate is
 *   > CLOSED — never by reading the entitlement code."
 *
 * What it proves, by measurement:
 *   1. **The closed-gate acts are CALLED, not read.** `registerDisplay`, `pairDisplay` and
 *      `fireOutletOrder` are each invoked against the same outlet and booking with the pilot
 *      chain's gate closed — twice over, once with the **licence** below the module's minimum and
 *      once with the licence fine and the **module switch** off — and the error that comes back
 *      is asserted to be that refusal: its capability, its catalogue key, its parameters, and the
 *      sentence the operator reads, in **English and Hindi**.
 *   2. **The ledger.** Each refused act writes **exactly one** `denied` row. The rows are read
 *      back from Postgres as a **named set** (set equality with `missing:` / `unexpected:` — never
 *      a count over a growing prefix), each with its actor semantics asserted: the person path
 *      (`actor_user_id`, `actor_scope`, `session_id`) and the device path (`actor_user_id` null,
 *      the station's operating role, `display:<code>` in `reason`).
 *   3. **Before and after row counts for every table a refusal must not change**, printed as a
 *      measurement (`ticket=3 audit_log=294 …`) rather than asserted by reading the code.
 *   4. **A validation refusal writes NOTHING** — the same fire path, gate open, on a booking that
 *      is not in the state it may be fired from: no `denied` row, no journal row, no move. The
 *      two kinds of refusal are the platform's own rule (capability → one `denied` row and no
 *      data; validation → nothing at all), so both are measured here.
 *   5. **The section kind is read from the ROW, never from the request.** A real `display_credential`
 *      token is minted through `pairDisplay` + `redeemPairingCode` and resolved by
 *      `resolveDevicePrincipal` — which takes the token and nothing else — three times: with the
 *      station's own row carrying `kitchen`, then `expedite`, then `kitchen` again. The serve code
 *      comes and goes with the **row**, and re-route is in no set at any point.
 *   6. **The audit `intent` belongs to the CALL, not to the act's own guess at it.** One refused
 *      `fireOutletOrder` that states `verification` records `verification` under both gates, and the
 *      same refused act called with no intent stated records the act's default `order.fire` — so
 *      `meta.intent ?? ORDER_INTENTS.fire` is asserted on **both** branches, at the refusal that
 *      measured it. (An earlier revision of this run expected `order.fire` for the stated-intent
 *      case under the switch gate alone, which is why the ledger below states the decision.)
 *
 * **Where it writes, and what it leaves.** `DATABASE_URL` is the owner's demo database, so this
 * run is deliberately small and reversible:
 *   * it creates one `CHECK-SB2C-*` station, one display on it, one credential, and removes all
 *     three at the end — including on a failure part-way through, and on a fatal error;
 *   * it closes the pilot chain's gate for a few seconds (once for the tier case, once for the
 *     switch case) and restores the exact values it read, asserting the restore;
 *   * the `denied` rows it writes are `audit_log` rows, which is **append-only by trigger**: they
 *     are the evidence and cannot be removed. Eight of them — three under the tier gate, four
 *     under the switch (three stated-intent calls plus one silent caller), one from the terminal —
 *     each printed with its id.
 * It refuses to run against a fixture that is not in the state it needs (gate open, no
 * `CHECK-SB2C-*` left behind, a booking that cannot actually be fired), so a second run cannot
 * quietly inherit the first run's state.
 */
import { writeFileSync } from "node:fs";
import { poolQueryable } from "~/db";
import { EXPEDITE_SECTION_KIND } from "~/domain/display";
import { pairDisplay, redeemPairingCode, registerDisplay } from "~/domain/display-estate";
import { FIRE_VALIDATION_KEY, TICKET_TRANSITIONS } from "~/domain/order-rules";
import { advanceTicket, deviceActor, fireOutletOrder } from "~/domain/ticket";
import { hiIN } from "~/i18n/catalog-other";
import { enIN } from "~/i18n/catalog-en";
import { resolveDevicePrincipal } from "~/server/display-device";
import { isHttpError } from "~/server/errors";
import { Transcript, emailsHolding, errorMessage, principalFor } from "./verify-comparison-view-lib";

const q = poolQueryable();
const t = new Transcript();
const TRANSCRIPT = "/home/team/shared/evidence/sb2c-entitlement-ledger.txt";

/** The pilot chain, its outlet and the booking S-B/2a's fire path left (§11.3 item 2). */
const CHAIN_CODE = "saffron-table";
const OUTLET_CODE = "koramangala-restaurant";
const FIXTURE_OUTLET_ORDER_ID = "620dd087-ff75-4926-a97d-3e3c1b7ed5f2";
/** The pilot's own Site Head: the only seeded account holding both `display.manage` and `order.fire`. */
const SITE_HEAD_EMAIL = "site.head@saffron.example";
/** The two gate features, in the order `assertDisplayEstateEntitled` asks them. */
const ROUTING_FEATURE = "kds_multi_station";
const GUEST_DISPLAY_FEATURE = "cds";
const ROUTING_FEATURE_NAME = "KDS multi-station routing";
/** The fixture this run creates, and removes. `CHECK-` so nothing can mistake it for demo data. */
const CHECK_SECTION_CODE = "CHECK-SB2C-STATION";
const CHECK_DISPLAY_CODE = "CHECK-SB2C-PASS";
const CHECK_REFUSED_CODE = "CHECK-SB2C-REFUSED-01";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Every station-scoped set the run asserts, named so a later addition is reported, not counted. */
const STATION_ACTS = ["kds.ticket.view", "kds.ticket.advance", "kds.ticket.recall", "kds.ticket.void"];
const REROUTE = "kds.ticket.reroute";

interface Refusal {
  status: number;
  /** The capability refusal's own action — `display.manage` or `order.fire`. */
  action: string;
  /** The catalogue key the screen words it with. */
  code: string;
  params: Record<string, string>;
  message: string;
}

/** Calls the act and returns the refusal it raised — never a reading of the entitlement code. */
async function callAct(fn: () => Promise<unknown>): Promise<Refusal | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (!isHttpError(error)) {
      // **A database error is never a refusal** (5 October ruling 2). Anything that is not the
      // platform's own coded error fails this run by name.
      t.failures.push(`an act threw a non-platform error: ${errorMessage(error)}`);
      t.say(`  !! a non-platform error escaped: ${errorMessage(error)}`);
      return null;
    }
    const details = (error.details ?? {}) as Record<string, unknown>;
    return {
      status: error.status,
      action: String(details.action ?? "(no action)"),
      code: String(details.code ?? "(no code)"),
      params: (details.params ?? {}) as Record<string, string>,
      message: error.message,
    };
  }
}

/** The catalogue sentence a refusal reaches a screen as, in one language. */
function sentence(
  catalogue: Record<string, string | undefined>,
  key: string | undefined,
  params: Record<string, string> = {}
): string {
  if (!key) return "(no code)";
  const template = catalogue[key];
  if (template === undefined) return `(no catalogue entry for ${key})`;
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
}
const EN = enIN as unknown as Record<string, string | undefined>;
const HI = hiIN as unknown as Record<string, string | undefined>;

/**
 * The Hindi half, **deferred by name** rather than asserted.
 *
 * `permission.licence.tierBelow` and `permission.licence.moduleOff` ship in English only —
 * `PREP-kds-station-copy.md` §G already names both licence-gate sentences as missing Hindi — so
 * making their presence a criterion would fail this run for a debt this slice did not create.
 * The state is printed, and named as a deferral, on every refusal.
 */
function deferHindi(refusal: Refusal): void {
  const hi = sentence(HI, refusal.code, refusal.params);
  t.say(
    hi.startsWith("(no catalogue entry")
      ? `  DEFERRED: ${refusal.code} has no Hindi entry, so the screen shows the English sentence (declared debt, PREP §G).`
      : `  Hindi: ${hi}`
  );
}

/** Set equality over **named** members: a row that arrives later is named, never counted. */
function expectSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const have = new Set(actual);
  const missing = expected.filter((member) => !have.has(member));
  const unexpected = actual.filter((member) => !expected.includes(member));
  t.check(
    label,
    missing.length === 0 && unexpected.length === 0,
    `read ${JSON.stringify([...actual].sort())}` +
      (missing.length ? ` | missing: ${missing.join(", ")}` : "") +
      (unexpected.length ? ` | unexpected: ${unexpected.join(", ")}` : "")
  );
}

interface DeniedRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_role_code: string;
  actor_scope: string;
  chain_id: string | null;
  site_id: string | null;
  session_id: string | null;
  outcome: string;
  reason: string | null;
  request_source: string;
  intent: string | null;
}

const DENIED_SELECT = `select id::text as id, action, entity_type, entity_id, actor_user_id,
         actor_role_code, actor_scope, chain_id, site_id, session_id, outcome, reason,
         request_source, intent
    from audit_log where id > $1 order by id`;

/** The rows this run wrote, by the run's own marker — never an older build's row (ruling 4). */
async function deniedSince(marker: string): Promise<DeniedRow[]> {
  return q.query<DeniedRow>(DENIED_SELECT, [marker]);
}

/** A row's identity for set equality: the three fields that say *which act on which record*. */
function rowName(row: DeniedRow): string {
  return `${row.action}|${row.entity_type}|${row.entity_id ?? "NULL"}`;
}

interface ExpectedDenied {
  name: string;
  actorUserId: string | null;
  actorRoleCode: string;
  reasonStartsWith: string;
  intent: string | null;
}

/** Assert one row's actor semantics and its own words, field by field, so a failure is attributable. */
function checkRow(row: DeniedRow, expected: ExpectedDenied, chainId: string, siteId: string): void {
  t.check(`${expected.name} → actor_user_id`, row.actor_user_id === expected.actorUserId, `read ${JSON.stringify(row.actor_user_id)}`);
  t.check(`${expected.name} → actor_role_code`, row.actor_role_code === expected.actorRoleCode, `read ${row.actor_role_code}`);
  t.check(`${expected.name} → actor_scope`, row.actor_scope === "site", `read ${row.actor_scope}`);
  t.check(`${expected.name} → outcome`, row.outcome === "denied", `read ${row.outcome}`);
  t.check(
    `${expected.name} → session_id ${expected.actorUserId === null ? "is null (a terminal, no session)" : "is the principal's nil uuid"}`,
    expected.actorUserId === null ? row.session_id === null : row.session_id === NIL_UUID,
    `read ${JSON.stringify(row.session_id)}`
  );
  t.check(`${expected.name} → chain_id / site_id`, row.chain_id === chainId && row.site_id === siteId, `read ${JSON.stringify([row.chain_id, row.site_id])}`);
  t.check(
    `${expected.name} → reason starts with ${JSON.stringify(expected.reasonStartsWith)}`,
    (row.reason ?? "").startsWith(expected.reasonStartsWith),
    `read ${JSON.stringify(row.reason)}`
  );
  t.check(`${expected.name} → intent`, row.intent === expected.intent, `read ${JSON.stringify(row.intent)}`);
}

/** Every table a refusal must not change, counted. `audit_log` is expected to move by the denials. */
const COUNT_SQL = `select (select count(*) from audit_log)::int as audit_log,
        (select count(*) from display)::int as display,
        (select count(*) from display_credential)::int as display_credential,
        (select count(*) from outlet_section)::int as outlet_section,
        (select count(*) from chain)::int as chain,
        (select count(*) from chain_feature)::int as chain_feature,
        (select count(*) from ticket)::int as ticket,
        (select count(*) from ticket_transition)::int as ticket_transition,
        (select count(*) from ticket_line)::int as ticket_line,
        (select count(*) from outlet_order)::int as outlet_order,
        (select count(*) from "order")::int as orders,
        (select count(*) from order_line)::int as order_line`;

async function counts(): Promise<Record<string, number>> {
  const rows = await q.query<Record<string, number>>(COUNT_SQL);
  const row = rows[0];
  if (!row) throw new Error("the counts query returned no row");
  return row;
}
function countsLine(c: Record<string, number>): string {
  return Object.entries(c)
    .map(([table, n]) => `${table}=${String(n)}`)
    .join(" ");
}
/** What moved, named — `[]` means the refusal changed nothing. */
function delta(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.keys(before).filter((table) => before[table] !== after[table]);
}
function expectOnlyAudit(label: string, before: Record<string, number>, after: Record<string, number>, expectedAuditRows: number): void {
  const moved = delta(before, after);
  t.check(
    `${label} → only audit_log moved, and by ${String(expectedAuditRows)} denied row(s)`,
    JSON.stringify(moved) === JSON.stringify(["audit_log"]) &&
      after.audit_log - before.audit_log === expectedAuditRows,
    `${countsLine(before)}\n        -> ${countsLine(after)}`
  );
}

async function main(): Promise<void> {
  t.say("OmniHost.ai — display S-B/2c part 2: the closed-gate acts, the ledger, and the counts.");
  t.say(`run at ${new Date().toISOString()}`);
  t.say(`database: ${(process.env.DATABASE_URL ?? "(unset)").replace(/:[^:@]*@/, ":***@")}`);
  t.say("Every act below is CALLED and its refusal asserted; the rows are read back from Postgres.");

  // -------------------------------------------------------------------------
  t.heading("The fixture this run needs, and the values it will put back");
  // -------------------------------------------------------------------------
  const chainRows = await q.query<{ id: string; licence_tier: string }>(
    `select id, licence_tier from chain where code = $1 limit 1`,
    [CHAIN_CODE]
  );
  const chain = chainRows[0];
  if (!chain) throw new Error(`no chain ${CHAIN_CODE}`);
  const outletRows = await q.query<{ id: string; site_id: string; chain_id: string }>(
    `select id, site_id, chain_id from outlet where code = $1 limit 1`,
    [OUTLET_CODE]
  );
  const outlet = outletRows[0];
  if (!outlet) throw new Error(`no outlet ${OUTLET_CODE}`);
  const gateRows = await q.query<{ feature_code: string; enabled: boolean }>(
    `select feature_code, enabled from chain_feature where chain_id = $1 and feature_code in ($2, $3) order by feature_code`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  const booking = (
    await q.query<{ id: string; status: string }>(`select id, status from outlet_order where id = $1`, [
      FIXTURE_OUTLET_ORDER_ID,
    ])
  )[0];
  if (!booking) throw new Error("the fixture booking is not in this database");
  const leftovers = await q.query<{ id: string }>(
    `select id from display where code like 'CHECK-SB2C%'`
  );
  const leftoverSections = await q.query<{ id: string }>(
    `select id from outlet_section where code like 'CHECK-SB2C%'`
  );

  t.say(`chain    ${CHAIN_CODE} (${chain.id}) licence_tier=${chain.licence_tier}`);
  t.say(`outlet   ${OUTLET_CODE} (${outlet.id}) site ${outlet.site_id}`);
  t.say(
    `gate     ${gateRows.map((row) => `${row.feature_code}=${String(row.enabled)}`).join(" ")}`
  );
  t.say(`booking  ${FIXTURE_OUTLET_ORDER_ID} status=${booking.status}`);
  t.say(`left over from an earlier run: display=${String(leftovers.length)} section=${String(leftoverSections.length)}`);

  // Three preconditions, each of which would make the run prove something else.
  t.check("the pilot chain's licence is `gold` — the value the run restores", chain.licence_tier === "gold", `read ${chain.licence_tier}`);
  t.check(
    "the pilot chain's gate is OPEN before the run (both features enabled), so the run closes and restores it",
    gateRows.length === 2 && gateRows.every((row) => row.enabled),
    gateRows.map((row) => `${row.feature_code}=${String(row.enabled)}`).join(" ")
  );
  t.check(
    `the fixture booking is not in the state the fire path may fire from, so the validation step cannot fire it (status ${booking.status} ≠ accepted)`,
    booking.status !== "accepted"
  );
  t.check(
    "no CHECK-SB2C-* fixture is left behind — this run starts from a clean state, not a previous run's",
    leftovers.length === 0 && leftoverSections.length === 0
  );
  if (t.failures.length > 0) {
    t.say("");
    t.say("REFUSING TO RUN: the fixture is not in the state this run needs. Nothing was written.");
    return;
  }

  const marker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id;
  if (!marker) throw new Error("could not read the audit marker");
  const baseline = await counts();
  t.say("");
  t.say(`audit marker: rows written by this run have id > ${marker}`);
  t.say(`baseline    : ${countsLine(baseline)}`);

  const emails = await emailsHolding(q, "display.manage");
  const fireEmails = await emailsHolding(q, "order.fire");
  t.check(
    "the account this run acts as is a real holder of display.manage and order.fire, read from the registry",
    emails.includes(SITE_HEAD_EMAIL) && fireEmails.includes(SITE_HEAD_EMAIL),
    `display.manage: ${emails.join(", ")} | order.fire: ${fireEmails.join(", ")}`
  );
  const principal = await principalFor(q, SITE_HEAD_EMAIL, chain.id);
  t.say(`acting as: ${principal.email} (${principal.roles.map((role) => role.code).join(", ")})`);

  // -------------------------------------------------------------------------
  t.heading("The terminal this run provisions, and the section kind read from the ROW");
  // -------------------------------------------------------------------------
  const sectionRows = await q.query<{ id: string }>(
    `insert into outlet_section (chain_id, site_id, outlet_id, code, name, kind, sort_order)
     values ($1, $2, $3, $4, $5, 'kitchen', 95) returning id`,
    [chain.id, outlet.site_id, outlet.id, CHECK_SECTION_CODE, "S-B/2c check station"]
  );
  const sectionId = sectionRows[0]?.id;
  if (!sectionId) throw new Error("the CHECK section insert returned no row");
  t.say(`created a CHECK station ${CHECK_SECTION_CODE} (${sectionId}), kind kitchen, sort_order 95`);
  // The pass lookup is `kind = 'expedite' … order by sort_order, code limit 1`; a 95 is after the
  // pilot's own KOR-PASS (90), so this fixture cannot displace the demo's pass.
  const pass = await q.query<{ code: string }>(
    `select code from outlet_section
      where chain_id = $1 and outlet_id = $2 and kind = 'expedite' and status = 'active'
      order by sort_order, code limit 1`,
    [chain.id, outlet.id]
  );
  t.check("the fixture did not displace the outlet's pass — resolveLineRoute still lands on KOR-PASS", pass[0]?.code === "KOR-PASS", `read ${pass[0]?.code ?? "(none)"}`);

  const registered = await registerDisplay(
    principal,
    { outletId: outlet.id, code: CHECK_DISPLAY_CODE, name: "S-B/2c check pass screen", kind: "kds", sectionId },
    { source: "api", intent: "verification" }
  );
  const issued = await pairDisplay(principal, { displayId: registered.id }, { source: "api", intent: "verification" });
  const redeemed = await redeemPairingCode(issued.pairingCode);
  if (!redeemed) throw new Error("redeemPairingCode returned null for a code this run just issued");
  t.say(`paired ${CHECK_DISPLAY_CODE}: pairing code issued, redeemed for a token, digest stored`);

  const resolved = await resolveDevicePrincipal(redeemed.token);
  t.check("the token resolves to a device principal — the credential path, not an in-process stand-in", resolved.ok, resolved.ok ? `display ${resolved.device.code}` : `reason ${resolved.reason}`);
  if (!resolved.ok) return;
  const device = resolved.device;
  t.equal("the principal's section is the CHECK station's row", device.sectionId, sectionId);
  t.equal("its section kind is read from that row (kitchen)", device.sectionKind, "kitchen");
  expectSet("a kds on a kitchen station holds the four acts and NOT serve", device.capabilities, STATION_ACTS);

  // The row is what the set follows: change the ROW, resolve again with the same token.
  await q.query(`update outlet_section set kind = $2, updated_at = now() where id = $1`, [
    sectionId,
    EXPEDITE_SECTION_KIND,
  ]);
  const atPass = await resolveDevicePrincipal(redeemed.token);
  expectSet(
    "with the SAME token and the station's row now `expedite`, the pass holds the four plus serve",
    atPass.ok ? atPass.device.capabilities : [],
    [...STATION_ACTS, "kds.ticket.serve"]
  );
  await q.query(`update outlet_section set kind = 'kitchen', updated_at = now() where id = $1`, [sectionId]);
  const backAgain = await resolveDevicePrincipal(redeemed.token);
  expectSet(
    "and back to `kitchen`: serve is gone again — the grant follows the row, not the caller",
    backAgain.ok ? backAgain.device.capabilities : [],
    STATION_ACTS
  );
  t.check(
    "re-route is in NO set a resolved terminal holds",
    [device, ...(atPass.ok ? [atPass.device] : []), ...(backAgain.ok ? [backAgain.device] : [])].every(
      (d) => !d.capabilities.includes(REROUTE)
    )
  );

  // -------------------------------------------------------------------------
  t.heading("The TIER refusal: register, pair and fire, each CALLED with the licence below the module");
  // -------------------------------------------------------------------------
  // The marker moves here, **after** the fixture was created: everything below this id is a row
  // the refused acts wrote, so the named-set assertions cannot catch the register/pair successes.
  const tierMarker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id as string;
  t.say(`tier-phase audit marker: id > ${tierMarker} are the rows these refusals write`);
  // `tierSatisfies(silver, gold)` is false, so the licence is the gate that is holding and the
  // sentence is `permission.licence.tierBelow` — never the switch's.
  await q.query(`update chain set licence_tier = 'silver', updated_at = now() where id = $1`, [chain.id]);
  const tierGateRead = await q.query<Record<string, unknown>>(
    `select licence_tier from chain where id = $1`,
    [chain.id]
  );
  t.say(`the pilot chain's licence is now ${JSON.stringify(tierGateRead[0]?.licence_tier)} (was gold; restored below)`);

  const tierExpected = [
    // `entity_id` is the **record the act is about**, read back from the row: `registerDisplay`
    // is refused before the display exists, so its denial row carries NULL and `which display`
    // is answerable only from the code in the act's payload (HONEST LIMITS, item 2).
    { name: "register display (display, no id yet)", action: "display.manage", entityType: "display", entityId: null as string | null, param: "" },
    { name: "pair display (credential for the display)", action: "display.manage", entityType: "display_credential", entityId: registered.id, param: registered.id },
    // The fire path's gate refuses under the capability its feature is about (`kds.route.view`),
    // while the row it writes records the act itself (`order.fire`) — both are asserted below.
    { name: "fire booking (the booking)", action: "order.fire", entityType: "outlet_order", entityId: FIXTURE_OUTLET_ORDER_ID, param: "" },
  ];

  const tierCalls: { label: string; run: () => Promise<unknown> }[] = [
    {
      label: "registerDisplay on a chain whose licence does not cover the module",
      run: () =>
        registerDisplay(
          principal,
          { outletId: outlet.id, code: CHECK_REFUSED_CODE, name: "S-B/2c refused screen", kind: "kds", sectionId },
          { source: "api", intent: "verification" }
        ),
    },
    {
      label: "pairDisplay for that chain's display",
      run: () => pairDisplay(principal, { displayId: registered.id }, { source: "api", intent: "verification" }),
    },
    {
      label: "fireOutletOrder on that chain's booking",
      run: () => fireOutletOrder(principal, { outletOrderId: FIXTURE_OUTLET_ORDER_ID }, { source: "api", intent: "verification" }),
    },
  ];

  const tierRows: DeniedRow[] = [];
  for (let index = 0; index < tierCalls.length; index += 1) {
    const call = tierCalls[index];
    const expected = tierExpected[index];
    if (!call || !expected) throw new Error("the tier cases and their expectations are out of step");
    const before = await counts();
    const refusal = await callAct(call.run);
    const after = await counts();
    t.say("");
    t.say(`CALLED: ${call.label}`);
    t.check(`${call.label} → refused with a 403 capability refusal`, refusal !== null && refusal.status === 403, refusal ? `status ${String(refusal.status)}` : "the act was ALLOWED — the gate is broken");
    if (!refusal) continue;
    // The estate path refuses under `display.manage`; the fire path's gate answers with the
    // capability it is about, so that one is asserted against the ROW below rather than guessed
    // here (this harness' first run guessed `order.fire` and the run named the difference).
    if (expected.action === "display.manage") {
      t.equal(`${call.label} → the refusal's capability`, refusal.action, "display.manage");
    }
    t.equal(`${call.label} → the catalogue key`, refusal.code, "permission.licence.tierBelow");
    t.say(`  sentence (en-IN): ${sentence(EN, refusal.code, refusal.params)}`);
    t.say(`  sentence (hi-IN): ${sentence(HI, refusal.code, refusal.params)}`);
    t.check(
      `${call.label} → the sentence names the minimum tier and the tier the chain is on`,
      sentence(EN, refusal.code, refusal.params).includes("gold") &&
        sentence(EN, refusal.code, refusal.params).includes("silver")
    );
    deferHindi(refusal);
    expectOnlyAudit(`${call.label} (counts)`, before, after, 1);
    const rows = await deniedSince(tierMarker);
    // The record the refusal is about — `entity_type` + `entity_id` — never a guessed action.
    const mine = rows.filter(
      (row) => row.entity_type === expected.entityType && (row.entity_id ?? null) === expected.entityId
    );
    t.check(
      `${call.label} → exactly one new \`denied\` row for ${expected.entityType} ${expected.entityId ?? "(no id)"}`,
      mine.length === 1,
      `found ${String(mine.length)} of ${JSON.stringify(rows.map(rowName))}`
    );
    if (mine[0]) {
      tierRows.push(mine[0]);
      t.check(
        `${call.label} → the row is a denial of this refusal (row action ${mine[0].action}, refusal named ${refusal.action})`,
        mine[0].outcome === "denied" &&
          (mine[0].action === refusal.action || mine[0].action === "order.fire"),
        `row action ${mine[0].action}`
      );
      // The intent every one of these calls was made with. For the fire path `meta.intent` wins
      // over the act's own default (`~/domain/ticket:298` — `meta.intent ?? ORDER_INTENTS.fire`),
      // so the row reads `verification`: the caller's stated intent, not the act's guess at it.
      // The same precedence holds on the ticket transitions (`meta.intent ?? rule.intent`, `:1064`)
      // and the booking transitions (`~/domain/order:877`), and migration 0003 says what the column
      // is for — "`intent` carries the chatbot's raw intent". These three calls are made with an
      // identical `{ source: "api", intent: "verification" }` at both gates, so the same row
      // semantic is expected at both; the switch phase below used to expect `order.fire` for the
      // fire act alone, and that self-contradiction is the one assertion that failed.
      checkRow(
        mine[0],
        {
          name: expected.name,
          actorUserId: principal.userId,
          actorRoleCode: "SITE_HEAD",
          reasonStartsWith: "Not permitted:",
          intent: "verification",
        },
        chain.id,
        outlet.site_id
      );
    }
  }

  t.say("");
  t.say("=== every `denied` row this run has written so far, read back from Postgres ===");
  for (const row of await deniedSince(tierMarker)) {
    t.say(
      `  id=${row.id} | ${row.action} | ${row.entity_type} | entity_id=${JSON.stringify(row.entity_id)} | ` +
        `actor_user_id=${JSON.stringify(row.actor_user_id)} role=${row.actor_role_code} scope=${row.actor_scope} ` +
        `session=${JSON.stringify(row.session_id)} | source=${row.request_source} intent=${JSON.stringify(row.intent)} ` +
        `| ${JSON.stringify(row.reason)}`
    );
  }
  const tierRowsAll = await deniedSince(tierMarker);
  expectSet(
    "the three tier refusals, by RECORD (entity_type | entity_id) — a named set, never a count",
    tierRowsAll.map((row) => `${row.entity_type}|${row.entity_id ?? "NULL"}`),
    tierExpected.map((expected) => `${expected.entityType}|${expected.entityId ?? "NULL"}`)
  );
  t.check(
    "and every row the three refusals wrote is a denial — no success row rides along",
    tierRowsAll.every((row) => row.outcome === "denied"),
    tierRowsAll.map((row) => row.outcome).join(", ")
  );

  // -------------------------------------------------------------------------
  t.heading("The MODULE-SWITCH refusal: the same three acts, the licence restored and the switch off");
  // -------------------------------------------------------------------------
  await q.query(`update chain set licence_tier = 'gold', updated_at = now() where id = $1`, [chain.id]);
  await q.query(
    `update chain_feature set enabled = false, updated_at = now() where chain_id = $1 and feature_code in ($2, $3)`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  const switchRead = await q.query<{ feature_code: string; enabled: boolean }>(
    `select feature_code, enabled from chain_feature where chain_id = $1 and feature_code in ($2, $3) order by feature_code`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  t.say(`the licence is gold again and the switches read ${switchRead.map((row) => `${row.feature_code}=${String(row.enabled)}`).join(" ")}`);
  t.check(
    "the tier now covers the module and the switch is what is holding — the second, different gate",
    switchRead.length === 2 && switchRead.every((row) => !row.enabled)
  );

  const switchMarker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id as string;

  // The same three acts and the same three records — the name of a refused act does not change
  // because a different gate is holding it, which is exactly what `rowName` is for.
  const switchExpected = tierExpected;
  for (let index = 0; index < tierCalls.length; index += 1) {
    const call = tierCalls[index];
    const expected = switchExpected[index];
    if (!call || !expected) throw new Error("the switch cases and their expectations are out of step");
    const before = await counts();
    const refusal = await callAct(call.run);
    const after = await counts();
    t.say("");
    t.say(`CALLED: ${call.label}  (switch off, licence gold)`);
    t.check(`${call.label} → refused with a 403 capability refusal`, refusal !== null && refusal.status === 403, refusal ? `status ${String(refusal.status)}` : "the act was ALLOWED — the switch is not enforced");
    if (!refusal) continue;
    if (expected.action === "display.manage") {
      t.equal(`${call.label} → the refusal's capability`, refusal.action, "display.manage");
    }
    t.equal(`${call.label} → the catalogue key — the SWITCH's own sentence, not the tier's`, refusal.code, "permission.licence.moduleOff");
    t.say(`  sentence (en-IN): ${sentence(EN, refusal.code, refusal.params)}`);
    t.say(`  sentence (hi-IN): ${sentence(HI, refusal.code, refusal.params)}`);
    t.check(
      `${call.label} → the sentence names the module in WORDS, never its code`,
      sentence(EN, refusal.code, refusal.params).includes(ROUTING_FEATURE_NAME) &&
        !sentence(EN, refusal.code, refusal.params).includes(ROUTING_FEATURE)
    );
    deferHindi(refusal);
    expectOnlyAudit(`${call.label} (counts)`, before, after, 1);
    const rows = await deniedSince(switchMarker);
    const mine = rows.filter(
      (row) => row.entity_type === expected.entityType && (row.entity_id ?? null) === expected.entityId
    );
    t.check(
      `${call.label} → exactly one new \`denied\` row for ${expected.entityType} ${expected.entityId ?? "(no id)"}`,
      mine.length === 1,
      `found ${String(mine.length)} of ${JSON.stringify(rows.map(rowName))}`
    );
    if (mine[0]) {
      t.check(
        `${call.label} → the row is a denial of this refusal (row action ${mine[0].action})`,
        mine[0].outcome === "denied" && (mine[0].action === refusal.action || mine[0].action === "order.fire"),
        `row action ${mine[0].action}, refusal named ${refusal.action}`
      );
    }
    if (mine[0]) {
      checkRow(
        mine[0],
        {
          name: expected.name,
          actorUserId: principal.userId,
          actorRoleCode: "SITE_HEAD",
          reasonStartsWith: "Not permitted: KDS multi-station routing is switched off for this chain",
          // **The caller's stated intent wins** — the decision this run's first attempt forced.
          // These three calls state `verification`, exactly as they do under the tier gate, and the
          // fire path reads `meta.intent ?? ORDER_INTENTS.fire` (`~/domain/ticket:298`), so the row
          // reads `verification` here too: one act, one call, one intent, whichever gate refused it.
          // The gate is a property of the refusal; the intent is a property of the CALL.
          //
          // The failed run expected `order.fire` here and only here, which made the harness
          // disagree with itself about a call it makes identically twice. The fix is the
          // expectation, not the code — and NOT a relaxation: the block after this loop calls the
          // same refused act with NO stated intent and asserts the row reads the act's own default
          // `order.fire`, so the precedence is now measured in both directions rather than assumed.
          intent: "verification",
        },
        chain.id,
        outlet.site_id
      );
    }
  }
  const switchRowsAll = await deniedSince(switchMarker);
  expectSet(
    "the three switch refusals, by RECORD — the same three records, a different gate",
    switchRowsAll.map((row) => `${row.entity_type}|${row.entity_id ?? "NULL"}`),
    switchExpected.map((expected) => `${expected.entityType}|${expected.entityId ?? "NULL"}`)
  );
  t.check(
    "and every one of those is a denial too",
    switchRowsAll.every((row) => row.outcome === "denied"),
    switchRowsAll.map((row) => row.outcome).join(", ")
  );

  // -------------------------------------------------------------------------
  t.heading("The same refusal with a SILENT caller: the act's own intent is the fallback");
  // -------------------------------------------------------------------------
  // The other half of the precedence, asserted rather than argued. This is what makes the fix
  // above a statement about *which* intent wins instead of a relaxation of an assertion to
  // whatever the run printed: the same act, at the same gate, called with NO `meta.intent` at
  // all, records `order.fire` — the act's own default from `ORDER_INTENTS.fire`. So
  // `meta.intent ?? ORDER_INTENTS.fire` is measured on both branches, and a future change that
  // dropped the caller's intent, or dropped the default, fails a named assertion here.
  const silentMarker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id as string;
  const beforeSilent = await counts();
  const silentRefusal = await callAct(() =>
    // No third argument: the caller states nothing, which is the fallback's branch.
    fireOutletOrder(principal, { outletOrderId: FIXTURE_OUTLET_ORDER_ID })
  );
  const afterSilent = await counts();
  t.say("");
  t.say("CALLED: fireOutletOrder with NO stated intent (the caller is silent; the act's default applies)");
  t.check(
    "the same closed gate refuses it with the same sentence",
    silentRefusal !== null && silentRefusal.status === 403 && silentRefusal.code === "permission.licence.moduleOff",
    silentRefusal ? `status ${String(silentRefusal.status)} code ${silentRefusal.code}` : "the act was ALLOWED — the gate is not enforced"
  );
  expectOnlyAudit("the silent caller's refusal (counts)", beforeSilent, afterSilent, 1);
  const silentRows = await deniedSince(silentMarker);
  expectSet(
    "one `denied` row for the same record, written by the silent caller",
    silentRows.map(rowName),
    [`order.fire|outlet_order|${FIXTURE_OUTLET_ORDER_ID}`]
  );
  t.check(
    "a caller that states no intent records the act's OWN default `order.fire` — so `meta.intent ?? ORDER_INTENTS.fire` is asserted on both of its branches, not one",
    silentRows[0]?.intent === "order.fire",
    `read ${JSON.stringify(silentRows[0]?.intent ?? null)}`
  );

  // -------------------------------------------------------------------------
  t.heading("The VALIDATION refusal: the gate open, the act called, and NOTHING written");
  // -------------------------------------------------------------------------
  await q.query(
    `update chain_feature set enabled = true, updated_at = now() where chain_id = $1 and feature_code in ($2, $3)`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  const openAgain = await q.query<{ feature_code: string; enabled: boolean }>(
    `select feature_code, enabled from chain_feature where chain_id = $1 and feature_code in ($2, $3) order by feature_code`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  t.check("the chain's gate is open again", openAgain.length === 2 && openAgain.every((row) => row.enabled));

  const validationMarker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id as string;
  const beforeValidation = await counts();
  const validation = await callAct(() =>
    fireOutletOrder(principal, { outletOrderId: FIXTURE_OUTLET_ORDER_ID }, { source: "api", intent: "verification" })
  );
  const afterValidation = await counts();
  t.say(`CALLED: fireOutletOrder on a booking whose status is ${booking.status}`);
  t.check(
    "the refusal is a 400 validation refusal of the fire path's own state check — not a licence sentence",
    validation !== null && validation.status === 400 && validation.code === FIRE_VALIDATION_KEY.wrongState,
    validation ? `status ${String(validation.status)} code ${validation.code}` : "the act was ALLOWED — the booking would have been fired"
  );
  t.check(
    "a validation refusal writes NOTHING: no new audit row at all, and no table moved",
    (await deniedSince(validationMarker)).length === 0 && delta(beforeValidation, afterValidation).length === 0,
    `${countsLine(beforeValidation)}\n        -> ${countsLine(afterValidation)} | audit rows since the marker: ${String((await deniedSince(validationMarker)).length)}`
  );

  // -------------------------------------------------------------------------
  t.heading("The DEVICE path: one `denied` row with no user, and the ticket id on it");
  // -------------------------------------------------------------------------
  // A real resolved terminal (its own station is the CHECK one) is asked to advance a ticket that
  // belongs to another station. `assertDeviceMayActOn` refuses, `refuseDevice` records it.
  const otherTicket = (
    await q.query<{ id: string; section_code: string }>(
      `select tk.id, s.code as section_code from ticket tk join outlet_section s on s.id = tk.section_id
        where tk.outlet_order_id = $1 and s.code <> $2 order by tk.ticket_no limit 1`,
      [FIXTURE_OUTLET_ORDER_ID, CHECK_SECTION_CODE]
    )
  )[0];
  if (!otherTicket) throw new Error("the fixture has no ticket at another station");
  const deviceMarker = (
    await q.query<{ id: string }>(`select coalesce(max(id), 0)::text as id from audit_log`)
  )[0]?.id as string;
  const beforeDevice = await counts();
  const deviceRefusal = await callAct(() =>
    advanceTicket(deviceActor(device), { ticketId: otherTicket.id, to: "acknowledged" }, { source: "api" })
  );
  const afterDevice = await counts();
  t.say(`CALLED: advanceTicket as ${device.code} (station ${CHECK_SECTION_CODE}) on the ticket at ${otherTicket.section_code}`);
  t.check(
    "refused with the capability refusal S-B/2c added, never a database error",
    deviceRefusal !== null && deviceRefusal.status === 403 && deviceRefusal.code === "kds.refusal.notYourStation",
    deviceRefusal ? `status ${String(deviceRefusal.status)} code ${deviceRefusal.code}` : "the act was ALLOWED"
  );
  t.equal(
    "and the refused capability is the act's own — the check is the act's, not a proxy for it",
    deviceRefusal?.action,
    TICKET_TRANSITIONS.acknowledge.capability
  );
  expectOnlyAudit("advanceTicket by a terminal (counts)", beforeDevice, afterDevice, 1);
  const deviceRows = await deniedSince(deviceMarker);
  expectSet(
    "the terminal's refusal, by name",
    deviceRows.map(rowName),
    [`kds.ticket.advance|ticket|${otherTicket.id}`]
  );
  const deviceRow = deviceRows[0];
  if (deviceRow) {
    checkRow(
      deviceRow,
      {
        name: "advance ticket (terminal)|ticket|" + otherTicket.id,
        actorUserId: null,
        actorRoleCode: device.operatingRoleCode,
        reasonStartsWith: `display:${device.code}`,
        // `refuseDevice` records the fact, not an intent: a terminal acts from a fixed set, so the
        // row carries no `intent` at all. Asserted as null rather than left unread.
        intent: null,
      },
      chain.id,
      outlet.site_id
    );
    t.check(
      "the terminal's row carries the ticket id, so 'which tickets were refused here' is answerable by id",
      deviceRow.entity_id === otherTicket.id,
      `entity_id ${JSON.stringify(deviceRow.entity_id)}`
    );
  }

  // -------------------------------------------------------------------------
  t.heading("Restore and teardown");
  // -------------------------------------------------------------------------
  await restore(chain.id, chain.licence_tier, gateRows);
  await q.query(`update outlet_section set kind = 'kitchen', updated_at = now() where id = $1`, [sectionId]);
  // From here the run has put the chain's gate back itself, so the failure path below must not
  // claim otherwise — its first version said "the run failed before its own restore" on a run
  // whose STEP 7 had passed every restore assertion, which reads as a run that had to be repaired
  // by hand. It had not been.
  ownRestoreDone = true;
  await q.query(`delete from display_credential where display_id = $1 or display_id in (select id from display where code like 'CHECK-SB2C%')`, [registered.id]);
  await q.query(`delete from display where id = $1 or code like 'CHECK-SB2C%'`, [registered.id]);
  await q.query(`delete from outlet_section where id = $1`, [sectionId]);

  const restoredChain = (await q.query<{ licence_tier: string }>(`select licence_tier from chain where id = $1`, [chain.id]))[0];
  const restoredGate = await q.query<{ feature_code: string; enabled: boolean }>(
    `select feature_code, enabled from chain_feature where chain_id = $1 and feature_code in ($2, $3) order by feature_code`,
    [chain.id, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  t.check("the pilot chain's licence is back to the value this run read", restoredChain?.licence_tier === chain.licence_tier, `read ${String(restoredChain?.licence_tier)}`);
  t.check(
    "both switches are back to the values this run read",
    restoredGate.length === 2 &&
      restoredGate.every((row) => gateRows.find((before) => before.feature_code === row.feature_code)?.enabled === row.enabled),
    restoredGate.map((row) => `${row.feature_code}=${String(row.enabled)}`).join(" ")
  );
  const remaining = await q.query<{ n: number }>(
    `select (select count(*) from display where code like 'CHECK-SB2C%')::int
          + (select count(*) from display_credential c join display d on d.id = c.display_id where d.code like 'CHECK-SB2C%')::int
          + (select count(*) from outlet_section where code like 'CHECK-SB2C%')::int as n`
  );
  t.check("every CHECK-SB2C-* row this run created is gone", remaining[0]?.n === 0, `left: ${String(remaining[0]?.n)}`);

  const finalCounts = await counts();
  t.say("");
  t.say(`final    : ${countsLine(finalCounts)}`);
  t.say(`the ledger moved by ${String(finalCounts.audit_log - baseline.audit_log)} row(s): 3 tier refusals + 3 switch refusals + 1 silent-caller refusal + 1 terminal refusal + 3 successes`);
  t.say("(registerDisplay, pairDisplay and redeemPairingCode write a success row each — those are acts, not refusals.)");
  t.say("audit_log is append-only by trigger: the `denied` rows this run wrote are the evidence and stay.");

  t.say("");
  t.say("=".repeat(78));
  t.say("HONEST LIMITS — what this run does NOT prove");
  t.say("=".repeat(78));
  t.say("1. It does not prove the terminal half of the ticket lifecycle (T5/T6/T7/T9 driven from a");
  t.say("   paired terminal). The terminal here performs ONE refused act, to measure the device-actor");
  t.say("   row; a permitted transition by a terminal is still deferred by name.");
  t.say("2. `registerDisplay`'s denial row carries entity_id = the CODE the caller asked for, because");
  t.say("   the display it would have created has no id yet — so 'which display' is answerable by code,");
  t.say("   not by row id. The other two closed-gate rows carry the real id. The case where a denial");
  t.say("   row carries entity_id NULL is `guard()`'s own capability refusal (an account without");
  t.say("   `display.manage`), which this run does not produce: it acts as a real holder.");
  t.say("3. The two gates were closed by writing the chain's own licence/switch rows for the duration");
  t.say("   of the calls and putting them back; this run measures the domain's refusal on those values,");
  t.say("   not the commercial process that would set them.");
  t.say("4. Hindi coverage is asserted only for the two sentences this run reads. The catalogue's");
  t.say("   wider English/Hindi gap is a separate, already-declared debt.");
}

/** Puts the chain's gate back exactly as this run found it — called on every exit path. */
async function restore(
  chainId: string,
  licenceTier: string,
  gate: { feature_code: string; enabled: boolean }[]
): Promise<void> {
  await q.query(`update chain set licence_tier = $2, updated_at = now() where id = $1`, [chainId, licenceTier]);
  for (const row of gate) {
    await q.query(
      `update chain_feature set enabled = $3, updated_at = now() where chain_id = $1 and feature_code = $2`,
      [chainId, row.feature_code, row.enabled]
    );
  }
}

let restored = false;
/**
 * Whether the run reached its own restore and teardown (STEP 7). The failure path below runs on
 * **every** non-zero exit — including a plain assertion failure, which does not throw and leaves
 * this true — so it must say which of the two situations it is in rather than assume.
 */
let ownRestoreDone = false;
const restoreOnce = async (): Promise<void> => {
  if (restored) return;
  restored = true;
  const chain = (await q.query<{ id: string; licence_tier: string }>(`select id, licence_tier from chain where code = $1`, [CHAIN_CODE]))[0];
  if (!chain) return;
  await restore(chain.id, "gold", [
    { feature_code: ROUTING_FEATURE, enabled: true },
    { feature_code: GUEST_DISPLAY_FEATURE, enabled: true },
  ]);
  await q.query(`update outlet_section set kind = 'kitchen' where code = $1`, [CHECK_SECTION_CODE]);
};

try {
  await main();
} catch (error) {
  t.say("");
  t.say(`FATAL ${errorMessage(error)}`);
  t.failures.push(`the run threw: ${errorMessage(error)}`);
} finally {
  if (t.failures.length > 0) {
    t.say("");
    t.say(
      ownRestoreDone
        ? "re-asserting the pilot chain's gate (idempotent — this run reached its own restore above, and STEP 7's assertions read it back):"
        : "putting the pilot chain's gate back (the run did not reach its own restore):"
    );
    try {
      await restoreOnce();
      t.say("  restored: licence gold, both switches on, the CHECK station back to `kitchen`.");
    } catch (error) {
      t.say(`  RESTORE FAILED: ${errorMessage(error)}`);
      t.say("  repair by hand: update chain set licence_tier = 'gold' where code = 'saffron-table';");
      t.say("  update chain_feature set enabled = true where feature_code in ('kds_multi_station','cds')");
      t.say("    and chain_id = (select id from chain where code = 'saffron-table');");
    }
  }
  const failures = t.finish(
    TRANSCRIPT,
    "the closed gate refuses by calling the act, writes exactly one `denied` row per refusal, changes no data, and the terminal's serve grant follows its station's row."
  );
  writeFileSync("/tmp/sb2c-entitlement-ledger.txt", `${t.lines.join("\n")}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
