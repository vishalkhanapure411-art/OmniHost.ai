import "@tanstack/react-start/server-only";

import { getCookie, getRequest, setCookie, deleteCookie } from "@tanstack/react-start/server";

import { Unauthenticated } from "~/server/errors";
import { SESSION_COOKIE, SESSION_TTL_HOURS, resolvePrincipal, type Principal } from "~/server/session";

/**
 * Glue between an incoming HTTP request and the session model.
 *
 * Two entry-point styles exist in this app and both end up here:
 *   * server functions (`createServerFn`) and page loaders, which read the ambient
 *     request through TanStack's request helpers, and
 *   * API routes under `src/routes/api/*`, which receive the `Request` directly and
 *     set their own response headers.
 *
 * In both cases the session token is read from an HttpOnly cookie. It is never read
 * from a query string, body field or custom header, so a caller cannot assert an
 * identity by asking nicely.
 */

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(SESSION_TTL_HOURS * 60 * 60)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** True when the site is served over HTTPS (so the cookie can be marked Secure). */
export function requestIsSecure(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The current principal for a server function / loader, or null. */
export async function currentPrincipal(): Promise<Principal | null> {
  let token: string | undefined;
  try {
    token = getCookie(SESSION_COOKIE);
  } catch {
    token = undefined;
  }
  if (!token) {
    try {
      token = readCookie(getRequest(), SESSION_COOKIE);
    } catch {
      token = undefined;
    }
  }
  return resolvePrincipal(token);
}

/** As above, but a missing session is an error rather than a null. */
export async function requirePrincipal(): Promise<Principal> {
  const principal = await currentPrincipal();
  if (!principal) throw new Unauthenticated();
  return principal;
}

export async function currentPrincipalFromRequest(request: Request): Promise<Principal | null> {
  return resolvePrincipal(readCookie(request, SESSION_COOKIE));
}

/** Used by the login API route only. */
export function setSessionCookieOnResponse(token: string, secure: boolean): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(token, secure));
  return headers;
}

export function setSessionCookieOnCurrentResponse(token: string): void {
  setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });
}

export function clearSessionCookieOnCurrentResponse(): void {
  try {
    deleteCookie(SESSION_COOKIE, { path: "/" });
  } catch {
    // Nothing to clear outside a request context.
  }
}
