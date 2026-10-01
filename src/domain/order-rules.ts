/**
 * The booking side's shared vocabulary: what the codes are, what the arithmetic is, and
 * which catalog key words each state and each refusal (DESIGN-kds-and-ticket-routing.md
 * §2.1, slice S-B part 1).
 *
 * **Why this module imports nothing.** The same reason `~/domain/display`, `~/domain/nav`
 * and `~/domain/principal` do: routes and components are module-scope, client-retained
 * code, and a *type* is only erased if the module it is declared in can be loaded without
 * side effects. The booking screen (S-B/3) asks for `OrderOrigin`, the money conversion
 * and the sentence a refusal carries; if those lived beside code that imports `pg`, asking
 * for the type would drag the driver into the client bundle and the production build would
 * fail to hydrate. So the vocabulary and the arithmetic live here, and the reads and writes
 * live in `~/domain/order.ts` (server-only).
 *
 * Two rules from the team's own decisions are encoded here rather than left to a component:
 *
 *   * **Money is an integer number of minor units plus an ISO 4217 code** — never a float,
 *     never a bare number. `toMinorUnits` is the one place a `numeric` master-data amount
 *     becomes an integer, and it returns `null` for a currency it does not know rather than
 *     guessing two decimal places.
 *   * **Codes stay codes where a code is the subject; everything a person reads is words.**
 *     Every state and every origin has an explicit label key and there is no `?? fallback`
 *     anywhere in this file: the label-fallback sweep
 *     (`/home/team/shared/evidence/FINDINGS-label-fallback-sweep.md`) found the same rule
 *     broken at 55 call sites, all of the shape `MAP[code] ?? another label`, and a state
 *     that renders as a *different, real* state is worse than one that renders as nothing.
 *     So the lookups here return `null` for a code they do not know, and the caller decides.
 */

/** Where a booking came from. A channel, not a device. `order.origin` in migration 0012. */
export const ORDER_ORIGINS = ["pos", "kiosk", "tab", "guest_app", "chat"] as const;
export type OrderOrigin = (typeof ORDER_ORIGINS)[number];

/**
 * The outlet order's states (§2.1). `draft` and `rejected` exist in the spec's list but
 * are not reachable in this slice: a booking is written at `placed` and a rejection today
 * is a cancel before fire.
 */
export const OUTLET_ORDER_STATUSES = [
  "placed",
  "accepted",
  "fired",
  "in_progress",
  "ready",
  "served",
  "closed",
  "cancelled",
] as const;
export type OutletOrderStatus = (typeof OUTLET_ORDER_STATUSES)[number];

/** A line's own state. Derivable from its ticket's state in the pilot; stored per §2.1. */
export const ORDER_LINE_STATES = [
  "placed",
  "fired",
  "in_prep",
  "ready",
  "served",
  "voided",
  "held_unavailable",
] as const;
export type OrderLineState = (typeof ORDER_LINE_STATES)[number];

/**
 * The order-side lifecycle, as one table: which state each act may start from and the
 * capability it needs (§2.1 acceptance, §2.3 T11, §2.4).
 *
 * It is data rather than a chain of `if`s because the refusal kind depends on it: a
 * transition attempted from a state it does not list is a **validation** refusal — nothing
 * written at all — and the screen's sentence says the booking has moved on. That is the
 * same shape the ticket transitions use (`state = $expected` matching zero rows).
 */
export interface OrderTransitionRule {
  /** The act, and the `intent` its audit row carries (§2.3's audit column). */
  intent: string;
  capability: string;
  from: readonly OutletOrderStatus[];
  to: OutletOrderStatus;
}

