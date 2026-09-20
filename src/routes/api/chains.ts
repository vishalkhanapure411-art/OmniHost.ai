import { createFileRoute } from "@tanstack/react-router";

import { listChains, onboardChain } from "~/domain/chains";
import type { LicenceTier } from "~/domain/chains";
import { toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 * Chain API — the HTTP face of the same domain functions the screens call.
 *
 *   GET  /api/chains   → the chains this caller may reach
 *   POST /api/chains   → onboard a chain  { name, code?, licenceTier, taxJurisdiction? }
 *
 * This exists for two reasons beyond the console: it is the surface a later chatbot
 * gateway will call (the spec requires the chatbot to invoke "the identical domain
 * API" the screens use), and it makes the permission model testable without a browser
 * — `curl` as an AppSupport user gets exactly the same 403 the UI would.
 */
export const Route = createFileRoute("/api/chains")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const chains = await listChains(principal);
          return Response.json({ chains });
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
            name?: string;
            code?: string;
            licenceTier?: LicenceTier;
            taxJurisdiction?: string;
          };
          const chain = await onboardChain(
            principal,
            {
              name: body.name ?? "",
              code: body.code ?? null,
              licenceTier: (body.licenceTier ?? "silver") as LicenceTier,
              taxJurisdiction: body.taxJurisdiction ?? null,
            },
            { source: "api" }
          );
          return Response.json({ chain }, { status: 201 });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
