import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { auditedMutation, guard, primaryRoleCode, recordAudit, writeAudit, type AuditSource } from "~/server/audit";
import { NotFound, PermissionDenied, ValidationError } from "~/server/errors";
import { accessibleChainIds, type Principal } from "~/server/session";
import { assertDeviceMayActOn, refuseDevice, rowScopeWhere } from "~/server/display-device";
import { assertRoutingEntitled } from "~/domain/display-entitlement";
import { resolveLineRoute } from "~/domain/display-routing";
import type { DevicePrincipal, TicketRouteSource } from "~/domain/display";
import {
  FIRE_VALIDATION_KEY,
  ORDER_INTENTS,
  ORDER_TRANSITIONS,
  TICKET_TRANSITION_CODES,
  TICKET_TRANSITIONS,
  TICKET_VALIDATION_KEY,
  ticketReasonCodes,
  type TicketReasonAct,
} from "~/domain/order-rules";

/**
 * The ticket side of the display slice, part 2a: **Fire** (§2.3 T1) — the one act that turns
 * a priced, accepted booking into work at stations.
 *
 * `DESIGN-kds-and-ticket-routing.md` §2.2 (the tables), §1.4 (routing), §2.5 (the prep
 * deadline) and §2.6 case 1 (an 86'd line cannot be fired). Migration `0014_ticket_fire.sql`
 * is the schema half. **T2–T11 are not here**: the ticket lifecycle's transitions, the
 * station display and the offline outbox are S-B/2b and S-C.
 *
 * Six rules shape the act, and each is a decision rather than a preference.
 *
 *   * **One transaction, and the ledger row is in it.** The booking's state, every ticket,
 *     every ticket line, every line's recorded route, the journal row and the audit rows are
 *     written together or not at all (`auditedMutation`). §2.3's first rule — a transition
 *     that writes its audit row in a second transaction is a defect — applies to T1 as much
 *     as to T2.
 *   * **One audit row per ticket**, `entity_type = 'ticket'`, the act named in `intent`
 *     (`order.fire`), after-state = the ticket it created — plus the booking's own row on
 *     `outlet_order`, which is the order-side half of the same act. Four rows for a
 *     three-station fire, all in one transaction, all quoted in the read-back.
 *   * **Routing is resolved once, at fire, and recorded** (§1.4, D4). The resolution is
 *     §1.4's chain and nothing else: `article_route` → `route_default` → the outlet's pass,
 *     flagged unrouted. There is **no third guess** — the article's category name is never
 *     parsed and there is no "beverages probably go to the bar" heuristic, because a dish
 *     silently sent to a station that does not make it is worse than an unrouted line that
 *     somebody can see (§1.4 item 3).
 *   * **An unrouted line is never dropped and never silently re-homed.** It goes to the
 *     outlet's `expedite` section when one exists and is recorded `routing_source =
 *     'unrouted'` (§1.4 item 4, D3 — the value the spec's own prose names for this case);
 *     when the outlet has no pass there is no station to attach it to, and the fire is
 *     refused with a sentence naming the article. Both branches are the lead's ruling of
 *     29 Sept 2026 (`DECISIONS.md:163`): *"an unrouted line falls to a pass if one exists,
 *     and refuses the fire if none does — no invented station."*
 *   * **The deadline is captured, not recomputed** (§2.5, D10). `prep_deadline_at` is
 *     `fired_at` plus the site's `guest.prep_time_sla_minutes`, read from the setting that
 *     already exists (module `operations`, scope site, seeded default 25) — no new key is
 *     invented. Both stamps come from the same `now()`, so the difference is *exactly* the
 *     setting and not the setting plus the time the transaction took.
 *   * **A capability refusal writes one `denied` row and changes nothing; a validation
 *     refusal writes nothing at all.** `guard()` is the first half. Every `ValidationError`
 *     below is raised before the first insert — or inside the transaction, which then rolls
 *     back whole, leaving the ledger's gap exactly as deliberate as it is on the booking
 *     side.
 *
 * **A deliberate divergence, stated where it bites.** `resolveLineRoute` (S-A, merged and
 * verified) reports the pass fallback as `routeSource = 'expedite_fallback'` — the value the
 * routing *screen* shows as "Sent to the pass" when it previews where a line would go. §1.4
 * item 4 and D3 both say the *recorded* source for an unrouted line is `'unrouted'`, and the
 * acceptance criterion for this slice names the same value. So the resolver's own answer is
 * used for the target and the recorded source is §1.4's. This is one line, and it is called
 * out in the PR and the evidence so the lead can rule that a fired line should carry the
 * resolver's value verbatim if they prefer the two code paths to be indistinguishable.
 *
 * **Tenant boundary** (§1.6, D22). The outlet, the site and the chain come from the
 * `outlet_order` row and never from a request parameter; every write carries `chain_id`; and
 * migration 0014's composite foreign keys refuse a ticket whose section, outlet or booking
 * belongs to another outlet or chain even if this code were wrong.
 */

export interface FireMeta {
  source?: AuditSource;
  intent?: string | null;
}

interface FireContext {
  outletOrderId: string;
  orderId: string;
  chainId: string;
  siteId: string;
  outletId: string;
  outletCode: string;
  siteCode: string;
  status: string;
  serviceReference: string;
  timezone: string;
  currency: string;
  /** The SITE's calendar date, so "per service day" is the site's day and not UTC's. */
  serviceDate: string;
}

export interface FireTicketLine {
  orderLineId: string;
  position: number;
  articleId: string;
  articleCode: string;
  quantity: number;
  /** The line's own state on the ticket. `queued` at fire: nobody has touched it yet. */
  state: string;
}

export interface FiredTicket {
  ticketId: string;
  ticketNo: number;
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  sectionKind: string;
  state: string;
  routingSource: TicketRouteSource;
  /** True when any line on this ticket matched no route of its own (§1.4 item 4, D3). */
  hasUnroutedLine: boolean;
  serviceDate: string;
  firedAt: string;
  prepDeadlineAt: string;
  lines: FireTicketLine[];
}

export interface FireResult {
  outletOrderId: string;
  orderId: string;
  serviceReference: string;
  from: string;
  to: string;
  serviceDate: string;
  slaMinutes: number;
  firedAt: string;
  prepDeadlineAt: string;
  tickets: FiredTicket[];
  /** The status board's number (§5.2) and §11.4's configuration worklist, counted at fire. */
  unroutedLineCount: number;
}

function validation(message: string, code: string, params?: Record<string, string>): ValidationError {
  return new ValidationError(message, { code, ...(params ? { params } : {}) });
}

