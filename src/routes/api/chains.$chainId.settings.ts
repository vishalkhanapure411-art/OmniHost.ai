import { createFileRoute } from "@tanstack/react-router";

import { getChainSettings, updateChainSetting, updateSiteLocale } from "~/domain/appconfig";
import { toErrorResponse, Unauthenticated, ValidationError } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";

/**
 *   GET   /api/chains/:chainId/settings          → the App-layer definitions + this chain's values
 *   PATCH /api/chains/:chainId/settings          → { key, value }         (delegated chain setting)
 *                                                  { siteId, locale }     (site.locale)
 *
 * One route for both because they are one screen's two halves and one permission family.
 * The bounds a value is checked against are read from `setting_definition` inside the
 * write transaction — never from the request — so a crafted PATCH cannot widen them.
 */
export const Route = createFileRoute("/api/chains/$chainId/settings")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const settings = await getChainSettings(principal, params.chainId);
          return Response.json({ settings });
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
            key?: string;
            value?: string | number | boolean;
            siteId?: string;
            locale?: string | null;
          };

          if (body.siteId !== undefined && body.key === undefined) {
            const result = await updateSiteLocale(
              principal,
              params.chainId,
              body.siteId,
              body.locale ?? null,
              { source: "api" }
            );
            return Response.json({ updated: "site.locale", ...result });
          }

          if (body.key !== undefined && body.value !== undefined) {
            const result = await updateChainSetting(
              principal,
              params.chainId,
              { key: body.key, value: body.value, siteId: body.siteId ?? null },
              { source: "api" }
            );
            return Response.json({ updated: "chain.setting", ...result });
          }

          throw new ValidationError("send either { key, value } or { siteId, locale }");
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