export const ORDER_TRANSITIONS: Record<"accept" | "cancel" | "close" | "fire", OrderTransitionRule> = {
  accept: { intent: "order.accept", capability: "order.book", from: ["placed"], to: "accepted" },
  // §2.3 T1 — Fire. It is in this table because it is the same kind of fact as the other
  // three (a state the booking may move from, the capability that permits it, the state it
  // lands in), even though the work it does is much larger: it writes the tickets. The
  // `from` list is what the fire path quotes when it refuses a booking that has already
  // moved on. Only `accepted` is listed: §2.1's reachable states in this slice fire from
  // `accepted`, and `placed` never survives a booking's own transaction (acceptance is
  // written in it — O13).
  fire: { intent: "order.fire", capability: "order.fire", from: ["accepted"], to: "fired" },
  // Cancel before fire only. After fire the tickets exist and the honest act is a ticket
  // void (T7), which is the station's, not the booking's (§2.1's own wording).
  cancel: {
    intent: "order.cancel",
    capability: "order.cancel",
    from: ["placed", "accepted"],
    to: "cancelled",
  },
  close: { intent: "order.close", capability: "order.close", from: ["served"], to: "closed" },
};

/** The `intent` the booking's own audit rows carry. */
export const ORDER_INTENTS = {
  place: "order.place",
  accept: "order.accept",
  cancel: "order.cancel",
  close: "order.close",
  /** §2.3 T1. The same intent on the booking's row and on each ticket's row: the act is one. */
  fire: "order.fire",
} as const;

/**
 * A ticket's states (§2.2, §2.3). The lifecycle's alphabet — **not** the state machine:
 * which transition may start from which state, and the capability each needs, is §2.3's
 * table and S-B/2b's code. Kept here, in the import-free module, because the station
 * display (S-C) asks for `TicketState` and the seven words it may show.
 */
