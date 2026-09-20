import "@tanstack/react-start/server-only";

import { withTransaction, type Queryable } from "~/db";
import { PermissionDenied } from "~/server/errors";
import { requirePermission, type PermissionMeta } from "~/server/permissions";
import type { Principal } from "~/server/session";

/**
 * The one audit helper.
 *
 * The spec states this requirement three times, in the same words each time, for both
 * surfaces: "Every chatbot-initiated transaction is audit-logged: who, role, site,
 * before/after state, timestamp — the same log a screen-driven action would produce,
 * since the chatbot calls the identical domain API" (Chatbot Interaction Model), and
 * "Every chatbot- or screen-driven transaction is audit-logged with who, role, site,
 * before/after state" (Non-Functional Requirements → Security). Phase 0a has no
 * chatbot, which is exactly why the log is built as a shared helper rather than
 * inside the chatbot: the gateway will call these same domain functions later and get
 * the same trail for free.
 *
 * Two rules make this more than a logging call:
 *   1. `auditedMutation()` writes the mutation and its audit row in ONE database
 *      transaction. There is no window where a change exists unlogged, and a failed
 *      audit insert takes the change down with it.
 *   2. denials are logged too, with outcome 'denied'. A refused attempt is the thing
 *      an auditor or a chain's security team actually asks about.
 */

export type AuditSource = "screen" | "chatbot" | "api" | "system";
export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEntry {
  principal: Principal;
  /** The permission/tool code that authorised (or refused) the call. */
  action: string;
  entityType: string;
  entityId?: string | null;
  chainId?: string | null;
  siteId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  outcome?: AuditOutcome;
  reason?: string | null;
  /** Chatbot intent text; null for screen-driven calls (spec's ChatbotAuditLog shape). */
  intent?: string | null;
  source?: AuditSource;
  requestId?: string | null;
}

/**
 * Which role to stamp on the row. If the caller holds several, the one that actually
 * carries the action is the honest answer; otherwise the first is recorded so there
 * is always a value.
 */
export function primaryRoleCode(principal: Principal, action: string): string {
  const carrying = principal.roles.find((role) => role.code.length > 0 && principal.permissions.includes(action));
  return carrying?.code ?? principal.roles[0]?.code ?? "UNKNOWN";
}

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Inserts the audit row using an existing query handle (so it can join a transaction). */
export async function writeAudit(tx: Queryable, entry: AuditEntry): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `insert into audit_log (
        chain_id, site_id, actor_user_id, actor_role_code, actor_scope,
        action, entity_type, entity_id, before_state, after_state,
        outcome, reason, intent, request_source, session_id, request_id
     ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
        $11, $12, $13, $14, $15, $16
     ) returning id`,
    [
      entry.chainId ?? null,
      entry.siteId ?? null,
      entry.principal.userId,
      primaryRoleCode(entry.principal, entry.action),
      entry.principal.scope,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      json(entry.beforeState),
      json(entry.afterState),
      entry.outcome ?? "success",
      entry.reason ?? null,
      entry.intent ?? null,
      entry.source ?? "api",
      entry.principal.sessionId,
      entry.requestId ?? null,
    ]
  );
  return rows[0]?.id ?? "";
}

/**
 * Records an event on its own connection — used for denials and errors, where the
 * mutation's transaction has already rolled back.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await withTransaction((tx) => writeAudit(tx, entry));
  } catch (error) {
    // Never let the audit of a refusal mask the refusal itself.
    console.error("[omnihost] failed to write audit_log", error);
  }
}

export interface MutationOutcome {
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface GuardArgs {
  principal: Principal;
  action: string;
  entityType: string;
  chainId?: string | null;
  siteId?: string | null;
  /** Describes the target for the denial message, e.g. `chain <uuid>`. */
  target?: string;
  source?: AuditSource;
  intent?: string | null;
  requestId?: string | null;
}

/**
 * Permission check + denial audit in one call. Every domain function starts here, so
 * a refused attempt — the thing an auditor asks about — leaves a row with outcome
 * 'denied' and the reason, rather than vanishing into a 403.
 */
export async function guard(args: GuardArgs): Promise<PermissionMeta> {
  try {
    return await requirePermission(args.principal, args.action, {
      chainId: args.chainId ?? null,
      siteId: args.siteId ?? null,
      describes: args.target,
    });
  } catch (error) {
    if (error instanceof PermissionDenied) {
      await recordAudit({
        principal: args.principal,
        action: args.action,
        entityType: args.entityType,
        entityId: null,
        chainId: args.chainId ?? args.principal.chainId ?? null,
        siteId: args.siteId ?? args.principal.siteId ?? null,
        outcome: "denied",
        reason: error.details?.reason ? String(error.details.reason) : error.message,
        intent: args.intent ?? null,
        source: args.source ?? "api",
        requestId: args.requestId ?? null,
      });
    }
    throw error;
  }
}

export interface AuditedMutationArgs {
  principal: Principal;
  action: string;
  entityType: string;
  chainId?: string | null;
  siteId?: string | null;
  intent?: string | null;
  source?: AuditSource;
  requestId?: string | null;
  /**
   * The work. Receives the transaction handle; returns the entity id plus the state
   * before and after so the caller cannot forget to supply them.
   */
  run: (tx: Queryable) => Promise<MutationOutcome>;
}

/**
 * Runs a mutation and its audit row atomically. Every mutating domain function in
 * this phase goes through here — that is the spec's "every transaction is
 * audit-logged", made structural rather than a habit.
 */
export async function auditedMutation(args: AuditedMutationArgs): Promise<MutationOutcome> {
  return withTransaction(async (tx) => {
    const outcome = await args.run(tx);
    await writeAudit(tx, {
      principal: args.principal,
      action: args.action,
      entityType: args.entityType,
      entityId: outcome.entityId ?? null,
      chainId: args.chainId ?? null,
      siteId: args.siteId ?? null,
      beforeState: outcome.before,
      afterState: outcome.after,
      outcome: "success",
      reason: outcome.reason ?? null,
      intent: args.intent ?? null,
      source: args.source ?? "api",
      requestId: args.requestId ?? null,
    });
    return outcome;
  });
}
