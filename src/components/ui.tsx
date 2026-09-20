import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { AlertTriangle, Check, Close, InfoCircle, Spinner, XCircle } from "~/components/icons";

/**
 * Console primitives.
 *
 * Thin on purpose. Layout, density, colour, radii and elevation come from
 * `src/styles/tokens.css`, so the whole console can be retuned from one file; text
 * comes from the message catalog, so nothing here writes a user-visible string. A
 * component in this file that reaches for a colour, a pixel value or an English word is
 * a bug.
 *
 * Accessibility is treated as part of the component, not as the caller's homework:
 *   * `Field` publishes its IDs through context and the controls pick them up, so an
 *     error message is always tied to its input by `aria-describedby` and
 *     `aria-invalid` — a caller cannot forget.
 *   * `Dialog` traps focus, closes on Escape, restores focus and labels itself.
 *   * `Badge` takes a shape as well as a tone, so status is never colour-only.
 */

// ── Buttons ────────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  type = "button",
  disabled = false,
  loading = false,
  onClick,
  title,
  icon,
  iconAfter,
  fullWidth = false,
  "aria-describedby": describedBy,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  title?: string;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  fullWidth?: boolean;
  "aria-describedby"?: string;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: "btn-primary",
    secondary: "btn-secondary",
    ghost: "btn-ghost",
    danger: "btn-danger",
    quiet: "btn-quiet",
  };
  return (
    <button
      type={type}
      title={title}
      aria-busy={loading || undefined}
      aria-describedby={describedBy}
      disabled={disabled || loading}
      onClick={onClick}
      className={`btn ${variants[variant]} ${size === "sm" ? "btn-sm" : ""} ${
        fullWidth ? "w-full justify-center" : ""
      }`}
    >
      {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon}
      <span className="min-w-0">{children}</span>
      {iconAfter}
    </button>
  );
}