export const TICKET_STATES = [
  "queued",
  "acknowledged",
  "in_prep",
  "ready",
  "served",
  "voided",
  "held_unavailable",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/**
 * §2.3's transition labels, as the ledger and the journal name them (T1 fire … T11 close).
 * A code, because a code is the subject here: a screen words it from the catalogue (S-B/2b
 * writes T2–T11; T1 is the fire path's).
 *
 * **T8 (`hold_unavailable`) and T10 (re-fire/print) are deliberately absent.** §2.3 lists
 * eleven transitions and S-B/2b builds the eight that change a ticket's life without a
 * printer or an 86: T8 needs the availability path (its own slice) and T10 is S-E's print
 * job, which is not a state change at all. A code nothing writes is a promise the platform
 * cannot keep, so the two are named here and not registered.
 */
export const TICKET_TRANSITION_CODES = {
  fire: "T1",
  acknowledge: "T2",
  start: "T3",
  ready: "T4",
  recall: "T5",
  serve: "T6",
  void: "T7",
  reroute: "T9",
  close: "T11",
} as const;

/** The acts the ticket lifecycle records, for a read-back or a screen that lists them. */
export type TicketTransitionName = keyof typeof TICKET_TRANSITION_CODES;

/**
 * §2.3's lifecycle as one table: which state an act may start from, where it lands, and the
 * capability it needs. Data rather than a chain of `if`s, for the same reason
 * `ORDER_TRANSITIONS` is: **the refusal kind depends on it.** A transition attempted from a
 * state it does not list is a *validation* refusal — nothing written at all, not even a
 * ledger row — and the sentence says where the ticket has got to instead.
 *
 * The `from` lists are §2.3's own, read literally:
 *   * T2 acknowledge takes `queued` only. Acknowledge is the optional claim, so an already
 *     acknowledged ticket is not acknowledged twice.
 *   * T3 start takes `queued` **or** `acknowledged`: this is the kitchen's one tap, and the
 *     fast path deliberately skips the claim (D8).
 *   * T4 ready takes `in_prep` only.
 *   * T5 recall takes `ready` only. From `served` there is nothing to recall — the food left
 *     the pass — and §2.3 says the honest act there is a void plus a new ticket.
 *   * T6 serve takes `ready` only: nothing goes to the pass before it is ready.
 *   * T7 void takes every **non-terminal** state. `served` is excluded on purpose (§2.3's
 *     own sentence and §2.7's example): voiding served work is a different act with a
 *     different remedy, and the copy says so.
 *   * T9 re-route leaves the state alone and takes the three states before `ready`. Once a
 *     ticket is ready the food exists at that station, so moving the *ticket* would move a
 *     record and not the plate; that call is a choice §2.3 leaves open, and it is the
 *     conservative one.
 *   * T11 close is the booking's own act (`from: ["served"]`, in `ORDER_TRANSITIONS`); the
 *     row below exists so a read-back or a screen can list all of §2.3 in one place, and
 *     `closeOutletOrder` in `~/domain/order` is the code that performs it.
 */
export interface TicketTransitionRule {
  /** §2.3's row label — the `transition_code` the journal stores. */
  code: string;
  /** The act, and the `intent` its audit row carries. */
  intent: string;
  capability: string;
  from: readonly TicketState[];
  /** `null` for T9, the one transition that changes the ticket without changing its state. */
  to: TicketState | null;
  /** True when the act writes a `reason_code` into the journal — and, for a void, the ticket. */
  needsReason: boolean;
}

export const TICKET_TRANSITIONS: Record<
  "acknowledge" | "start" | "ready" | "recall" | "serve" | "void" | "reroute",
  TicketTransitionRule
> = {
  acknowledge: {
    code: TICKET_TRANSITION_CODES.acknowledge,
    intent: "ticket.acknowledge",
    capability: "kds.ticket.advance",
    from: ["queued"],
    to: "acknowledged",
    needsReason: false,
  },
  start: {
    code: TICKET_TRANSITION_CODES.start,
    intent: "ticket.start",
    capability: "kds.ticket.advance",
    from: ["queued", "acknowledged"],
    to: "in_prep",
    needsReason: false,
  },
  ready: {
    code: TICKET_TRANSITION_CODES.ready,
    intent: "ticket.ready",
    capability: "kds.ticket.advance",
    from: ["in_prep"],
    to: "ready",
    needsReason: false,
  },
  recall: {
    code: TICKET_TRANSITION_CODES.recall,
    intent: "ticket.recall",
    capability: "kds.ticket.recall",
    from: ["ready"],
    to: "in_prep",
    needsReason: true,
  },
  serve: {
    code: TICKET_TRANSITION_CODES.serve,
    intent: "ticket.serve",
    capability: "kds.ticket.serve",
    from: ["ready"],
    to: "served",
    needsReason: false,
  },
  void: {
    code: TICKET_TRANSITION_CODES.void,
    intent: "ticket.void",
    capability: "kds.ticket.void",
    from: ["queued", "acknowledged", "in_prep", "ready"],
    to: "voided",
    needsReason: true,
  },
  reroute: {
    code: TICKET_TRANSITION_CODES.reroute,
    intent: "ticket.reroute",
    capability: "kds.ticket.reroute",
    // No `to`: a re-route changes the station and leaves the state where it is (§2.3 T9).
    from: ["queued", "acknowledged", "in_prep"],
    to: null,
    needsReason: true,
  },
};

/** T11's rule, quoted from the order side so one table describes all of §2.3. */
export const TICKET_CLOSE_RULE = {
  code: TICKET_TRANSITION_CODES.close,
  intent: ORDER_INTENTS.close,
  capability: "order.close",
  from: ["served"] as readonly string[],
  to: "closed" as const,
};

/**
 * The reason codes each reasoned act offers, and the only ones it accepts.
 *
 * **Why a closed list rather than free text.** A reason code is our vocabulary, not the
 * operator's prose: it is counted ("how many tickets were voided as dropped this week?"),
 * and it is rendered through a catalogue key so no screen ever prints a machine value as if
 * it were English (the fail-open class the copy sweep found 55 times). An unregistered code
 * is therefore refused — a validation refusal that writes nothing — rather than stored and
 * later rendered as `unknown_reason` at a person.
 *
 * The list is deliberately short and is **this slice's own**: §6.4 names the refusal
 * sentences but no reason codes, so these are named here; a rename later is a catalogue edit
 * and a row in this map, not a redesign.
 */
export const TICKET_REASON_CODES = {
  recall: ["marked_ready_in_error", "quality_check_failed"],
  void: ["dropped", "guest_cancelled", "article_unavailable", "duplicate_ticket"],
  reroute: ["wrong_station", "station_unavailable"],
} as const;

export type TicketReasonAct = keyof typeof TICKET_REASON_CODES;

/** The codes one act accepts, as a readonly array of its own union. */
export function ticketReasonCodes(act: TicketReasonAct): readonly string[] {
  return TICKET_REASON_CODES[act];
}

/** The label key for a reason code, or `null` for a code this build does not know. */
export function ticketReasonLabelKey(code: string): string | null {
  return TICKET_REASON_LABEL_KEY[code] ?? null;
}

export const TICKET_REASON_LABEL_KEY: Record<string, string> = {
  marked_ready_in_error: "ticket.reason.marked_ready_in_error",
  quality_check_failed: "ticket.reason.quality_check_failed",
  dropped: "ticket.reason.dropped",
  guest_cancelled: "ticket.reason.guest_cancelled",
  article_unavailable: "ticket.reason.article_unavailable",
  duplicate_ticket: "ticket.reason.duplicate_ticket",
  wrong_station: "ticket.reason.wrong_station",
  station_unavailable: "ticket.reason.station_unavailable",
};

/**
 * A ticket state code is a code in the database and a word on a screen. One key per state,
 * an explicit map, **no fallback** — the same discipline `ORDER_STATUS_LABEL_KEY` follows.
 * `ticket.state.*` rather than `order.line.state.*` is §6.3's own named key space.
 */
export const TICKET_STATE_LABEL_KEY: Record<TicketState, string> = {
  queued: "ticket.state.queued",
  acknowledged: "ticket.state.acknowledged",
  in_prep: "ticket.state.in_prep",
  ready: "ticket.state.ready",
  served: "ticket.state.served",
  voided: "ticket.state.voided",
  held_unavailable: "ticket.state.held_unavailable",
};

/** The label key for a ticket state, or `null` — never a neighbouring state's word. */
export function ticketStateLabelKey(state: string): string | null {
  return (TICKET_STATE_LABEL_KEY as Record<string, string | undefined>)[state] ?? null;
}

/**
 * §2.3's acts in words, one key per transition code. The code stays the code in the journal
 * and in an identifier position; this is what a button or a ledger line reads as.
 */
export const TICKET_TRANSITION_LABEL_KEY: Record<string, string> = {
  [TICKET_TRANSITION_CODES.acknowledge]: "ticket.action.acknowledge",
  [TICKET_TRANSITION_CODES.start]: "ticket.action.start",
  [TICKET_TRANSITION_CODES.ready]: "ticket.action.ready",
  [TICKET_TRANSITION_CODES.recall]: "ticket.action.recall",
  [TICKET_TRANSITION_CODES.serve]: "ticket.action.serve",
  [TICKET_TRANSITION_CODES.void]: "ticket.action.void",
  [TICKET_TRANSITION_CODES.reroute]: "ticket.action.reroute",
  [TICKET_TRANSITION_CODES.close]: "ticket.action.close",
};

/** The label key for a transition code, or `null` — never a neighbouring act's word. */
export function ticketTransitionLabelKey(code: string): string | null {
  return TICKET_TRANSITION_LABEL_KEY[code] ?? null;
}

/**
 * The validation refusals the ticket lifecycle raises, each with the sentence it reads as.
 *
 * Four of them are §6.4's own sentences (`kds.refusal.movedOn`, `voidedTicket`,
 * `heldTicket`, `recallFromServed`) and keep the designer's wording verbatim — the rest are
 * additions in the same shape, each marked as one where it is declared in the catalog. A
 * **validation** refusal aborts its transaction and writes nothing at all, so these
 * sentences are the only record the act leaves; every one of them says what to do next.
 *
 * `params.state` carries a *state code*, and the screen words it through
 * `ticketStateLabelKey` — the domain has no locale and must not invent one.
 */
export const TICKET_VALIDATION_KEY = {
  /** The ticket moved on: zero rows matched the state the caller expected (§2.3's rule). */
  movedOn: "kds.refusal.movedOn",
  /** T2–T4 against a voided ticket. */
  voided: "kds.refusal.voidedTicket",
  /** T2–T4 against a held ticket — §2.6's decision comes first. */
  held: "kds.refusal.heldTicket",
  /** T5 from `served`: the honest act is a void plus a new ticket (§2.3). */
  recallFromServed: "kds.refusal.recallFromServed",
  /** T7 against a `served` ticket: the food left the pass. Addition to §6.4. */
  voidServed: "ticket.validation.voidServed",
  /** No reason code at all where one is required (§2.3's reason column). */
  reasonRequired: "order.validation.reasonRequired",
  /** A reason code this act does not offer. Addition to §6.4. */
  reasonUnknown: "ticket.validation.reasonUnknown",
  /** T9 with no target station. Addition to §6.4. */
  rerouteTargetRequired: "ticket.validation.rerouteTargetRequired",
  /** T9 to the station the ticket is already on. Addition to §6.4. */
  rerouteSameStation: "ticket.validation.rerouteSameStation",
  /** T9 to a station that already has a ticket for this booking (the D5 one-ticket rule). */
  rerouteStationTaken: "ticket.validation.rerouteStationTaken",
  /** The same fact as the one-ticket-per-station key sees it, when the write raced the check. */
  rerouteStationBusy: "ticket.validation.rerouteStationBusy",
  /** The ticket is not one this caller's tenant may touch — worded, never confirmed. */
  crossTenant: "kds.refusal.notYourStation",
} as const;

/**
 * The **fire path's** validation refusals (§1.4, §2.2, §2.5, §2.6 case 1), each with the
 * sentence it reads as in `~/domain/ticket`.
 *
 * **Catalogue entries for these land with S-B/2b/S-C, not here** — deliberately, and this
 * delegation's own instruction: a catalogue key exists for copy a surface consumes, and no
 * screen fires a booking in S-B/2a. The strings are the codes a refusal reaches a screen as
 * (the same `{ code, params }` shape `ORDER_VALIDATION_KEY` uses), so the entry is one line
 * beside its neighbours in `catalog-en`/`catalog-other` when the screen that shows it
 * exists. Until then the domain sentences are the only wording, which is the same place the
 * booking side was at the end of S-B/1.
 */
export const FIRE_VALIDATION_KEY = {
  /** The booking is not in a state it may be fired from — §2.3 T1's `from` list. */
  wrongState: "order.validation.fireWrongState",
  /** A line's article is 86'd at this outlet (§2.6 case 1: refused before the ticket exists). */
  articleUnavailable: "order.validation.fireArticleUnavailable",
  /** A line matched no route and the outlet has no pass to fall back to (D3, lead ruling). */
  unroutedNoStation: "order.validation.fireUnroutedNoStation",
  /** Nothing in the booking resolves to a station at all — the same refusal, named once. */
  noStations: "order.validation.fireNoStations",
  /** The site has no prep-time SLA defined, so no deadline can be captured (§2.5). */
  slaMissing: "order.validation.fireSlaMissing",
  /** The SLA in force is not a number the platform can turn into a deadline. */
  slaNotANumber: "order.validation.fireSlaNotANumber",
  /** The SLA in force is outside the bounds its own definition sets. */
  slaOutOfRange: "order.validation.fireSlaOutOfRange",
  /** Two fires raced for the same station's next number. Nothing was written. */
  ticketNumberTaken: "order.validation.fireTicketNumberTaken",
  /** The booking has no lines, so there is no work to raise. */
  linesMissing: "order.validation.fireLinesMissing",
} as const;


/**
 * A state code is a code in the database and a word on a screen. One key per state, an
 * explicit map, **no fallback** — see the header.
 */
export const ORDER_STATUS_LABEL_KEY: Record<OutletOrderStatus, string> = {
  placed: "order.status.placed",
  accepted: "order.status.accepted",
  fired: "order.status.fired",
  in_progress: "order.status.in_progress",
  ready: "order.status.ready",
  served: "order.status.served",
  closed: "order.status.closed",
  cancelled: "order.status.cancelled",
};

export const ORDER_LINE_STATE_LABEL_KEY: Record<OrderLineState, string> = {
  placed: "order.line.state.placed",
  fired: "order.line.state.fired",
  in_prep: "order.line.state.in_prep",
  ready: "order.line.state.ready",
  served: "order.line.state.served",
  voided: "order.line.state.voided",
  held_unavailable: "order.line.state.held_unavailable",
};

export const ORDER_ORIGIN_LABEL_KEY: Record<OrderOrigin, string> = {
  pos: "order.origin.pos",
  kiosk: "order.origin.kiosk",
  tab: "order.origin.tab",
  guest_app: "order.origin.guest_app",
  chat: "order.origin.chat",
};

/** The label key for a status, or `null` for a code this build does not know. */
export function orderStatusLabelKey(status: string): string | null {
  return (ORDER_STATUS_LABEL_KEY as Record<string, string | undefined>)[status] ?? null;
}

/** The label key for a line state, or `null` — never a neighbouring state's word. */
export function orderLineStateLabelKey(state: string): string | null {
  return (ORDER_LINE_STATE_LABEL_KEY as Record<string, string | undefined>)[state] ?? null;
}

/** The label key for an origin, or `null`. */
export function orderOriginLabelKey(origin: string): string | null {
  return (ORDER_ORIGIN_LABEL_KEY as Record<string, string | undefined>)[origin] ?? null;
}

/**
 * The validation refusals the booking side can raise, each with the sentence it reads as
 * (§2.7's ledger rule and the owner's copy rule: words, never a code in prose).
 *
 * A **validation** refusal aborts its transaction and writes nothing — the ledger's gap is
 * deliberate — so these sentences are the only record the act leaves, which is why each one
 * says what to do next rather than claiming something was recorded.
 */
export const ORDER_VALIDATION_KEY = {
  linesRequired: "order.validation.linesRequired",
  quantityInvalid: "order.validation.quantityInvalid",
  articleUnknown: "order.validation.articleUnknown",
  // A line with no article at all names nothing, so it is its own sentence.
  articleRequired: "order.validation.articleRequired",
  articleNotSellable: "order.validation.articleNotSellable",
  priceMissing: "order.validation.priceMissing",
  priceAmbiguous: "order.validation.priceAmbiguous",
  taxClassMissing: "order.validation.taxClassMissing",
  taxRateMissing: "order.validation.taxRateMissing",
  // Not a number at all: nothing to quote back, so it is its own sentence.
  serviceChargeNotANumber: "order.validation.serviceChargeNotANumber",
  serviceChargeOutOfRange: "order.validation.serviceChargeOutOfRange",
  currencyUnknown: "order.validation.currencyUnknown",
  // Priced in a currency this outlet does not trade in. Separately actionable from a currency this build cannot convert at all.
  currencyMismatch: "order.validation.currencyMismatch",
  outletUnknown: "order.validation.outletUnknown",
  originUnknown: "order.validation.originUnknown",
  referenceTaken: "order.validation.referenceTaken",
  notAccepted: "order.validation.notAccepted",
  cannotCancel: "order.validation.cannotCancel",
  notServed: "order.validation.notServed",
  reasonRequired: "order.validation.reasonRequired",
} as const;

/** The four acts the booking side records, for the read-back and for S-B/2. */
export const ORDER_ACTIONS = ["order.book", "order.fire", "order.cancel", "order.close"] as const;

/**
 * ISO 4217 minor-unit exponents, as an explicit list and **not** a default-to-2 rule.
 *
 * `Intl.NumberFormat` renders the exponent correctly for any currency it knows, so this map
 * is not for display: it is for the one conversion that stores money as an integer. A
 * currency absent from it has no exponent this build has agreed, and `toMinorUnits` answers
 * `null` — refusing the booking — rather than quietly dividing by a hundred. The list
 * carries every currency the platform's jurisdictions can name today plus the standard
 * three- and zero-decimal economies; adding one is a deliberate line, which is the point.
 */
export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SAR: 2,
  SGD: 2,
  MYR: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  HKD: 2,
  NZD: 2,
  THB: 2,
  LKR: 2,
  BDT: 2,
  NPR: 2,
  PKR: 2,
  ZAR: 2,
  // Three-decimal currencies.
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  // Zero-decimal currencies.
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  IDR: 0,
};