/** The booking's own tenant context, read from the row — never from a request (§1.6 item 1). */
async function fireContext(db: Queryable, outletOrderId: string): Promise<FireContext> {
  const rows = await db.query<{
    id: string;
    order_id: string;
    chain_id: string;
    site_id: string;
    outlet_id: string;
    outlet_code: string;
    site_code: string;
    status: string;
    service_reference: string;
    timezone: string;
    currency: string;
    service_date: string;
  }>(
    `select oo.id, oo.order_id, oo.chain_id, oo.site_id, oo.outlet_id, ol.code as outlet_code,
            s.code as site_code, oo.status, o.service_reference, s.timezone, s.currency,
            to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') as service_date
       from outlet_order oo
       join "order" o on o.id = oo.order_id
       join outlet ol on ol.id = oo.outlet_id
       join site s on s.id = oo.site_id
      where oo.id = $1
      limit 1`,
    [outletOrderId]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Outlet order", outletOrderId);
  return {
    outletOrderId: row.id,
    orderId: row.order_id,
    chainId: row.chain_id,
    siteId: row.site_id,
    outletId: row.outlet_id,
    outletCode: row.outlet_code,
    siteCode: row.site_code,
    status: row.status,
    serviceReference: row.service_reference,
    timezone: row.timezone,
    currency: row.currency.trim(),
    serviceDate: row.service_date,
  };
}

/**
 * The prep-time SLA in force for one site (§2.5): the site's own `chain_setting` row, then
 * the chain-level one, then the definition's platform default — the same resolution order the
 * settings screen describes and the service charge uses.
 *
 * The definition's own bounds are enforced here, because a value outside them is a row
 * nothing in the platform wrote (the settings screen refuses it). A missing definition is a
 * refusal and not a default: `prep_deadline_at` is NOT NULL, and inventing a number the
 * platform has not agreed would put a made-up SLA in the one place a kitchen looks.
 */
export async function resolvePrepSlaMinutes(
  db: Queryable,
  input: { chainId: string; siteId: string }
): Promise<number> {
  // SPEC/PRD MISMATCH, quoted rather than fixed: the PRD says the deadline is "configurable at
  // chain level (default SLA) and overridable per site" (p.8) while the seeded definition is
  // site-scoped. The resolution below reads the site's row *or* the chain's, so the chain-level
  // default the PRD describes works today; what does not exist is a chain-scoped *definition*.
  const rows = await db.query<{
    value: string | null;
    min_value: string | null;
    max_value: string | null;
    default_value: string | null;
  }>(
    `select cs.value::text as value,
            sd.min_value::text as min_value,
            sd.max_value::text as max_value,
            sd.default_value::text as default_value
       from setting_definition sd
       left join lateral (
         select c2.value from chain_setting c2
          where c2.chain_id = $1 and c2.setting_key = sd.key
            and (c2.site_id = $2 or c2.site_id is null)
          order by (c2.site_id is not null) desc
          limit 1
       ) cs on true
      where sd.key = 'guest.prep_time_sla_minutes'
      limit 1`,
    [input.chainId, input.siteId]
  );
  const row = rows[0];
  if (!row) {
    throw validation(
      "The platform has no guest prep-time setting, so a prep deadline cannot be captured for this booking.",
      FIRE_VALIDATION_KEY.slaMissing
    );
  }
  const raw = row.value ?? row.default_value;
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    throw validation(
      `The prep time for this site is set to ${raw ?? "nothing"}, which is not a number of minutes, so no deadline can be captured.`,
      FIRE_VALIDATION_KEY.slaNotANumber,
      { value: raw ?? "" }
    );
  }
  const min = row.min_value === null ? null : Number(row.min_value);
  const max = row.max_value === null ? null : Number(row.max_value);
  if ((min !== null && value < min) || (max !== null && value > max)) {
    throw validation(
      `The prep time for this site is set to ${String(value)} minutes, outside the ${String(min)} to ${String(max)} the platform allows.`,
      FIRE_VALIDATION_KEY.slaOutOfRange,
      { value: String(value), min: String(min), max: String(max) }
    );
  }
  return value;
}

interface FireLineRow {
  id: string;
  position: number;
  article_id: string;
  article_code: string;
  article_name: string | null;
  quantity: number;
}

/** One line's resolved targets, kept beside the line so grouping cannot lose one. */
interface ResolvedLine {
  line: FireLineRow;
  targetSectionIds: string[];
  isPrimaryFirst: boolean;
  /** §1.4 item 4: recorded on the line, and on the ticket that carries it. */
  recordedSource: TicketRouteSource;
  unrouted: boolean;
}

/**
 * Fires an accepted booking: §2.3 T1, and the whole of this slice's write path.
 *
 * `order.fire`, intent `order.fire`, entity `ticket` (one row per ticket) plus the booking's
 * own row. Returns every ticket with its lines, its recorded route and its deadline, which is
 * what the read-back harness and (from S-C) the station display read.
 */
