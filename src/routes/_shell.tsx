import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";

import { AppShell } from "~/components/AppShell";
import { useI18n } from "~/i18n";
import { getSession } from "~/server-fns";

/**
 * The signed-in frame. Resolved before anything renders, so an unauthenticated visitor
 * never sees a flash of console chrome, and so every child route can rely on
 * `context.principal` being a real, server-resolved identity.
 *
 * This is the seam every later role module plugs into: add a route file under
 * `_shell.*`, optionally a `NAV_ITEMS` row in src/domain/auth.ts and a `nav.route.*`
 * message for it, and navigation, the identity strip, the language switcher and the
 * permission registry come for free.
 *
 * The page title comes from the active child route's `staticData.titleKey` and is
 * translated here, so no route file holds an English string.
 */
export const Route = createFileRoute("/_shell")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.principal) throw redirect({ to: "/login" });
    return {
      principal: session.principal,
      nav: session.nav,
      openApprovals: session.openApprovals,
    };
  },
  component: ShellLayout,
});

function ShellLayout() {
  const { principal, nav, openApprovals } = Route.useRouteContext();
  const title = useTitle();
  return (
    <AppShell principal={principal} nav={nav} openApprovals={openApprovals} title={title}>
      <Outlet />
    </AppShell>
  );
}

/** The header title comes from the active child route, so the shell keeps no list. */
function useTitle(): string {
  const { t } = useI18n();
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const staticData = matches[index]?.staticData as { titleKey?: string } | undefined;
    if (staticData?.titleKey) {
      const translated = t(staticData.titleKey as never);
      return translated === staticData.titleKey ? staticData.titleKey : translated;
    }
  }
  return t("app.tagline");
}
