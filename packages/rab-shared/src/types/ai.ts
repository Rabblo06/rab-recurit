/**
 * AI Phase 1 — the wire contract shared by the API (`modules/ai`), the rab-ai Worker and the later web client. Full
 * contract: docs/ai/API_CONTRACT.md. Only identifiers, bounded text the user is entitled to and metadata travel here —
 * never a raw tool output, a prompt, a provider key or another user's data.
 */

/** Why `GET /rest/v1/ai/availability` says AI is not available to the caller (the routes themselves all answer 404). */
export const AiUnavailableReason = {
  PLATFORM_DISABLED: 'platform_disabled',
  ORGANISATION_DISABLED: 'organisation_disabled',
  NOT_PERMITTED: 'not_permitted',
  NO_WORKSPACE: 'no_workspace',
} as const;
export type AiUnavailableReasonType = (typeof AiUnavailableReason)[keyof typeof AiUnavailableReason];

/**
 * Error codes a turn can end with (`ai_message.error_code`, the SSE `error` event, 4xx/5xx `code`). A closed list: the
 * database CHECK on `error_code` holds the same values (AiPhase1Schema1786720200000).
 */
export const AiErrorCode = {
  NOT_AVAILABLE: 'AI_NOT_AVAILABLE',
  INPUT_TOO_LONG: 'AI_INPUT_TOO_LONG',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  ORG_BUSY: 'AI_ORG_BUSY',
  BUDGET_EXHAUSTED: 'AI_BUDGET_EXHAUSTED',
  TURN_IN_PROGRESS: 'AI_TURN_IN_PROGRESS',
  CONVERSATION_FULL: 'AI_CONVERSATION_FULL',
  SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
  ACCESS_REVOKED: 'AI_ACCESS_REVOKED',
  MODEL_TIMEOUT: 'AI_MODEL_TIMEOUT',
  MODEL_ERROR: 'AI_MODEL_ERROR',
  TURN_TOKEN_LIMIT: 'AI_TURN_TOKEN_LIMIT',
  WORKER_INTERRUPTED: 'AI_WORKER_INTERRUPTED',
  INTERNAL: 'AI_INTERNAL_ERROR',
} as const;
export type AiErrorCodeType = (typeof AiErrorCode)[keyof typeof AiErrorCode];

/** Persisted per tool call on the assistant turn (`ai_message.tool_calls`). Metadata only — never arguments or results. */
export interface AiToolCallSummary {
  name: string;
  outcome: 'ok' | 'denied' | 'invalid_input' | 'error';
  rows: number | null;
}

/** One Server-Sent Event on `GET /rest/v1/ai/conversations/:id/stream`. `id` (SSE) is the resumable cursor. */
export type AiStreamEvent =
  | { type: 'status'; turnId: string; status: 'queued' | 'running' }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'tool'; turnId: string; name: string; phase: 'started' | 'finished'; outcome?: AiToolCallSummary['outcome'] }
  | { type: 'done'; turnId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: AiErrorCodeType | null; content: string }
  | { type: 'error'; turnId: string; errorCode: AiErrorCodeType };
