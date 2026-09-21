/**
 * The browser-safe projection of a signed-in principal.
 *
 * `Principal` (in `~/server/session`) is the server's own view of an identity: it carries
 * the resolved permission set, the roles, the chain/site scope and the session's own
 * bookkeeping. Screens do not need — and must not be handed — more than the fields below,
 * so the bridge (`~/server-fns`) projects one into the other in `toPublic`.
 *
 * **Why this file exists.** It is a *type-only, import-free* module on purpose. Types are
 * erased at compile time, but a type is only erased if the module it is declared in can be
 * imported without side effects: a screen that asks for `PublicPrincipal` from a module
 * that also value-imports `pg`, `node:crypto` or a `@tanstack/react-start/server-only`
 * marker drags all of that into the **client** bundle, and the app cannot hydrate. Keeping
 * the shared, browser-safe shapes in modules that import nothing server-only is what makes
 * the boundary hold. See `~/domain/nav` for the sibling case, and `~/server-fns` for the
 * rule the whole bridge follows.
 */
export interface PublicPrincipal {
  userId: string;
  email: string;
  displayName: string;
  scope: "app" | "central" | "site";
  chainId: string | null;
  siteId: string | null;
  roles: { code: string; name: string; layer: string; functionCode: string | null; chainId: string | null; siteId: string | null }[];
  grants: { reason: string; chainId: string | null; expiresAt: string | null; grantedBy: string | null; permissions: string[] }[];
  permissions: string[];
  sessionExpiresAt: string;
}