export async function fireOutletOrder(
  principal: Principal,
  input: { outletOrderId: string },
  meta: FireMeta = {}
): Promise<FireResult> {
  const db = poolQueryable();
  const ctx = await fireContext(db, input.outletOrderId);
  const intent = meta.intent ?? ORDER_INTENTS.fire;
  const rule = ORDER_TRANSITIONS.fire;

  await guard({
    principal,
    action: rule.capability,
    entityType: "outlet_order",
    chainId: ctx.chainId,
    siteId: ctx.siteId,
    target: `booking ${ctx.serviceReference}`,
    source: meta.source,
    intent,
  });

  // The routing entitlement, asked **before** the transaction opens. `resolveLineRoute` asks
  // it again per line (a check a caller can forget is not a check), but by then it is inside
  // the transaction, and a `PermissionDenied` raised there rolls back — so the refusal would
  // record nothing at all, which is the gap `~/domain/display-entitlement` names at its own
  // line 314 and leaves to S-B. It is closed here: a licence or module switch that does not
  // cover routing is a **capability** refusal, so it writes exactly one `denied` row and
  // changes no data.
  try {
    await assertRoutingEntitled(db, ctx.chainId);
  } catch (error) {
    if (error instanceof PermissionDenied) {
      await recordAudit({
        principal,
        action: rule.capability,
        entityType: "outlet_order",
        entityId: ctx.outletOrderId,
        chainId: ctx.chainId,
        siteId: ctx.siteId,
        outcome: "denied",
        reason: error.message,
        intent,
        source: meta.source ?? "api",
      });
    }
    throw error;
  }

  // A validation refusal that reads the booking's state before anything is written, so the
  // commonest mistake (firing twice) leaves no trace at all. The UPDATE below carries the
  // same expectation in its WHERE clause, which is the check that actually holds under a race.
  if (!(rule.from as readonly string[]).includes(ctx.status)) {
    throw validation(
      `This booking is ${ctx.status}, and it can only be sent to the kitchen from ${rule.from.join(" or ")}. A booking that has already been fired has its tickets.`,
      FIRE_VALIDATION_KEY.wrongState,
      { status: ctx.status }
    );
  }

  const slaMinutes = await resolvePrepSlaMinutes(db, { chainId: ctx.chainId, siteId: ctx.siteId });
  // The tickets are collected out of the transaction by this closure: `auditedMutation`'s
  // before/after payload is the audit row's own snapshot (JSON-friendly), and the caller needs
  // the typed rows.
  let firedTickets: FiredTicket[] = [];
  /** The lines that matched no route of their own, counted for the status board (§5.2). */
  let unroutedLines = 0;

  try {
    const outcome = await auditedMutation({
      principal,
      action: rule.capability,
      entityType: "outlet_order",
      chainId: ctx.chainId,
      siteId: ctx.siteId,
      source: meta.source,
      intent,
      run: async (tx) => {
        // (1) The booking moves, and it carries the deadline it was fired against. `now()` is
        // the transaction's own start, so the two stamps are the same instant and the
        // difference is exactly the setting (§2.5).
        const moved = await tx.query<{ fired_at: string; prep_deadline_at: string; service_date: string }>(
          `update outlet_order
              set status = $3,
                  fired_at = now(),
                  prep_deadline_at = now() + make_interval(mins => $4::int),
                  updated_at = now()
            where id = $1 and chain_id = $2 and status = any($5::text[])
            returning to_char(fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fired_at,
                      to_char(prep_deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as prep_deadline_at,
                      to_char((fired_at at time zone $6)::date, 'YYYY-MM-DD') as service_date`,
          [ctx.outletOrderId, ctx.chainId, rule.to, slaMinutes, rule.from, ctx.timezone]
        );
        const stamped = moved[0];
        if (!stamped) {
          // Zero rows updated: the booking moved on between the read above and this write
          // (another screen, or a cancel). A validation refusal — nothing written at all.
          throw validation(
            `This booking is no longer ${rule.from.join(" or ")}, so it cannot be sent to the kitchen. Reload it to see where it has got to.`,
            FIRE_VALIDATION_KEY.wrongState,
            { status: ctx.status }
          );
        }

        await tx.query(
          `update "order" set status = $2, updated_at = now() where id = $1 and chain_id = $3`,
          [ctx.orderId, rule.to, ctx.chainId]
        );

        // (2) The lines, their articles, and the two facts §2.6 case 1 needs: an 86'd line
        // cannot be fired, and the refusal must name the dish in words.
        const lines = await tx.query<FireLineRow>(
          `select ol.id, ol.position, ol.article_id, a.code as article_code,
                  (select t.name from article_version_text t
                    where t.article_version_id = ol.article_version_id
                    order by t.locale limit 1) as article_name,
                  ol.quantity
             from order_line ol
             join article a on a.id = ol.article_id
            where ol.outlet_order_id = $1 and ol.chain_id = $2
            order by ol.position`,
          [ctx.outletOrderId, ctx.chainId]
        );
        if (lines.length === 0) {
          throw validation(
            "This booking has no lines, so there is no work to raise at any station.",
            FIRE_VALIDATION_KEY.linesMissing
          );
        }

        const unavailable = await tx.query<{ article_code: string; article_name: string | null }>(
          `select a.code as article_code,
                  (select t.name from article_version_text t
                    where t.article_version_id = a.current_version_id
                    order by t.locale limit 1) as article_name
             from article_availability aa
             join article a on a.id = aa.article_id
            where aa.outlet_id = $1 and aa.availability = 'unavailable'
              and aa.article_id = any($2::uuid[])`,
          [ctx.outletId, lines.map((line) => line.article_id)]
        );
        if (unavailable.length > 0) {
          // §2.6 case 1: 86'd before the ticket exists. The line stays on the booking and is
          // not silently emptied; the fire is refused and nothing is written.
          const names = unavailable.map((row) => row.article_name ?? row.article_code).join(", ");
          throw validation(
            `${names} is not available at this outlet, so this booking cannot be sent to the kitchen as it stands. Take the dish off the booking or bring it back into service.`,
            FIRE_VALIDATION_KEY.articleUnavailable,
            { articles: names }
          );
        }

        // (3) §1.4's resolution, once per line, inside this transaction.
        const resolved: ResolvedLine[] = [];
        const starved: string[] = [];
        for (const line of lines) {
          const resolution = await resolveLineRoute(tx, {
            chainId: ctx.chainId,
            outletId: ctx.outletId,
            articleId: line.article_id,
          });
          if (resolution.targets.length === 0) {
            // Unrouted with no pass to fall back to: there is no station to attach the line
            // to, and inventing one is the failure D3 exists to prevent. The fire is refused
            // and every starved article is named.
            starved.push(line.article_name ?? line.article_code);
            continue;
          }
          const primary = resolution.targets.find((target) => target.isPrimary) ?? resolution.targets[0]!;
          resolved.push({
            line,
            targetSectionIds: resolution.targets.map((target) => target.sectionId),
            isPrimaryFirst: primary === resolution.targets[0],
            // §1.4 item 4 / D3: an unrouted line is flagged `unrouted` even when it lands on
            // the pass. See the module header for why this is not the resolver's own value.
            recordedSource: resolution.unrouted ? "unrouted" : primary.routeSource,
            unrouted: resolution.unrouted,
          });
        }
        if (starved.length > 0) {
          throw validation(
            `${starved.join(", ")} has no station at this outlet and this outlet has no pass to fall back to, so there is nowhere to send it. Route the dish, or add a pass section to the outlet.`,
            FIRE_VALIDATION_KEY.unroutedNoStation,
            { articles: starved.join(", ") }
          );
        }
        if (resolved.length === 0) {
          throw validation(
            "No line of this booking resolves to a station at this outlet, so there is nowhere to send it.",
            FIRE_VALIDATION_KEY.noStations
          );
        }
        unroutedLines = resolved.filter((entry) => entry.unrouted).length;

        // (4) One ticket per resolved station (§2.2, D5): the lines routed there are its lines.
        const bySection = new Map<string, ResolvedLine[]>();
        for (const line of resolved) {
          for (const sectionId of line.targetSectionIds) {
            const group = bySection.get(sectionId) ?? [];
            group.push(line);
            bySection.set(sectionId, group);
          }
        }

        const tickets: FiredTicket[] = [];
        const sectionIds = [...bySection.keys()];
        const sections = await tx.query<{ id: string; code: string; name: string; kind: string }>(
          `select id, code, name, kind from outlet_section
            where outlet_id = $1 and id = any($2::uuid[])`,
          [ctx.outletId, sectionIds]
        );
        const sectionById = new Map(sections.map((section) => [section.id, section]));

        for (const [sectionId, group] of bySection) {
          const section = sectionById.get(sectionId);
          if (!section) throw new Error(`resolved station ${sectionId} is not a section of this outlet`);
          group.sort((a, b) => a.line.position - b.line.position);

          // The number a human says out loud: per station, per service day, from 1.
          const nextNo = await tx.query<{ n: number }>(
            `select (coalesce(max(ticket_no), 0) + 1)::int as n
               from ticket
              where outlet_id = $1 and section_id = $2 and service_date = $3::date`,
            [ctx.outletId, sectionId, ctx.serviceDate]
          );
          const ticketNo = nextNo[0]?.n ?? 1;

          // The ticket's own routing_source is a summary of its lines': an unrouted line takes
          // precedence, so a ticket that carries configuration debt never reads as if it had
          // been routed deliberately. The per-line truth stays on the line (D4).
          const hasUnroutedLine = group.some((entry) => entry.unrouted);
          const ticketSource: TicketRouteSource = hasUnroutedLine
            ? "unrouted"
            : (group[0]?.recordedSource ?? "unrouted");

          const ticketRows = await tx.query<{ id: string }>(
            `insert into ticket
               (chain_id, site_id, outlet_id, outlet_order_id, section_id, service_date, ticket_no,
                state, routing_source, fired_at, prep_deadline_at)
             values ($1, $2, $3, $4, $5, $6::date, $7, 'queued', $8, $9::timestamptz, $10::timestamptz)
             returning id`,
            [
              ctx.chainId,
              ctx.siteId,
              ctx.outletId,
              ctx.outletOrderId,
              sectionId,
              stamped.service_date,
              ticketNo,
              ticketSource,
              stamped.fired_at,
              stamped.prep_deadline_at,
            ]
          );
          const ticketId = ticketRows[0]?.id;
          if (!ticketId) throw new Error("ticket insert returned no row");

          const ticketLines: FireTicketLine[] = [];
          for (const entry of group) {
            // A line appears once on a ticket, and its quantity is never copied here: the row
            // points at the order line that holds it (§2.2).
            await tx.query(
              `insert into ticket_line (chain_id, ticket_id, order_line_id, position, state)
               values ($1, $2, $3, $4, 'queued')`,
              [ctx.chainId, ticketId, entry.line.id, entry.line.position]
            );
            // The route is recorded on the line, once, and never recomputed (D4). `line_state`
            // moves with it: the line is at a station now and the station's own states begin.
            await tx.query(
              `update order_line
                  set routing_section_id = $3, routing_source = $4, line_state = 'fired', updated_at = now()
                where id = $1 and chain_id = $2`,
              [entry.line.id, ctx.chainId, sectionId, entry.recordedSource]
            );
            ticketLines.push({
              orderLineId: entry.line.id,
              position: entry.line.position,
              articleId: entry.line.article_id,
              articleCode: entry.line.article_code,
              quantity: entry.line.quantity,
              state: "queued",
            });
          }

          const ticket: FiredTicket = {
            ticketId,
            ticketNo,
            sectionId,
            sectionCode: section.code,
            sectionName: section.name,
            sectionKind: section.kind,
            state: "queued",
            routingSource: ticketSource,
            hasUnroutedLine,
            serviceDate: stamped.service_date,
            firedAt: stamped.fired_at,
            prepDeadlineAt: stamped.prep_deadline_at,
            lines: ticketLines,
          };

          // §2.3 T1's own audit row: entity `ticket`, the act named in `intent`, after-state =
          // the ticket. Written in this transaction with everything it describes.
          const auditId = await writeAudit(tx, {
            principal,
            action: rule.capability,
            entityType: "ticket",
            entityId: ticketId,
            chainId: ctx.chainId,
            siteId: ctx.siteId,
            outcome: "success",
            intent,
            source: meta.source ?? "api",
            reason: `ticket ${String(ticketNo)} for booking ${ctx.serviceReference} at ${section.name}`,
            beforeState: null,
            afterState: {
              ticketNo,
              sectionCode: section.code,
              sectionKind: section.kind,
              state: "queued",
              routingSource: ticketSource,
              serviceDate: stamped.service_date,
              firedAt: stamped.fired_at,
              prepDeadlineAt: stamped.prep_deadline_at,
              unrouted: hasUnroutedLine,
              lines: ticketLines.map((line) => ({
                articleCode: line.articleCode,
                quantity: line.quantity,
                position: line.position,
              })),
            },
          });

          // The journal row (§2.2, §1.3(f)): the ticket's own story, indexed by the audit row
          // written beside it. `from_state` is NULL because T1 is the transition that creates
          // the ticket — there is no state before it.
          await tx.query(
            `insert into ticket_transition
               (chain_id, ticket_id, transition_code, from_state, to_state, actor_user_id,
                actor_role_code, actor_scope, audit_id)
             values ($1, $2, $3, null, 'queued', $4, $5, $6, $7)`,
            [
              ctx.chainId,
              ticketId,
              TICKET_TRANSITION_CODES.fire,
              principal.userId,
              primaryRoleCode(principal, rule.capability),
              principal.scope,
              auditId || null,
            ]
          );

          tickets.push(ticket);
        }

        firedTickets = tickets;

        return {
          entityId: ctx.outletOrderId,
          before: { status: ctx.status },
          after: {
            status: rule.to,
            serviceReference: ctx.serviceReference,
            serviceDate: stamped.service_date,
            firedAt: stamped.fired_at,
            prepDeadlineAt: stamped.prep_deadline_at,
            slaMinutes,
            tickets: tickets.map((ticket) => ({
              ticketNo: ticket.ticketNo,
              sectionCode: ticket.sectionCode,
              routingSource: ticket.routingSource,
              lines: ticket.lines.length,
            })),
          },
        };
      },
    });

    const after = outcome.after as {
      serviceDate: string;
      firedAt: string;
      prepDeadlineAt: string;
      slaMinutes: number;
    };
    return {
      outletOrderId: ctx.outletOrderId,
      orderId: ctx.orderId,
      serviceReference: ctx.serviceReference,
      from: ctx.status,
      to: rule.to,
      serviceDate: after.serviceDate,
      slaMinutes: after.slaMinutes,
      firedAt: after.firedAt,
      prepDeadlineAt: after.prepDeadlineAt,
      tickets: firedTickets,
      unroutedLineCount: unroutedLines,
    };
  } catch (error) {
    // The unique key behind the per-station number is the backstop, not the message: two
    // fires racing for the same station's next number must reach the caller as a refusal, and
    // the transaction that lost the race wrote nothing (this is a validation refusal).
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw validation(
        "Another booking took this station's next ticket number at the same instant, so nothing was written. Send this booking to the kitchen again.",
        FIRE_VALIDATION_KEY.ticketNumberTaken
      );
    }
    throw error;
  }
}

