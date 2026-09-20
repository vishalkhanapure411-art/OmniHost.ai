import "@tanstack/react-start/server-only";

import { sql, withTransaction } from "~/db";
import { auditedMutation, guard, recordAudit, writeAudit } from "~/server/audit";
import { NotFound, PermissionDenied, ValidationError } from "~/server/errors";
import { canReachChain, type Principal } from "~/server/session";
import type { MutationMeta } from "~/domain/chains";

/**
 * AppSupport — the escalated-ticket queue and time-boxed chain access.
 *
 * Spec, twice, in the same words: any AppSupport access into a specific chain's data is
 * "scoped, time-boxed and audit-logged", and "a chain should be able to see exactly who
 * at OmniHost.ai touched their data and why". Two consequences that shape everything
 * below:
 *
 *   1. The APP_SUPPORT role itself carries **no** tool codes (db/seed.sql). Working the
 *      queue is held by a *delegation*; reaching a chain's data is held by a second,
 *      chain-scoped, expiring delegation. That is why the negative test matters —
 *      holding an App-layer role must never be readable as "reaches every chain".
 *   2. Reading the queue and acting on a ticket that names a chain are different
 *      permissions applied to the same row. A ticket for a chain the operator cannot
 *      reach is visible (it is the platform's own operating data, and hiding it would
 *      hide the need for a grant) but its actions are refused server-side, with the
 *      reason.
 *
 * Time-boxing is not a cleanup job. Approving an access request writes an ordinary
 * `scope_grant` with a non-null `expires_at`; `resolvePrincipal` already refuses to load
 * an expired grant, so access ends by itself on the next request after the window
 * closes, and an unapproved request grants nothing at all.
 */

export type TicketSeverity = "low" | "medium" | "high" | "critical";
export type TicketStatus =
  | "new"
  | "triaged"
  | "assigned"
  | "waiting"
  | "resolved"
  | "closed"
  | "cancelled";

export interface SupportTicketView {
  id: string;
  reference: string;
  chainId: string | null;
  chainName: string | null;
  siteId: string | null;
  siteName: string | null;
  category: string;
  severity: TicketSeverity;
  source: string;
  subject: string;
  detail: string | null;
  status: TicketStatus;
  raisedBy: string | null;
  raisedByLabel: string | null;
  assignedUserId: string | null;
  assignedTo: string | null;
  assignedAt: string | null;
  responseDueAt: string | null;
  resolveDueAt: string | null;
  escalatedAt: string | null;
  escalatedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Past its first-response clock and not yet resolved. */
  overdue: boolean;
  /**
   * Whether this caller can reach the ticket's chain. A ticket with no chain is
   * reachable by anyone holding the queue permission; one with a chain is reachable
   * only under a grant naming it. The server re-checks on every action.
   */
  reachable: boolean;
}

export interface SupportAgentView {
  userId: string;
  displayName: string;
  email: string;
}

export interface SupportQueueView {
  tickets: SupportTicketView[];
  /** App-layer colleagues a ticket may be assigned to. */
  agents: SupportAgentView[];
  /** Counts, computed over what this caller can see. */
  counts: { open: number; overdue: number; resolved: number };
  /** True when the caller holds the resolving tool. */
  canResolve: boolean;
  canAssign: boolean;
}

