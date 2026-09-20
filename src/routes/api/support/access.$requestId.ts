import { createFileRoute } from "@tanstack/react-router";

import { decideSupportAccessRequest } from "~/domain/support";
import { toErrorResponse, Unauthenticated, ValidationError } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   PATCH /api/support/access/:requestId   → { approve: boolean, note?, grantedHours? }
 *
 * Requires `scope.grant.manage` — the capability table gives "Grant scopes to
 * AppConfig/AppSupport" to AppAdmin alone — and reach into the chain being granted, so a
 * delegated operator cannot widen someone else's access to a chain they cannot reach
 * themselves. An approval writes the time-boxed `scope_grant`; a refusal writes nothing.
 */
export const Route = createFileRoute("/api/support/access/$requestId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            approve?: boolean;
            note?: string | null;
            grantedHours?: number | null;
          };
          if (typeof body.approve !== "boolean") {
            throw new ValidationError("approve must be true or false");
          }
          const result = await decideSupportAccessRequest(
            principal,
            params.requestId,
            { approve: body.approve, note: body.note ?? null, grantedHours: body.grantedHours ?? null },
            { source: "api" }
          );
          return Response.json({ updated: "access_request", ...result });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