/** The exponent for a currency, or `null` when this build has not agreed one. */
export function currencyMinorUnits(currency: string): number | null {
  const exponent = CURRENCY_MINOR_UNITS[currency.trim().toUpperCase()];
  return exponent === undefined ? null : exponent;
}

/**
 * A major-unit amount (the shape `article_price.amount` is stored in, `numeric(18,4)`) as an
 * integer number of minor units — or `null` for a currency this build has no exponent for.
 *
 * `Math.round` is half-away-from-zero, which is `half_up` for the only values this is called
 * with (a menu price, never negative) and matches the seeded tax classes' own rounding rule
 * (`tax_class.rounding = 'half_up'`). A published price with more precision than the minor
 * unit can hold is rounded here **once**, and the rounded integer is what the line pins — so
 * what the bill reproduces is what was charged, not what was stored upstream.
 */
export function toMinorUnits(amount: number, currency: string): number | null {
  const exponent = currencyMinorUnits(currency);
  if (exponent === null) return null;
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 10 ** exponent);
}

/** A minor-unit integer back in major units, for a formatter that expects a decimal. */
export function fromMinorUnits(minor: number, currency: string): number | null {
  const exponent = currencyMinorUnits(currency);
  if (exponent === null) return null;
  return minor / 10 ** exponent;
}

