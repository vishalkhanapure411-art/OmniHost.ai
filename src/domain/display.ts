/**
 * The display layer's shared vocabulary: what the kinds and codes are, what a device
 * principal looks like, and which catalog key words each refusal.
 *
 * **Why this module imports nothing.** The same reason `~/domain/nav` and
 * `~/domain/principal` do: routes and components are module-scope, client-retained code,
 * and a *type* is only erased if the module it is declared in can be loaded without side
 * effects. A station display screen (S-C) asks for `DisplayKind`, the shape of a device
 * principal and the sentence a refusal carries; if those lived beside code that imports
 * `pg` or `node:crypto`, asking for the type would drag the driver into the client bundle
 * and the production build would fail to hydrate. So the vocabulary lives here and the
 * enforcement lives in `~/server/display-device` (server-only).
 *
 * DESIGN-kds-and-ticket-routing.md §1.2 fixes the three words this file encodes: a
 * **section** is a production area (`outlet_section`, and for the pilot a station *is* a
 * section, D1); a **station** is the routing target for a line; a **display** is a device.
 * Nothing here is a screen.
 */

/** A device record's kind — `display.kind` in migration 0011. */
export const DISPLAY_KINDS = ["kds", "cds", "status", "printer"] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];

/** How a printer's job leaves the platform. Printer-only (§1.3(b), enforced by a check). */
export const DISPLAY_TRANSPORTS = ["kds_hosted", "lan_escpos", "print_agent"] as const;
export type DisplayTransport = (typeof DISPLAY_TRANSPORTS)[number];

/**
 * Why a line was routed where it was — recorded on the line at fire and **never**
 * recomputed (D4, §1.4). The order of these four is the resolution order, and the fourth
 * is the one that must stay visible: an unrouted line is configuration debt, not a
 * silent drop.
 */
export const TICKET_ROUTE_SOURCES = [
  "article_route",
  "category_default",
  "expedite_fallback",
  "unrouted",
] as const;
export type TicketRouteSource = (typeof TICKET_ROUTE_SOURCES)[number];

/**
 * A route source is a code in the database and a sentence on a screen. One key per
 * source, an explicit map, and no fallback — a key built from data (`route.source.${code}`)
 * fails *open* and prints the key, which is the class of defect the copy sweep put 55
 * call sites behind (FINDINGS-label-fallback-sweep.md; DECISIONS rules 1 and 2).
 */
export const ROUTE_SOURCE_LABEL_KEY: Record<TicketRouteSource, string> = {
  article_route: "route.source.article_route",
  category_default: "route.source.category_default",
  expedite_fallback: "route.source.expedite_fallback",
  unrouted: "route.source.unrouted",
};

/** The one sentence each capability refusal reaches a screen as (§6.4). */
export const DISPLAY_REFUSAL_KEY = {
  notYourStation: "kds.refusal.notYourStation",
  noStationOnTerminal: "kds.refusal.noStationOnTerminal",
  /**
   * Added to §6.4's list, and said so here rather than borrowed from a neighbour: the
   * spec's sentences cover a wrong station, a terminal with no station, a voided ticket
   * and a recall, but not "this terminal is not configured for that action at all" — which
   * is what a CDS or a printer reaching a ticket action must be told. Using
   * `notYourStation` there would be a false statement about the device.
   */
  actionNotOnTerminal: "kds.refusal.actionNotOnTerminal",
  offlineCannotCreate: "kds.refusal.offlineCannotCreate",
  duplicatePrimaryRoute: "route.validation.duplicatePrimary",
  printerNeedsSection: "display.validation.printerNeedsSection",
} as const;
export type DisplayRefusalKey = (typeof DISPLAY_REFUSAL_KEY)[keyof typeof DISPLAY_REFUSAL_KEY];

/**
 * The one section kind that means "the pass" (§1.4's expedite fallback, D27). Named here
 * rather than spelled `'expedite'` in two modules: the serve grant below and the routing
 * fallback ask the same question about the same column.
 */
export const EXPEDITE_SECTION_KIND = "expedite";

