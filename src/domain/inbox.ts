import "@tanstack/react-start/server-only";

import { sql } from "~/db";
import { guard, type JsonState } from "~/server/audit";
import { accessibleChainIds, type Principal } from "~/server/session";

/**
 * Read models for the two screens that make the platform's claims inspectable: the
 * approvals/task inbox and the audit trail. Both are read-only and both are filtered
 * by the caller's resolved tenant scope.
 */

export interface ApprovalItem {
  id: string;
  chainId: string;
  chainName: string;
  siteId: string | null;
  siteName: string | null;
  category: string;
  title: string;
  summary: string | null;
  status: string;
  dueAt: string | null;
  raisedBy: string | null;
  raisedByRole: string;
  assignedRole: string | null;
  createdAt: string;
}

export interface InboxPage {
  items: ApprovalItem[];
  mine: number;
  open: number;
}

/**
 * The inbox. Phase 0a renders the empty state honestly — the modules that raise a
 * maker-checker item (receiving, waste, refunds) arrive with their phases — but the
 * query, the routing rule and the scope filters are real, so the first module to
 * raise a task lands in a working screen.
 */
export async function listApprovals(principal: Principal, limit = 50): Promise<InboxPage> {
  // No dedicated permission: an inbox is a view of items already routed to a role the
  // caller holds. Scoping is the control, and it is applied below.
  const allowed = accessibleChainIds(principal);
  const roles = principal.roles.map((role) => role.code);
  const identity = { userId: principal.userId, chainId: principal.chainId, siteId: principal.siteId };

  const rows = await sql()<{
    id: string;
    chain_id: string;
    chain_name: string;
    site_id: string | null;
    site_name: string | null;
    category: string;
    title: string;
    summary: string | null;
    status: string;
    due_at: Date | null;
    raised_by: string | null;
    raised_by_role_code: string;
    assigned_role_code: string | null;
    created_at: Date;
  }>`
    select t.id, t.chain_id, c.name as chain_name, t.site_id, s.name as site_name,
           t.category, t.title, t.summary, t.status, t.due_at,
           u.display_name as raised_by, t.raised_by_role_code, t.assigned_role_code, t.created_at
      from approval_task t
      join chain c on c.id = t.chain_id
      left join site s on s.id = t.site_id
      left join "user" u on u.id = t.raised_by_user_id
     where (${allowed}::uuid[] is null or t.chain_id = any(${allowed}::uuid[]))
       and (${identity.chainId}::uuid is null or t.chain_id = ${identity.chainId})
       and (${identity.siteId}::uuid is null or t.site_id is null or t.site_id = ${identity.siteId})
       and (t.assigned_user_id = ${identity.userId} or t.assigned_role_code = any(${roles}::text[]))
     order by (t.status = 'open') desc, t.due_at asc nulls last, t.created_at desc
     limit ${limit}
  `;

  const items: ApprovalItem[] = rows.map((row) => ({
    id: row.id,
    chainId: row.chain_id,
    chainName: row.chain_name,
    siteId: row.site_id,
    siteName: row.site_name,
    category: row.category,
    title: row.title,
    summary: row.summary,
    status: row.status,
    dueAt: row.due_at ? row.due_at.toISOString() : null,
    raisedBy: row.raised_by,
    raisedByRole: row.raised_by_role_code,
    assignedRole: row.assigned_role_code,
    createdAt: row.created_at.toISOString(),
  }));

  return {
    items,
    mine: items.filter((item) => item.status === "open").length,
    open: items.length,
  };
}

/**
 * A before/after audit snapshot, carried across the server-fn boundary as JSON text.
 * Defined beside the writer in `~/server/audit` and re-exported here so the audit read
 * model and the master-data history panes cannot drift apart; `BeforeAfter` parses it
 * back for display.
 */
export type { JsonState };

export interface AuditEntryView {
  id: string;
  createdAt: string;
  chainId: string | null;
  chainName: string | null;
  siteId: string | null;
  actorName: string | null;
  actorRole: string;
  actorScope: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  reason: string | null;
  source: string;
  intent: string | null;
  before: JsonState;
  after: JsonState;
}

/**
 * The audit trail. Two ways in, matching the two things the spec asks of this log:
 *   * `chain.audit.read` — the App-layer capability to investigate a chain;
 *   * `audit.read` — the chain's own view of who at OmniHost.ai touched its data,
 *     which the spec requires to be visible to the chain ("a chain should be able to
 *     see exactly who at OmniHost.ai touched their data and why, which matters for a
 *     platform holding another company's sales and cost data").
 * Either way the row set is filtered by the caller's resolved scope, so the tenant
 * boundary holds even for the operator view.
 */
export async function listAuditEntries(
  principal: Principal,
  options: { chainId?: string | null; limit?: number } = {}
): Promise<AuditEntryView[]> {
  const allowed = accessibleChainIds(principal);
  const chainId = options.chainId ?? principal.chainId ?? null;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const siteId = principal.scope === "site" ? principal.siteId : null;

  await guard({
    principal,
    action: principal.scope === "app" ? "chain.audit.read" : "audit.read",
    entityType: "audit_log",
    chainId,
    target: chainId ? `chain ${chainId}` : "all chains",
  });

  const rows = await sql()<{
    id: string;
    created_at: Date;
    chain_id: string | null;
    chain_name: string | null;
    site_id: string | null;
    actor_name: string | null;
    actor_role_code: string;
    actor_scope: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    outcome: string;
    reason: string | null;
    request_source: string;
    intent: string | null;
    before_state: unknown;
    after_state: unknown;
  }>`
    select a.id, a.created_at, a.chain_id, c.name as chain_name, a.site_id,
           u.display_name as actor_name, a.actor_role_code, a.actor_scope,
           a.action, a.entity_type, a.entity_id, a.outcome, a.reason,
           a.request_source, a.intent, a.before_state, a.after_state
      from audit_log a
      left join chain c on c.id = a.chain_id
      left join "user" u on u.id = a.actor_user_id
     where (${allowed}::uuid[] is null or a.chain_id = any(${allowed}::uuid[]))
       and (${chainId}::uuid is null or a.chain_id = ${chainId})
       and (${siteId}::uuid is null or a.site_id is null or a.site_id = ${siteId})
     order by a.id desc
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: String(row.id),
    createdAt: row.created_at.toISOString(),
    chainId: row.chain_id,
    chainName: row.chain_name,
    siteId: row.site_id,
    actorName: row.actor_name,
    actorRole: row.actor_role_code,
    actorScope: row.actor_scope,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    outcome: row.outcome,
    reason: row.reason,
    source: row.request_source,
    intent: row.intent,
    before: row.before_state === null ? null : JSON.stringify(row.before_state),
    after: row.after_state === null ? null : JSON.stringify(row.after_state),
  }));
}

/** True when the caller holds any route into the audit trail. */
export function canReadAudit(principal: Principal): boolean {
  return principal.permissions.includes("chain.audit.read") || principal.permissions.includes("audit.read");
}
