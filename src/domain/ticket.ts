import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { auditedMutation, guard, primaryRoleCode, recordAudit, writeAudit, type AuditSource } from "~/server/audit";
import { NotFound, PermissionDenied, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import { assertRoutingEntitled } from "~/domain/display-entitlement";
import { resolveLineRoute } from "~/domain/display-routing";
import type { TicketRouteSource } from "~/domain/display";
import {
  FIRE_VALIDATION_KEY,
  ORDER_INTENTS,
  ORDER_TRANSITIONS,
  TICKET_TRANSITION_CODES,
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