interface TicketRow {
  id: string;
  reference: string;
  chain_id: string | null;
  chain_name: string | null;
  site_id: string | null;
  site_name: string | null;
  category: string;
  severity: string;
  source: string;
  subject: string;
  detail: string | null;
  status: string;
  raised_by: string | null;
  raised_by_label: string | null;
  assigned_user_id: string | null;
  assigned_to: string | null;
  assigned_at: Date | null;
  response_due_at: Date | null;
  resolve_due_at: Date | null;
  escalated_at: Date | null;
  escalated_to: string | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toTicket(row: TicketRow, principal: Principal): SupportTicketView {
  const resolved = row.status === "resolved" || row.status === "closed" || row.status === "cancelled";
  // Breach of the first-response clock. The resolution clock is shown separately, so an
  // overdue ticket is one nobody has picked up in time rather than one merely still open.
  const overdue = !resolved && row.response_due_at !== null && row.response_due_at.getTime() < Date.now();
  return {
    id: row.id,
    reference: row.reference,
    chainId: row.chain_id,
    chainName: row.chain_name,
    siteId: row.site_id,
    siteName: row.site_name,
    category: row.category,
    severity: (["low", "medium", "high", "critical"] as const).includes(row.severity as TicketSeverity)
      ? (row.severity as TicketSeverity)
      : "medium",
    source: row.source,
    subject: row.subject,
    detail: row.detail,
    status: row.status as TicketStatus,
    raisedBy: row.raised_by,
    raisedByLabel: row.raised_by_label,
    assignedUserId: row.assigned_user_id,
    assignedTo: row.assigned_to,
    assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
    responseDueAt: row.response_due_at ? row.response_due_at.toISOString() : null,
    resolveDueAt: row.resolve_due_at ? row.resolve_due_at.toISOString() : null,
    escalatedAt: row.escalated_at ? row.escalated_at.toISOString() : null,
    escalatedTo: row.escalated_to,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    overdue,
    reachable: row.chain_id === null || canReachChain(principal, row.chain_id),
  };
}

/**
 * The ticket queue. Requires `support.ticket.read`.
 *
 * Every ticket the platform has is listed, including those for chains this operator
 * cannot reach — marked `reachable: false` so the screen can offer "request access"
 * instead of a button the server would refuse. Acting on such a ticket is refused by
 * `guard()` on the write path with the chain in the target, which is where the control
 * lives; this flag only decides what the interface offers.
 */
export async function listSupportTickets(
  principal: Principal,
  options: { status?: string | null; limit?: number } = {}
): Promise<SupportQueueView> {
  await guard({ principal, action: "support.ticket.read", entityType: "support_ticket" });

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const status = (options.status ?? "").trim();
  const rows = await sql()<TicketRow>`
    select t.id, t.reference, t.chain_id, c.name as chain_name, t.site_id,
           s.name as site_name, t.category, t.severity, t.source, t.subject, t.detail, t.status,
           u.display_name as raised_by, t.raised_by_label,
           t.assigned_user_id, a.display_name as assigned_to, t.assigned_at,
           t.response_due_at, t.resolve_due_at, t.escalated_at, t.escalated_to,
           t.resolution_note, t.resolved_at, t.created_at, t.updated_at
      from support_ticket t
      left join chain c on c.id = t.chain_id
      left join site s on s.id = t.site_id
      left join "user" u on u.id = t.raised_by_user_id
      left join "user" a on a.id = t.assigned_user_id
     where (${status === "" ? null : status}::text is null or t.status = ${status === "" ? null : status})
    order by
      case t.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end asc,
      (t.status in ('resolved', 'closed', 'cancelled')) asc,
      t.resolve_due_at asc nulls last,
      t.created_at desc
    limit ${limit}
  `;

  const agents = await sql()<{ user_id: string; display_name: string; email: string }>`
    select distinct u.id as user_id, u.display_name, u.email
      from "user" u
      join role_assignment ra on ra.user_id = u.id and ra.status = 'active' and ra.revoked_at is null
      join role r on r.id = ra.role_id and r.layer = 'app'
     where u.status = 'active' and r.code in ('APP_ADMIN', 'APP_SUPPORT', 'APP_CONFIG')
     order by u.display_name asc
  `;

  const tickets = rows.map((row) => toTicket(row, principal));

  return {
    tickets,
    agents: agents.map((agent) => ({
      userId: agent.user_id,
      displayName: agent.display_name,
      email: agent.email,
    })),
    counts: {
      open: tickets.filter((ticket) => ticket.status !== "resolved" && ticket.status !== "closed" && ticket.status !== "cancelled").length,
      overdue: tickets.filter((ticket) => ticket.overdue).length,
      resolved: tickets.filter((ticket) => ticket.status === "resolved" || ticket.status === "closed").length,
    },
    canResolve: principal.permissions.includes("support.ticket.resolve"),
    canAssign: principal.permissions.includes("support.ticket.assign"),
  };
}

export interface AssignTicketInput {
  /** The user to assign to. `null` releases the ticket back to the queue. */
  assignToUserId: string | null;
}

/**
 * Assigns a ticket (or releases it). Requires `support.ticket.assign`, and — because
 * the ticket names a chain — reach into that chain.
 *
 * The ticket's chain is read first so the *target* can be named in the permission check
 * and in the denial audit row: `guard()` is handed the chain, so an AppSupport operator
 * holding a grant for one chain is refused on another chain's ticket with
 * "your delegated scope does not include this chain".
 */
export async function assignSupportTicket(
  principal: Principal,
  ticketId: string,
  input: AssignTicketInput,
  meta: MutationMeta = {}
): Promise<{ reference: string; before: string | null; after: string | null }> {
  if (!ticketId) throw new ValidationError("ticketId is required");

  const target = await sql()<{ chain_id: string | null; reference: string }>`
    select chain_id, reference from support_ticket where id = ${ticketId} limit 1
  `;
  const ticket = target[0];
  if (!ticket) throw new NotFound("Support ticket", ticketId);

  await guard({
    principal,
    action: "support.ticket.assign",
    entityType: "support_ticket",
    chainId: ticket.chain_id,
    target: `ticket ${ticket.reference}${ticket.chain_id ? ` in chain ${ticket.chain_id}` : ""}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const assignee = input.assignToUserId;
  if (assignee) {
    const rows = await sql()<{ id: string }>`
      select id from "user" where id = ${assignee} and status = 'active' limit 1
    `;
    if (!rows[0]) throw new ValidationError("that assignee is not an active user");
  }

  const outcome = await auditedMutation({
    principal,
    action: "support.ticket.assign",
    entityType: "support_ticket",
    chainId: ticket.chain_id,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{ assigned_user_id: string | null }>(
        `select assigned_user_id from support_ticket where id = $1 for update`,
        [ticketId]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Support ticket", ticketId);
      await tx.query(
        `update support_ticket
            set assigned_user_id = $2,
                assigned_at = case when $2::uuid is null then null else now() end,
                status = case
                           when $2::uuid is null then (case when status = 'assigned' then 'triaged' else status end)
                           when status in ('new', 'triaged', 'waiting') then 'assigned'
                           else status
                         end,
                updated_at = now()
          where id = $1`,
        [ticketId, assignee]
      );
      return {
        entityId: ticketId,
        before: { assignedUserId: row.assigned_user_id },
        after: { assignedUserId: assignee },
      };
    },
  });

  return {
    reference: ticket.reference,
    before: (outcome.before as { assignedUserId: string | null }).assignedUserId,
    after: assignee,
  };
}

/**
 * Resolves a ticket with a mandatory note. Requires `support.ticket.resolve` and reach
 * into the ticket's chain.
 *
 * Spec: "closure requires the raising role or their Head to verify the fix, not just
 * the assignee to mark it done". This records the *operator's* resolution and its note;
 * the verifying closure by the raising role is a chain-side action and ships with the
 * chain-side ticket modules (Phase 4) — stated here rather than implied by a status
 * name. `status = 'resolved'`, not `'closed'`, is the deliberate consequence.
 */
export async function resolveSupportTicket(
  principal: Principal,
  ticketId: string,
  note: string,
  meta: MutationMeta = {}
): Promise<{ reference: string; before: string; after: string }> {
  if (!ticketId) throw new ValidationError("ticketId is required");
  const resolution = (note ?? "").trim();
  if (resolution.length < 10) {
    throw new ValidationError("a resolution note of at least 10 characters is required");
  }

  const target = await sql()<{ chain_id: string | null; reference: string; status: string }>`
    select chain_id, reference, status from support_ticket where id = ${ticketId} limit 1
  `;
  const ticket = target[0];
  if (!ticket) throw new NotFound("Support ticket", ticketId);

  await guard({
    principal,
    action: "support.ticket.resolve",
    entityType: "support_ticket",
    chainId: ticket.chain_id,
    target: `ticket ${ticket.reference}${ticket.chain_id ? ` in chain ${ticket.chain_id}` : ""}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "support.ticket.resolve",
    entityType: "support_ticket",
    chainId: ticket.chain_id,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{ status: string }>(
        `select status from support_ticket where id = $1 for update`,
        [ticketId]
      );
      const row = rows[0];
      if (!row) throw new NotFound("Support ticket", ticketId);
      if (row.status === "closed" || row.status === "cancelled") {
        throw new ValidationError(`a ${row.status} ticket cannot be resolved`);
      }
      await tx.query(
        `update support_ticket
            set status = 'resolved', resolution_note = $2, resolved_by_user_id = $3,
                resolved_at = now(), updated_at = now()
          where id = $1`,
        [ticketId, resolution, principal.userId]
      );
      return {
        entityId: ticketId,
        before: { status: row.status },
        after: { status: "resolved", resolutionNote: resolution },
      };
    },
  });

