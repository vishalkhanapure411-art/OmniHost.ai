import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { auditedMutation, guard, writeAudit, type AuditSource } from "~/server/audit";
import { NotFound, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import {
  ORDER_ORIGINS,
  ORDER_INTENTS,
  ORDER_TRANSITIONS,
  ORDER_VALIDATION_KEY,
  priceLine,
  toMinorUnits,
  type LineArithmetic,
  type OrderOrigin,
} from "~/domain/order-rules";

/**
 * The booking side (S-B part 1): taking a booking, pricing it from master data, pinning
 * what it was priced from, and the order-side transitions — `DESIGN-kds-and-ticket-routing.md`
 * §2.1, §2.3 (the order-side rows) and §2.4.
 *
 * What is deliberately NOT here, because it is a later delegation in the same slice:
 * **fire** with per-line routing resolution, `ticket`/`ticket_line` (S-B/2), and the
 * booking screen (S-B/3). Nothing in this module writes a ticket, a route or a print job,
 * and nothing here recomputes routing: `order_line.routing_section_id` and `routing_source`
 * stay NULL until S-B/2 fires the booking (D4).
 *
 * Five rules shape every function below.
 *
 *   * **One mutation, one transaction, one audit row, one named capability.** Booking,
 *     accepting, cancelling and closing each go through `auditedMutation` and are behind
 *     `guard()`. The audit row carries `action` = the capability code (§2.4:
 *     `order.book` / `order.cancel` / `order.close`) and `intent` = the specific act
 *     (`order.place` / `order.accept` / …), which is the shape S-A's rows carry
 *     (`display.manage` + `display.register`).
 *   * **A booking is accepted in the same transaction that places it** (§2.1, O13): the
 *     booking screen *is* the outlet counter while there is one outlet, so acceptance is a
 *     state and an explicit `order.accept` audit row, not a second tap. That is the second
 *     audit row `bookOutletOrder` writes, and it is the only place this module writes two.
 *   * **A capability refusal writes a `denied` row and changes no data; a validation
 *     refusal aborts its transaction and writes nothing.** `guard()` is the first half and
 *     is used for it. The second half is every `ValidationError` below: each is raised
 *     *before* the first insert, so there is no row to point at and the screen is the only
 *     record — the ledger's gap is deliberate.
 *   * **Version pinning is the point** (§2.1, §11.3.5). A line pins the article's CURRENT
 *     SELLABLE version (`article.current_version_id`, which the draft-version rule of
 *     `0010_article_version_supersede.sql` only moves on approval), the exact `article_price`
 *     window row, the tax class, the tax rate row and its rate, and the amounts that
 *     resolved — so a historical bill reproduces after the version is superseded and a new
 *     price window opens. Nothing here invents a second versioning mechanism.
 *   * **Money is an integer number of minor units plus an ISO 4217 code.** The master-data
 *     `numeric(18,4)` major-unit amount is converted exactly once, by `toMinorUnits`, and
 *     only for a currency this build has an exponent for; an unknown currency is a refusal,
 *     not a guess.
 *
 * The amounts, stated so they can be re-checked against the database by hand:
 *
 *     unit_amount_minor            = round(article_price.amount x 10^exponent)   [INR: x100]
 *     net_amount_minor             = unit_amount_minor x quantity
 *     tax_amount_minor             = inclusive: amount - net   | exclusive: round(net x rate%)
 *     line_amount_minor            = net + tax                  (what the menu prints)
 *     service_charge_amount_minor  = round(net x service_charge_percent / 100)
 *     line_total_minor             = line_amount_minor + service_charge_amount_minor
 *     outlet_order.subtotal_minor  = SUM(line_amount_minor)
 *     outlet_order.tax_minor       = SUM(tax_amount_minor)
 *     outlet_order.service_charge_minor = SUM(service_charge_amount_minor)
 *     outlet_order.total_minor     = subtotal_minor + service_charge_minor
 *
 * Every identity in that list is a check constraint on `order_line` / `outlet_order`
 * (migration 0012), so a future caller that computes any of them differently is refused by
 * the database rather than believed.
 *
 * **Tenant boundary.** There is no RLS policy (DECISIONS.md:8, D22). The outlet, the site and
 * the chain are read from the `outlet` row and never from a request parameter, every write
 * carries `chain_id` in its WHERE clause, and the composite foreign keys in 0012 refuse a
 * cross-site or cross-chain pair even if the code were wrong.
 */

export interface BookingLineInput {
  /** The article's chain-unique code, as the master data screen and the API both use. */
  articleCode: string;
  quantity: number;
  prepNotes?: string | null;
}

export interface BookingInput {
  outletId: string;
  /** `pos | kiosk | tab | guest_app | chat` — where the booking came from. */
  origin: string;
  /** The token the guest is called by. Generated when the caller does not supply one. */
  serviceReference?: string | null;
  tableLabel?: string | null;
  lines: readonly BookingLineInput[];
}

export interface PricedLine {
  orderLineId: string;
  position: number;
  articleId: string;
  articleCode: string;
  articleName: string | null;
  articleVersionId: string;
  articleVersion: number;
  articlePriceId: string;
  taxClassId: string | null;
  taxClassCode: string | null;
  taxRateId: string | null;
  taxRatePct: number;
  taxInclusive: boolean;
  quantity: number;
  unitAmountMinor: number;
  netAmountMinor: number;
  taxAmountMinor: number;
  amountMinor: number;
  serviceChargeMinor: number;
  totalMinor: number;
}

export interface BookedOrder {
  orderId: string;
  serviceReference: string;
  outletOrderId: string;
  status: string;
  currencyCode: string;
  serviceChargePercent: number;
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  totalMinor: number;
  lines: PricedLine[];
}

interface OutletContext {
  id: string;
  code: string;
  name: string;
  chainId: string;
  siteId: string;
  siteCode: string;
  timezone: string;
  currency: string;
  jurisdictionCode: string | null;
  locale: string;
  siteDate: string;
}

function validation(message: string, code: string, params?: Record<string, string>): ValidationError {
  return new ValidationError(message, { code, ...(params ? { params } : {}) });
}

/**
 * The outlet's own tenant context, read from the row — §1.6 item 1's rule applied to the
 * booking side, so a crafted `outletId` is resolved and then checked rather than trusted.
 * `siteDate` is the **site's** calendar date, not UTC's: a price window is a date-only
 * column and the pilot's site is Asia/Kolkata, five and a half hours ahead of UTC.
 */
async function outletContext(db: Queryable, outletId: string): Promise<OutletContext> {
  const rows = await db.query<{
    id: string;
    code: string;
    name: string;
    chain_id: string;
    site_id: string;
    site_code: string;
    timezone: string;
    currency: string;
    jurisdiction_code: string | null;
    locale: string | null;
    site_date: string;
  }>(
    `select o.id, o.code, o.name, o.chain_id, o.site_id, s.code as site_code, s.timezone,
            s.currency, s.jurisdiction_code, s.locale,
            to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') as site_date
       from outlet o
       join site s on s.id = o.site_id
      where o.id = $1
      limit 1`,
    [outletId]
  );
  const row = rows[0];
  if (!row) {
    throw validation("That outlet does not exist.", ORDER_VALIDATION_KEY.outletUnknown);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    chainId: row.chain_id,
    siteId: row.site_id,
    siteCode: row.site_code,
    timezone: row.timezone,
    currency: (row.currency ?? "INR").trim(),
    jurisdictionCode: row.jurisdiction_code,
    locale: row.locale ?? "en-IN",
    siteDate: row.site_date,
  };
}

export interface PricingFacts {
  articleId: string;
  articleCode: string;
  articleName: string | null;
  articleVersionId: string;
  articleVersion: number;
  versionStatus: string;
  articlePriceId: string;
  priceAmount: number;
  currencyCode: string;
  taxClassId: string | null;
  taxClassCode: string | null;
  taxInclusive: boolean;
  taxRateId: string | null;
  taxRatePct: number;
  /** The window the price came from, quoted in the refusal messages and the ledger. */
  priceEffectiveFrom: string;
  priceEffectiveTo: string | null;
}

/**
 * Everything a line is priced from, read from master data and **not** written anywhere.
 *
 * The resolution order, and each step is a documented decision rather than a fallback:
 *
 *   1. **The article's current version, and it must be sellable.** `article.current_version_id`
 *      is what the draft-version rule leaves pointing at the version on sale while a
 *      proposal sits beside it, so this read is the same one billing uses. A version in
 *      `draft` or `pending_review` is one nobody may sell: the booking is refused with a
 *      sentence naming the state, because `DEMO-MC-DRAFT` is a real row in the pilot data and
 *      a screen that priced it would be selling an undecided price.
 *   2. **The open price window for that version at that outlet**, matched on the *site's*
 *      date. None → refused, naming the outlet: a line with no price is not a zero-priced
 *      line. More than one open window → refused as ambiguous rather than picking the newer
 *      one, because "which price was it" must never be a guess.
 *   3. **The tax class of that version**, with the per-jurisdiction override applied:
 *      `article_version_jurisdiction.tax_class_id` when the site's own jurisdiction has a
 *      row, otherwise the version's own class. `IN-KA` is the pilot's.
 *   4. **The effective tax rate** for that class and date. `intra_state` is preferred (a sale
 *      inside the state it is taxed in), then `standard` — and **`exempt` and `zero_rated`
 *      are never chosen automatically**. A rate the platform picked for you that happens to
 *      be zero is a tax silently not charged, which is the one arithmetic error a guest
 *      never discovers. No rate in the preferred set → refused, naming the class.
 */
export async function priceArticleAtOutlet(
  db: Queryable,
  input: { chainId: string; outletId: string; jurisdictionCode: string | null; siteDate: string; locale: string; articleCode: string }
): Promise<PricingFacts> {
  const code = input.articleCode.trim();
  if (!code) {
    throw validation("A booking line needs an article.", ORDER_VALIDATION_KEY.articleRequired);
  }
  const rows = await db.query<{
    article_id: string;
    article_code: string;
    article_name: string | null;
    article_version_id: string;
    version: number;
    version_status: string;
    tax_class_id: string | null;
  }>(
    `select a.id as article_id, a.code as article_code, t.name as article_name,
            v.id as article_version_id, v.version, v.status as version_status,
            coalesce(avj.tax_class_id, v.tax_class_id) as tax_class_id
       from article a
       join article_version v on v.id = a.current_version_id
       left join article_version_jurisdiction avj
              on avj.article_version_id = v.id and avj.jurisdiction_code = $3
       left join lateral (
         select t2.name from article_version_text t2
          where t2.article_version_id = v.id
          order by (t2.locale = $4) desc, t2.locale
          limit 1
       ) t on true
      where a.chain_id = $1 and lower(a.code) = lower($2)
      limit 1`,
    [input.chainId, code, input.jurisdictionCode, input.locale]
  );
  const article = rows[0];
  if (!article) {
    throw validation(`${code} is not an article of this chain.`, ORDER_VALIDATION_KEY.articleUnknown, {
      article: code,
    });
  }
  if (article.version_status !== "active") {
    throw validation(
      `${article.article_name ?? code} is on version ${String(article.version)} in state ${article.version_status}, which is not a version anyone may sell.`,
      ORDER_VALIDATION_KEY.articleNotSellable,
      { article: article.article_name ?? code, version: String(article.version), status: article.version_status }
    );
  }

  const prices = await db.query<{
    id: string;
    amount: string;
    currency_code: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `select p.id, p.amount::text as amount, p.currency_code, p.effective_from::text as effective_from,
            p.effective_to::text as effective_to
       from article_price p
      where p.chain_id = $1 and p.article_id = $2 and p.article_version_id = $3 and p.outlet_id = $4
        and p.effective_from <= $5::date
        and (p.effective_to is null or p.effective_to >= $5::date)
      order by p.effective_from desc`,
    [input.chainId, article.article_id, article.article_version_id, input.outletId, input.siteDate]
  );
  if (prices.length === 0) {
    throw validation(
      `${article.article_name ?? code} has no price at this outlet on ${input.siteDate}. Price it for this outlet before booking it.`,
      ORDER_VALIDATION_KEY.priceMissing,
      { article: article.article_name ?? code, date: input.siteDate }
    );
  }
  if (prices.length > 1) {
    throw validation(
      `${article.article_name ?? code} has ${String(prices.length)} open prices at this outlet on ${input.siteDate}, so the price to sell it at is ambiguous. Close the extra window before booking it.`,
      ORDER_VALIDATION_KEY.priceAmbiguous,
      { article: article.article_name ?? code, date: input.siteDate, count: String(prices.length) }
    );
  }
  const price = prices[0] as (typeof prices)[number];

  if (!article.tax_class_id) {
    throw validation(
      `${article.article_name ?? code} has no tax class, so its tax cannot be resolved. Set one on its version before booking it.`,
      ORDER_VALIDATION_KEY.taxClassMissing,
      { article: article.article_name ?? code }
    );
  }
  const classes = await db.query<{ id: string; code: string; inclusive: boolean }>(
    `select id, code, inclusive from tax_class where id = $1 and chain_id = $2 limit 1`,
    [article.tax_class_id, input.chainId]
  );
  const taxClass = classes[0];
  if (!taxClass) {
    throw validation(
      `${article.article_name ?? code} points at a tax class this chain does not have.`,
      ORDER_VALIDATION_KEY.taxClassMissing,
      { article: article.article_name ?? code }
    );
  }

  // `intra_state`, then `standard`. Never `exempt`, never `zero_rated`: see the doc comment.
  const preferredSupplyTypes = ["intra_state", "standard"];
  const rates = await db.query<{ id: string; rate_pct: string; supply_type: string }>(
    `select tr.id, tr.rate_pct::text as rate_pct, tr.supply_type
       from tax_rate tr
      where tr.chain_id = $1 and tr.tax_class_id = $2
        and tr.supply_type = any($3::text[])
        and tr.effective_from <= $4::date
        and (tr.effective_to is null or tr.effective_to >= $4::date)
      order by array_position($3::text[], tr.supply_type), tr.effective_from desc
      limit 1`,
    [input.chainId, taxClass.id, preferredSupplyTypes, input.siteDate]
  );
  const rate = rates[0];
  if (!rate) {
    throw validation(
      `${taxClass.code} has no tax rate in force on ${input.siteDate} for a sale inside the state. The platform will not price a line at a tax it has not resolved.`,
      ORDER_VALIDATION_KEY.taxRateMissing,
      { taxClass: taxClass.code, date: input.siteDate }
    );
  }

  return {
    articleId: article.article_id,
    articleCode: article.article_code,
    articleName: article.article_name,
    articleVersionId: article.article_version_id,
    articleVersion: article.version,
    versionStatus: article.version_status,
    articlePriceId: price.id,
    priceAmount: Number(price.amount),
    currencyCode: price.currency_code.trim(),
    taxClassId: taxClass.id,
    taxClassCode: taxClass.code,
    taxInclusive: taxClass.inclusive,
    taxRateId: rate.id,
    taxRatePct: Number(rate.rate_pct),
    priceEffectiveFrom: price.effective_from,
    priceEffectiveTo: price.effective_to,
  };
}

/**
 * The site's service-charge percentage: the site's own row, then the chain's, then the
 * setting's platform default — the same resolution order the settings screen describes,
 * read from `chain_setting` (which keys on `setting_key` and carries a nullable `site_id`)
 * and `setting_definition`. Out of the definition's own bounds is a refusal: the bounds are
 * on the definition, so a value outside them is a row nothing in the platform wrote.
 */
export async function resolveServiceChargePercent(
  db: Queryable,
  input: { chainId: string; siteId: string }
): Promise<number> {
  const key = "payments.service_charge_percent";
  const rows = await db.query<{ value: string; min_value: string | null; max_value: string | null }>(
    `select coalesce(cs.value, sd.default_value)::text as value,
            sd.min_value::text as min_value, sd.max_value::text as max_value
       from setting_definition sd
       left join lateral (
         select c2.value from chain_setting c2
          where c2.chain_id = $1 and c2.setting_key = sd.key
            and (c2.site_id = $2 or c2.site_id is null)
          order by (c2.site_id is not null) desc
          limit 1
       ) cs on true
      where sd.key = $3
      limit 1`,
    [input.chainId, input.siteId, key]
  );
  const row = rows[0];
  if (!row) {
    // No definition: the platform has no agreed service-charge rate, so the honest answer is
    // zero — and it is stated, not assumed: the outlet order records the 0 it was priced at.
    return 0;
  }
  const value = Number(row.value);
  if (!Number.isFinite(value)) {
    throw validation(
      "The service charge setting is not a number, so the booking cannot be priced.",
      ORDER_VALIDATION_KEY.serviceChargeNotANumber
    );
  }
  const min = row.min_value === null ? null : Number(row.min_value);
  const max = row.max_value === null ? null : Number(row.max_value);
  if ((min !== null && value < min) || (max !== null && value > max)) {
    throw validation(
      `The service charge is set to ${String(value)}, outside the ${String(min)} to ${String(max)} the platform allows.`,
      ORDER_VALIDATION_KEY.serviceChargeOutOfRange,
      { value: String(value), min: String(min), max: String(max) }
    );
  }
  return value;
}

interface PreparedLine {
  facts: PricingFacts;
  quantity: number;
  prepNotes: string | null;
  unitAmountMinor: number;
  arithmetic: LineArithmetic;
}

/**
 * Prices every line of a booking **before anything is written**, so a refusal on the third
 * line leaves no order, no outlet order and no lines — the validation-refusal rule applied
 * to a multi-line write.
 */
async function prepareLines(
  db: Queryable,
  ctx: OutletContext,
  lines: readonly BookingLineInput[],
  serviceChargePercent: number
): Promise<PreparedLine[]> {
  if (lines.length === 0) {
    throw validation("A booking needs at least one line.", ORDER_VALIDATION_KEY.linesRequired);
  }
  const prepared: PreparedLine[] = [];
  for (const line of lines) {
    const quantity = Math.trunc(line.quantity);
    if (!Number.isFinite(line.quantity) || quantity < 1) {
      throw validation(
        `A line's quantity must be a whole number of one or more, not ${String(line.quantity)}.`,
        ORDER_VALIDATION_KEY.quantityInvalid,
        { value: String(line.quantity) }
      );
    }
    const facts = await priceArticleAtOutlet(db, {
      chainId: ctx.chainId,
      outletId: ctx.id,
      jurisdictionCode: ctx.jurisdictionCode,
      siteDate: ctx.siteDate,
      locale: ctx.locale,
      articleCode: line.articleCode,
    });
    const unitAmountMinor = toMinorUnits(facts.priceAmount, facts.currencyCode);
    if (unitAmountMinor === null) {
      throw validation(
        `This build has no minor-unit rule for ${facts.currencyCode}, so it will not price a line in it.`,
        ORDER_VALIDATION_KEY.currencyUnknown,
        { currency: facts.currencyCode }
      );
    }
    if (facts.currencyCode !== ctx.currency) {
      throw validation(
        `${facts.articleName ?? facts.articleCode} is priced in ${facts.currencyCode} and this outlet trades in ${ctx.currency}.`,
        ORDER_VALIDATION_KEY.currencyMismatch,
        { article: facts.articleName ?? facts.articleCode, price: facts.currencyCode, outlet: ctx.currency }
      );
    }
    prepared.push({
      facts,
      quantity,
      prepNotes: (line.prepNotes ?? "").trim() || null,
      unitAmountMinor,
      arithmetic: priceLine({
        unitAmountMinor,
        quantity,
        taxRatePct: facts.taxRatePct,
        taxInclusive: facts.taxInclusive,
        serviceChargePct: serviceChargePercent,
      }),
    });
  }
  return prepared;
}

/**
 * The next service reference for a site on a service day: `T-001`, reset by the site's own
 * calendar day. Generated inside the booking's transaction so the number a guest is called by
 * is chosen with the order that carries it.
 *
 * A collision (two bookings racing on the same number) is refused with a sentence asking for
 * an explicit reference; it is *not* silently retried, because a retry inside an already
 * decided transaction is a second decision. The unique key on
 * `(chain_id, site_id, service_reference)` is what makes the collision visible.
 */
async function nextServiceReference(
  tx: Queryable,
  ctx: OutletContext
): Promise<string> {
  const rows = await tx.query<{ n: number }>(
    `select (count(*) + 1)::int as n
       from "order"
      where chain_id = $1 and site_id = $2
        and placed_at >= (date_trunc('day', now() at time zone $3) at time zone $3)`,
    [ctx.chainId, ctx.siteId, ctx.timezone]
  );
  const n = rows[0]?.n ?? 1;
  return `T-${String(n).padStart(3, "0")}`;
}

export interface MutationMeta {
  source?: AuditSource;
  intent?: string | null;
}

/**
 * Takes a booking: the `order`, its one `outlet_order`, every priced line, and — in the same
 * transaction, as a second and explicit audit row — the outlet's acceptance (§2.1, O13).
 *
 * `order.book` with intent `order.place`, then `order.book` with intent `order.accept`.
 * One transaction, so the booking, its prices and both ledger rows exist together or not at
 * all. Returns the ids and the pinned amounts, which is what S-B/2 will fire.
 */
export async function bookOutletOrder(
  principal: Principal,
  input: BookingInput,
  meta: MutationMeta = {}
): Promise<BookedOrder> {
  const db = poolQueryable();
  const ctx = await outletContext(db, input.outletId);
  await guard({
    principal,
    action: "order.book",
    entityType: "order",
    chainId: ctx.chainId,
    siteId: ctx.siteId,
    target: `outlet ${ctx.code}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  if (!(ORDER_ORIGINS as readonly string[]).includes(input.origin)) {
    throw validation(`${input.origin} is not a booking channel.`, ORDER_VALIDATION_KEY.originUnknown, {
      origin: input.origin,
    });
  }
  const origin = input.origin as OrderOrigin;
  const serviceChargePercent = await resolveServiceChargePercent(db, {
    chainId: ctx.chainId,
    siteId: ctx.siteId,
  });
  const prepared = await prepareLines(db, ctx, input.lines, serviceChargePercent);

  const subtotalMinor = prepared.reduce((sum, line) => sum + line.arithmetic.amountMinor, 0);
  const taxMinor = prepared.reduce((sum, line) => sum + line.arithmetic.taxMinor, 0);
  const serviceChargeMinor = prepared.reduce((sum, line) => sum + line.arithmetic.serviceChargeMinor, 0);
  const totalMinor = subtotalMinor + serviceChargeMinor;

  const explicitReference = input.serviceReference?.trim() || null;
  try {
    const outcome = await auditedMutation({
      principal,
      action: "order.book",
      entityType: "order",
      chainId: ctx.chainId,
      siteId: ctx.siteId,
      source: meta.source,
      intent: ORDER_INTENTS.place,
      run: async (tx) => {
        const serviceReference = explicitReference ?? (await nextServiceReference(tx, ctx));
        const orderRows = await tx.query<{ id: string }>(
          `insert into "order"
             (chain_id, site_id, service_reference, origin, table_label, placed_by_user_id, status)
           values ($1, $2, $3, $4, $5, $6, 'accepted')
           returning id`,
          [
            ctx.chainId,
            ctx.siteId,
            serviceReference,
            origin,
            input.tableLabel?.trim() || null,
            principal.userId,
          ]
        );
        const orderId = orderRows[0]?.id;
        if (!orderId) throw new Error("order insert returned no row");

        const outletOrderRows = await tx.query<{ id: string }>(
          `insert into outlet_order
             (chain_id, site_id, outlet_id, order_id, status, request_source, accepted_at,
              accepted_by_user_id, currency_code, service_charge_percent,
              subtotal_minor, tax_minor, service_charge_minor, total_minor)
           values ($1, $2, $3, $4, 'accepted', $5, now(), $6, $7, $8, $9, $10, $11, $12)
           returning id`,
          [
            ctx.chainId,
            ctx.siteId,
            ctx.id,
            orderId,
            meta.source === "chatbot" ? "chatbot" : (meta.source ?? "screen"),
            principal.userId,
            ctx.currency,
            serviceChargePercent,
            subtotalMinor,
            taxMinor,
            serviceChargeMinor,
            totalMinor,
          ]
        );
        const outletOrderId = outletOrderRows[0]?.id;
        if (!outletOrderId) throw new Error("outlet_order insert returned no row");

        const inserted: PricedLine[] = [];
        let position = 0;
        for (const line of prepared) {
          const a = line.arithmetic;
          const lineRows = await tx.query<{ id: string }>(
            `insert into order_line
               (chain_id, outlet_order_id, position, article_id, article_version_id, article_price_id,
                tax_class_id, tax_rate_id, tax_rate_pct, tax_inclusive, quantity,
                unit_amount_minor, line_amount_minor, tax_amount_minor, net_amount_minor,
                service_charge_amount_minor, line_total_minor, currency_code, prep_notes)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
             returning id`,
            [
              ctx.chainId,
              outletOrderId,
              position,
              line.facts.articleId,
              line.facts.articleVersionId,
              line.facts.articlePriceId,
              line.facts.taxClassId,
              line.facts.taxRateId,
              line.facts.taxRatePct,
              line.facts.taxInclusive,
              line.quantity,
              a.unitAmountMinor,
              a.amountMinor,
              a.taxMinor,
              a.netMinor,
              a.serviceChargeMinor,
              a.totalMinor,
              ctx.currency,
              line.prepNotes,
            ]
          );
          const orderLineId = lineRows[0]?.id;
          if (!orderLineId) throw new Error("order_line insert returned no row");
          inserted.push({
            orderLineId,
            position,
            articleId: line.facts.articleId,
            articleCode: line.facts.articleCode,
            articleName: line.facts.articleName,
            articleVersionId: line.facts.articleVersionId,
            articleVersion: line.facts.articleVersion,
            articlePriceId: line.facts.articlePriceId,
            taxClassId: line.facts.taxClassId,
            taxClassCode: line.facts.taxClassCode,
            taxRateId: line.facts.taxRateId,
            taxRatePct: line.facts.taxRatePct,
            taxInclusive: line.facts.taxInclusive,
            quantity: line.quantity,
            unitAmountMinor: a.unitAmountMinor,
            netAmountMinor: a.netMinor,
            taxAmountMinor: a.taxMinor,
            amountMinor: a.amountMinor,
            serviceChargeMinor: a.serviceChargeMinor,
            totalMinor: a.totalMinor,
          });
          position += 1;
        }

        // §2.1, O13: acceptance is a state and an explicit audit row, not a second tap. It is
        // written here, inside the booking's own transaction, so the "accepted" fact and the
        // "placed" fact cannot come apart.
        await writeAudit(tx, {
          principal,
          action: "order.book",
          entityType: "outlet_order",
          entityId: outletOrderId,
          chainId: ctx.chainId,
          siteId: ctx.siteId,
          outcome: "success",
          intent: ORDER_INTENTS.accept,
          source: meta.source ?? "screen",
          reason: "auto-accepted at booking: one outlet, so the booking screen is the outlet counter",
          beforeState: { status: "placed" },
          afterState: { status: "accepted", serviceReference, outletCode: ctx.code },
        });

        return {
          entityId: orderId,
          before: null,
          after: {
            serviceReference,
            origin,
            tableLabel: input.tableLabel?.trim() || null,
            outletCode: ctx.code,
            siteCode: ctx.siteCode,
            currencyCode: ctx.currency,
            serviceChargePercent,
            subtotalMinor,
            taxMinor,
            serviceChargeMinor,
            totalMinor,
            outletOrderId,
            lines: inserted.map((line) => ({
              orderLineId: line.orderLineId,
              articleCode: line.articleCode,
              articleVersionId: line.articleVersionId,
              articlePriceId: line.articlePriceId,
              taxRateId: line.taxRateId,
              taxRatePct: line.taxRatePct,
              taxInclusive: line.taxInclusive,
              quantity: line.quantity,
              unitAmountMinor: line.unitAmountMinor,
            })),
          },
        };
      },
    });

    const after = outcome.after as {
      serviceReference: string;
      outletOrderId: string;
      currencyCode: string;
      serviceChargePercent: number;
      subtotalMinor: number;
      taxMinor: number;
      serviceChargeMinor: number;
      totalMinor: number;
      lines: { orderLineId: string }[];
    };
    return {
      orderId: outcome.entityId ?? "",
      serviceReference: after.serviceReference,
      outletOrderId: after.outletOrderId,
      status: "accepted",
      currencyCode: after.currencyCode,
      serviceChargePercent: after.serviceChargePercent,
      subtotalMinor: after.subtotalMinor,
      taxMinor: after.taxMinor,
      serviceChargeMinor: after.serviceChargeMinor,
      totalMinor: after.totalMinor,
      lines: prepared.map((line, index) => ({
        orderLineId: after.lines[index]?.orderLineId ?? "",
        position: index,
        articleId: line.facts.articleId,
        articleCode: line.facts.articleCode,
        articleName: line.facts.articleName,
        articleVersionId: line.facts.articleVersionId,
        articleVersion: line.facts.articleVersion,
        articlePriceId: line.facts.articlePriceId,
        taxClassId: line.facts.taxClassId,
        taxClassCode: line.facts.taxClassCode,
        taxRateId: line.facts.taxRateId,
        taxRatePct: line.facts.taxRatePct,
        taxInclusive: line.facts.taxInclusive,
        quantity: line.quantity,
        unitAmountMinor: line.arithmetic.unitAmountMinor,
        netAmountMinor: line.arithmetic.netMinor,
        taxAmountMinor: line.arithmetic.taxMinor,
        amountMinor: line.arithmetic.amountMinor,
        serviceChargeMinor: line.arithmetic.serviceChargeMinor,
        totalMinor: line.arithmetic.totalMinor,
      })),
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw validation(
        `${explicitReference ?? "the generated reference"} is already used at this site today. Supply a different service reference.`,
        ORDER_VALIDATION_KEY.referenceTaken,
        { reference: explicitReference ?? "" }
      );
    }
    throw error;
  }
}

interface OutletOrderContext {
  id: string;
  status: string;
  chainId: string;
  siteId: string;
  outletId: string;
  orderId: string;
  serviceReference: string;
}

/** The outlet order's own tenant context, read from the row — never from a request. */
async function outletOrderContext(db: Queryable, outletOrderId: string): Promise<OutletOrderContext> {
  const rows = await db.query<{
    id: string;
    status: string;
    chain_id: string;
    site_id: string;
    outlet_id: string;
    order_id: string;
    service_reference: string;
  }>(
    `select oo.id, oo.status, oo.chain_id, oo.site_id, oo.outlet_id, oo.order_id, o.service_reference
       from outlet_order oo
       join "order" o on o.id = oo.order_id
      where oo.id = $1
      limit 1`,
    [outletOrderId]
  );
  const row = rows[0];
  if (!row) throw new NotFound("Outlet order", outletOrderId);
  return {
    id: row.id,
    status: row.status,
    chainId: row.chain_id,
    siteId: row.site_id,
    outletId: row.outlet_id,
    orderId: row.order_id,
    serviceReference: row.service_reference,
  };
}

/**
 * Runs one order-side transition: guard, then a single UPDATE whose WHERE clause states the
 * state it expects.
 *
 * Zero rows updated is a **validation refusal** — nothing written, no ledger row — and its
 * sentence says which state the booking is actually in, because the caller's view has moved
 * on (another screen, or the kitchen). That is the same optimistic-concurrency shape the
 * ticket transitions use (§2.3's rules), applied one level up.
 */
async function applyOrderTransition(
  principal: Principal,
  input: { outletOrderId: string; transition: keyof typeof ORDER_TRANSITIONS; reason?: string | null },
  meta: MutationMeta
): Promise<{ outletOrderId: string; from: string; to: string }> {
  const rule = ORDER_TRANSITIONS[input.transition];
  const db = poolQueryable();
  const ctx = await outletOrderContext(db, input.outletOrderId);
  await guard({
    principal,
    action: rule.capability,
    entityType: "outlet_order",
    chainId: ctx.chainId,
    siteId: ctx.siteId,
    target: `booking ${ctx.serviceReference}`,
    source: meta.source,
    intent: meta.intent ?? rule.intent,
  });

  const reason = input.reason?.trim() || null;
  if (rule.intent !== ORDER_INTENTS.accept && !reason) {
    throw validation("This act needs a reason.", ORDER_VALIDATION_KEY.reasonRequired);
  }

  const outcome = await auditedMutation({
    principal,
    action: rule.capability,
    entityType: "outlet_order",
    chainId: ctx.chainId,
    siteId: ctx.siteId,
    source: meta.source,
    intent: meta.intent ?? rule.intent,
    run: async (tx) => {
      const updated = await tx.query<{ status: string }>(
        `update outlet_order
            set status = $3,
                cancelled_at = case when $3 = 'cancelled' then now() else cancelled_at end,
                cancel_reason_code = case when $3 = 'cancelled' then $4 else cancel_reason_code end,
                closed_at = case when $3 = 'closed' then now() else closed_at end,
                accepted_at = case when $3 = 'accepted' and accepted_at is null then now() else accepted_at end,
                accepted_by_user_id = case when $3 = 'accepted' and accepted_by_user_id is null then $5 else accepted_by_user_id end,
                updated_at = now()
          where id = $1 and chain_id = $2 and status = any($6::text[])
          returning status`,
        [
          ctx.id,
          ctx.chainId,
          rule.to,
          reason,
          principal.userId,
          rule.from,
        ]
      );
      if (!updated[0]) {
        throw validation(
          `This booking is ${ctx.status}, and it can only be ${rule.to === "cancelled" ? "cancelled" : rule.to} from ${rule.from.join(" or ")}. Reload it to see where it has got to.`,
          input.transition === "cancel"
            ? ORDER_VALIDATION_KEY.cannotCancel
            : input.transition === "close"
              ? ORDER_VALIDATION_KEY.notServed
              : ORDER_VALIDATION_KEY.notAccepted,
          { status: ctx.status }
        );
      }
      // The parent order mirrors its single outlet order (§2.1). The roll-up rule for
      // several outlet orders is out of this slice (§8) and is the reason this is one
      // UPDATE in the same transaction rather than a trigger.
      await tx.query(
        `update "order"
            set status = $2,
                cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
                cancel_reason_code = case when $2 = 'cancelled' then $3 else cancel_reason_code end,
                updated_at = now()
          where id = $1 and chain_id = $4`,
        [ctx.orderId, rule.to, reason, ctx.chainId]
      );
      return {
        entityId: ctx.id,
        before: { status: ctx.status },
        after: { status: rule.to, ...(reason ? { reason } : {}) },
        ...(reason ? { reason } : {}),
      };
    },
  });

  return {
    outletOrderId: ctx.id,
    from: (outcome.before as { status: string }).status,
    to: rule.to,
  };
}

/** Accepts a booking's outlet order. `order.book` + intent `order.accept` (§2.1). */
export async function acceptOutletOrder(
  principal: Principal,
  input: { outletOrderId: string },
  meta: MutationMeta = {}
): Promise<{ outletOrderId: string; from: string; to: string }> {
  return applyOrderTransition(principal, { outletOrderId: input.outletOrderId, transition: "accept" }, meta);
}

/**
 * Cancels a booking before fire. `order.cancel` + intent `order.cancel` (§2.4).
 *
 * Before fire only: after fire the tickets exist and the honest act is a ticket void (T7),
 * which is the station's and is not in this slice. A cancel with no reason is refused with
 * nothing written — the column and the check constraint both exist because "cancelled, why
 * nobody knows" is the state the ledger is for.
 */
export async function cancelOutletOrder(
  principal: Principal,
  input: { outletOrderId: string; reasonCode: string },
  meta: MutationMeta = {}
): Promise<{ outletOrderId: string; from: string; to: string }> {
  return applyOrderTransition(
    principal,
    { outletOrderId: input.outletOrderId, transition: "cancel", reason: input.reasonCode },
    meta
  );
}

/**
 * Closes a served booking (§2.3 T11, `order.close`).
 *
 * The spec names `order.close` in T11's capability column and does **not** register it in
 * §2.4's table — a gap this slice closes rather than works around, because otherwise T11 is
 * a transition no one holds the right to make. It is registered in `db/seed.sql` with the
 * roles §2.3 names (Site Operations Team, Site Head) and marked as the addition it is.
 */
export async function closeOutletOrder(
  principal: Principal,
  input: { outletOrderId: string; reasonCode: string },
  meta: MutationMeta = {}
): Promise<{ outletOrderId: string; from: string; to: string }> {
  return applyOrderTransition(
    principal,
    { outletOrderId: input.outletOrderId, transition: "close", reason: input.reasonCode },
    meta
  );
}

export interface OutletOrderReadback {
  orderId: string;
  outletOrderId: string;
  serviceReference: string;
  origin: string;
  tableLabel: string | null;
  orderStatus: string;
  outletOrderStatus: string;
  placedAt: string;
  acceptedAt: string | null;
  firedAt: string | null;
  closedAt: string | null;
  currencyCode: string;
  serviceChargePercent: number;
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  totalMinor: number;
  outletCode: string;
  siteCode: string;
  lines: {
    orderLineId: string;
    position: number;
    articleCode: string;
    articleVersionId: string;
    articlePriceId: string;
    taxRateId: string | null;
    taxRatePct: number;
    taxInclusive: boolean;
    quantity: number;
    unitAmountMinor: number;
    netAmountMinor: number;
    taxAmountMinor: number;
    amountMinor: number;
    serviceChargeMinor: number;
    totalMinor: number;
    routingSectionId: string | null;
    routingSource: string | null;
    lineState: string;
  }[];
}

/**
 * Reads one booking back, pinned values and all.
 *
 * **SPEC-GAP, flagged rather than papered over:** §2.4 registers no read capability for the
 * order side — it has `order.book`, `order.fire` and `order.cancel` and nothing that says
 * who may *look* at a booking. This read is gated on `order.book`, the capability of the
 * people who take them, because the alternative was inventing an `order.view` code the spec
 * does not have. It is one line to change when the lead rules on it.
 */
export async function readOutletOrder(
  principal: Principal,
  outletOrderId: string,
  meta: MutationMeta = {}
): Promise<OutletOrderReadback> {
  const db = poolQueryable();
  const ctx = await outletOrderContext(db, outletOrderId);
  await guard({
    principal,
    action: "order.book",
    entityType: "outlet_order",
    chainId: ctx.chainId,
    siteId: ctx.siteId,
    target: `booking ${ctx.serviceReference}`,
    source: meta.source,
  });

  const header = await db.query<{
    order_id: string;
    outlet_order_id: string;
    service_reference: string;
    origin: string;
    table_label: string | null;
    order_status: string;
    outlet_order_status: string;
    placed_at: string;
    accepted_at: string | null;
    fired_at: string | null;
    closed_at: string | null;
    currency_code: string;
    service_charge_percent: string;
    subtotal_minor: number;
    tax_minor: number;
    service_charge_minor: number;
    total_minor: number;
    outlet_code: string;
    site_code: string;
  }>(
    `select o.id as order_id, oo.id as outlet_order_id, o.service_reference, o.origin, o.table_label,
            o.status as order_status, oo.status as outlet_order_status,
            to_char(o.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as placed_at,
            to_char(oo.accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as accepted_at,
            to_char(oo.fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fired_at,
            to_char(oo.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as closed_at,
            oo.currency_code, oo.service_charge_percent::text as service_charge_percent,
            oo.subtotal_minor, oo.tax_minor, oo.service_charge_minor, oo.total_minor,
            ol.code as outlet_code, s.code as site_code
       from outlet_order oo
       join "order" o on o.id = oo.order_id
       join outlet ol on ol.id = oo.outlet_id
       join site s on s.id = oo.site_id
      where oo.id = $1 and oo.chain_id = $2`,
    [outletOrderId, ctx.chainId]
  );
  const head = header[0];
  if (!head) throw new NotFound("Outlet order", outletOrderId);

  const lines = await db.query<{
    order_line_id: string;
    position: number;
    article_code: string;
    article_version_id: string;
    article_price_id: string | null;
    tax_rate_id: string | null;
    tax_rate_pct: string;
    tax_inclusive: boolean;
    quantity: number;
    unit_amount_minor: number;
    net_amount_minor: number;
    tax_amount_minor: number;
    line_amount_minor: number;
    service_charge_amount_minor: number;
    line_total_minor: number;
    routing_section_id: string | null;
    routing_source: string | null;
    line_state: string;
  }>(
    `select ol.id as order_line_id, ol.position, a.code as article_code, ol.article_version_id,
            ol.article_price_id, ol.tax_rate_id, ol.tax_rate_pct::text as tax_rate_pct, ol.tax_inclusive,
            ol.quantity, ol.unit_amount_minor, ol.net_amount_minor, ol.tax_amount_minor,
            ol.line_amount_minor, ol.service_charge_amount_minor, ol.line_total_minor,
            ol.routing_section_id, ol.routing_source, ol.line_state
       from order_line ol
       join article a on a.id = ol.article_id
      where ol.outlet_order_id = $1 and ol.chain_id = $2
      order by ol.position`,
    [outletOrderId, ctx.chainId]
  );

  return {
    orderId: head.order_id,
    outletOrderId: head.outlet_order_id,
    serviceReference: head.service_reference,
    origin: head.origin,
    tableLabel: head.table_label,
    orderStatus: head.order_status,
    outletOrderStatus: head.outlet_order_status,
    placedAt: head.placed_at,
    acceptedAt: head.accepted_at,
    firedAt: head.fired_at,
    closedAt: head.closed_at,
    currencyCode: head.currency_code.trim(),
    serviceChargePercent: Number(head.service_charge_percent),
    subtotalMinor: head.subtotal_minor,
    taxMinor: head.tax_minor,
    serviceChargeMinor: head.service_charge_minor,
    totalMinor: head.total_minor,
    outletCode: head.outlet_code,
    siteCode: head.site_code,
    lines: lines.map((row) => ({
      orderLineId: row.order_line_id,
      position: row.position,
      articleCode: row.article_code,
      articleVersionId: row.article_version_id,
      articlePriceId: row.article_price_id ?? "",
      taxRateId: row.tax_rate_id,
      taxRatePct: Number(row.tax_rate_pct),
      taxInclusive: row.tax_inclusive,
      quantity: row.quantity,
      unitAmountMinor: row.unit_amount_minor,
      netAmountMinor: row.net_amount_minor,
      taxAmountMinor: row.tax_amount_minor,
      amountMinor: row.line_amount_minor,
      serviceChargeMinor: row.service_charge_amount_minor,
      totalMinor: row.line_total_minor,
      routingSectionId: row.routing_section_id,
      routingSource: row.routing_source,
      lineState: row.line_state,
    })),
  };
}
