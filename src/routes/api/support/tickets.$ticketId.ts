import { createFileRoute } from "@tanstack/react-router";

import { assignSupportTicket, resolveSupportTicket } from "~/domain/support";
import { toErrorResponse, Unauthenticated, ValidationError } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   PATCH /api/support/tickets/:ticketId
 *     { assignToUserId: string | null }   → assign, or return to the queue  (support.ticket.assign)
 *     { resolutionNote: string }          → resolve                          (support.ticket.resolve)
 *
 * Both actions are refused unless the caller can *reach* the ticket's chain: the chain id
 * is the permission check's target, so an AppSupport operator with a grant for one chain
 * gets a 403 carrying the reason on another chain's ticket — which is exactly the
 * negative case this vertical has to prove.
 */
export const Route = createFileRoute("/api/support/tickets/$ticketId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            assignToUserId?: string | null;
            resolutionNote?: string;
          };

          if (body.assignToUserId !== undefined) {
            const result = await assignSupportTicket(
              principal,
              params.ticketId,
              { assignToUserId: body.assignToUserId },
              { source: "api" }
            );
            return Response.json({ updated: "assignment", ...result });
          }

          if (typeof body.resolutionNote === "string") {
            const result = await resolveSupportTicket(principal, params.ticketId, body.resolutionNote, {
              source: "api",
            });
            return Response.json({ updated: "resolution", ...result });
          }

          throw new ValidationError("send either { assignToUserId } or { resolutionNote }");
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
