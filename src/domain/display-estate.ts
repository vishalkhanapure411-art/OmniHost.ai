import "@tanstack/react-start/server-only";

import { poolQueryable, withTransaction, type Queryable } from "~/db";
import { auditedMutation, guard, recordAudit, writeAudit } from "~/server/audit";
import { newPairingCode, newSessionToken, sha256 } from "~/server/crypto";
import { NotFound, PermissionDenied, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import {
  DISPLAY_KINDS,
  DISPLAY_TRANSPORTS,
  type DisplayKind,
  type DisplayTransport,
} from "~/domain/display";
import { displayEntitlement, estateGateRows, assertDisplayEstateEntitled, type DisplayEntitlement, type DisplayGateRow } from "~/domain/display-entitlement";

/**
 * The display estate (S4's server half): registering a device, pairing it, withdrawing its
 * access and deactivating it — all on the site record next to the outlet they belong to
 * (D21), and none of it a screen yet.
 *
 * Four rules from the spec shape every function here:
 *
 *   * **A terminal is provisioned by a person and never self-registers** (O12). Pairing
 *     issues a **single-use code**; redeeming it is the only way a terminal obtains a
 *     token, and re-pairing **revokes the live credential in the same transaction**, so a
 *     device never holds two secrets. The unique index that enforces that is in migration
 *     0011 — this module is what makes the database's rule reachable.
 *   * **Both secrets are stored hashed and neither is ever returned twice.** The pairing
 *     code is returned once, at issue; the device token once, at redemption. Neither the
 *     code nor its hash goes into an audit row, a read model or a log line.
 *   * **One mutation, one transaction, one audit row, one named capability.** Registering,
 *     pairing, revoking and deactivating each go through `auditedMutation` with
 *     `display.manage`; deactivating a display that also revokes its credential is
 *     deliberately **one** action with **one** audit row, because it is one thing a person
 *     decided.
 *   * **A validation refusal writes nothing.** A printer with no station, a station that
 *     belongs to another outlet, a code already taken at that outlet: each aborts before
 *     the write, so there is no ledger row to point at and the screen is the only record.
 *     A capability refusal is the other half and is `guard()`'s: a `denied` row and no data.
 *
 * Every function here reads the outlet (or the display) from the database **first** and
 * decides the tenant from that row, so no request parameter can name its own chain.
 */

export interface DisplayCredentialState {
  credentialId: string;
  issuedAt: string;
  /** Who paired it (O12: "the pairing record naming who issued it"). */
  issuedBy: string | null;
  issuedByEmail: string | null;
  /** The role code this device's audit rows carry (§2.4 item 2). */
  operatingRoleCode: string;
  /** True while the single-use code has been issued and not yet redeemed. */
  pairingPending: boolean;
  pairingExpiresAt: string | null;
  redeemedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface DisplayRecord {
  id: string;
  code: string;
  name: string;
  kind: DisplayKind;
  status: string;
  sectionId: string | null;
  sectionCode: string | null;
  sectionName: string | null;
  transport: string | null;
  address: string | null;
  locale: string | null;
  timezone: string | null;
  requireOperatorPin: boolean;
  lastSeenAt: string | null;
  /** The latest provisioning record. Never the token, and never its hash. */
  credential: DisplayCredentialState | null;
}

export interface DisplayEstate {
  outlet: { id: string; code: string; name: string; chainId: string; siteId: string };
  /** Every station of the outlet, so a screen can put a display on one. */
  stations: { id: string; code: string; name: string; kind: string; status: string }[];
  displays: DisplayRecord[];
  /** The tier gate, reported rather than assumed (§11.5.6). */
  entitlement: DisplayEntitlement | null;
  /**
   * Both gated features with the gate holding each one named, and the held gate's own
   * sentence (`estateGateRows`). Carried as data so the screen renders one of the two
   * sentences it is given instead of re-deriving the precedence — and so neither sentence
   * can be collapsed into the other (lead ruling, 29 Sept 2026).
   */
  gates: DisplayGateRow[];
  /**
   * True when at least one of the two features is open. The estate's own answer to "may a
   * terminal be provisioned here", which is what the screen refuses its writes on.
   */
  licensed: boolean;
  /**
   * How long an issued pairing code is good for. Here because a screen must not import
   * `PAIRING_WINDOW_MINUTES` from this server-only module to fill in a sentence: that
   * import is what drags `pg` and `node:crypto` into the client bundle and stops the app
   * hydrating (see the header of `~/domain/display`). The value crosses as data.
   */
  pairingWindowMinutes: number;
}

interface OutletContext {
  id: string;
  code: string;
  name: string;
  chainId: string;
  siteId: string;
}

/**
 * **The estate's entitlement gate, asked in the domain and recorded in the ledger** (lead
 * ruling, 30 Sept 2026; S-B/2c).
 *
 * The screen withholds its register/pair/revoke buttons when neither gated feature is open,
 * and a hidden button is a convenience rather than a control: this is the half a curl, a
 * script or the chatbot gateway cannot skip. It is asked **after** `guard()`, so a caller who
 * holds no `display.manage` is told that first — the capability is about the person, the
 * licence about the chain — and **before** the transaction opens, so the refusal records one
 * `denied` row and changes nothing (which is what the check counts).
 *
 * `assertDisplayEstateEntitled` keeps the two refusals apart: `permission.licence.tierBelow`
 * when the licence does not cover the module, `permission.licence.moduleOff` when the operator
 * has switched it off. This function only records which one it was.
 */
async function assertEstateGateOpenFor(
  db: Queryable,
  principal: Principal,
  args: {
    action: string;
    entityType: string;
    entityId?: string | null;
    chainId: string;
    siteId: string | null;
    source?: "screen" | "chatbot" | "api" | "system";
    intent?: string | null;
  }
): Promise<void> {
  try {
    await assertDisplayEstateEntitled(db, args.chainId, args.action);
  } catch (error) {
    if (error instanceof PermissionDenied) {
      // A capability refusal writes exactly one `denied` row and changes no data, the same
      // shape the fire path and every transition use. The row's reason carries the licence
      // sentence's own words, so the ledger says which of the two gates was holding.
      await recordAudit({
        principal,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId ?? null,
        chainId: args.chainId,
        siteId: args.siteId,
        outcome: "denied",
        reason: error.message,
        intent: args.intent ?? null,
        source: args.source ?? "api",
      });
    }
    throw error;
  }
}

/** The outlet's own tenant context, read from the row. Never taken from a request. */
async function outletContext(db: Queryable, outletId: string): Promise<OutletContext> {
  const rows = await db.query<{ id: string; code: string; name: string; chain_id: string; site_id: string }>(
    `select id, code, name, chain_id, site_id from outlet where id = $1 limit 1`,
    [outletId]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Outlet", outletId);
  return { id: row.id, code: row.code, name: row.name, chainId: row.chain_id, siteId: row.site_id };
}

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface DisplayRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  section_id: string | null;
  section_code: string | null;
  section_name: string | null;
  transport: string | null;
  address: string | null;
  locale: string | null;
  timezone: string | null;
  require_operator_pin: boolean;
  last_seen_at: unknown;
  credential_id: string | null;
  issued_at: unknown;
  issued_by: string | null;
  issued_by_email: string | null;
  operating_role_code: string | null;
  pairing_pending: boolean | null;
  pairing_expires_at: unknown;
  redeemed_at: unknown;
  revoked_at: unknown;
  revoke_reason: string | null;
}

const DISPLAY_SELECT = `
  select d.id, d.code, d.name, d.kind, d.status, d.section_id,
         s.code as section_code, s.name as section_name,
         d.transport, d.address, d.locale, d.timezone, d.require_operator_pin, d.last_seen_at,
         c.id as credential_id, c.issued_at, c.issued_by_user_id as issued_by,
         u.email as issued_by_email, c.operating_role_code,
         (c.pairing_code_hash is not null) as pairing_pending,
         c.pairing_expires_at, c.redeemed_at, c.revoked_at, c.revoke_reason
    from display d
    left join outlet_section s on s.id = d.section_id
    left join lateral (
      select * from display_credential c2
       where c2.display_id = d.id
       order by c2.issued_at desc
       limit 1
    ) c on true
    left join "user" u on u.id = c.issued_by_user_id
`;

function toDisplay(row: DisplayRow): DisplayRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as DisplayKind,
    status: row.status,
    sectionId: row.section_id,
    sectionCode: row.section_code,
    sectionName: row.section_name,
    transport: row.transport,
    address: row.address,
    locale: row.locale,
    timezone: row.timezone,
    requireOperatorPin: row.require_operator_pin,
    lastSeenAt: asIso(row.last_seen_at),
    credential: row.credential_id
      ? {
          credentialId: row.credential_id,
          issuedAt: asIso(row.issued_at) ?? "",
          issuedBy: row.issued_by,
          issuedByEmail: row.issued_by_email,
          operatingRoleCode: row.operating_role_code ?? "",
          pairingPending: row.pairing_pending === true,
          pairingExpiresAt: asIso(row.pairing_expires_at),
          redeemedAt: asIso(row.redeemed_at),
          revokedAt: asIso(row.revoked_at),
          revokeReason: row.revoke_reason,
        }
      : null,
  };
}