// ===========================================================================
// S-B/2b — the lifecycle: T2–T7 and T9 (§2.3)
// ===========================================================================
//
// `DESIGN-kds-and-ticket-routing.md` §2.3's table, minus T1 (the fire path above), T8
// (hold for unavailability — §2.6's decision, its own slice) and T10 (re-fire/print — S-E,
// and not a state change at all). T11 (close the booking) is `closeOutletOrder` in
// `~/domain/order`; this module reads the booking to *reach* `served`.
//
// Seven rules shape every act below, and each is a decision rather than a preference.
//
//   * **One transaction, one audit row, one journal row.** The state change, the ticket's
//     own line states, the `ticket_transition` row and the `audit_log` row are written
//     together or not at all (`auditedMutation`, with `linkAudit` carrying the ledger row's
//     id into the journal). §2.3: "a ticket transition that writes its audit row in a second
//     transaction is a defect, not a variation."
//   * **Every transition states the state it expects.** The UPDATE's WHERE clause carries
//     `state = $expected` alongside the id and the tenant, so zero rows updated is a
//     **validation** refusal — nothing written at all, not even a ledger row — and the copy
//     says where the ticket has got to. That is also what makes offline replay safe (§3.4):
//     a replayed transition that has already been applied changes nothing.
//   * **The refusals are split the binding way.** A *capability* refusal (no such
//     capability, another station's ticket, a terminal with no station, a licence that does
//     not cover routing) writes exactly one `denied` row and changes no data. A *validation*
//     refusal (the ticket moved on, it is voided or held, a recall from `served`, a missing
//     or unoffered reason code, a re-route to a station that already has one) writes
//     **nothing at all** — the ledger's gap is deliberate, and the screen's sentence is its
//     only record.
//   * **The tenant boundary is code, because no RLS policy backs it** (§1.6, D22). A ticket
//     is resolved **within the caller's reachable chains**, so an id from another chain is
//     never even read; and when a ticket exists but is out of reach the refusal is a
//     capability refusal whose sentence and ledger reason name no other chain (§6.4, D16 —
//     confirming that another tenant's record exists is a leak even with no data shown).
//   * **A terminal may act only on its own station's tickets** (§2.4 item 3). The device
//     path goes through `assertDeviceMayActOn` (S-A, merged and verified) and its UPDATE
//     carries S-A's `rowScopeWhere`, so a station display cannot widen to another station
//     even if every other check were skipped. A **person** holds a role at a site, not a
//     station, so no section is bound to them — the site and chain scopes are the boundary,
//     and the screen is what narrows a station for a human.
//   * **The recorded route is not recomputed.** A re-route (T9) moves `section_id` and
//     leaves `routing_source` alone: that column says *why* the line was routed where it was
//     at fire (D4), and the act that moved it afterwards is a journal row with a reason and
//     a ledger row with before/after station. The table has no station columns of its own
//     (0014's design) — a known limit, recorded here rather than papered over.
//   * **The ticket's line states move with it.** `ticket_line.state` is written in the same
//     statement's transaction, so no row in the database claims a line is queued under a
//     ticket that is being prepared. `order_line.line_state` is deliberately **not** moved
//     here: a line can appear on several stations' tickets (the combo case §1.4 item 5), its
//     roll-up across them is not this slice's rule — the same reasoning `~/domain/order`
//     gives for the parent order's roll-up — and the ticket is the record of record.

