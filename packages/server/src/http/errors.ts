import type { ApiError, ApiErrorCode } from "@alisio/sdk";

/** HTTP status for every web API error code (§8.3). */
export const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  forbidden_host: 403,
  validation_failed: 400,
  not_found: 404,
  unknown_command: 404,
  session_busy: 409,
  session_locked: 409,
  workspace_limit: 503,
  workspace_missing: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  path_outside_workspace: 403,
  not_a_git_repo: 409,
  approval_resolved: 409,
  capability_ceiling: 403,
  not_manageable: 403,
  mcp_not_permitted: 403,
  runs_active: 409,
  provider_unavailable: 502,
  protocol_mismatch: 426,
  shutting_down: 503,
  stream_limit: 503,
  workspace_archived: 409,
  picker_busy: 409,
  picker_unavailable: 503,
  permission_denied: 403,
  internal: 500,
};

/** A typed API failure; routes throw it and the server renders it as an `ApiError` body. */
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code];
  }
}

/** Renders any thrown value as an `ApiError`; unknown errors become a generic 500. */
export function toApiError(
  error: unknown,
  correlationId: string,
): { status: number; body: ApiError } {
  if (error instanceof HttpError)
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
        correlationId,
      },
    };
  return {
    status: 500,
    body: { error: { code: "internal", message: "Internal server error" }, correlationId },
  };
}
