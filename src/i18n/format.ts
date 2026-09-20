/**
 * Locale-aware formatting.
 *
 * Every date, time, number and amount the console renders goes through here. Three
 * rules, all owner-set:
 *
 *   1. **Currency is an amount plus an ISO code.** Never a bare number, never an
 *      assumed rupee. `Money` is a type, not a convention, so `formatMoney` cannot be
 *      called by accident with a number alone.
 *   2. **Timestamps are stored in UTC and rendered in the viewer's zone.** The zone is
 *      resolved (site → chain → platform) and reported in the shell, so two operators
 *      looking at the same GRN in two offices both see their own clock and know it.
 *   3. **Nothing is string-concatenated.** `Intl` decides where the symbol, the sign,
 *      the decimal separator and the thousands separator go — Arabic, Indian grouping
 *      (1,23,456) and European separators come out right without a branch in a
 *      component.
 */

export interface Money {
  amount: number;
  /** ISO 4217. Required, deliberately. */
  currency: string;
}

export function isMoney(value: unknown): value is Money {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Money).amount === "number" &&
    typeof (value as Money).currency === "string"
  );
}

export interface MoneyParts {
  /** Rendered currency marker: symbol, code or name, per the display option. */
  marker: string;
  integer: string;
  /** Decimal separator plus fraction, or "" when the amount is whole. */
  fraction: string;
  sign: "-" | "+" | "";
  negative: boolean;
}

export type CurrencyDisplay = "symbol" | "code" | "name" | "narrowSymbol";

export interface Formatters {
  locale: string;
  timeZone: string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  integer: (value: number) => string;
  decimal: (value: number, digits?: number) => string;
  percent: (value: number, options?: Intl.NumberFormatOptions) => string;
  currency: (value: number, currency: string, options?: Intl.NumberFormatOptions) => string;
  money: (money: Money, options?: { display?: CurrencyDisplay; signDisplay?: Intl.NumberFormatOptions["signDisplay"] }) => string;
  moneyParts: (money: Money, options?: { display?: CurrencyDisplay }) => MoneyParts;
  date: (input: string | Date | null | undefined) => string;
  time: (input: string | Date | null | undefined) => string;
  dateTime: (input: string | Date | null | undefined) => string;
  weekdayDateTime: (input: string | Date | null | undefined) => string;
  /** ISO instant for a `title` attribute or an audit record. */
  iso: (input: string | Date | null | undefined) => string;
  relative: (input: string | Date | null | undefined, now?: Date) => string;
  /** A quantity with its unit code — `20 kg`. The UOM is never translated, only spaced. */
  quantity: (value: number, uom: string) => string;
  list: (values: string[]) => string;
}

