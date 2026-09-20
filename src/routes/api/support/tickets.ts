import { createFileRoute } from "@tanstack/react-router";

import { listSupportTickets } from "~/domain/support";
import { toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   GET /api/support/tickets[?status=open...]  → the escalated queue
 *
 * Tickets carry a `reachable` flag computed from the caller's resolved scope: the server
 * will refuse an *action* on a ticket whose chain this caller cannot reach, and the flag
 * exists so the screen can offer "request access" instead of a button that fails.
 */
export const Route = createFileRoute("/api/support/tickets")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const status = new URL(request.url).searchParams.get("status");
          const queue = await listSupportTickets(principal, { status });
          return Response.json(queue);
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