/**
 * The estate an operator sees: the outlet's stations, its displays with their pairing
 * state, and the tier gate. Read-only, `display.view`, and the chain predicate is on every
 * query — §1.6 item 2 in its non-ticket form.
 */
export async function outletDisplayEstate(
  principal: Principal,
  outletId: string
): Promise<DisplayEstate> {
  const db = poolQueryable();
  return outletDisplayEstateIn(db, principal, outletId);
}

/** The same read inside an open transaction, for a caller that already holds one. */
export async function outletDisplayEstateIn(
  db: Queryable,
  principal: Principal,
  outletId: string
): Promise<DisplayEstate> {
  const outlet = await outletContext(db, outletId);
  await guard({
    principal,
    action: "display.view",
    entityType: "display",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    target: `outlet ${outlet.code}`,
  });

  const displayRows = await db.query<DisplayRow>(
    `${DISPLAY_SELECT} where d.chain_id = $1 and d.outlet_id = $2 order by d.kind, d.code`,
    [outlet.chainId, outlet.id]
  );
  const stations = await db.query<{ id: string; code: string; name: string; kind: string; status: string }>(
    `select id, code, name, kind, status from outlet_section
      where chain_id = $1 and outlet_id = $2 order by sort_order, code`,
    [outlet.chainId, outlet.id]
  );
  const entitlement = await displayEntitlement(db, outlet.chainId);
  const gates = estateGateRows(entitlement);
  return {
    outlet: { id: outlet.id, code: outlet.code, name: outlet.name, chainId: outlet.chainId, siteId: outlet.siteId },
    stations,
    displays: displayRows.map(toDisplay),
    entitlement,
    gates,
    // The estate's writes need one of the two features open; with neither, the screen must
    // say which of the two gates is holding each one rather than offering a button the
    // licence does not cover.
    licensed: gates.some((gate) => gate.entitled),
    pairingWindowMinutes: PAIRING_WINDOW_MINUTES,
  };
}

