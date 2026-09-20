import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { PublicPrincipal, NavItem } from "~/server-fns";
import { Badge, Button, formatWhen } from "~/components/ui";

/**
 * The app shell — the frame every role module plugs into.
 *
 * It owns three things and no more: the role-aware navigation, the identity strip that
 * makes the current scope visible (which chain, which site, under which role, and
 * whether that authority is a delegated grant), and the approval-count badge. A later
 * module adds a route and, if it needs one, a `NAV_ITEMS` row; it does not touch this
 * file's structure.
 */

function scopeLabel(principal: PublicPrincipal): string {
  if (principal.scope === "app") return "App layer";
  if (principal.scope === "central") return "Central";
  return "Site";
}

export function AppShell({
  principal,
  nav,
  openApprovals,
  title,
  children,
}: {
  principal: PublicPrincipal;
  nav: NavItem[];
  openApprovals: number;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-fg">
            OH
          </span>
          <div>
            <p className="text-sm font-semibold text-fg">OmniHost.ai</p>
            <p className="text-2xs text-fg-subtle">Phase 0a foundation</p>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3">
          <ul className="flex flex-col gap-0.5">
            {nav.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                  activeProps={{ className: "bg-accent-soft text-accent font-semibold" }}
                >
                  <span>{item.label}</span>
                  {item.to === "/approvals" && openApprovals > 0 ? (
                    <span className="rounded-sm bg-accent px-1.5 text-2xs font-semibold text-accent-fg">
                      {openApprovals}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-border px-4 py-3">
          <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">Permissions</p>
          <p className="mt-1 text-xs text-fg-muted">
            {principal.permissions.length} tool{principal.permissions.length === 1 ? "" : "s"} resolved
            server-side
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-accent">Show registry</summary>
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {principal.permissions.map((code) => (
                <li key={code}>
                  <Badge tone="neutral">{code}</Badge>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-5 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <p className="truncate text-sm font-semibold text-fg">{title}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs font-semibold text-fg">{principal.displayName}</p>
              <p className="text-2xs text-fg-subtle">
                {principal.roles.map((role) => role.name).join(", ") || "no role"} ·{" "}
                {scopeLabel(principal)}
              </p>
            </div>
            <Badge tone={principal.scope === "app" ? "accent" : "info"}>{scopeLabel(principal)}</Badge>
            <SignOutButton />
          </div>
        </header>

        {principal.grants.length > 0 ? (
          <div className="border-b border-border bg-warn-soft px-5 py-2">
            <p className="text-xs text-fg">
              <span className="font-semibold">Delegated access.</span> You are operating under{" "}
              {principal.grants.length} grant{principal.grants.length === 1 ? "" : "s"} you did not
              hold by role — scoped to specific permissions, and time-boxed where the spec requires it.
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {principal.grants.map((grant) => (
                <li key={grant.reason} className="text-2xs text-fg-muted">
                  {grant.reason} · granted by {grant.grantedBy ?? "platform"} · expires{" "}
                  {formatWhen(grant.expiresAt)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function SignOutButton() {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void fetch("/api/session", { method: "DELETE" }).then(() => {
          window.location.href = "/login";
        });
      }}
    >
      Sign out
    </Button>
  );
}