  return {
    reference: ticket.reference,
    before: (outcome.before as { status: string }).status,
    after: "resolved",
  };
}

// ── Time-boxed chain access ──────────────────────────────────────────────────

export interface SupportAccessRequestView {
  id: string;
  requestedByUserId: string;
  requestedBy: string;
  chainId: string;
  chainName: string;
  siteId: string | null;
  ticketId: string | null;
  ticketReference: string | null;
  reason: string;
  requestedHours: number;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** When the access this request produced stops working, if it was approved. */
  grantExpiresAt: string | null;
  createdAt: string;
}

export interface SupportAccessView {
  requests: SupportAccessRequestView[];
  /** Grants this operator currently holds that are chain-scoped and time-boxed. */
  grants: {
    grantId: string;
    chainId: string;
    chainName: string | null;
    reason: string;
    expiresAt: string | null;
    permissions: string[];
  }[];
  /** True when the caller may approve or refuse requests (AppAdmin's scope.grant.manage). */
  canDecide: boolean;
  canRequest: boolean;
  /** The chains this caller may ask for access to — every chain, since asking is not having. */
  chains: { id: string; name: string }[];
}

/**
 * The access view: what has been asked for, what this operator currently holds, and —
 * for a decider — the pending queue.
 *
 * A requester sees their own history; a holder of `scope.grant.manage` (AppAdmin, per
 * the capability table's "Grant scopes to AppConfig/AppSupport: yes / no / no") sees
 * every pending request, because deciding them is their job.
 */
