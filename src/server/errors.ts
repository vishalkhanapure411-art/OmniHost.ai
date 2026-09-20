import "@tanstack/react-start/server-only";

/**
 * Domain errors that a server entry point turns into an HTTP response. Keeping them
 * in one place is what lets every entry point (server function, API route, page
 * loader) answer a denied permission with the same 403 shape instead of each
 * inventing its own.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 403. The caller's resolved tool registry does not contain the action. */
export class PermissionDenied extends HttpError {
  constructor(action: string, reason: string, details?: Record<string, unknown>) {
    super(403, "permission_denied", `Not permitted: ${reason}`, { action, reason, ...details });
    this.name = "PermissionDenied";
  }
}

/** 401. No session, expired session, or a revoked one. */
export class Unauthenticated extends HttpError {
  constructor(reason = "Sign in to continue.") {
    super(401, "unauthenticated", reason);
    this.name = "Unauthenticated";
  }
}

/** 404. Also the answer when a row exists but outside the caller's tenant scope. */
export class NotFound extends HttpError {
  constructor(entity: string, id?: string) {
    super(404, "not_found", id ? `${entity} ${id} not found.` : `${entity} not found.`);
    this.name = "NotFound";
  }
}

/** 400. Bad or missing input. */
export class ValidationError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "validation_error", message, details);
    this.name = "ValidationError";
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

/** Normalises anything thrown into a `{status, body}` pair for an API route. */
export function toErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isHttpError(error)) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message, ...(error.details ?? {}) },
    };
  }
  console.error("[omnihost] unhandled error", error);
  return {
    status: 500,
    body: { error: "internal_error", message: "Something went wrong." },
  };
}
