import { createFileRoute } from "@tanstack/react-router";

import { signIn, signOut } from "~/domain/auth";
import { ValidationError, toErrorResponse } from "~/server/errors";
import { readCookie, requestIsSecure, sessionCookie } from "~/server/context";
import { SESSION_COOKIE, resolvePrincipal } from "~/server/session";

/**
 * Session API. The console signs in here with a plain fetch, so the cookie handling is
 * explicit and identical in the dev server and the built server.
 *
 *   POST   /api/session   { email, password }  → opens a session and sets the cookie
 *   GET    /api/session                        → the current identity, or null
 *   DELETE /api/session                        → revokes the session and clears the cookie
 *
 * The identity is only ever read from the HttpOnly cookie: no endpoint here accepts a
 * role, scope, chain or user id from the client.
 */
export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const principal = await resolvePrincipal(readCookie(request, SESSION_COOKIE));
        if (!principal) return Response.json({ principal: null });
        return Response.json({
          principal: {
            userId: principal.userId,
            email: principal.email,
            displayName: principal.displayName,
            scope: principal.scope,
            chainId: principal.chainId,
            siteId: principal.siteId,
            roles: principal.roles.map((role) => role.code),
            permissions: principal.permissions,
          },
        });
      },

      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { email?: string; password?: string };
          if (!body.email || !body.password) {
            throw new ValidationError("email and password are required");
          }
          const result = await signIn(body.email, body.password, {
            ip: request.headers.get("x-forwarded-for"),
            userAgent: request.headers.get("user-agent"),
          });
          return Response.json(
            {
              principal: {
                userId: result.principal.userId,
                email: result.principal.email,
                displayName: result.principal.displayName,
                scope: result.principal.scope,
                chainId: result.principal.chainId,
                siteId: result.principal.siteId,
                roles: result.principal.roles.map((role) => role.code),
                permissions: result.principal.permissions,
              },
              expiresAt: result.expiresAt,
            },
            {
              status: 201,
              headers: { "Set-Cookie": sessionCookie(result.token, requestIsSecure(request)) },
            }
          );
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },

      DELETE: async ({ request }) => {
        try {
          await signOut(readCookie(request, SESSION_COOKIE));
          return Response.json(
            { signedOut: true },
            {
              headers: {
                "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
              },
            }
          );
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
