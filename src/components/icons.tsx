import type { SVGProps } from "react";

/**
 * Icons — inline SVG, no icon dependency.
 *
 * Two rules, both from the localisation direction:
 *   * **Direction-aware icons flip; object icons do not.** A chevron, an arrow and a
 *     progress bar encode a reading direction and carry `className="icon-directional"`,
 *     which the stylesheet mirrors under `[dir="rtl"]`. A bin, a clock, a building or a
 *     lock encodes an object and never flips.
 *   * **An icon is never the only carrier of meaning.** Every icon used for status sits
 *     next to its label, and decorative icons are `aria-hidden` so a screen reader does
 *     not announce "warning" twice.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Icon({ size = 16, title, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Reading-direction icon: flips under `[dir="rtl"]`. */
export function ChevronRight(props: IconProps) {
  return (
    <Icon {...props} className={`icon-directional ${props.className ?? ""}`}>
      <path d="M9 18l6-6-6-6" />
    </Icon>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Icon {...props} className={`icon-directional ${props.className ?? ""}`}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Icon>
  );
}

export function ArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Icon>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M18 13l-6 6-6-6" />
    </Icon>
  );
}

export function Check(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 6L9 17l-5-5" />
    </Icon>
  );
}

export function CheckCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </Icon>
  );
}

export function Close(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function XCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Icon>
  );
}

export function AlertTriangle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17.5h.01" />
    </Icon>
  );
}

export function InfoCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7.5h.01" />
    </Icon>
  );
}

export function Clock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function Lock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
    </Icon>
  );
}

export function Search(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
    </Icon>
  );
}

export function Plus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function Minus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function Dot(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Status shapes. Shape, not only colour, distinguishes these on a monochrome print. */
export function StatusShape({ shape, size = 14 }: { shape: "ok" | "warn" | "danger" | "info" | "neutral"; size?: number }) {
  if (shape === "ok") return <CheckCircle size={size} />;
  if (shape === "warn") return <AlertTriangle size={size} />;
  if (shape === "danger") return <XCircle size={size} />;
  if (shape === "info") return <InfoCircle size={size} />;
  return <Minus size={size} />;
}

export function Globe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17" />
      <path d="M12 3.2c2.4 2.4 3.6 5.4 3.6 8.8s-1.2 6.4-3.6 8.8c-2.4-2.4-3.6-5.4-3.6-8.8S9.6 5.6 12 3.2z" />
    </Icon>
  );
}

export function Rows(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  );
}

export function Layers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5l8 4.5-8 4.5-8-4.5 8-4.5z" />
      <path d="M4 12.5l8 4.5 8-4.5" />
    </Icon>
  );
}

export function Store(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.5V20h16V9.5" />
      <path d="M3 9.5L5.5 4h13L21 9.5z" />
      <path d="M10 20v-5h4v5" />
    </Icon>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`animate-spin ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" fill="none" />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function Chat(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7A2.5 2.5 0 0117.5 16H10l-6 4z" />
    </Icon>
  );
}

export function Shield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5l7 3v5c0 4.2-2.8 7.6-7 9-4.2-1.4-7-4.8-7-9v-5z" />
    </Icon>
  );
}
