import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";

import { AppShell } from "~/components/AppShell";
import { getSession } from "~/server-fns";

/**
 * The signed-in frame. Resolved before anything renders, so an unauthenticated
 * visitor never sees a flash of console chrome, and so every child route can rely on
 * `context.principal` being a real, server-resolved identity.
 *
 * This is the seam every later role module plugs into: add a route file under
 * `_shell.*`, optionally add a row to NAV_ITEMS in src/domain/auth.ts, and the
 * navigation, identity strip and permission registry in the sidebar come for free.
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
  return (
    <AppShell principal={principal} nav={nav} openApprovals={openApprovals} title={useTitle()}>
      <Outlet />
    </AppShell>
  );
}

/** The header title comes from the active child route, so the shell keeps no list. */
function useTitle(): string {
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const staticData = matches[index]?.staticData as { title?: string } | undefined;
    if (staticData?.title) return staticData.title;
  }
  return "Console";
}