/**
 * Who is moving the ticket: a person, or a fixed terminal with nobody logged in (§2.4 item 2).
 *
 * The two are not interchangeable and the code never pretends they are: a person is
 * authorised by roles, grants and scope through `guard()`, and a terminal by the fixed
 * capability set its *kind* carries (§D26). A device's audit rows have `actor_user_id` null,
 * the station's operating role code and `display:<code>` in `reason`, so the trail names the
 * terminal — and **never the person who tapped** (O2: PIN attribution is +1–2 sessions and
 * is not built).
 */
export type TicketActor =
  | { readonly kind: "person"; readonly principal: Principal }
  | { readonly kind: "device"; readonly device: DevicePrincipal };

export function personActor(principal: Principal): TicketActor {
  return { kind: "person", principal };
}

export function deviceActor(device: DevicePrincipal): TicketActor {
  return { kind: "device", device };
}

export interface TicketTransitionMeta {
  source?: AuditSource;
  intent?: string | null;
}

/** Every act this module performs, as it is addressed by the exported functions. */
export type TicketLifecycleAct =
  | "acknowledge"
  | "start"
  | "ready"
  | "recall"
  | "serve"
  | "void"
  | "reroute";

export interface TicketLifecycleResult {
  ticketId: string;
  ticketNo: number;
  /** §2.3's row label ('T2' … 'T9') — the code in the journal, worded on a screen. */
  transitionCode: string;
  /** The `ticket_transition.id` this act wrote, so a read-back can follow it to the ledger. */
  transitionId: string | null;
  from: string;
  to: string;
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  readyAt: string | null;
  servedAt: string | null;
  voidedAt: string | null;
  voidReasonCode: string | null;
  reasonCode: string | null;
  /** How many `ticket_line` rows moved with the ticket (0 for a re-route, which moves no state). */
  linesMoved: number;
  outletOrderId: string;
  outletOrderStatus: string;
  /** True when this act was the one that finished the booking's work (T6's last ticket). */
  outletOrderMovedToServed: boolean;
}

interface TicketLifecycleRow {
  id: string;
  chain_id: string;
  site_id: string;
  outlet_id: string;
  outlet_order_id: string;
  service_reference: string;
  outlet_order_status: string;
  section_id: string;
  section_code: string;
  section_name: string;
  ticket_no: number;
  state: string;
  prep_deadline_at: string;
  ready_at: string | null;
  served_at: string | null;
  voided_at: string | null;
  void_reason_code: string | null;
}

/** A refusal by a terminal: one `denied` row naming the device, and no data change. */
async function refuseDeviceAction(
  device: DevicePrincipal,
  args: { action: string; ticketId: string; chainId: string; siteId: string | null; reason: string }
): Promise<void> {
  await refuseDevice(device, {
    action: args.action,
    entityType: "ticket",
    entityId: args.ticketId,
    reason: args.reason,
    chainId: args.chainId,
    siteId: args.siteId,
  });
}

/**
 * Resolves the ticket a caller wants to move, **within the caller's reach**, or refuses
 * without revealing that a record outside it exists.
 *
 * A person: the ticket's chain must be one `accessibleChainIds` names (`null` = a
 * platform-wide App identity, which reaches every chain). A terminal: the ticket's chain
 * must be the device's own. When nothing comes back, one more probe asks whether the row
 * exists at all — and a row that exists but is out of reach is answered as a **capability**
 * refusal (§2.7: "a cross-chain id → zero rows updated, then a capability refusal; the copy
 * may not say the ticket exists"), with the same worded sentence a wrong station gets. A row
 * that does not exist is a `NotFound`, and its message names only the id the caller supplied.
 */
