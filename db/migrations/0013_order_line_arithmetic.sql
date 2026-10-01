-- OmniHost.ai — migration 0013: the line arithmetic identity, corrected for a tax-inclusive menu price
-- ------------------------------------------------------------------------------------------------
-- Found by S-B/1c, the slice that takes the first real three-line booking through `bookOutletOrder`
-- and reads it back. Migration 0012's `order_line_arithmetic` asserted
--
--     net_amount_minor = unit_amount_minor * quantity
--
-- unconditionally, and that identity holds only for a tax-**exclusive** class. The pilot's menu
-- prices are tax-inclusive — 0012's own column comment on `unit_amount_minor` says so ("the menu
-- price of one unit, tax-inclusive, in minor units (the INR paise a guest sees on the menu)"), and
-- so does the comment on `line_amount_minor` ("unit_amount_minor x quantity: the line as printed on
-- the menu") — so for those lines the menu amount *is* the gross, the tax is extracted from it, and
-- `net` is the amount less the tax. `priceLine` (`src/domain/order-rules.ts`) does exactly that, and
-- 0012's own header comment above the constraint already described it ("its amount is its net plus
-- its tax — which is how a tax-inclusive menu price splits (tax = amount - net) and how an exclusive
-- one adds up (amount = net + tax)"). The constraint therefore contradicted the two comments
-- directly above it.
--
-- **What it cost, stated with both numbers.** Booking `T-001` at `koramangala-restaurant` as
-- `site.head@saffron.example` (a principal that holds `order.book`) was refused:
--
--     new row for relation "order_line" violates check constraint "order_line_arithmetic"
--     sqlstate 23514, constraint order_line_arithmetic, table order_line
--     the code computed net_amount_minor = 37619 (unit 39500, tax class inclusive, rate 5.0000%)
--     the constraint demanded net_amount_minor = unit_amount_minor * quantity = 39500
--
-- 1881 paise apart — exactly the tax. The transaction rolled back whole and no `order` row could be
-- written at any outlet, for any article, for any tax-inclusive class: the booking side of the
-- display slice was unreachable. The running code follows the inclusive convention and the comments;
-- the constraint's first clause was the defect, so it is the clause that changes here.
--
-- **The corrected constraint** states the branch that applies and then the two identities that hold
-- in both branches:
--
--   * inclusive: `line_amount_minor = unit_amount_minor * quantity`   (the menu price is the gross)
--   * exclusive: `net_amount_minor  = unit_amount_minor * quantity`   (the tax is added on top)
--   * `line_amount_minor = net_amount_minor + tax_amount_minor`        (both branches)
--   * `line_total_minor  = line_amount_minor + service_charge_amount_minor`
--
-- Checked against both branches of `priceLine`: inclusive 39500 -> net 37619 = round(39500*100/105),
-- tax 1881, amount 37619 + 1881 = 39500 = unit x qty; exclusive base 39500 -> net 39500 = unit x qty,
-- tax 1975 = round(39500*5/100), amount 41475 = net + tax. Neither branch can now be stored wrong,
-- and a class whose `inclusive` flag is wrong is refused rather than believed.
--
-- **Additive and reversible.** One constraint is dropped and one is added; no table, column or row
-- changes and no data is rewritten (the table had no rows when this ran). To undo, drop the
-- constraint below and re-add 0012's — which is only possible while no tax-inclusive line exists,
-- so undo means removing such lines first. `order_line` is empty in the pilot today (0 rows), so
-- this migration validates instantly.
alter table order_line
  drop constraint order_line_arithmetic;

alter table order_line
  add constraint order_line_arithmetic
    check (
      (
        (tax_inclusive and line_amount_minor = unit_amount_minor * quantity)
        or ((not tax_inclusive) and net_amount_minor = unit_amount_minor * quantity)
      )
      and line_amount_minor = net_amount_minor + tax_amount_minor
      and line_total_minor = line_amount_minor + service_charge_amount_minor
    );
