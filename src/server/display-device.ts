import "@tanstack/react-start/server-only";

import { sql } from "~/db";
import { displayCapabilities, type DevicePrincipal, type DisplayKind } from "~/domain/display";
import { recordAudit } from "~/server/audit";
import { sha256 } from "~/server/crypto";
import { PermissionDenied } from "~/server/errors";

/**
 * The device principal, and the four code points where the per-chain boundary is enforced.
 *
 * **Why this file exists in this shape.** Per-chain isolation has **no RLS policy behind
 * it** — the boundary is code (DECISIONS.md:8, D22). `DESIGN-kds-and-ticket-routing.md`
 * §1.6 names four places, and this module is where all four of them are, so a reviewer can
 * check them rather than assume them:
 *
 *   1. **The device principal is resolved from the `display` row, never from a request
 *      parameter** — `resolveDevicePrincipal()`. It takes a raw token and nothing else: no
 *      chain, site, outlet or section can be passed in, so a request cannot name its own
 *      scope. The scope in the returned principal is read from `display`.
 *   2. **Every read of a station's queue carries the tenant predicate** —
 *      `stationQueueWhere()`. A device attached to a station gets
 *      `chain_id and outlet_id and section_id`; an outlet-scope device (pass, CDS, status
 *      board) gets `chain_id and outlet_id` and **no section**, so it can never widen to
 *      another site. Nothing in the display layer reads tickets without it.
 *   3. **Every transition's UPDATE carries `and chain_id = …`** — `rowScopeWhere()`, which
 *      always emits the chain predicate alongside the row id and the expected state. A
 *      crafted id from another chain updates zero rows, and is then refused as a
 *      capability refusal (§6.4) rather than reported as a missing row.
 *   4. **A credential is accepted only when the display's own row is active and its chain
 *      matches the credential's issuance chain** — the checks in
 *      `resolveDevicePrincipal()` below. The chain equality is also a database invariant
 *      (migration 0011's composite foreign key) because a boundary with no RLS behind it
 *      deserves both. Revocation is one `revoked_at`, and it stops the terminal rather
 *      than hiding a button: the resolver is the only way in.
 *
 * **A device is not a role-holding identity.** `authorise()` decides what a *person* may
 * do, from roles, grants and scope. A terminal has none of those — it has a **fixed,
 * enumerated capability set by kind** (`displayCapabilities`, D26) resolved at this point,
 * which is why `assertDeviceMayActOn()` checks membership here and does not call
 * `requirePermission()`. Its audit rows are addressed by the device, with `actor_user_id`
 * null (§2.4 item 2) — and **a device row never names the person who tapped** (O2).
 */

/** Why a credential was not accepted. Each is a distinct, non-leaking answer. */
export type DeviceRefusalReason =
  | "no_token"
  | "unknown_token"
  | "revoked"
  | "display_inactive"
  | "chain_mismatch";

export type DeviceResolution =
  | { ok: true; device: DevicePrincipal }
  | { ok: false; reason: DeviceRefusalReason };

interface CredentialRow {
  credential_id: string;
  credential_chain_id: string;
  operating_role_code: string;
  revoked_at: Date | null;
  display_id: string;
  chain_id: string;
  site_id: string;
  outlet_id: string;
  section_id: string | null;
  code: string;
  name: string;
  kind: string;
  status: string;
}

/**
 * Resolves a raw terminal token to its device principal.
 *
 * The token's digest is what is looked up — the same rule `app_session` follows
 * (`0001:125-140`): the raw token exists only on the terminal, so a database leak hands
 * over no live terminal.
 *
 * The conditions are evaluated **after** the single lookup rather than inside the `where`
 * clause, deliberately: refusing with `unknown_token` when the truth is "this credential
 * was revoked" would make the ledger unable to tell a stolen token from a withdrawn one,
 * and the refusal would be unattributable. One read, no window, and a reason that is true.
 */