async function resolveTicketForActor(
  actor: TicketActor,
  ticketId: string,
  action: string,
  intent: string | null,
  source: AuditSource | undefined
): Promise<TicketLifecycleRow> {
  const db = poolQueryable();
  const where =
    actor.kind === "person"
      ? "tk.id = $1 and ($2::uuid[] is null or tk.chain_id = any($2::uuid[]))"
      : "tk.id = $1 and tk.chain_id = $2";
  const params =
    actor.kind === "person"
      ? [ticketId, accessibleChainIds(actor.principal)]
      : [ticketId, actor.device.chainId];

  const rows = await db.query<TicketLifecycleRow>(
    `select tk.id, tk.chain_id, tk.site_id, tk.outlet_id, tk.outlet_order_id,
            o.service_reference, oo.status as outlet_order_status,
            tk.section_id, s.code as section_code, s.name as section_name,
            tk.ticket_no, tk.state,
            to_char(tk.prep_deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as prep_deadline_at,
            to_char(tk.ready_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ready_at,
            to_char(tk.served_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as served_at,
            to_char(tk.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as voided_at,
            tk.void_reason_code
       from ticket tk
       join outlet_section s on s.id = tk.section_id
       join outlet_order oo on oo.id = tk.outlet_order_id
       join "order" o on o.id = oo.order_id
      where ${where}
      limit 1`,
    params
  );
  const row = rows[0];
  if (row) return row;

  const exists = await db.query<{ chain_id: string }>(
    `select chain_id from ticket where id = $1 limit 1`,
    [ticketId]
  );
  if (exists.length === 0) throw new NotFound("Ticket", ticketId);

  // It exists, and it is not ours. A capability refusal that names no other chain and no
  // other station — the sentence IS part of the boundary here (§6.4, D16).
  const reason =
    actor.kind === "person"
      ? `${action} targets a ticket outside this caller's chains`
      : `${action} targets a ticket outside this display's chain`;
  if (actor.kind === "person") {
    await recordAudit({
      principal: actor.principal,
      action,
      entityType: "ticket",
      entityId: ticketId,
      chainId: actor.principal.chainId,
      siteId: actor.principal.siteId,
      outcome: "denied",
      reason,
      intent,
      source: source ?? "api",
    });
    throw new PermissionDenied(action, reason, { code: TICKET_VALIDATION_KEY.crossTenant });
  }
  await refuseDeviceAction(actor.device, {
    action,
    ticketId,
    chainId: actor.device.chainId,
    siteId: actor.device.siteId,
    reason,
  });
  throw new PermissionDenied(action, reason, {
    code: TICKET_VALIDATION_KEY.crossTenant,
    deviceCode: actor.device.code,
  });
}

/**
 * The capability half, for both kinds of actor. A person goes through `guard()`, which
 * writes the `denied` row itself; a terminal through S-A's `assertDeviceMayActOn`, whose
 * refusal is recorded here because a device has no roles to resolve against.
 */
async function assertMayMoveTicket(
  actor: TicketActor,
  args: { action: string; row: TicketLifecycleRow; intent: string | null; source?: AuditSource }
): Promise<void> {
  const { action, row, intent, source } = args;
  if (actor.kind === "person") {
    await guard({
      principal: actor.principal,
      action,
      entityType: "ticket",
      chainId: row.chain_id,
      siteId: row.site_id,
      target: `ticket ${String(row.ticket_no)} at ${row.section_name}`,
      source,
      intent,
    });
    return;
  }
  try {
    assertDeviceMayActOn(actor.device, action, {
      chainId: row.chain_id,
      outletId: row.outlet_id,
      siteId: row.site_id,
      sectionId: row.section_id,
    });
  } catch (error) {
    if (error instanceof PermissionDenied) {
      await refuseDeviceAction(actor.device, {
        action,
        ticketId: row.id,
        chainId: row.chain_id,
        siteId: row.site_id,
        reason: error.details?.reason ? String(error.details.reason) : error.message,
      });
    }
    throw error;
  }
}

/** The ledger's word for the act: the transition code, the two states, and where. */
function transitionReason(
  rule: { code: string; to: string | null },
  row: TicketLifecycleRow,
  reasonCode: string | null
): string {
  const to = rule.to ?? row.state;
  const base = `${rule.code} ${row.state} -> ${to} on ticket ${String(row.ticket_no)} at ${row.section_code} (booking ${row.service_reference})`;
  return reasonCode ? `${base} — ${reasonCode}` : base;
}

/**
 * The state-specific validation refusal, in words. `params.state` is a *state code*: the
 * screen words it through `ticketStateLabelKey` (`~/domain/order-rules`), because the domain
 * has no locale and must not invent one.
 */
function refusalFor(row: TicketLifecycleRow, act: TicketLifecycleAct): ValidationError {
  const [code, message] = ((): [string, string] => {
    if (row.state === "voided") {
      return [
        TICKET_VALIDATION_KEY.voided,
        "This ticket was voided, so it cannot be moved. Fire a new ticket for the dish instead.",
      ];
    }
    if (row.state === "held_unavailable") {
      return [
        TICKET_VALIDATION_KEY.held,
        "This ticket is held because an article became unavailable. Decide on its lines first — nothing has changed.",
      ];
    }
    if (row.state === "served" && act === "recall") {
      return [
        TICKET_VALIDATION_KEY.recallFromServed,
        "This ticket has already been served, so it cannot be recalled. Void it and fire a new one instead.",
      ];
    }
    if (row.state === "served" && act === "void") {
      return [
        TICKET_VALIDATION_KEY.voidServed,
        "This ticket has already been served, so it cannot be voided. If the dish came back, fire a new ticket for it.",
      ];
    }
    return [
      TICKET_VALIDATION_KEY.movedOn,
      `This ticket has already moved on — it is now ${row.state}. Reload to see where it is.`,
    ];
  })();
  return validation(message, code, { state: row.state });
}

/** The reason code a reasoned act was given, or a validation refusal naming the gap. */
function requireReasonCode(act: TicketReasonAct, reasonCode: string | undefined): string {
  const code = (reasonCode ?? "").trim();
  if (!code) {
    throw validation(
      "This needs a reason. Choose why it is being done, then continue.",
      TICKET_VALIDATION_KEY.reasonRequired
    );
  }
  if (!ticketReasonCodes(act).includes(code)) {
    throw validation(
      `${code} is not one of the reasons this action offers. Choose a reason from the list.`,
      TICKET_VALIDATION_KEY.reasonUnknown,
      { reason: code }
    );
  }
  return code;
}

/**
 * One transition, whichever it is: §2.3's rules applied once, so seven acts cannot drift
 * apart. `advanceTicket` carries the three `kds.ticket.advance` acts (T2/T3/T4) and the other
 * exported functions are one line each — a caller reads a verb, the rules stay in one place.
 */
