import { createFileRoute } from "@tanstack/react-router";

import { getChain, setChainFeature, updateChainTier } from "~/domain/chains";
import type { LicenceTier } from "~/domain/chains";
import { ValidationError, toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   GET   /api/chains/:chainId   → chain detail (tier, features, sites and outlets)
 *   PATCH /api/chains/:chainId   → { licenceTier } or { featureCode, enabled }
 *
 * The chain id arrives in the URL, which is precisely why it is re-checked against the
 * caller's resolved scope on every call — a client-supplied id is data, not authority.
 */
export const Route = createFileRoute("/api/chains/$chainId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const chain = await getChain(principal, params.chainId);
          return Response.json({ chain });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },

      PATCH: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            licenceTier?: LicenceTier;
            featureCode?: string;
            enabled?: boolean;
          };
          if (body.licenceTier) {
            const result = await updateChainTier(principal, params.chainId, body.licenceTier, {
              source: "api",
            });
            return Response.json({ updated: "licenceTier", ...result });
          }
          if (body.featureCode !== undefined && body.enabled !== undefined) {
            const result = await setChainFeature(
              principal,
              params.chainId,
              body.featureCode,
              body.enabled,
              { source: "api" }
            );
            return Response.json({ updated: "feature", ...result });
          }
          throw new ValidationError("send either { licenceTier } or { featureCode, enabled }");
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
