import type { ReactNode } from "react";

import { useI18n } from "~/i18n";
import { NO_VALUE, type Money } from "~/i18n/format";

/**
 * Value renderers — the three things a dense operations row is mostly made of, and the
 * three things that break first in an international product: money, quantities and
 * timestamps.
 *
 *   * **Money** is an amount plus an ISO code. `MoneyValue` cannot be called with a
 *     number, so no screen can quietly assume rupees. The integer and the fraction are
 *     rendered as separate spans so a column of money aligns on the decimal, and the
 *     currency code is always present — either in the cell or in the column header.
 *   * **Quantity** carries its unit-of-measure code, untranslated: `kg`, `L`, `pc` are
 *     codes the store ledger, the API and the vendor's invoice all use, and a
 *     localised "किग्रा" in a column an operator reconciles against a paper invoice is
 *     worse than useless. The UOM's *label* is a master-data concern for MDM.
 *   * **Timestamp** renders an ISO instant in the resolved zone, with the full instant
 *     and the zone in the `title` and in `<time datetime>` for assistive tech.
 */

export function MoneyValue({
  money,
  showCode = true,
  signed = false,
  tone,
}: {
  money: Money | null | undefined;
  /** Keep the ISO code visible unless the column header already names the currency. */
  showCode?: boolean;
  /** Force an explicit +/− so a credit and a debit never look alike. */
  signed?: boolean;
  tone?: "danger" | "ok" | "default";
}) {
  const { format, t } = useI18n();
  if (!money) return <span className="text-fg-subtle">{t("common.none")}</span>;
  const parts = format.moneyParts(money);
  const toneClass = tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : "";
  const signPrefix = signed && !parts.negative ? "+" : "";
  return (
    <span className={`num inline-flex items-baseline gap-1 justify-end ${toneClass}`}>
      <span>
        {signPrefix}
        {parts.negative ? "−" : ""}
        {parts.integer}
        {parts.fraction ? <span className="money-frac">{parts.fraction}</span> : null}
      </span>
      {showCode ? <span className="text-2xs font-medium tracking-wide text-fg-subtle">{money.currency}</span> : null}
    </span>
  );
}

/** A money cell for a table: right-aligned, code in the header, `title` has the lot. */
export function MoneyCell({
  money,
  showCode = true,
  signed = false,
  tone,
}: {
  money: Money | null | undefined;
  showCode?: boolean;
  signed?: boolean;
  tone?: "danger" | "ok" | "default";
}) {
  const { format, t } = useI18n();
  if (!money) return <span className="text-fg-subtle">{t("common.none")}</span>;
  return (
    <span title={format.money(money, { display: "code" })}>
      <MoneyValue money={money} showCode={showCode} signed={signed} tone={tone} />
    </span>
  );
}

export function QuantityValue({
  value,
  uom,
  decimals = 3,
}: {
  value: number | null | undefined;
  /** A UOM code from master data — `kg`, `L`, `pc`. Rendered as-is, never translated. */
  uom: string;
  decimals?: number;
}) {
  const { format, t } = useI18n();
  if (value === null || value === undefined) return <span className="text-fg-subtle">{t("common.none")}</span>;
  return (
    <span className="num inline-flex items-baseline gap-1 justify-end">
      <span>{format.number(value, { maximumFractionDigits: decimals, minimumFractionDigits: 0 })}</span>
      <span className="text-2xs font-medium tracking-wide text-fg-subtle">{uom}</span>
    </span>
  );
}