async function applyTicketTransition(
  actor: TicketActor,
  act: TicketLifecycleAct,
  input: { ticketId: string; sectionId?: string; reasonCode?: string },
  meta: TicketTransitionMeta
): Promise<TicketLifecycleResult> {
  const rule = TICKET_TRANSITIONS[act];
  const db = poolQueryable();
  const intent = meta.intent ?? rule.intent;
  const row = await resolveTicketForActor(actor, input.ticketId, rule.capability, intent, meta.source);

  // Capability first, exactly as the fire path does: a caller who may not make the act is
  // told that, and not something about the ticket's state that they have no business seeing.
  await assertMayMoveTicket(actor, { action: rule.capability, row, intent, source: meta.source });

  // The entitlement, asked before the transaction opens, so a licence or module switch that
  // does not cover routing is a **capability** refusal with exactly one `denied` row rather
  // than a rolled-back transaction that records nothing. Same two sentences as the fire path.
  try {
    await assertRoutingEntitled(db, row.chain_id);
  } catch (error) {
    if (error instanceof PermissionDenied) {
      const reason = error.message;
      if (actor.kind === "person") {
        await recordAudit({
          principal: actor.principal,
          action: rule.capability,
          entityType: "ticket",
          entityId: row.id,
          chainId: row.chain_id,
          siteId: row.site_id,
          outcome: "denied",
          reason,
          intent,
          source: meta.source ?? "api",
        });
      } else {
        await refuseDeviceAction(actor.device, {
          action: rule.capability,
          ticketId: row.id,
          chainId: row.chain_id,
          siteId: row.site_id,
          reason,
        });
      }
    }
    throw error;
  }

  // ---- the validation refusals, none of which writes anything at all ----
  if (!(rule.from as readonly string[]).includes(row.state)) {
    throw refusalFor(row, act);
  }
  const reasonCode = rule.needsReason ? requireReasonCode(act as TicketReasonAct, input.reasonCode) : null;
  if (act === "reroute") {
    const target = (input.sectionId ?? "").trim();
    if (!target) {
      throw validation(
        "A re-route needs a station. Choose the station that will produce this work.",
        TICKET_VALIDATION_KEY.rerouteTargetRequired
      );
    }
    if (target === row.section_id) {
      throw validation(
        `This ticket is already at ${row.section_name}. Choose a different station, or leave it where it is.`,
        TICKET_VALIDATION_KEY.rerouteSameStation,
        { station: row.section_name }
      );
    }
  }

  const to = rule.to;
  const setParts: string[] = [];
  const setParams: unknown[] = [];
  if (act === "reroute") {
    setParts.push("section_id = $1");
    setParams.push(input.sectionId);
  } else {
    setParts.push("state = $1");
    setParams.push(to);
    if (act === "ready") setParts.push("ready_at = now()");
    if (act === "recall") setParts.push("ready_at = null");
    if (act === "serve") setParts.push("served_at = now()");
    if (act === "void") {
      setParts.push("voided_at = now()", `void_reason_code = ${String(setParams.length + 1)}`);
      setParams.push(reasonCode);
    }
  }
  setParts.push("updated_at = now()");

  // The tenant predicate, plus the state the caller expects. A person is bounded by the
  // chain and the outlet of the row they were resolved against; a terminal carries S-A's
  // `rowScopeWhere`, which adds the station when the device is attached to one.
  const scope =
    actor.kind === "device"
      ? rowScopeWhere(actor.device, {
          alias: "ticket",
          id: row.id,
          expectedState: row.state,
          parameterOffset: setParams.length,
        })
      : {
          // The `$` matters: without it these four interpolations were **integer literals**
          // (`ticket.id = 2 and ticket.chain_id = 3 ...`), and Postgres refuses the first one
          // with `operator does not exist: uuid = integer` (SQLSTATE 42883). Every transition a
          // *person* drove — T5 recall, T6 serve, T7 void, T9 re-route — threw before writing
          // anything, while the terminal path (S-A's `rowScopeWhere`) worked. Found by the
          // S-B/2b read-back: evidence, `sb2b-ticket-lifecycle-readback.txt`.
          sql:
            `ticket.id = $${String(setParams.length + 1)} and ticket.chain_id = $${String(setParams.length + 2)}` +
            ` and ticket.outlet_id = $${String(setParams.length + 3)} and ticket.state = $${String(setParams.length + 4)}`,
          params: [row.id, row.chain_id, row.outlet_id, row.state] as string[],
        };

  let transitionId: string | null = null;
  let moved: {
    ticket_no: number;
    state: string;
    section_id: string;
    section_code: string;
    ready_at: string | null;
    served_at: string | null;
    voided_at: string | null;
    void_reason_code: string | null;
  }[] = [];
  let linesMoved = 0;
  let outletOrderMoved = false;

  try {
    const outcome = await auditedMutation({
      principal: actor.kind === "person" ? actor.principal : null,
      device:
        actor.kind === "device"
          ? { roleCode: actor.device.operatingRoleCode, displayCode: actor.device.code }
          : null,
      action: rule.capability,
      entityType: "ticket",
      chainId: row.chain_id,
      siteId: row.site_id,
      source: meta.source ?? (actor.kind === "device" ? "screen" : "api"),
      intent,
      run: async (tx) => {
        // §1.4 item 5 / T9: a station of the same outlet that has no ticket for this booking
        // yet. Both checks are validation refusals inside the transaction, so neither leaves
        // a row behind.
        if (act === "reroute") {
          const station = await tx.query<{ id: string; code: string; name: string }>(
            `select id, code, name from outlet_section where id = $1 and outlet_id = $2 limit 1`,
            [input.sectionId, row.outlet_id]
          );
          if (!station[0]) {
            throw validation(
              "That station belongs to a different outlet. Choose one of this outlet's stations.",
              "route.validation.sectionNotInOutlet"
            );
          }
          const taken = await tx.query<{ ticket_no: number }>(
            `select ticket_no from ticket
              where outlet_order_id = $1 and section_id = $2 and chain_id = $3
              limit 1`,
            [row.outlet_order_id, input.sectionId, row.chain_id]
          );
          if (taken[0]) {
            throw validation(
              `This booking already has ticket ${String(taken[0].ticket_no)} at ${station[0].name}, and one booking has one ticket per station. Void that one first, or choose another station.`,
              TICKET_VALIDATION_KEY.rerouteStationTaken,
              { ticket: String(taken[0].ticket_no), station: station[0].name }
            );
          }
        }

        const updated = await tx.query<{
          ticket_no: number;
          state: string;
          section_id: string;
          section_code: string;
          ready_at: string | null;
          served_at: string | null;
          voided_at: string | null;
          void_reason_code: string | null;
        }>(
          `update ticket
              set ${setParts.join(", ")}
            where ${scope.sql}
            returning ticket.ticket_no, ticket.state, ticket.section_id,
                      (select s.code from outlet_section s where s.id = ticket.section_id) as section_code,
                      to_char(ticket.ready_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ready_at,
                      to_char(ticket.served_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as served_at,
                      to_char(ticket.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as voided_at,
                      ticket.void_reason_code`,
          [...setParams, ...scope.params]
        );
        const after = updated[0];
        if (!after) {
          // Zero rows updated: the ticket moved on between the read above and this write.
          // A validation refusal — this transaction rolls back whole, so nothing is written.
          throw refusalFor(row, act);
        }
        moved = updated;

        if (to !== null) {
          const lines = await tx.query<{ id: string }>(
            `update ticket_line
                set state = $3, updated_at = now()
              where ticket_id = $1 and chain_id = $2
              returning id`,
            [row.id, row.chain_id, to]
          );
          linesMoved = lines.length;
        }

        // §2.3 T6 and §2.1's outlet order: the booking is `served` once its work is
        // finished. "Finished" is stated rather than assumed — every ticket terminal
        // (`served` or `voided`) and at least one actually served. A booking whose only
        // ticket was voided is not a served booking, and one voided ticket does not hold a
        // booking open forever.
        let servedFrom: string | null = null;
        if (act === "serve") {
          const counts = await tx.query<{ open: number; served: number }>(
            `select count(*) filter (where state not in ('served','voided'))::int as open,
                    count(*) filter (where state = 'served')::int as served
               from ticket where outlet_order_id = $1 and chain_id = $2`,
            [row.outlet_order_id, row.chain_id]
          );
          const tally = counts[0];
          if (tally && tally.open === 0 && tally.served > 0) {
            const booking = await tx.query<{ status: string }>(
              `update outlet_order
                  set status = 'served', served_at = coalesce(served_at, now()), updated_at = now()
                where id = $1 and chain_id = $2 and status <> 'served'
                returning status`,
              [row.outlet_order_id, row.chain_id]
            );
            if (booking[0]) {
              outletOrderMoved = true;
              servedFrom = "the booking's own work is finished";
              // The parent order mirrors its single outlet order (§2.1), the same roll-up
              // `~/domain/order` applies for accept, cancel and close.
              await tx.query(
                `update "order" set status = 'served', updated_at = now()
                  where id = (select order_id from outlet_order where id = $1) and chain_id = $2`,
                [row.outlet_order_id, row.chain_id]
              );
            }
          }
        }

        return {
          entityId: row.id,
          reason: transitionReason(rule, row, reasonCode),
          before: {
            state: row.state,
            sectionCode: row.section_code,
            readyAt: row.ready_at,
            servedAt: row.served_at,
            voidReasonCode: row.void_reason_code,
          },
          after: {
            state: after.state,
            sectionCode: after.section_code,
            readyAt: after.ready_at,
            servedAt: after.served_at,
            voidedAt: after.voided_at,
            reasonCode,
            linesMoved,
            ...(outletOrderMoved
              ? { outletOrder: { status: "served", because: servedFrom } }
              : {}),
          },
        };
      },
      // §2.2's journal row, written in this transaction with the ledger row's own id — the
      // one thing `linkAudit` exists for (see `~/server/audit`). `to_state` is NOT NULL in
      // 0014, so a re-route records the state it stayed in rather than a null.
      linkAudit: async (tx, auditId) => {
        const rows = await tx.query<{ id: string }>(
          `insert into ticket_transition
             (chain_id, ticket_id, transition_code, from_state, to_state, actor_user_id,
              actor_role_code, actor_scope, display_code, reason_code, audit_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning id`,
          [
            row.chain_id,
            row.id,
            rule.code,
            row.state,
            to ?? row.state,
            actor.kind === "person" ? actor.principal.userId : null,
            actor.kind === "person"
              ? primaryRoleCode(actor.principal, rule.capability)
              : actor.device.operatingRoleCode,
            actor.kind === "person" ? actor.principal.scope : "site",
            actor.kind === "device" ? actor.device.code : null,
            reasonCode,
            auditId,
          ]
        );
        transitionId = rows[0]?.id ?? null;
      },
    });
    void outcome;
  } catch (error) {
    // The one-ticket-per-station key behind T9's check is the backstop, not the message: if
    // it fires, the operator still gets the worded refusal rather than a 500, and the
    // transaction that failed wrote nothing.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw validation(
        "That station already has a ticket for this booking, and one booking has one ticket per station. Reload to see the tickets, then void that one or choose another station.",
        TICKET_VALIDATION_KEY.rerouteStationBusy
      );
    }
    throw error;
  }

  const after = moved[0];
  if (!after) throw new Error("ticket transition returned no row");
  const booking = await db.query<{ status: string }>(
    `select status from outlet_order where id = $1 and chain_id = $2`,
    [row.outlet_order_id, row.chain_id]
  );
  return {
    ticketId: row.id,
    ticketNo: after.ticket_no,
    transitionCode: rule.code,
    transitionId,
    from: row.state,
    to: after.state,
    sectionId: after.section_id,
    sectionCode: after.section_code,
    sectionName: row.section_name,
    readyAt: after.ready_at,
    servedAt: after.served_at,
    voidedAt: after.voided_at,
    voidReasonCode: after.void_reason_code,
    reasonCode,
    linesMoved,
    outletOrderId: row.outlet_order_id,
    outletOrderStatus: booking[0]?.status ?? row.outlet_order_status,
    outletOrderMovedToServed: outletOrderMoved,
  };
}

