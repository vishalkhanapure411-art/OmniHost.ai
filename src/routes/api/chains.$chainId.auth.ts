import { createFileRoute } from "@tanstack/react-router";

import {
  getChainAuthConfig,
  updateChainAuthConfig,
  type UpdateChainAuthInput,
} from "~/domain/appconfig";
import { toErrorResponse, Unauthenticated, ValidationError } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   GET   /api/chains/:chainId/auth   → the chain's authentication / SSO configuration
 *   PATCH /api/chains/:chainId/auth   → write it  { authMode, ssoProtocol?, ... }
 *
 * The HTTP face of the same domain functions the console and (later) the chatbot call.
 * Reads need `chain.auth.read`, writes `auth.sso.configure` — both App-layer tools that
 * the APP_CONFIG role holds none of by default: a delegated, chain-scoped, time-boxed
 * grant is what makes this succeed, and an operator without one gets the same 403 here
 * as in the browser.
 */
export const Route = createFileRoute("/api/chains/$chainId/auth")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const config = await getChainAuthConfig(principal, params.chainId);
          return Response.json({ config });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },

      PATCH: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as Partial<UpdateChainAuthInput>;
          if (!body.authMode) {
            throw new ValidationError("authMode is required ('native' or 'sso')");
          }
          const result = await updateChainAuthConfig(
            principal,
            params.chainId,
            { ...body, authMode: body.authMode },
            { source: "api" }
          );
          return Response.json({ updated: "auth", ...result });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