function toDate(input: string | Date | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createFormatters(locale: string, timeZone: string): Formatters {
  const numberFormatters = new Map<string, Intl.NumberFormat>();
  const dateCache = new Map<string, Intl.DateTimeFormat>();

  function numberFormat(options: Intl.NumberFormatOptions, cacheKey: string): Intl.NumberFormat {
    const cached = numberFormatters.get(cacheKey);
    if (cached) return cached;
    let formatter: Intl.NumberFormat;
    try {
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      formatter = new Intl.NumberFormat(undefined, options);
    }
    numberFormatters.set(cacheKey, formatter);
    return formatter;
  }

  function dateFormat(options: Intl.DateTimeFormatOptions, cacheKey: string): Intl.DateTimeFormat {
    const cached = dateCache.get(cacheKey);
    if (cached) return cached;
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      formatter = new Intl.DateTimeFormat(locale, options);
    }
    dateCache.set(cacheKey, formatter);
    return formatter;
  }

  const relativeFormatter = (() => {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    } catch {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    }
  })();

  const listFormatter = (() => {
    try {
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
    } catch {
      return new Intl.ListFormat("en", { style: "long", type: "conjunction" });
    }
  })();

  function moneyParts(money: Money, options?: { display?: CurrencyDisplay }): MoneyParts {
    const display = options?.display ?? "symbol";
    const formatter = numberFormat(
      { style: "currency", currency: money.currency, currencyDisplay: display },
      `currency:${money.currency}:${display}`
    );
    const parts = formatter.formatToParts(money.amount);
    let marker = "";
    let integer = "";
    let fraction = "";
    const currencySeparator = display === "code" ? " " : "";
    for (const part of parts) {
      switch (part.type) {
        case "currency":
          marker += part.value;
          break;
        case "integer":
        case "group":
          integer += part.value;
          break;
        case "decimal":
          fraction += part.value;
          break;
        case "fraction":
          fraction += part.value;
          break;
        case "minusSign":
        case "plusSign":
        case "literal":
        case "nan":
          if (part.type === "literal" && part.value.trim() === "" && marker !== "") {
            // A literal space between the symbol and the number: keep it with the marker
            // so `€ 1.234,50` and `1 234,50 €` both render in ICU's own order.
            marker += currencySeparator || " ";
          }
          break;
        default:
          break;
      }
    }
    if (!marker) marker = money.currency;
    return {
      marker: marker.trim(),
      integer,
      fraction,
      sign: money.amount < 0 ? "-" : "",
      negative: money.amount < 0,
    };
  }

  return {
    locale,
    timeZone,

    number(value, options) {
      return numberFormat(options ?? {}, JSON.stringify(options ?? {})).format(value);
    },
    integer(value) {
      return numberFormat({ maximumFractionDigits: 0 }, "int").format(value);
    },
    decimal(value, digits = 2) {
      return numberFormat(
        { minimumFractionDigits: digits, maximumFractionDigits: digits },
        `dec:${digits}`
      ).format(value);
    },
    percent(value, options) {
      return numberFormat({ style: "percent", ...(options ?? {}) }, `pct:${JSON.stringify(options ?? {})}`).format(
        value
      );
    },
    currency(value, currency, options) {
      let formatter: Intl.NumberFormat;
      try {
        formatter = new Intl.NumberFormat(locale, { style: "currency", currency, ...(options ?? {}) });
      } catch {
        return `${value} ${currency}`;
      }
      return formatter.format(value);
    },
    money(money, options) {
      return this.currency(money.amount, money.currency, { currencyDisplay: options?.display ?? "symbol" });
    },
    moneyParts,

    date(input) {
      const date = toDate(input);
      return date ? dateFormat({ year: "numeric", month: "short", day: "2-digit" }, "date").format(date) : "";
    },
    time(input) {
      const date = toDate(input);
      return date ? dateFormat({ hour: "2-digit", minute: "2-digit" }, "time").format(date) : "";
    },
    dateTime(input) {
      const date = toDate(input);
      return date
        ? dateFormat({ year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }, "dt").format(
            date
          )
        : "";
    },
    weekdayDateTime(input) {
      const date = toDate(input);
      return date
        ? dateFormat(
            { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" },
            "wd"
          ).format(date)
        : "";
    },
    iso(input) {
      const date = toDate(input);
      return date ? date.toISOString() : "";
    },
    relative(input, now = new Date()) {
      const date = toDate(input);
      if (!date) return "";
      const deltaSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
      const abs = Math.abs(deltaSeconds);
      const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 60 * 60 * 24 * 365],
        ["month", 60 * 60 * 24 * 30],
        ["day", 60 * 60 * 24],
        ["hour", 60 * 60],
        ["minute", 60],
        ["second", 1],
      ];
      for (const [unit, seconds] of units) {
        if (abs >= seconds || unit === "second") {
          return relativeFormatter.format(Math.round(deltaSeconds / seconds), unit);
        }
      }
      return "";
    },
    quantity(value, uom) {
      return `${numberFormat({ maximumFractionDigits: 3 }, "qty").format(value)}\u00a0${uom}`;
    },
    list(values) {
      return listFormatter.format(values);
    },
  };
}

/**
 * Em dash for an absent value — the console's one way of saying "nothing here".
 * Rendered through the catalog like everything else (`common.none`).
 */
export const NO_VALUE = "—";
