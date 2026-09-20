import { createFileRoute } from "@tanstack/react-router";

import { listSupportAccess, requestSupportAccess, useSupportAccess } from "~/domain/support";
import { toErrorResponse, Unauthenticated, ValidationError } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   GET  /api/support/access   → requests (own, or every pending one for an AppAdmin)
 *                                 plus the live chain-scoped grants this caller holds
 *   POST /api/support/access   → { chainId, reason, requestedHours, ticketId? }      (ask)
 *                              → { useChainId }                                       (use)
 *
 * Asking requires `support.access.request`; *using* requires
 * `support.chain_access.timeboxed` **and** a live grant for that chain. Using writes the
 * audit row the spec asks for — "scoped, time-boxed and audit-logged" applied to the use,
 * not just the grant — so a chain's trail shows which support sessions opened its account.
 */
export const Route = createFileRoute("/api/support/access")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const access = await listSupportAccess(principal);
          return Response.json(access);
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            chainId?: string;
            reason?: string;
            requestedHours?: number;
            ticketId?: string | null;
            useChainId?: string;
          };

          if (body.useChainId) {
            const result = await useSupportAccess(principal, body.useChainId, { source: "api" });
            return Response.json({ used: true, ...result });
          }

          if (!body.chainId || !body.reason || body.requestedHours === undefined) {
            throw new ValidationError("send either { useChainId } or { chainId, reason, requestedHours }");
          }

          const result = await requestSupportAccess(
            principal,
            {
              chainId: body.chainId,
              reason: body.reason,
              requestedHours: body.requestedHours,
              ticketId: body.ticketId ?? null,
            },
            { source: "api" }
          );
          return Response.json({ requested: true, ...result }, { status: 201 });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