/**
 * What one line's amounts are, given the pinned price and the pinned rates. Pure arithmetic,
 * stated here so it can be checked by reading it and re-checked against the database.
 *
 * The Indian menu convention is a **tax-inclusive** price, so this is the split that matters:
 * with the pinned menu price `p`, a quantity `q`, a rate `r` per cent and a service charge
 * `sc` per cent, and with `B = p x q` (the menu total for the line),
 *
 *     net             = round(B x 100 / (100 + r))   (the value, ex tax)
 *     tax             = B - net                      (so net + tax = B exactly, no cent lost)
 *     amount          = net + tax = B                (what the menu prints, owed for the food)
 *     service_charge  = round(net x sc / 100)        (on the value, not on the tax)
 *     total           = amount + service_charge
 *
 * An **exclusive** class is the other branch of the same function and is what a market that
 * quotes prices before tax needs: `net = B`, `tax = round(B x r / 100)`, `amount = net + tax`.
 *
 * Every identity above is also a check constraint on `order_line` (migration 0012), so a
 * future caller that recomputes any of them differently is refused by the database rather
 * than believed.
 */
export interface LineArithmetic {
  /** The pinned menu price of ONE unit, in minor units. */
  unitAmountMinor: number;
  /** `unitAmountMinor` x quantity — the value before tax. */
  netMinor: number;
  /** The tax in the line: extracted when inclusive, added when exclusive. */
  taxMinor: number;
  /** What is owed for the food: net + tax. */
  amountMinor: number;
  serviceChargeMinor: number;
  totalMinor: number;
}

export function priceLine(input: {
  unitAmountMinor: number;
  quantity: number;
  taxRatePct: number;
  taxInclusive: boolean;
  serviceChargePct: number;
}): LineArithmetic {
  const { unitAmountMinor, quantity, taxRatePct, taxInclusive, serviceChargePct } = input;
  const base = unitAmountMinor * quantity;
  let netMinor: number;
  let taxMinor: number;
  if (taxInclusive) {
    netMinor = Math.round((base * 100) / (100 + taxRatePct));
    taxMinor = base - netMinor;
  } else {
    netMinor = base;
    taxMinor = Math.round((base * taxRatePct) / 100);
  }
  const serviceChargeMinor = Math.round((netMinor * serviceChargePct) / 100);
  const amountMinor = netMinor + taxMinor;
  return {
    unitAmountMinor,
    netMinor,
    taxMinor,
    amountMinor,
    serviceChargeMinor,
    totalMinor: amountMinor + serviceChargeMinor,
  };
}
