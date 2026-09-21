import { createFileRoute } from "@tanstack/react-router";

import { commitImport, dryRunImport } from "~/domain/import";
import { Unauthenticated, toErrorResponse, ValidationError } from "~/server/errors";
import { currentPrincipal } from "~/server/context";

/**
 * The master-data import endpoint (§16).
 *
 *   POST /api/mdm/import   { entity, fileName, content, phase: "dry_run" | "commit" }
 *
 * The same domain entry points the screen calls, with the same capability check, the same
 * audit rows and the same report — a REST caller cannot reach a row the screen cannot. The
 * phase is explicit in the body rather than a second endpoint so a log line always says which
 * of the two acts happened.
 *
 * The file's text is the payload: the browser (or a script) reads the CSV and posts its
 * content, so there is no multipart parser between a chain's export and the validation that
 * reads it. A large file is still one request; the chunking §16 item 7 asks for is on the
 * batch, not on the body.
 */
export const Route = createFileRoute("/api/mdm/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const principal = await currentPrincipal();
        if (!principal) {
          const { status, body } = toErrorResponse(new Unauthenticated());
          return Response.json(body, { status });
        }
        try {
          const body = (await request.json()) as {
            entity?: string;
            fileName?: string;
            content?: string;
            phase?: string;
          };
          const phase = body.phase === "commit" ? "commit" : "dry_run";
          if (!body.fileName || typeof body.content !== "string") {
            throw new ValidationError("fileName and content are required");
          }
          const request_ = {
            entity: "article" as const,
            fileName: body.fileName,
            content: body.content,
          };
          const report =
            phase === "commit"
              ? await commitImport(principal, request_)
              : await dryRunImport(principal, request_);
          return Response.json({ report });
        } catch (error) {
          const { status, body: payload } = toErrorResponse(error);
          return Response.json(payload, { status });
        }
      },
    },
  },
});