export async function listSupportAccess(principal: Principal): Promise<SupportAccessView> {
  await guard({ principal, action: "support.access.request", entityType: "support_access_request" });
  const canDecide = principal.permissions.includes("scope.grant.manage");

  const rows = await sql()<{
    id: string;
    requested_by_user_id: string;
    requested_by: string;
    chain_id: string;
    chain_name: string;
    site_id: string | null;
    ticket_id: string | null;
    ticket_reference: string | null;
    reason: string;
    requested_hours: number;
    status: string;
    decided_by: string | null;
    decided_at: Date | null;
    decision_note: string | null;
    grant_expires_at: Date | null;
    created_at: Date;
  }>`
    select r.id, r.requested_by_user_id, requester.display_name as requested_by,
           r.chain_id, c.name as chain_name, r.site_id, r.ticket_id, t.reference as ticket_reference,
           r.reason, r.requested_hours, r.status,
           decider.display_name as decided_by, r.decided_at, r.decision_note,
           sg.expires_at as grant_expires_at, r.created_at
      from support_access_request r
      join "user" requester on requester.id = r.requested_by_user_id
      join chain c on c.id = r.chain_id
      left join support_ticket t on t.id = r.ticket_id
      left join "user" decider on decider.id = r.decided_by_user_id
      left join scope_grant sg on sg.id = r.scope_grant_id
     where (${canDecide}::boolean or r.requested_by_user_id = ${principal.userId})
     order by (r.status = 'pending') desc, r.created_at desc
     limit 50
  `;

  const grants = await sql()<{
    id: string;
    chain_id: string;
    chain_name: string | null;
    reason: string;
    expires_at: Date | null;
  }>`
    select sg.id, sg.chain_id, c.name as chain_name, sg.reason, sg.expires_at
      from scope_grant sg
      left join chain c on c.id = sg.chain_id
     where sg.granted_to_user_id = ${principal.userId}
       and sg.status = 'active'
       and sg.revoked_at is null
       and sg.chain_id is not null
       and sg.expires_at is not null
       and sg.expires_at > now()
     order by sg.expires_at asc
  `;

  const chains = principal.permissions.includes("support.ticket.read")
    ? await sql()<{ id: string; name: string }>`select id, name from chain order by name asc`
    : [];

  return {
    requests: rows.map((row) => ({
      id: row.id,
      requestedByUserId: row.requested_by_user_id,
      requestedBy: row.requested_by,
      chainId: row.chain_id,
      chainName: row.chain_name,
      siteId: row.site_id,
      ticketId: row.ticket_id,
      ticketReference: row.ticket_reference,
      reason: row.reason,
      requestedHours: row.requested_hours,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      decisionNote: row.decision_note,
      grantExpiresAt: row.grant_expires_at ? row.grant_expires_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    })),
    grants: grants.map((grant) => ({
      grantId: grant.id,
      chainId: grant.chain_id,
      chainName: grant.chain_name,
      reason: grant.reason,
      expiresAt: grant.expires_at ? grant.expires_at.toISOString() : null,
      permissions: principal.grants.find((entry) => entry.grantId === grant.id)?.permissions ?? [],
    })),
    canDecide,
    canRequest: principal.permissions.includes("support.access.request"),
    chains: chains.map((chain) => ({ id: chain.id, name: chain.name })),
  };
}