/**
 * §2.3 T2/T3/T4 — the three acts under `kds.ticket.advance`: acknowledge, start, ready.
 *
 * One capability, three states, because they are the kitchen's own three taps and §2.4
 * grants them to one set of holders (Site Culinary Team, Site Operations Team, and a station
 * display). `to` is spelled out rather than inferred so a caller cannot ask for a state the
 * capability does not cover: nothing here reaches `served`, `voided` or `held_unavailable`.
 */
export async function advanceTicket(
  actor: TicketActor,
  input: { ticketId: string; to: "acknowledged" | "in_prep" | "ready" },
  meta: TicketTransitionMeta = {}
): Promise<TicketLifecycleResult> {
  const act: TicketLifecycleAct =
    input.to === "acknowledged" ? "acknowledge" : input.to === "in_prep" ? "start" : "ready";
  return applyTicketTransition(actor, act, { ticketId: input.ticketId }, meta);
}

/** §2.3 T5 — recall a ticket marked ready in error. `ready → in_prep`, reason required. */
export async function recallTicket(
  actor: TicketActor,
  input: { ticketId: string; reasonCode: string },
  meta: TicketTransitionMeta = {}
): Promise<TicketLifecycleResult> {
  return applyTicketTransition(actor, "recall", input, meta);
}

/** §2.3 T6 — serve a ready ticket: `ready → served`, `served_at` stamped. */
export async function serveTicket(
  actor: TicketActor,
  input: { ticketId: string },
  meta: TicketTransitionMeta = {}
): Promise<TicketLifecycleResult> {
  return applyTicketTransition(actor, "serve", input, meta);
}

/**
 * §2.3 T7 — void a non-terminal ticket, with a reason code.
 *
 * A **production** act, not a money act (D9): the PRD routes the void of a *sale* to Revenue
 * Assurance, and a dish dropped on the floor is not a financial event. When the money layer
 * exists, voiding a charged line re-enters through that path separately.
 */
export async function voidTicket(
  actor: TicketActor,
  input: { ticketId: string; reasonCode: string },
  meta: TicketTransitionMeta = {}
): Promise<TicketLifecycleResult> {
  return applyTicketTransition(actor, "void", input, meta);
}

/**
 * §2.3 T9 — re-route a ticket to another station of the same outlet. The state does not
 * change; the station does, with a reason, and **only before `ready`**: once a ticket is
 * ready the food exists where it was made.
 */
export async function rerouteTicket(
  actor: TicketActor,
  input: { ticketId: string; sectionId: string; reasonCode: string },
  meta: TicketTransitionMeta = {}
): Promise<TicketLifecycleResult> {
  return applyTicketTransition(actor, "reroute", input, meta);
}
