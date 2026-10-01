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

export const ORDER_TRANSITIONS: Record<"accept" | "cancel" | "close", OrderTransitionRule> = {
  accept: { intent: "order.accept", capability: "order.book", from: ["placed"], to: "accepted" },
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