export interface RequestSupportAccessInput {
  chainId: string;
  reason: string;
  requestedHours: number;
  ticketId?: string | null;
}

/**
 * Asks for time-boxed access to one chain. Requires `support.access.request`, which is
 * deliberately *not* a chain-scoped capability: asking for access you do not have is the
 * whole point, and an approved request is what creates the grant. Nothing here grants
 * anything — the request lands in a queue only `scope.grant.manage` can decide.
 */
export async function requestSupportAccess(
  principal: Principal,
  input: RequestSupportAccessInput,
  meta: MutationMeta = {}
): Promise<{ requestId: string; chainId: string; status: string }> {
  const chainId = (input.chainId ?? "").trim();
  const reason = (input.reason ?? "").trim();
  const hours = input.requestedHours;
  if (!chainId) throw new ValidationError("chainId is required");
  if (reason.length < 10) throw new ValidationError("a reason of at least 10 characters is required");
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new ValidationError("requestedHours must be a whole number between 1 and 720");
  }

  await guard({
    principal,
    action: "support.access.request",
    entityType: "support_access_request",
    chainId,
    target: `chain ${chainId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const outcome = await auditedMutation({
    principal,
    action: "support.access.request",
    entityType: "support_access_request",
    chainId,
    source: meta.source ?? "api",
    intent: meta.intent ?? null,
    run: async (tx) => {
      const chain = await tx.query<{ id: string }>(`select id from chain where id = $1`, [chainId]);
      if (!chain[0]) throw new NotFound("Chain", chainId);

      const pending = await tx.query<{ id: string }>(
        `select id from support_access_request
          where requested_by_user_id = $1 and chain_id = $2 and status = 'pending'`,
        [principal.userId, chainId]
      );
      if (pending[0]) {
        throw new ValidationError("you already have a pending request for this chain");
      }

      let ticketId: string | null = input.ticketId ?? null;
      if (ticketId) {
        const ticket = await tx.query<{ id: string }>(
          `select id from support_ticket where id = $1 and chain_id = $2`,
          [ticketId, chainId]
        );
        if (!ticket[0]) ticketId = null;
      }

      const inserted = await tx.query<{ id: string }>(
        `insert into support_access_request (requested_by_user_id, chain_id, reason, ticket_id, requested_hours)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [principal.userId, chainId, reason, ticketId, hours]
      );
      const id = inserted[0]?.id;
      if (!id) throw new Error("access request insert returned no row");

      return {
        entityId: id,
        before: null,
        after: { chainId, reason, requestedHours: hours, status: "pending" },
      };
    },
  });

  return { requestId: outcome.entityId ?? "", chainId, status: "pending" };
}

export interface DecideSupportAccessInput {
  approve: boolean;
  note?: string | null;
  /** Overrides the requested window. Capped at the requested window's bounds. */
  grantedHours?: number | null;
}