export function IconButton({
  label,
  children,
  onClick,
  tone = "neutral",
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  tone?: "neutral" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:bg-surface-muted disabled:opacity-40 ${
        tone === "danger" ? "text-danger" : "text-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}

// ── Badges ─────────────────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

export function Badge({
  children,
  tone = "neutral",
  title,
  shape = true,
  mono = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
  /** Draw the tone's shape. Off only where the badge already sits in a labelled row. */
  shape?: boolean;
  mono?: boolean;
}) {
  const shapes: Record<BadgeTone, ReactNode> = {
    ok: <Check size={11} strokeWidth={3} />,
    warn: <AlertTriangle size={11} strokeWidth={2.5} />,
    danger: <XCircle size={11} strokeWidth={2.5} />,
    info: <InfoCircle size={11} strokeWidth={2.5} />,
    accent: null,
    neutral: null,
  };
  return (
    <span title={title} className={`badge badge-${tone} ${mono ? "font-mono normal-case" : ""}`}>
      {shape && shapes[tone] ? <span aria-hidden="true">{shapes[tone]}</span> : null}
      <span>{children}</span>
    </span>
  );
}

// ── Surfaces ───────────────────────────────────────────────────────────────────

export function Card({
  children,
  className = "",
  as: Element = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Element className={`rounded-lg border border-border bg-surface shadow-card ${className}`}>{children}</Element>;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-2.5">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold text-fg">
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 max-w-prose text-xs text-fg-muted">{subtitle}</p> : null}
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
  meta,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border bg-surface px-5 py-3.5">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">{eyebrow}</p>
        ) : null}
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        {description ? <p className="mt-0.5 max-w-3xl text-xs text-fg-muted">{description}</p> : null}
        {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({
  title,
  count,
  actions,
  level = 2,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <Heading className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">{title}</Heading>
        {count !== undefined ? <span className="text-xs text-fg-subtle">{count}</span> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}

/**
 * Label/value pairs — the dense summary a detail pane needs and a table would waste
 * vertical space on. Values align in a second column so a stack of them scans.
 */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: { label: ReactNode; value: ReactNode; span?: boolean }[];
  columns?: 1 | 2 | 3;
}) {
  const cols = columns === 1 ? "sm:grid-cols-1" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2 ${cols}`}>
      {items.map((item, index) => (
        <div key={index} className={item.span ? "sm:col-span-full" : ""}>
          <dt className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{item.label}</dt>
          <dd className="mt-0.5 text-sm text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Banners and notes ──────────────────────────────────────────────────────────

export function Banner({
  tone = "info",
  title,
  children,
  actions,
  compact = false,
}: {
  tone?: "info" | "warn" | "ok" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  const icons: Record<string, ReactNode> = {
    info: <InfoCircle size={16} />,
    warn: <AlertTriangle size={16} />,
    ok: <Check size={16} />,
    danger: <XCircle size={16} />,
  };
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`banner banner-${tone} ${compact ? "banner-compact" : ""}`}
    >
      <span className="mt-px shrink-0" aria-hidden="true">
        {icons[tone]}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="text-sm font-semibold text-fg">{title}</p> : null}
        {children ? <div className="text-xs text-fg-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Alias kept so a file importing the Phase 0a name still reads correctly. */
export const Note = Banner;

// ── States ─────────────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? "px-5 py-8" : "px-6 py-14"}`}>
      {icon ? <span className="text-fg-subtle">{icon}</span> : null}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="max-w-md text-xs text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  detail,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The server's own message. Shown verbatim, never re-worded by the UI. */
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <span className="text-danger" aria-hidden="true">
        <AlertTriangle size={22} />
      </span>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="max-w-lg text-xs text-fg-muted">{description}</p> : null}
      {detail ? (
        <p className="mt-1 max-w-lg rounded-md border border-border bg-surface-sunken px-3 py-1.5 font-mono text-2xs text-fg-muted">
          {detail}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function PermissionDenied({
  title,
  description,
  requiredPermission,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  requiredPermission?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <span className="text-warn" aria-hidden="true">
        <AlertTriangle size={22} />
      </span>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="max-w-lg text-xs text-fg-muted">{description}</p> : null}
      {requiredPermission ? (
        <code className="rounded-sm border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
          {requiredPermission}
        </code>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton block ${className}`} />;
}

/**
 * The pending state for a list route. Marked `aria-busy` with a visually hidden
 * sentence, so a screen reader gets "Loading" once instead of a row of empty boxes.
 */
export function TableSkeleton({
  rows = 6,
  columns = 5,
  label,
}: {
  rows?: number;
  columns?: number;
  label: string;
}) {
  return (
    <div aria-busy="true" className="p-3">
      <p className="sr-only">{label}</p>
      <div className="mb-2 flex gap-3">
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3 border-t border-border py-2.5">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton key={columnIndex} className={`h-3.5 flex-1 ${columnIndex === 0 ? "max-w-[40%]" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Form controls ──────────────────────────────────────────────────────────────

interface FieldContextValue {
  id: string;
  errorId: string;
  hintId: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldIds(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Rendered to the right of the label — a unit, a currency, a read-only marker. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Field({ id, label, hint, error, required = false, aside, children }: FieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const value = useMemo<FieldContextValue>(
    () => ({ id, errorId, hintId, invalid: Boolean(error), required }),
    [id, errorId, hintId, error, required]
  );
  return (
    <FieldContext.Provider value={value}>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
            {label}
            {required ? (
              <span className="ms-1 text-danger" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
          {aside ? <span className="text-2xs text-fg-subtle">{aside}</span> : null}
        </div>
        {children}
        {error ? (
          <p id={errorId} role="alert" className="flex items-start gap-1 text-xs text-danger">
            <span className="mt-px shrink-0" aria-hidden="true">
              <XCircle size={12} />
            </span>
            <span>{error}</span>
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs text-fg-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Wires a control to its Field's ids. A control used outside a Field is unaffected. */
function useControlAria(explicit?: string): {
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
  invalid: boolean;
} {
  const field = useContext(FieldContext);
  const describedBy = [field?.errorId && field.invalid ? field.errorId : null, field?.hintId && !field.invalid ? field.hintId : null]
    .filter(Boolean)
    .join(" ");
  return {
    id: explicit ?? field?.id,
    "aria-invalid": field?.invalid || undefined,
    "aria-describedby": describedBy || undefined,
    "aria-required": field?.required || undefined,
    invalid: Boolean(field?.invalid),
  };
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  name,
  autoComplete,
  disabled = false,
  id: explicitId,
  onBlur,
  inputMode,
  maxLength,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
  autoComplete?: string;
  disabled?: boolean;
  id?: string;
  onBlur?: () => void;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "tel";
  maxLength?: number;
  autoFocus?: boolean;
}) {
  const aria = useControlAria(explicitId);
  return (
    <input
      type={type}
      name={name}
      id={aria.id}
      aria-invalid={aria["aria-invalid"]}
      aria-describedby={aria["aria-describedby"]}
      aria-required={aria["aria-required"]}
      autoComplete={autoComplete}
      inputMode={inputMode}
      maxLength={maxLength}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onBlur={onBlur}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={`control w-full ${aria.invalid ? "control-invalid" : ""}`}
    />
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  id: explicitId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
}) {
  const aria = useControlAria(explicitId);
  return (
    <textarea
      id={aria.id}
      rows={rows}
      aria-invalid={aria["aria-invalid"]}
      aria-describedby={aria["aria-describedby"]}
      value={value}
      placeholder={placeholder}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={`control w-full ${aria.invalid ? "control-invalid" : ""}`}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  ariaLabel,
  id: explicitId,
  emptyLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
  id?: string;
  emptyLabel?: string;
}) {
  const aria = useControlAria(explicitId);
  return (
    <select
      aria-label={ariaLabel}
      id={aria.id}
      aria-invalid={aria["aria-invalid"]}
      aria-describedby={aria["aria-describedby"]}
      disabled={disabled}
      value={value}
      onChange={(event) => {
        onChange(event.target.value as T);
      }}
      className={`control ${aria.invalid ? "control-invalid" : ""} ${disabled ? "opacity-60" : ""}`}
    >
      {emptyLabel ? <option value="">{emptyLabel}</option> : null}
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
      className={`toggle ${checked ? "toggle-on" : "toggle-off"}`}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** Filter/segmented control. Used for row density; reusable for any small either/or. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; title?: string; icon?: ReactNode }[];
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="segmented">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={selected}
            onClick={() => {
              onChange(option.value);
            }}
            className={`segmented-item ${selected ? "segmented-item-on" : ""} ${size === "sm" ? "segmented-item-sm" : ""}`}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  id = "filter-search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  id?: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <span className="pointer-events-none absolute inset-y-0 start-2.5 flex items-center text-fg-subtle" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        id={id}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="control w-full ps-8"
      />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" strokeLinecap="round" />
    </svg>
  );
}

// ── Dialog: confirm before commit ──────────────────────────────────────────────

/**
 * The confirm-before-commit surface. Anything financial, stock-affecting or
 * permission-widening shows one of these and waits for an explicit confirm — the same
 * rule the chatbot's confirmation card follows, so a screen action and a chat action
 * behave identically.
 *
 * Escape closes, focus is trapped inside and returned to the trigger, and the dialog is
 * labelled by its own heading.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  tone = "default",
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "danger";
  width?: "sm" | "md" | "lg";
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    (focusable ?? panel).focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => node.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

  return (
    <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`dialog-panel ${widths[width]}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-xs text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <Close size={16} />
          </IconButton>
        </header>
        {children ? <div className="px-4 py-3 text-sm text-fg">{children}</div> : null}
        {footer ? (
          <footer
            className={`flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 ${
              tone === "danger" ? "bg-danger-soft" : ""
            }`}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** A summary row for a confirm dialog: what will be written, and to what. */
export function ConfirmSummary({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-border rounded-md border border-border bg-surface-sunken">
      {items.map((item, index) => (
        <div key={index} className="flex items-baseline justify-between gap-4 px-3 py-1.5">
          <dt className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{item.label}</dt>
          <dd className="text-sm text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Validation summary for the top of a form. Placed in the DOM with `role="alert"` and
 * linked to by the submit button, so "why did nothing happen" is answered out loud.
 */
export function ValidationSummary({ id, title, items }: { id: string; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div id={id} role="alert" className="banner banner-danger">
      <span className="mt-px shrink-0" aria-hidden="true">
        <XCircle size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{title}</p>
        <ul className="mt-1 list-inside list-disc text-xs text-fg-muted">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
