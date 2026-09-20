import type { ReactNode } from "react";

/**
 * Primitives for the console. They are intentionally thin: layout, density and colour
 * come from tokens.css, so a designer can restyle the whole console by editing that
 * one file. Nothing here hard-codes a colour, a font size or a row height.
 */

export function Button({
  children,
  variant = "secondary",
  size = "md",
  type = "button",
  disabled = false,
  onClick,
  title,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const variants: Record<string, string> = {
    primary: "bg-accent text-accent-fg border-accent hover:bg-accent-hover",
    secondary: "bg-surface text-fg border-border-strong hover:bg-surface-muted",
    ghost: "bg-transparent text-fg-muted border-transparent hover:bg-surface-muted",
    danger: "bg-surface text-danger border-danger hover:bg-danger-soft",
  };
  const sizes: Record<string, string> = {
    sm: "px-2 py-0.5 text-xs",
    md: "field-control text-sm",
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]}`}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-sunken text-fg-muted border-border",
    accent: "bg-accent-soft text-accent border-accent-soft",
    ok: "bg-ok-soft text-ok border-ok-soft",
    warn: "bg-warn-soft text-warn border-warn-soft",
    danger: "bg-danger-soft text-danger border-danger-soft",
    info: "bg-info-soft text-info border-info-soft",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-2xs font-semibold tracking-wide uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-surface shadow-card ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border bg-surface px-5 py-4">
      <div>
        {eyebrow ? (
          <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">{eyebrow}</p>
        ) : null}
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        {description ? <p className="mt-0.5 max-w-3xl text-xs text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="max-w-md text-xs text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">{label}</span>
      <div className="mt-1">{children}</div>
      {error ? (
        <span className="mt-1 block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-fg-subtle">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  name,
  autoComplete,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
  autoComplete?: string;
}) {
  return (
    <input
      type={type}
      name={name}
      autoComplete={autoComplete}
      value={value}
      placeholder={placeholder}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className="field-control w-full rounded-md border border-border-strong bg-surface text-sm text-fg placeholder:text-fg-subtle"
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(event) => {
        onChange(event.target.value as T);
      }}
      className="field-control rounded-md border border-border-strong bg-surface text-sm text-fg disabled:opacity-50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative inline-flex h-4.5 w-8 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-sunken"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-surface shadow-card transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "ok" | "danger";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: "border-info-soft bg-info-soft text-fg",
    warn: "border-warn-soft bg-warn-soft text-fg",
    ok: "border-ok-soft bg-ok-soft text-fg",
    danger: "border-danger-soft bg-danger-soft text-fg",
  };
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${tones[tone]}`}>{children}</div>
  );
}

/** Renders a before/after pair the way the audit screen needs it. */
export function BeforeAfter({ before, after }: { before: string | null; after: string | null }) {
  const render = (value: string | null) => {
    if (value === null || value === undefined || value === "") return "—";
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (parsed === null) return "—";
    if (typeof parsed !== "object") return String(parsed);
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries
      .map(([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`)
      .join(", ");
  };
  return (
    <div className="grid gap-1 text-xs">
      <div className="text-fg-muted">
        <span className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">before</span>{" "}
        <span className="font-mono">{render(before)}</span>
      </div>
      <div className="text-fg">
        <span className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">after</span>{" "}
        <span className="font-mono">{render(after)}</span>
      </div>
    </div>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16);
}
