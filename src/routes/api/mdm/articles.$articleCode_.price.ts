import { createFileRoute } from "@tanstack/react-router";
import { updateArticlePrice } from "~/domain/mdm";
import { ValidationError, toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";
/**
 *   POST /api/mdm/articles/:articleCode/price
 *        { outletCode, amount, currencyCode, effectiveFrom? }
 *
 * A financial action, so it needs `mdm.article.price.update` rather than the general
 * article update, and it writes its audit row in the same transaction as the price row:
 * the closed window and the opened one are both in the trail.
 *
 * The file name carries a trailing underscore (`articles.$articleCode_.price`) so this is
 * a sibling path, not a nested route under the detail route.
 */
export const Route = createFileRoute("/api/mdm/articles/$articleCode_/price")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            outletCode?: string;
            amount?: number;
            currencyCode?: string;
            effectiveFrom?: string | null;
          };
          if (typeof body.amount !== "number") {
            throw new ValidationError(
              "amount is required and must be a number — money is { amount, currencyCode }"
            );
          }
          const result = await updateArticlePrice(
            principal,
            {
              code: params.articleCode,
              outletCode: body.outletCode ?? "",
              amount: body.amount,
              currencyCode: body.currencyCode ?? "",
              effectiveFrom: body.effectiveFrom ?? null,
            },
            { source: "api", intent: "mdm.article.price.update" }
          );
          return Response.json({ updated: "price", ...result });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
