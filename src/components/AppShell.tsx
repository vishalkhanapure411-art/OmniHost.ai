import { Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { DensitySwitch } from "~/components/density";
import { Globe, Layers, Lock, Spinner } from "~/components/icons";
import { Badge, Button, Select } from "~/components/ui";
import { TimestampValue } from "~/components/values";
import { LOCALES, catalogCoverage } from "~/i18n/locales";
import { useI18n } from "~/i18n";
import type { LocaleCode } from "~/i18n/locales";
import type { NavItem, PublicPrincipal } from "~/server-fns";

/**
 * The app shell — the frame every role module plugs into.
 *
 * It owns four things and no more:
 *   1. **Role-aware navigation**, built from the same registry the server enforces
 *      (`NAV_ITEMS` in the domain layer). Hiding an item is a courtesy; the server
 *      refuses the call either way.
 *   2. **An identity strip that makes scope visible** — which chain, which site, which
 *      role, whether the authority is a delegated grant, and the zone timestamps are
 *      being rendered in. An operator looking at a GRN needs to know which clock they
 *      are reading.
 *   3. **Display preferences** — interface language and row density, both resolved on
 *      the server and both visible so a colleague's screen can be explained.
 *   4. **The approval-count badge**, which is the one number the shell must never get
 *      wrong.
 *
 * A later module adds a route file and, if it needs one, a `NAV_ITEMS` row. It does not
 * touch this file's structure.
 *
 * Translation: nav labels and descriptions come from the catalog, keyed by route
 * (`nav.route./chains`). The English label on the domain registry stays as the fallback,
 * so a route with no key yet still renders a sensible name instead of an empty box —
 * the registry keeps its single source of truth for *routes and permissions*, and the
 * catalog owns all *words*.
 */

/** Presentation grouping for the registry's routes. Not a permission statement. */
const NAV_GROUP: Record<string, "appLayer" | "platform"> = {
  "/chains": "appLayer",
  "/audit": "platform",
  "/approvals": "platform",
};

/**
 * Internal reference page, not a role capability: the design system gallery is
 * appended here rather than added to the domain registry, so the registry keeps meaning
 * "what this role may do in the tenant" and not "what pages exist".
 */
const INTERNAL_NAV: NavItem[] = [
  { to: "/design", label: "Design system", description: "Tokens, components and patterns." },
];

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
  const { t } = useI18n();
  const items = [...nav, ...INTERNAL_NAV];
  const grouped = groupNav(items);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t("app.skipToContent")}
      </a>

      <aside className="hidden w-60 shrink-0 flex-col border-e border-border bg-surface lg:flex">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-fg"
            aria-hidden="true"
          >
            OH
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{t("app.name")}</p>
            <p className="truncate text-2xs text-fg-subtle">{t("app.tagline")}</p>
          </div>
        </div>

        <nav aria-label={t("nav.section.aria")} className="flex-1 overflow-y-auto px-2 py-3">
          {grouped.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <p className="px-2 pb-1 text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
                {group.title}
              </p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      title={navDescription(item, t)}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-[var(--nav-item-py)] text-sm text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                      activeProps={{ className: "bg-accent-soft text-accent font-semibold" }}
                    >
                      <span className="min-w-0 truncate">{navLabel(item, t)}</span>
                      {item.to === "/approvals" && openApprovals > 0 ? (
                        <span className="num shrink-0 rounded-sm bg-accent px-1.5 text-2xs font-semibold text-accent-fg">
                          {openApprovals}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border px-4 py-3">
          <p className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
            {t("shell.permissions.title")}
          </p>
          <p className="mt-1 text-xs text-fg-muted">{tCountPermissions(principal, t)}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-accent">{t("shell.permissions.show")}</summary>
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {principal.permissions.map((code) => (
                <li key={code}>
                  <Badge tone="neutral" shape={false} mono>
                    {code}
                  </Badge>
                </li>
              ))}
            </ul>
          </details>
          <p className="mt-3 text-2xs text-fg-subtle">
            {t("shell.session.expires", { when: "" })}{" "}
            <TimestampValue value={principal.sessionExpiresAt} mode="weekday" />
          </p>
        </div>
      </aside>

      <div className="shell-main">
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-fg-subtle lg:hidden" aria-hidden="true">
              <Layers size={18} />
            </span>
            <p className="truncate text-sm font-semibold text-fg">{title}</p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <DensitySwitch />
            <LanguageSwitcher />
            <div className="hidden items-center gap-2 text-end sm:flex">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-fg">{principal.displayName}</p>
                <p className="truncate text-2xs text-fg-subtle">
                  {principal.roles.map((role) => role.name).join(", ") || t("shell.roles.none")} ·{" "}
                  {scopeLabel(principal, t)}
                </p>
              </div>
            </div>
            <SignOutButton />
          </div>
        </header>

        <MobileNav items={items} openApprovals={openApprovals} />

        {principal.grants.length > 0 ? (
          <div className="border-b border-border bg-warn-soft px-4 py-2" role="status">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
              <span className="text-warn" aria-hidden="true">
                <Lock size={14} />
              </span>
              {principal.grants.length === 1
                ? t("shell.grants.title.one")
                : t("shell.grants.title.other", { count: principal.grants.length })}
            </p>
            <p className="mt-0.5 text-xs text-fg-muted">{t("shell.grants.description")}</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {principal.grants.map((grant, index) => (
                <li key={index} className="text-2xs text-fg-muted">
                  {t("shell.grants.line", {
                    reason: grant.reason,
                    by: grant.grantedBy ?? t("common.unknown"),
                    when: grant.expiresAt ? "" : t("shell.grants.noExpiry"),
                  })}
                  {grant.expiresAt ? <TimestampValue value={grant.expiresAt} mode="weekday" className="ms-1" /> : null}
                  <span className="ms-1 font-mono">{grant.permissions.join(" ")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <main id="main" className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}

function tCountPermissions(principal: PublicPrincipal, t: ReturnType<typeof useI18n>["t"]): string {
  const count = principal.permissions.length;
  return count === 1
    ? t("shell.permissions.count.one", { count })
    : t("shell.permissions.count.other", { count });
}

function groupNav(items: NavItem[]): { key: string; title: string; items: NavItem[] }[] {
  return [
    {
      key: "platform",
      title: "nav.group.platform",
      items: items.filter((item) => NAV_GROUP[item.to] !== "appLayer"),
    },
    {
      key: "appLayer",
      title: "nav.group.appLayer",
      items: items.filter((item) => NAV_GROUP[item.to] === "appLayer"),
    },
  ].map((group) => ({ ...group, items: group.items }));
}

/**
 * Nav labels resolve through the catalog by route, with the domain registry's English
 * label as a fallback so a newly added route never renders blank.
 */
export function navLabel(item: NavItem, t: ReturnType<typeof useI18n>["t"]): string {
  const key = `nav.route.${item.to}` as const;
  const translated = t(key as never);
  return translated === key ? item.label : translated;
}

function navDescription(item: NavItem, t: ReturnType<typeof useI18n>["t"]): string {
  const key = `nav.route.${item.to}.description` as const;
  const translated = t(key as never);
  return translated === key ? item.description : translated;
}

function MobileNav({ items, openApprovals }: { items: NavItem[]; openApprovals: number }) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("nav.section.aria")}
      className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-3 py-1.5 lg:hidden"
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-muted"
          activeProps={{ className: "bg-accent-soft text-accent font-semibold" }}
        >
          {navLabel(item, t)}
          {item.to === "/approvals" && openApprovals > 0 ? (
            <span className="num ms-1 rounded-sm bg-accent px-1 text-2xs font-semibold text-accent-fg">
              {openApprovals}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The language switcher.
 *
 * The list is deliberately short and honest: two real catalogs (English (India), Hindi)
 * and two seeded pseudo-locales that exist to break layouts on purpose — one mirrors to
 * RTL, one pads every string by 40%. Both are labelled as layout tests so nobody
 * mistakes them for a translation. Coverage is shown for the real ones, because a
 * half-translated screen is a state to report, not to hide.
 */
export function LanguageSwitcher() {
  const { t, locale: active, setLocale, coverage, direction, timeZone } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-subtle" aria-hidden="true">
        <Globe size={14} />
      </span>
      <label className="sr-only" htmlFor="interface-language">
        {t("common.language.aria")}
      </label>
      <Select<LocaleCode>
        id="interface-language"
        ariaLabel={t("common.language.aria")}
        value={active}
        options={LOCALES.map((definition) => {
          const catalog = catalogCoverage(definition.catalog);
          const suffix = definition.pseudo
            ? ` · ${t("common.language.preview")}`
            : catalog.percent < 100
              ? ` · ${catalog.percent}%`
              : "";
          return { value: definition.code, label: `${definition.label}${suffix}` };
        })}
        onChange={(next) => {
          setBusy(true);
          setLocale(next);
          void router.invalidate().finally(() => {
            setBusy(false);
          });
        }}
      />
      {busy ? <Spinner size={12} className="text-fg-subtle" /> : null}
      <span className="hidden text-2xs text-fg-subtle xl:inline" title={`${timeZone} · ${direction}`}>
        {timeZone} · {direction === "rtl" ? t("shell.direction.rtl") : t("shell.direction.ltr")} ·{" "}
        {t("common.language.coverage", { translated: coverage.translated, total: coverage.total })}
      </span>
    </div>
  );
}

function SignOutButton() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      onClick={() => {
        setBusy(true);
        void fetch("/api/session", { method: "DELETE" }).then(() => {
          window.location.href = "/login";
        });
      }}
    >
      {t("action.signOut")}
    </Button>
  );
}

function scopeLabel(principal: PublicPrincipal, t: ReturnType<typeof useI18n>["t"]): string {
  if (principal.scope === "app") return t("shell.scope.app");
  if (principal.scope === "central") return t("shell.scope.central");
  return t("shell.scope.site");
}
