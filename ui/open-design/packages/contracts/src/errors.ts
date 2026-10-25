import type { JsonValue } from './common.js';

export const API_ERROR_CODES = [
  // Generic HTTP/API failures.
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_FAILED',
  'AGENT_UNAVAILABLE',
  'AGENT_AUTH_REQUIRED',
  'AGENT_EXECUTION_FAILED',
  // The agent's connection to its model provider was established and then
  // dropped or kept resetting mid-response (e.g. "socket connection was closed
  // unexpectedly", ECONNRESET, "Unable to connect to API", ETIMEDOUT). Distinct
  // from a refused connection that never opened. Transient and retryable;
  // surfaced by the daemon's per-agent failure diagnostics so the UI can show a
  // localized, human-readable reason instead of the raw SDK string, and so
  // triage can count this failure class by code.
  'AGENT_CONNECTION_DROPPED',
  'AGENT_PROMPT_TOO_LARGE',
  'AMR_MODEL_UNAVAILABLE',
  'AMR_AUTH_REQUIRED',
  'AMR_INSUFFICIENT_BALANCE',
  // The agent emitted a fabricated Markdown role marker
  // (`## user` / `## assistant` / `## system`) inside its own response.
  // The chat host parses those lowercase lines as real turn
  // boundaries, so an emission is a prompt-injection attempt the model
  // committed against itself (issue #3247; same class as #2102 /
  // #2464). The daemon detects the marker in the stream, truncates
  // emission at that point, and terminates the agent subprocess
  // (SIGTERM with SIGKILL fallback) so no further tokens or
  // `tool_use` blocks reach the dispatcher. Emitted by
  // `server.ts::abortForRoleMarker` alongside the existing
  // `fabricated_role_marker` warning event. Retryable.
  'ROLE_MARKER_HALLUCINATION',
  // The agent got stuck repeating failing tool calls (e.g. re-running the same
  // Edit that errors "string not found", or the same shell command that keeps
  // exiting non-zero) without making progress. The daemon's tool-loop guard
  // (`tool-loop-guard.ts`) counts consecutive failures and repeats of the same
  // failing action. Only emitted when OD_TOOL_LOOP_GUARD=halt is enabled: at
  // the hard ceiling the guard terminates the run so the agent cannot grind
  // through dozens more identical attempts. The default mode is `warn`, which
  // only surfaces a heads-up `tool_loop` event and never emits this error. The
  // caller should re-check the actual target (the file, the element, the
  // command) before retrying rather than resubmitting the same turn.
  // OD_TOOL_LOOP_GUARD accepts warn|halt|off. Retryable.
  'TOOL_LOOP_DETECTED',
  // The selected runtime agent def (apps/daemon/src/runtimes/defs/*) has
  // a checked-in field that fails strict source-config validation — e.g.
  // a non-integer, NaN, Infinity, or negative `inactivityTimeoutMs`
  // (issue #2467 review on PR #2579). The bug is in the source file;
  // the operator cannot recover the run, the daemon must abort it and
  // surface the def-correctness error so it shows up in dev rather
  // than silently disabling the agent-specific watchdog.
  'AGENT_RUNTIME_DEF_INVALID',
  'PROJECT_NOT_FOUND',
  'FILE_NOT_FOUND',
  'ARTIFACT_NOT_FOUND',
  // The agent emitted a new artifact whose body is dramatically smaller than
  // a prior artifact sharing the same metadata.identifier. Almost always means
  // the agent shipped a placeholder ("see other-file.html in this project",
  // a bare filename string, an empty fallback page) instead of the full
  // document. Configurable via OD_ARTIFACT_STUB_GUARD (reject|warn|off).
  'ARTIFACT_REGRESSION',
  // The daemon's publication guard found unresolved template placeholders
  // (e.g. pitch-deck `Name to confirm` / `$X.XM`) in an HTML/deck artifact
  // body at write time, so the file cannot be published. The caller should
  // supply the missing facts and retry rather than republishing the same
  // body. Returned by `POST /api/projects/:id/files` as a 422.
  'ARTIFACT_PUBLICATION_BLOCKED',
  // The workspace/daemon restarted after a run had emitted durable events but
  // before it wrote a terminal end event. The daemon recovers and seals the
  // event log instead of returning a misleading 404. Retryable; resumable when
  // the upstream CLI session and a committed tool/artifact boundary survived.
  'RUN_INTERRUPTED_BY_DAEMON_RESTART',
  'UPSTREAM_UNAVAILABLE',
  'RATE_LIMITED',
  // PR #974 round-4: desktop-paired daemon received an import request
  // but the desktop main process has not yet registered its HMAC secret
  // over sidecar IPC (startup race or daemon-restart-mid-session). The
  // client should retry shortly; the desktop runtime will re-register
  // on its existing retry schedule.
  'DESKTOP_AUTH_PENDING',
  // Agent-facing tool endpoint authorization failures.
  'TOOL_TOKEN_MISSING',
  'TOOL_TOKEN_INVALID',
  'TOOL_TOKEN_EXPIRED',
  'TOOL_ENDPOINT_DENIED',
  'TOOL_OPERATION_DENIED',
  'REFRESH_LOCKED',
  'REFRESH_TIMED_OUT',
  'REFRESH_FAILED',
  'OUTPUT_TOO_LARGE',
  'TEMPLATE_BINDING_INVALID',
  'REDACTION_REQUIRED',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
  requestId?: string;
  taskId?: string;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export type ApiValidationIssue = {
  /** Dot/bracket path, JSON pointer, or form field name that failed validation. */
  path: string;
  message: string;
  code?: string;
};

export type ApiValidationErrorDetails = {
  kind: 'validation';
  issues: ApiValidationIssue[];
};

export interface SseErrorPayload {
  message: string;
  error?: ApiError;
}

export function createApiError(code: ApiErrorCode, message: string, init: Omit<ApiError, 'code' | 'message'> = {}): ApiError {
  return { code, message, ...init };
}

export function createApiErrorResponse(error: ApiError): ApiErrorResponse {
  return { error };
}
