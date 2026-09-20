import { createFileRoute } from "@tanstack/react-router";
import { setArticleAvailability } from "~/domain/mdm";
import { ValidationError, toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";
/**
 *   POST /api/mdm/articles/:articleCode/availability
 *        { outletCode, availability: available|seasonal|unavailable, reason? }
 *
 * §7.2 item 6: marking a dish unavailable takes effect immediately, is audited and is
 * reversible. It is not a version, which is why it is a separate endpoint from anything
 * that changes what the article *is*.
 */
export const Route = createFileRoute("/api/mdm/articles/$articleCode_/availability")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const body = (await request.json()) as {
            outletCode?: string;
            availability?: string;
            reason?: string | null;
          };
          const availability = (body.availability ?? "").trim();
          if (!["available", "seasonal", "unavailable"].includes(availability)) {
            throw new ValidationError("availability must be available, seasonal or unavailable");
          }
          const result = await setArticleAvailability(
            principal,
            {
              code: params.articleCode,
              outletCode: body.outletCode ?? "",
              availability: availability as "available" | "seasonal" | "unavailable",
              reason: body.reason ?? null,
            },
            { source: "api", intent: "mdm.article.update" }
          );
          return Response.json({ updated: "availability", ...result });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