/**
 * The fixed, enumerated capability set of a device principal (D26, §2.4 item 2).
 *
 * A fixed terminal has no person logged in, so it is *not* given a person's roles: it gets
 * exactly what its kind needs and nothing else. A printer acts on nothing — it receives print
 * jobs (S-E) — and a CDS reads only its own guest surface.
 *
 * **A `kds` display holds the five ticket acts the kitchen actually performs** (lead ruling,
 * 1 Oct 2026 — DECISIONS.md §"The display layer's capability set, reason codes and replay
 * key", rulings 1 and 2): view, advance (T2/T3/T4), **recall** (T5, R on the keyboard map) and
 * **void** (T7, V) — with a reason. Until this slice the kds set was view + advance only, so a
 * kitchen that marked a ticket ready by mistake could neither recall nor void it, and the
 * design's own keyboard map had two dead keys.
 *
 * **Re-route (T9) is deliberately absent from every device set.** It is a configuration act —
 * §2.3 names Site Head for it — so a terminal is refused it with `actionNotOnTerminal`, which
 * is a statement about the device rather than a lie about the ticket.
 *
 * **`serve` (T6) hangs on the station's section kind, not on the display kind.** The pass is a
 * `kds` display whose *section* is the outlet's `expedite` section (D27; the same section
 * `~/domain/display-routing` falls an unrouted line to), so the second argument is the section
 * kind the resolver read from `outlet_section.kind`. That is why this signature takes it: the
 * ruling keeps the four display kinds and needs one fact the display row does not carry.
 * Without an `expedite` section a kds display holds no serve code — fail closed, like
 * everything else here.
 *
 * **This function fails closed.** An unrecognised kind gets an empty set, never a generous
 * default: the alternative is that a mistyped `kind` silently receives the station's
 * rights (the same failure shape as the tier coercion `parseTier` removed).
 */
export function displayCapabilities(kind: string, sectionKind?: string | null): readonly string[] {
  switch (kind) {
    case "kds": {
      const acts: string[] = [
        "kds.ticket.view",
        "kds.ticket.advance",
        "kds.ticket.recall",
        "kds.ticket.void",
      ];
      // Ruling 2: only the pass serves, and the pass is known by its station's kind. A
      // station-attached screen serving *another* station is refused by the scope check in
      // `assertDeviceMayActOn`, not by this set — a `kds` screen on the grill holds no serve
      // code at all, which is the first of the two refusals.
      if (sectionKind === EXPEDITE_SECTION_KIND) acts.push("kds.ticket.serve");
      return acts;
    }
    case "cds":
      return ["cds.display.view"];
    // SPEC-GAP, decided here: the status board reads tickets outlet-wide and acts on
    // nothing (D28). §2.4 enumerates station, expedite and CDS principals and leaves the
    // board implicit; read-only is the only set consistent with "read-only" in D28.
    case "status":
      return ["kds.ticket.view"];
    // A printer receives work the server hands it. It polls for nothing and transitions
    // nothing, so it holds nothing.
    case "printer":
      return [];
    default:
      return [];
  }
}

/** True for a kind that acts on a station's work (as opposed to reading or printing). */
export function isStationScopedKind(kind: string): boolean {
  return kind === "kds";
}

/**
 * A resolved device identity.
 *
 * `chainId`, `siteId`, `outletId` and `sectionId` come from the `display` row and from
 * nowhere else — §1.6 item 1: *the device principal is resolved from the display row,
 * never from a request parameter*, so a request cannot name its own outlet or station.
 * There is deliberately no field here a caller could supply.
 */
export interface DevicePrincipal {
  credentialId: string;
  displayId: string;
  code: string;
  name: string;
  kind: DisplayKind;
  /** Tenant scope, read from the display row. Never null: a display always belongs to a chain. */
  chainId: string;
  siteId: string;
  outletId: string;
  /** Null for an outlet-scope display: a pass screen, a guest display, a status board. */
  sectionId: string | null;
  /**
   * The *kind* of that section (`outlet_section.kind`), read from the row with it: `kitchen`,
   * `grill`, `expedite` … It is carried because it decides one capability — the pass's serve
   * grant (ruling 2, 1 Oct 2026) — and because a screen that says "this is the pass" should be
   * reading the database rather than inferring it. Null exactly when `sectionId` is null.
   */
  sectionKind: string | null;
  /** The role code this device's audit rows carry (§2.4 item 2). Never a person. */
  operatingRoleCode: string;
  /** Fixed by kind — see `displayCapabilities`. */
  capabilities: readonly string[];
}

/**
 * How a device's audit row is addressed: `actor_user_id` is null (nobody was logged in),
 * the role code is the station's operating role, and `reason` carries `display:<code>` so
 * the trail names the device (D26). Nothing may describe such a row as naming a person —
 * O2 is an open question precisely because it does not.
 */
export function deviceAuditReference(device: Pick<DevicePrincipal, "code">): string {
  return `display:${device.code}`;
}