export function NumberValue({ value, decimals = 0 }: { value: number | null | undefined; decimals?: number }) {
  const { format, t } = useI18n();
  if (value === null || value === undefined) return <span className="text-fg-subtle">{t("common.none")}</span>;
  return (
    <span className="num">
      {format.number(value, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}
    </span>
  );
}

export type TimestampMode = "date" | "time" | "dateTime" | "relative" | "weekday";

export function TimestampValue({
  value,
  mode = "dateTime",
  className = "",
}: {
  value: string | null | undefined;
  mode?: TimestampMode;
  className?: string;
}) {
  const { format, t, timeZone } = useI18n();
  if (!value) return <span className="text-fg-subtle">{t("common.none")}</span>;
  const iso = format.iso(value);
  if (!iso) return <span className="text-fg-subtle">{t("common.none")}</span>;
  const text =
    mode === "date"
      ? format.date(value)
      : mode === "time"
        ? format.time(value)
        : mode === "relative"
          ? format.relative(value)
          : mode === "weekday"
            ? format.weekdayDateTime(value)
            : format.dateTime(value);
  return (
    <time
      dateTime={iso}
      title={`${format.dateTime(value)} · ${timeZone}`}
      className={`num whitespace-nowrap ${className}`}
    >
      {text}
    </time>
  );
}

/**
 * A label with its machine identifier underneath — the console's convention for
 * anything an operator may have to quote to support: a chain code, a permission, a
 * feature code, a role code.
 */
export function CodeLabel({ label, code, className = "" }: { label: ReactNode; code: string; className?: string }) {
  return (
    <span className={`block min-w-0 ${className}`}>
      <span className="block truncate text-sm text-fg">{label}</span>
      <code className="block truncate font-mono text-2xs text-fg-subtle">{code}</code>
    </span>
  );
}

/**
 * Before/after state, as the audit trail records it.
 *
 * The audit log is evidence, so this renders what is stored rather than a tidy summary:
 * a changed field is shown as `before → after` side by side, unchanged fields stay in
 * the list (their absence would be its own kind of claim), and the raw JSON is the
 * fallback whenever the shape is not a flat object. Nothing is truncated away without
 * saying so.
 */
export function BeforeAfter({ before, after }: { before: string | null; after: string | null }) {
  const { t } = useI18n();

  const parsed = (value: string | null): { ok: true; data: unknown } | { ok: false; raw: string } => {
    if (value === null || value === undefined || value === "") return { ok: false, raw: t("common.none") };
    try {
      return { ok: true, data: JSON.parse(value) as unknown };
    } catch {
      return { ok: false, raw: value };
    }
  };

  const left = parsed(before);
  const right = parsed(after);

  const isFlat =
    left.ok &&
    right.ok &&
    typeof left.data === "object" &&
    left.data !== null &&
    typeof right.data === "object" &&
    right.data !== null &&
    !Array.isArray(left.data) &&
    !Array.isArray(right.data);

  if (!isFlat) {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{t("audit.before")}</dt>
        <dd className="break-all font-mono text-fg-muted">{"raw" in left ? left.raw : JSON.stringify(left.data)}</dd>
        <dt className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{t("audit.after")}</dt>
        <dd className="break-all font-mono text-fg">{"raw" in right ? right.raw : JSON.stringify(right.data)}</dd>
      </dl>
    );
  }

  const beforeObject = left.data as Record<string, unknown>;
  const afterObject = right.data as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])];
  if (keys.length === 0) return <p className="text-xs text-fg-subtle">{t("audit.noChange")}</p>;

  const renderValue = (value: unknown): string => {
    if (value === undefined || value === null) return t("common.none");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{t("audit.column.stateChange")}</caption>
      <thead>
        <tr className="text-2xs uppercase tracking-wide text-fg-subtle">
          <th scope="col" className="w-1/4 pb-1 text-start font-semibold">
            {t("pattern.ledger.column.item")}
          </th>
          <th scope="col" className="pb-1 text-start font-semibold">
            {t("audit.before")}
          </th>
          <th scope="col" className="pb-1 text-start font-semibold">
            {t("audit.after")}
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => {
          const changed = JSON.stringify(beforeObject[key]) !== JSON.stringify(afterObject[key]);
          return (
            <tr key={key} className={changed ? "bg-warn-soft" : undefined}>
              <td className="py-0.5 pe-2 align-top font-mono text-2xs text-fg-muted">{key}</td>
              <td className="py-0.5 pe-2 align-top font-mono break-all text-fg-muted">{renderValue(beforeObject[key])}</td>
              <td className={`py-0.5 align-top font-mono break-all ${changed ? "text-fg" : "text-fg-muted"}`}>
                {renderValue(afterObject[key])}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Unknown-value placeholder, catalog-driven so it is not a hard-coded glyph. */
export function NoValue() {
  const { t } = useI18n();
  return <span className="text-fg-subtle">{t("common.none")}</span>;
}

export { NO_VALUE };
