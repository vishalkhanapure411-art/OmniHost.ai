import "@tanstack/react-start/server-only";

import { sql } from "~/db";

/**
 * Grant status reconciliation.
 *
 * A time-boxed grant is refused because `expires_at` has passed — that check is what
 * makes the time-box real, and it runs on every request in `resolvePrincipal`. The
 * *stored* `status` column, though, used to stay `active` for ever, so the row a reviewer
 * (or the chain itself, which the spec says may see exactly who at OmniHost.ai has access
 * to its data and why) reads said the opposite of the truth: "active" on a window that
 * closed weeks ago.
 *
 * This is a reconciler, chosen over deriving status at each read site, because the row
 * is then honest for *every* reader including one running SQL directly at the database —
 * a `case when … then 'expired' end` in each query would only fix the callers that
 * remembered to write it. The two facts a grant carries stay distinct:
 *
 *   * `status = 'revoked'` — somebody decided to take the access away;
 *   * `status = 'expired'` — nobody decided anything; the window simply closed.
 *
 * Deliberately **not** audit-logged. `audit_log` records decisions (who, role, before and
 * after, when), and an append-only trail of "the clock moved" rows would bury the
 * decisions it exists to protect. The lapse is fully reconstructible from the grant row
 * itself — it is the value `expires_at` the grantor already wrote, with the audit row the
 * grantor already produced.
 */

export interface AccessReconciliation {
  /** Grants whose window closed and whose stored status said otherwise. */
  grantsExpired: number;
  /** Approved requests whose grant has lapsed or been revoked. */
  requestsExpired: number;
}

/**
 * Flips lapsed, still-"active" grants to `expired`, and the approved access requests that
 * produced them alongside. Returns what it changed — a normal call changes nothing, which
 * is the point of running it on every request rather than in a nightly job that a demo
 * database would never see run.
 */
export async function reconcileLapsedAccess(): Promise<AccessReconciliation> {
  const grants = await sql()<{ id: string }>`
    update scope_grant
       set status = 'expired', updated_at = now()
     where status = 'active'
       and revoked_at is null
       and expires_at is not null
       and expires_at <= now()
     returning id
  `;

  const requests = await sql()<{ id: string }>`
    update support_access_request r
       set status = 'expired', updated_at = now()
      from scope_grant sg
     where r.scope_grant_id = sg.id
       and r.status = 'approved'
       and (sg.status <> 'active' or sg.revoked_at is not null)
     returning r.id
  `;

  return { grantsExpired: grants.length, requestsExpired: requests.length };
}

/**
 * The same reconcile, for a path that must not fail because of it.
 *
 * Called opportunistically (the session resolver), like the `last_seen_at` touch it sits
 * beside: a repair that cannot run must never be the reason a legitimate request is
 * refused, and every authorisation decision in this codebase reads `expires_at` rather
 * than `status`, so an unreconciled row grants nothing either way.
 */
export function reconcileLapsedAccessSoon(): void {
  void reconcileLapsedAccess().catch(() => undefined);
}