/**
 * Approves or refuses a pending access request. Requires `scope.grant.manage` — the
 * capability table is unambiguous that granting scopes to AppConfig/AppSupport is
 * AppAdmin's and nobody else's — *and* reach into the chain being granted, so a
 * delegated operator cannot widen someone else's reach into a chain they cannot reach
 * themselves.
 *
 * Approval writes a normal `scope_grant` with an expiry, carrying the tools a support
 * session needs and nothing more: the time-boxed access tool plus read access to the
 * chain. Two audit rows land in the same transaction — the grant, and the decision —
 * so the chain can see both who decided and what it produced.
 */
export async function decideSupportAccessRequest(
  principal: Principal,
  requestId: string,
  input: DecideSupportAccessInput,
  meta: MutationMeta = {}
): Promise<{ requestId: string; status: string; grantId: string | null; expiresAt: string | null }> {
  if (!requestId) throw new ValidationError("requestId is required");

  const target = await sql()<{ chain_id: string; status: string; requested_hours: number; requested_by_user_id: string }>`
    select chain_id, status, requested_hours, requested_by_user_id
      from support_access_request where id = ${requestId} limit 1
  `;
  const request = target[0];
  if (!request) throw new NotFound("Support access request", requestId);

  await guard({
    principal,
    action: "scope.grant.manage",
    entityType: "support_access_request",
    chainId: request.chain_id,
    target: `support access to chain ${request.chain_id}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const hours = input.grantedHours ?? request.requested_hours;
  if (input.approve && (!Number.isInteger(hours) || hours < 1 || hours > 720)) {
    throw new ValidationError("grantedHours must be a whole number between 1 and 720");
  }

  return withTransaction(async (tx) => {
    const rows = await tx.query<{
      id: string;
      chain_id: string;
      reason: string;
      requested_hours: number;
      requested_by_user_id: string;
      status: string;
    }>(
      `select id, chain_id, reason, requested_hours, requested_by_user_id, status
         from support_access_request where id = $1 for update`,
      [requestId]
    );
    const row = rows[0];
    if (!row) throw new NotFound("Support access request", requestId);
    if (row.status !== "pending") {
      throw new ValidationError(`this request is already ${row.status}`);
    }

    const note = (input.note ?? "").trim() || null;
    let grantId: string | null = null;
    let expiresAt: string | null = null;

    if (input.approve) {
      const permissions = await tx.query<{ id: string }>(
        `select id from permission where code in ('support.chain_access.timeboxed', 'chain.read', 'chain.list')`
      );
      if (permissions.length === 0) throw new Error("the support access tools are not registered");

      const scopeKey = `grant|${row.requested_by_user_id}|${row.chain_id}|-|req:${row.id}`;
      const grant = await tx.query<{ id: string; expires_at: Date }>(
        `insert into scope_grant (
           granted_to_user_id, granted_by_user_id, chain_id, reason, status, expires_at, scope_key
         ) values ($1, $2, $3, $4, 'active', now() + ($5 || ' hours')::interval, $6)
         on conflict (scope_key) do update set
           status = 'active', revoked_at = null, reason = excluded.reason,
           expires_at = excluded.expires_at, updated_at = now()
         returning id, expires_at`,
        [
          row.requested_by_user_id,
          principal.userId,
          row.chain_id,
          `${row.reason} (approved for ${String(hours)}h)`,
          String(hours),
          scopeKey,
        ]
      );
      grantId = grant[0]?.id ?? null;
      if (!grantId) throw new Error("scope grant insert returned no row");
      expiresAt = grant[0] ? grant[0].expires_at.toISOString() : null;

      for (const permission of permissions) {
        await tx.query(
          `insert into scope_grant_permission (scope_grant_id, permission_id)
           values ($1, $2) on conflict do nothing`,
          [grantId, permission.id]
        );
      }

      await tx.query(
        `update support_access_request
            set status = 'approved', decided_by_user_id = $2, decided_at = now(),
                decision_note = $3, scope_grant_id = $4, updated_at = now()
          where id = $1`,
        [requestId, principal.userId, note, grantId]
      );

      // The grant, on its own row: "who at OmniHost.ai can touch this chain, and why".
      await writeAudit(tx, {
        principal,
        action: "scope.grant.manage",
        entityType: "scope_grant",
        entityId: grantId,
        chainId: row.chain_id,
        beforeState: null,
        afterState: {
          grantedToUserId: row.requested_by_user_id,
          hours,
          expiresAt,
          permissions: ["support.chain_access.timeboxed", "chain.read", "chain.list"],
        },
        outcome: "success",
        reason: `time-boxed support access approved from request ${row.id}`,
        source: meta.source ?? "screen",
      });
    } else {
      await tx.query(
        `update support_access_request
            set status = 'denied', decided_by_user_id = $2, decided_at = now(),
                decision_note = $3, updated_at = now()
          where id = $1`,
        [requestId, principal.userId, note]
      );
    }

    // The decision, on its own audit row. Two rows rather than one because two entities
    // change here — the request (decided) and the grant (created) — and an auditor
    // asking "what did this decision produce?" should not have to unpick a merged row.
    // Both rows are written inside the one transaction, so a failed write takes the
    // decision down with it.
    await writeAudit(tx, {
      principal,
      action: "support.access.decide",
      entityType: "support_access_request",
      entityId: requestId,
      chainId: row.chain_id,
      beforeState: { status: "pending" },
      afterState: { status: input.approve ? "approved" : "denied", grantId, expiresAt },
      outcome: "success",
      reason: input.approve
        ? `time-boxed access approved for ${String(hours)}h${note ? `: ${note}` : ""}`
        : `access request refused${note ? `: ${note}` : ""}`,
      source: meta.source ?? "screen",
    });

    return {
      requestId,
      status: input.approve ? "approved" : "denied",
      grantId,
      expiresAt,
    };
  });
}

/**
 * Records the *use* of time-boxed access, and returns what the operator is now working
 * inside.
 *
 * This is the spec's "scoped, time-boxed **and audit-logged**" applied to the use rather
 * than the grant: reaching a chain's data under a support grant writes a row naming the
 * grant, the chain and its expiry, so a chain's audit trail answers "which support
 * sessions actually opened my account, and when".
 *
 * Only a grant that is still live counts: `resolvePrincipal` loads active, unexpired
 * grants, and the grant is re-read here too, so a session that started before the window
 * closed cannot be kept open by holding a stale page.
 */
export async function useSupportAccess(
  principal: Principal,
  chainId: string,
  meta: MutationMeta = {}
): Promise<{ chainId: string; grantId: string; expiresAt: string }> {
  if (!chainId) throw new ValidationError("chainId is required");
  await guard({
    principal,
    action: "support.chain_access.timeboxed",
    entityType: "scope_grant",
    chainId,
    target: `chain ${chainId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const rows = await sql()<{ id: string; expires_at: Date | null; reason: string }>`
    select id, expires_at, reason
      from scope_grant
     where granted_to_user_id = ${principal.userId}
       and chain_id = ${chainId}
       and status = 'active'
       and revoked_at is null
       and expires_at is not null
     order by expires_at desc
     limit 1
  `;
  const grant = rows[0];
  if (!grant) {
    // A refusal, not bad input: no window was ever granted for this chain.
    throw new PermissionDenied(
      "support.chain_access.timeboxed",
      `no time-boxed access grant covers this chain — request access first`
    );
  }
  if (grant.expires_at && grant.expires_at.getTime() <= Date.now()) {
    // The window is gone. Say so, and name when it closed: an operator looking at a stale
    // screen needs to know the grant lapsed rather than that they never had one.
    throw new PermissionDenied(
      "support.chain_access.timeboxed",
      `your time-boxed access to this chain expired at ${grant.expires_at.toISOString()} — request access again`
    );
  }

  const expiresAt = grant.expires_at ? grant.expires_at.toISOString() : "";
  await recordAudit({
    principal,
    action: "support.chain_access.timeboxed",
    entityType: "scope_grant",
    entityId: grant.id,
    chainId,
    beforeState: null,
    afterState: { usedAt: new Date().toISOString(), expiresAt },
    outcome: "success",
    reason: `support session opened on chain ${chainId} under grant ${grant.id}`,
    source: meta.source ?? "screen",
  });

  return { chainId, grantId: grant.id, expiresAt };
}