export async function resolveDevicePrincipal(
  rawToken: string | null | undefined
): Promise<DeviceResolution> {
  if (!rawToken) return { ok: false, reason: "no_token" };
  const rows = await sql()<CredentialRow>`
    select c.id              as credential_id,
           c.chain_id        as credential_chain_id,
           c.operating_role_code,
           c.revoked_at,
           d.id              as display_id,
           d.chain_id,
           d.site_id,
           d.outlet_id,
           d.section_id,
           d.code,
           d.name,
           d.kind,
           d.status
      from display_credential c
      join display d on d.id = c.display_id
     where c.token_hash = ${sha256(rawToken)}
     limit 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown_token" };
  // §1.6 item 4, in order: revocation stops the terminal; an inactive display stops it; and
  // a credential whose issuance chain is not the display's chain is accepted by nobody.
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.status !== "active") return { ok: false, reason: "display_inactive" };
  if (row.credential_chain_id !== row.chain_id) return { ok: false, reason: "chain_mismatch" };

  const kind = row.kind as DisplayKind;
  return {
    ok: true,
    device: {
      credentialId: row.credential_id,
      displayId: row.display_id,
      code: row.code,
      name: row.name,
      kind,
      chainId: row.chain_id,
      siteId: row.site_id,
      outletId: row.outlet_id,
      sectionId: row.section_id,
      operatingRoleCode: row.operating_role_code,
      // Fixed by kind, and empty for a kind the registry does not know.
      capabilities: displayCapabilities(kind),
    },
  };
}

/**
 * §1.6 item 2 — the predicate every read of a station's work carries.
 *
 * Returns a SQL fragment plus the parameters it binds, so a caller can splice it after its
 * own parameters instead of re-numbering them by hand. It is deliberately not a
 * `where`-clause string with the values inlined: the values are parameters, and the
 * fragment always starts at the chain.
 */
export function stationQueueWhere(
  device: DevicePrincipal,
  options: { alias: string; parameterOffset?: number }
): { sql: string; params: string[] } {
  const alias = options.alias;
  let index = (options.parameterOffset ?? 0) + 1;
  const params: string[] = [device.chainId, device.outletId];
  const parts = [`${alias}.chain_id = $${String(index++)}`, `${alias}.outlet_id = $${String(index++)}`];
  if (device.sectionId !== null) {
    // The section clause is what makes a station screen a station screen. An outlet-scope
    // display gets no section here and therefore cannot be narrowed to one either — it
    // reads the outlet, never another outlet and never another site.
    parts.push(`${alias}.section_id = $${String(index++)}`);
    params.push(device.sectionId);
  }
  return { sql: parts.join(" and "), params };
}

/**
 * §1.6 item 3 — the predicate a transition's UPDATE carries.
 *
 * `id and chain_id` always; `outlet_id` and (when the device is station-scoped) `section_id`
 * too, so an id from another tenant's chain cannot be updated even by a device that was
 * tricked into trying; and `state = $n` when the caller states the state it expects, which
 * is the optimistic-concurrency rule of §2.3 — zero rows updated means the ticket moved on,
 * and that is a **validation** refusal that writes nothing.
 *
 * (`S-B` binds this to `ticket`; the estate functions in `~/domain/display-estate` do not
 * need it, which is why the shape is generic over the alias.)
 */
export function rowScopeWhere(
  device: DevicePrincipal,
  options: { alias: string; id: string; expectedState?: string | null; parameterOffset?: number }
): { sql: string; params: string[] } {
  const alias = options.alias;
  let index = (options.parameterOffset ?? 0) + 1;
  const params: string[] = [options.id, device.chainId, device.outletId];
  const parts = [
    `${alias}.id = $${String(index++)}`,
    `${alias}.chain_id = $${String(index++)}`,
    `${alias}.outlet_id = $${String(index++)}`,
  ];
  if (device.sectionId !== null) {
    parts.push(`${alias}.section_id = $${String(index++)}`);
    params.push(device.sectionId);
  }
  if (options.expectedState !== undefined && options.expectedState !== null) {
    parts.push(`${alias}.state = $${String(index++)}`);
    params.push(options.expectedState);
  }
  return { sql: parts.join(" and "), params };
}

/** Actions that only ever happen at one station, and therefore need a station on the device. */
const STATION_SCOPED_ACTIONS = new Set([
  "kds.ticket.advance",
  "kds.ticket.recall",
  "kds.ticket.reroute",
  "kds.ticket.void",
]);

/** The scope of the record a device wants to act on — **read from the row**, never from a request. */
export interface TicketTargetScope {
  chainId: string;
  outletId: string;
  siteId: string | null;
  sectionId: string | null;
}

/**
 * May this terminal act on this record?
 *
 * The rules are D27 and §2.4 item 3, and the copy is D16: a refusal says only that the
 * ticket is not on this station. It never confirms that the other record exists and never
 * names the other chain — with no RLS behind the boundary, the sentence *is* part of the
 * boundary, and confirming existence would be a leak even with no data shown.
 *
 * Throws `PermissionDenied` (a capability refusal: a `denied` audit row, nothing changed)
 * carrying the catalog key the screen words it with. Callers pass the scope they read from
 * the row they intend to touch, so this runs *after* the read and *before* any write.
 */
export function assertDeviceMayActOn(
  device: DevicePrincipal,
  action: string,
  target: TicketTargetScope
): void {
  const refuse = (messageKey: string, reason: string): never => {
    // `code` is the catalog key the screen words this with and `action` is the capability
    // that was refused — the same shape every other coded refusal crosses the wire in
    // (`~/server-fns` reads both out of `details`). Nothing here is user-visible prose.
    throw new PermissionDenied(action, reason, {
      target: `display ${device.code}`,
      deviceCode: device.code,
      code: messageKey,
    });
  };

  if (!device.capabilities.includes(action)) {
    // The terminal is not configured for this action at all. Its own sentence, because
    // "another station's ticket" would be a false statement about a CDS or a printer.
    refuse("kds.refusal.actionNotOnTerminal", `display ${device.code} does not hold ${action}`);
  }
  // Tenant first, and the same sentence as a wrong station: the caller learns nothing
  // about the other chain (§D16).
  if (target.chainId !== device.chainId) {
    refuse("kds.refusal.notYourStation", `${action} targets another chain`);
  }
  if (target.outletId !== device.outletId) {
    refuse("kds.refusal.notYourStation", `${action} targets another outlet`);
  }
  if (STATION_SCOPED_ACTIONS.has(action)) {
    if (device.sectionId === null) {
      refuse("kds.refusal.noStationOnTerminal", `${action} needs a station and this terminal has none`);
    }
    if (target.sectionId !== device.sectionId) {
      refuse("kds.refusal.notYourStation", `${action} targets another station`);
    }
  } else if (device.sectionId !== null && target.sectionId !== device.sectionId) {
    // A station-attached screen serves what the pass put on it and nothing else. An
    // outlet-scope pass screen legitimately spans stations, which is why the section
    // clause is conditional here and absolute above.
    refuse("kds.refusal.notYourStation", `${action} targets another station`);
  }
}

/**
 * Records a capability refusal by a device: one `denied` audit row, no data changed, and
 * `actor_user_id` null with `display:<code>` in `reason` so the trail names the terminal.
 *
 * Exists as a separate function rather than through `guard()` because `guard()` resolves a
 * *person's* authority, and a device has no roles to resolve against (see the header).
 */
export async function refuseDevice(
  device: DevicePrincipal,
  args: {
    action: string;
    entityType: string;
    entityId?: string | null;
    reason: string;
    chainId?: string | null;
    siteId?: string | null;
  }
): Promise<void> {
  await recordAudit({
    device: { roleCode: device.operatingRoleCode, displayCode: device.code },
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId ?? null,
    chainId: args.chainId ?? device.chainId,
    siteId: args.siteId ?? device.siteId,
    outcome: "denied",
    reason: args.reason,
    source: "screen",
  });
}