export interface RegisterDisplayInput {
  outletId: string;
  code: string;
  name: string;
  kind: string;
  sectionId?: string | null;
  transport?: string | null;
  address?: string | null;
  locale?: string | null;
  timezone?: string | null;
  requireOperatorPin?: boolean;
}

/**
 * Registers a display on the outlet. `display.manage`, one transaction, one audit row.
 *
 * The kind and transport are validated against the registry here rather than left to the
 * check constraints: a constraint violation reaches an operator as a 500, and these two
 * are the ones a screen can get wrong (the printer's station is the spec's own refusal,
 * `display.validation.printerNeedsSection`).
 */
export async function registerDisplay(
  principal: Principal,
  input: RegisterDisplayInput,
  meta: { source?: "screen" | "chatbot" | "api" | "system"; intent?: string | null } = {}
): Promise<{ id: string; code: string }> {
  const db = poolQueryable();
  const outlet = await outletContext(db, input.outletId);
  await guard({
    principal,
    action: "display.manage",
    entityType: "display",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    target: `outlet ${outlet.code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });
  // The licence and the module switch, in the domain (S-B/2c). Asked before the transaction
  // and before any validation, so a caller on a chain with no entitlement is refused with one
  // `denied` row rather than a 500 from a missing row or an admitted write.
  await assertEstateGateOpenFor(db, principal, {
    action: "display.manage",
    entityType: "display",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new ValidationError("A display needs a code.", { code: "display.validation.codeRequired" });
  if (!name) throw new ValidationError("A display needs a name.", { code: "display.validation.nameRequired" });
  if (!(DISPLAY_KINDS as readonly string[]).includes(input.kind)) {
    throw new ValidationError(`${input.kind} is not a display type`, {
      code: "display.validation.kindUnknown",
      params: { kind: input.kind },
    });
  }
  const kind = input.kind as DisplayKind;
  const transport = (input.transport ?? null) as DisplayTransport | null;
  if (transport !== null && !(DISPLAY_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new ValidationError(`${transport} is not a connection type`, {
      code: "display.validation.transportUnknown",
      params: { transport },
    });
  }
  // The spec's own refusal, in its own words: a printer must be attached to a station.
  if (kind === "printer" && !input.sectionId) {
    throw new ValidationError("A printer must be attached to a station.", {
      code: "display.validation.printerNeedsSection",
    });
  }
  if (kind !== "printer" && transport !== null) {
    throw new ValidationError("Only a printer has a connection type.", {
      code: "display.validation.transportOnlyOnPrinter",
    });
  }

  try {
    const outcome = await auditedMutation({
      principal,
      action: "display.manage",
      entityType: "display",
      chainId: outlet.chainId,
      siteId: outlet.siteId,
      source: meta.source,
      intent: meta.intent ?? null,
      run: async (tx) => {
        if (input.sectionId) {
          const station = await tx.query<{ id: string; code: string }>(
            `select id, code from outlet_section where id = $1 and outlet_id = $2 limit 1`,
            [input.sectionId, outlet.id]
          );
          if (!station[0]) {
            throw new ValidationError("That station is not one of this outlet's stations.", {
              code: "display.validation.sectionNotInOutlet",
            });
          }
        }
        const rows = await tx.query<{ id: string }>(
          `insert into display
             (chain_id, site_id, outlet_id, section_id, code, name, kind, transport, address,
              locale, timezone, require_operator_pin)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning id`,
          [
            outlet.chainId,
            outlet.siteId,
            outlet.id,
            input.sectionId ?? null,
            code,
            name,
            kind,
            transport,
            input.address ?? null,
            input.locale ?? null,
            input.timezone ?? null,
            input.requireOperatorPin === true,
          ]
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("display insert returned no row");
        return {
          entityId: id,
          before: null,
          after: {
            code,
            name,
            kind,
            sectionId: input.sectionId ?? null,
            transport,
            outletCode: outlet.code,
          },
        };
      },
    });
    return { id: outcome.entityId ?? "", code };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw new ValidationError(`This outlet already has a display with the code ${code}.`, {
        code: "display.validation.codeTaken",
        params: { code },
      });
    }
    throw error;
  }
}

/**
 * The operating role a device's audit rows carry, when the caller does not name one
 * (O2 note: the terminal acts as the function that works that station).
 *
 * SPEC-GAP, decided here and worth the lead's eye: §2.4 says the role code comes from "the
 * station's operating role code" and names `SITE_CULINARY_TEAM` for a kitchen screen, but
 * it does not say where a CDS, a status board or a printer gets one — their station has no
 * operating role of its own. The default below is the function that owns that surface, and
 * pairing accepts any real role code (`display_credential.operating_role_code` is a foreign
 * key onto `role.code`, so an invented code cannot be stored).
 */
export function defaultOperatingRole(kind: string): string {
  switch (kind) {
    case "kds":
      return "SITE_CULINARY_TEAM";
    case "status":
      return "SITE_OPERATIONS_TEAM";
    case "cds":
      return "SITE_OPERATIONS_TEAM";
    case "printer":
      return "SITE_CULINARY_TEAM";
    default:
      // Fail closed, like `displayCapabilities`: a kind the platform does not know gets no
      // operating role, so a terminal cannot be provisioned under a role it did not earn.
      // (Unreachable through `registerDisplay`, which validates the kind, and through the
      // check constraint on `display.kind` — which is exactly why this is a programming
      // error and not a fallback.)
      throw new ValidationError("This display's type is not one the platform knows.", {
        code: "display.validation.kindUnknown",
        params: { kind },
      });
  }
}

/** How long a pairing code is good for. A person is standing at the terminal. */
export const PAIRING_WINDOW_MINUTES = 10;

export interface PairingIssue {
  credentialId: string;
  displayId: string;
  displayCode: string;
  /** Returned **once**, to the person who issued it. Only its digest is stored. */
  pairingCode: string;
  expiresAt: string;
  /** The credential this issue revoked, when the terminal was re-paired (O12 rotation). */
  revokedCredentialId: string | null;
}

/**
 * Issues a single-use pairing code for a display, revoking any live credential first.
 *
 * One transaction, one audit row. The audit row records that a credential was issued, to
 * which display and by whom — and **not the code**, because the ledger is readable by
 * people who must not be able to pair a terminal with it.
 */
export async function pairDisplay(
  principal: Principal,
  input: { displayId: string; operatingRoleCode?: string },
  meta: { source?: "screen" | "chatbot" | "api" | "system"; intent?: string | null } = {}
): Promise<PairingIssue> {
  const db = poolQueryable();
  const display = await displayContext(db, input.displayId);
  await guard({
    principal,
    action: "display.manage",
    entityType: "display_credential",
    chainId: display.chainId,
    siteId: display.siteId,
    target: `display ${display.code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  // Pairing is provisioning, and provisioning is gated (S-B/2c): no licence, no pairing code.
  // A terminal is the thing that acts on a chain's work, so a chain that has not bought the
  // module must not be able to mint one through an API call the screen never offered.
  await assertEstateGateOpenFor(db, principal, {
    action: "display.manage",
    entityType: "display_credential",
    entityId: display.id,
    chainId: display.chainId,
    siteId: display.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const code = newPairingCode();
  const outcome = await auditedMutation({
    principal,
    action: "display.manage",
    entityType: "display_credential",
    chainId: display.chainId,
    siteId: display.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
    run: async (tx) => {
      const live = await tx.query<{ id: string }>(
        `select id from display_credential
          where display_id = $1 and token_hash is not null and revoked_at is null`,
        [display.id]
      );
      let revokedId: string | null = null;
      for (const row of live) {
        // Rotation, not accumulation (O12): the previous terminal stops working the moment
        // a new pairing code is issued, so a lost terminal is a re-pair away from dead.
        await tx.query(
          `update display_credential
              set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = $3
            where id = $1`,
          [row.id, principal.userId, "re-paired"]
        );
        revokedId = row.id;
      }
      const rows = await tx.query<{ id: string; pairing_expires_at: Date }>(
        `insert into display_credential
           (display_id, chain_id, pairing_code_hash, pairing_expires_at, operating_role_code, issued_by_user_id)
         values ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5, $6)
         returning id, pairing_expires_at`,
        [
          display.id,
          display.chainId,
          sha256(code),
          String(PAIRING_WINDOW_MINUTES),
          input.operatingRoleCode ?? defaultOperatingRole(display.kind),
          principal.userId,
        ]
      );
      const row = rows[0];
      if (!row) throw new Error("display_credential insert returned no row");
      return {
        entityId: row.id,
        before: revokedId ? { revokedCredentialId: revokedId } : null,
        // The code itself is deliberately absent: an audit row is readable by people who
        // must not be able to pair a terminal with it.
        after: {
          displayCode: display.code,
          kind: display.kind,
          operatingRoleCode: input.operatingRoleCode ?? defaultOperatingRole(display.kind),
          expiresAt: row.pairing_expires_at.toISOString(),
        },
      };
    },
  });

  const after = outcome.after as {
    displayCode: string;
    operatingRoleCode: string;
    expiresAt: string;
  };
  return {
    credentialId: outcome.entityId ?? "",
    displayId: display.id,
    displayCode: after.displayCode,
    pairingCode: code,
    expiresAt: after.expiresAt,
    revokedCredentialId:
      (outcome.before as { revokedCredentialId?: string } | null)?.revokedCredentialId ?? null,
  };
}

export interface RedeemedTerminal {
  displayId: string;
  displayCode: string;
  kind: DisplayKind;
  chainId: string;
  outletId: string;
  sectionId: string | null;
  operatingRoleCode: string;
  credentialId: string;
  /** Returned **once**, to the terminal. Only its digest is stored. */
  token: string;
}

/**
 * The terminal's own step: redeem the single-use code for a device token.
 *
 * There is no user principal here — possession of the code is the whole credential — so
 * this is the one function in the module that is not behind `guard()`. Its checks are the
 * spec's: the code is single-use (cleared on redemption), it expires, the display must be
 * active, and the credential's chain is the display's chain (a database invariant, and
 * re-checked here because §1.6 item 4 says so).
 *
 * The success is audited with the **device** actor: `actor_user_id` null, the credential's
 * operating role code, `reason` carrying `display:<code>`. Like every device row, it does
 * not name the person who typed the code (O2) — the pairing record names who issued it.
 */
export async function redeemPairingCode(code: string): Promise<RedeemedTerminal | null> {
  const token = newSessionToken();
  return withTransaction(async (tx) => {
    const rows = await tx.query<{
      credential_id: string;
      chain_id: string;
      credential_chain_id: string;
      operating_role_code: string;
      display_id: string;
      code: string;
      kind: string;
      status: string;
      outlet_id: string;
      section_id: string | null;
      expired: boolean;
    }>(
      `select c.id as credential_id, c.chain_id as credential_chain_id, c.operating_role_code,
              d.id as display_id, d.chain_id, d.code, d.kind, d.status, d.outlet_id, d.section_id,
              (c.pairing_expires_at is not null and c.pairing_expires_at < now()) as expired
         from display_credential c
         join display d on d.id = c.display_id
        where c.pairing_code_hash = $1 and c.revoked_at is null
        limit 1`,
      [sha256(code.trim())]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expired) return null;
    if (row.status !== "active") return null;
    if (row.chain_id !== row.credential_chain_id) return null;

    await tx.query(
      `update display_credential
          set token_hash = $2, pairing_code_hash = null, pairing_expires_at = null, redeemed_at = now()
        where id = $1`,
      [row.credential_id, sha256(token)]
    );
    await tx.query(`update display set last_seen_at = now(), updated_at = now() where id = $1`, [
      row.display_id,
    ]);
    await writeAudit(tx, {
      device: { roleCode: row.operating_role_code, displayCode: row.code },
      action: "display.pair",
      entityType: "display_credential",
      entityId: row.credential_id,
      chainId: row.chain_id,
      siteId: null,
      outcome: "success",
      reason: "pairing code redeemed; the code is cleared and only the token digest is stored",
      source: "system",
    });
    return {
      displayId: row.display_id,
      displayCode: row.code,
      kind: row.kind as DisplayKind,
      chainId: row.chain_id,
      outletId: row.outlet_id,
      sectionId: row.section_id,
      operatingRoleCode: row.operating_role_code,
      credentialId: row.credential_id,
      token,
    };
  });
}

/** Withdraws a terminal's access. One transaction, one audit row, and the terminal stops. */
export async function revokeDisplayCredential(
  principal: Principal,
  input: { displayId: string; reason: string },
  meta: { source?: "screen" | "chatbot" | "api" | "system"; intent?: string | null } = {}
): Promise<void> {
  const db = poolQueryable();
  const display = await displayContext(db, input.displayId);
  await guard({
    principal,
    action: "display.manage",
    entityType: "display_credential",
    chainId: display.chainId,
    siteId: display.siteId,
    target: `display ${display.code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });
  if (!input.reason.trim()) {
    throw new ValidationError("Withdrawing access needs a reason.", {
      code: "display.validation.revokeReasonRequired",
    });
  }

  await auditedMutation({
    principal,
    action: "display.manage",
    entityType: "display_credential",
    chainId: display.chainId,
    siteId: display.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
    run: async (tx) => {
      const live = await tx.query<{ id: string }>(
        `select id from display_credential
          where display_id = $1 and token_hash is not null and revoked_at is null
          for update`,
        [display.id]
      );
      const row = live[0];
      if (!row) {
        // Nothing to withdraw is a validation refusal: nothing written, no ledger gap.
        throw new ValidationError("This terminal has no active access to withdraw.", {
          code: "display.validation.noLiveCredential",
        });
      }
      await tx.query(
        `update display_credential
            set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = $3
          where id = $1`,
        [row.id, principal.userId, input.reason.trim()]
      );
      return { entityId: row.id, before: { revokedAt: null }, after: { revokedAt: "now", reason: input.reason.trim() } };
    },
  });
}

/**
 * Deactivates a display and, in the same transaction and the same audit row, withdraws any
 * live terminal access. One decision, one row: splitting it into two mutations would put
 * two ledger entries against one human act and let a screen do half of it.
 */
export async function deactivateDisplay(
  principal: Principal,
  input: { displayId: string; reason: string },
  meta: { source?: "screen" | "chatbot" | "api" | "system"; intent?: string | null } = {}
): Promise<void> {
  const db = poolQueryable();
  const display = await displayContext(db, input.displayId);
  await guard({
    principal,
    action: "display.manage",
    entityType: "display",
    chainId: display.chainId,
    siteId: display.siteId,
    target: `display ${display.code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });
  if (!input.reason.trim()) {
    throw new ValidationError("Deactivating a display needs a reason.", {
      code: "display.validation.deactivateReasonRequired",
    });
  }

  await auditedMutation({
    principal,
    action: "display.manage",
    entityType: "display",
    chainId: display.chainId,
    siteId: display.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
    run: async (tx) => {
      const rows = await tx.query<{ status: string }>(
        `update display
            set status = 'inactive', updated_at = now()
          where id = $1 and chain_id = $2
          returning status`,
        [display.id, display.chainId]
      );
      if (!rows[0]) throw new NotFound("Display", display.id);
      const revoked = await tx.query<{ id: string }>(
        `update display_credential
            set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = $3
          where display_id = $1 and revoked_at is null
          returning id`,
        [display.id, principal.userId, input.reason.trim()]
      );
      return {
        entityId: display.id,
        before: { status: display.status },
        after: {
          status: "inactive",
          reason: input.reason.trim(),
          revokedCredentialIds: revoked.map((row) => row.id),
        },
      };
    },
  });
}

interface DisplayContext {
  id: string;
  code: string;
  kind: DisplayKind;
  status: string;
  chainId: string;
  siteId: string;
  outletId: string;
}

/**
 * The display's own tenant context, read from the row — §1.6 item 1's rule applied to a
 * person's mutation as well, so a crafted `displayId` is resolved and then checked rather
 * than trusted.
 */
async function displayContext(db: Queryable, displayId: string): Promise<DisplayContext> {
  const rows = await db.query<{
    id: string;
    code: string;
    kind: string;
    status: string;
    chain_id: string;
    site_id: string;
    outlet_id: string;
  }>(`select id, code, kind, status, chain_id, site_id, outlet_id from display where id = $1 limit 1`, [
    displayId,
  ]);
  const row = rows[0];
  if (!row) throw new NotFound("Display", displayId);
  return {
    id: row.id,
    code: row.code,
    kind: row.kind as DisplayKind,
    status: row.status,
    chainId: row.chain_id,
    siteId: row.site_id,
    outletId: row.outlet_id,
  };
}
