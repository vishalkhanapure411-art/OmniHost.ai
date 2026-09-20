import { createFileRoute } from "@tanstack/react-router";
import { getArticle } from "~/domain/mdm";
import { toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";
/**
 *   GET /api/mdm/articles/:articleCode   → one article, whole: selling (per-outlet price
 *   and availability), compliance (per traded market), allergens, nutrition, version
 *   history and the ERP provenance keys.
 *
 * The code arrives in the URL, which is why the chain scope is re-resolved from the
 * principal on every call: a code in a path is data, not authority.
 */
export const Route = createFileRoute("/api/mdm/articles/$articleCode")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const article = await getArticle(principal, params.articleCode);
          return Response.json({ article });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
