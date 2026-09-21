/**
 * The navigation registry and the role-aware helper that filters it.
 *
 * This is the **client-safe half of the session payload**. It lives in the domain layer
 * next to `principal.ts` for one structural reason, and it is worth stating plainly because
 * the mistake it prevents is invisible until someone tries to build or hydrate the app:
 *
 * - The registry is *both* client code (the shell renders the nav it was handed) and server
 *   code (the bridge derives the nav from the principal's permissions and the enforcement
 *   path reads the same `requires` codes).
 * - The module it used to live in — `~/domain/auth` — is server-only by necessity: it
 *   verifies passwords, opens sessions and writes audit rows, so it value-imports
 *   `~/server/crypto` (`node:crypto`), `~/db` (`pg`) and the `server-only` markers.
 * - An import edge from client-reachable code to that module therefore puts `node:crypto`
 *   and `pg` into the **browser** graph: the production bundle fails to resolve
 *   `randomBytes` and the dev page never hydrates (`Buffer is not defined`). That is exactly
 *   what happened, and it broke both surfaces at once.
 *
 * So: the registry and its filter live here, in a module with **no imports at all**, and the
 * server imports them from here too. One definition, one place, no server code on the wire.
 *
 * `requires` is the same capability code the server checks in `requirePermission`. Hiding an
 * item is a courtesy — a link that would only be refused — and never the control; the server
 * refuses the operation itself regardless of what the nav offered.
 */
export interface NavItem {
  to: string;
  label: string;
  description: string;
}

/** A nav row before the principal's permissions have been applied. */
export interface NavEntry extends NavItem {
  requires: string[];
}

export const NAV_ITEMS: NavEntry[] = [
  {
    to: "/approvals",
    label: "Approvals & tasks",
    description: "Maker-checker items waiting on your role.",
    requires: [],
  },
  {
    to: "/chains",
    label: "Chains",
    description: "Onboard chains, set licence tier, switch features.",
    requires: ["chain.list"],
  },
  {
    // AppConfig's working surface: the chains a delegation names are the only ones the
    // server will return, so an operator with no grant sees an empty list rather than a
    // refused screen.
    to: "/support",
    label: "Support queue",
    description: "Escalated tickets and the chain access you hold.",
    requires: ["support.ticket.read"],
  },
  {
    to: "/support/access",
    label: "Support access",
    description: "Time-boxed access into a chain's account, and who asked for it.",
    requires: ["support.access.request"],
  },
  {
    // Phase 1's first screen. `requires` is the same code the server checks, so a role
    // that cannot read the master does not see the door to it either — a courtesy, not a
    // control: the API refuses regardless.
    to: "/mdm/articles",
    label: "Articles",
    description: "The article master: names, per-outlet prices, allergens, and the fields the market's profile requires.",
    requires: ["mdm.article.view"],
  },
  {
    to: "/audit",
    label: "Audit trail",
    description: "Who did what, with before and after state.",
    requires: ["chain.audit.read"],
  },
];

/**
 * Role-aware navigation, derived from the same registry the enforcement path uses.
 *
 * Takes only what it needs — the caller's permission codes — so it works on the server with
 * a real principal and on the client with the projected one, without either importing the
 * other's types at runtime.
 */
export function navFor(principal: { permissions: readonly string[] }): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    item.requires.every((code) => principal.permissions.includes(code))
  ).map(({ to, label, description }) => ({ to, label, description }));
}
