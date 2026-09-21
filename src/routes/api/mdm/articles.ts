import { createFileRoute } from "@tanstack/react-router";
import { getArticleFilterOptions, listArticles } from "~/domain/mdm";
import { toErrorResponse, Unauthenticated } from "~/server/errors";
import { currentPrincipalFromRequest } from "~/server/context";
/**
 * Master-data article API — the HTTP face of the same domain functions the screens call.
 *
 *   GET /api/mdm/articles
 *       ?q=            code / name / short name, case-insensitive
 *       &status=       draft | pending_review | active | seasonal | discontinued
 *       &category=     article category code
 *       &taxClass=     tax class code
 *       &outlet=       outlet code — "what does this outlet sell"
 *       &jurisdiction= the market whose compliance profile is applied
 *       &incomplete=1  only records the profile says are incomplete
 *       &limit=&offset= up to 200 rows per page
 *
 * `limit` defaults to the maximum page (200), not to 50: a caller that passes no
 * parameters must not silently lose the last rows of a longer list, and the response says
 * outright whether it saw everything (`hasMore`, `nextOffset`, `total`, `limit`,
 * `offset`). A chatbot or a report reads the same fields the screen does.
 *
 * This exists for the same two reasons the chain API does: it is the surface a later
 * chatbot gateway calls (the spec requires the chatbot to invoke "the identical domain
 * API" the screens use), and it makes the permission model testable with `curl` — a role
 * without `mdm.article.view` gets exactly the 403 the UI would show it.
 */
export const Route = createFileRoute("/api/mdm/articles")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await currentPrincipalFromRequest(request);
          if (!principal) throw new Unauthenticated();
          const url = new URL(request.url);
          const param = (name: string): string | null => {
            const value = url.searchParams.get(name);
            return value && value.trim() !== "" ? value.trim() : null;
          };
          const result = await listArticles(principal, {
            chainId: param("chainId"),
            query: param("q"),
            status: param("status"),
            categoryCode: param("category"),
            taxClassCode: param("taxClass"),
            jurisdiction: param("jurisdiction"),
            outletCode: param("outlet"),
            incompleteOnly: param("incomplete") === "1" || param("incomplete") === "true",
            limit: param("limit") ? Number(param("limit")) : undefined,
            offset: param("offset") ? Number(param("offset")) : undefined,
          });
          // The filter options are read only after the list has been permitted, so a
          // refused read leaves one audit row rather than two.
          const options = await getArticleFilterOptions(principal);
          return Response.json({ ...result, options });
        } catch (error) {
          const { status, body } = toErrorResponse(error);
          return Response.json(body, { status });
        }
      },
    },
  },
});
