/**
 * AI Phase 1 limits that are code constants, not configuration (docs/ai/PHASE1_PLAN.md). Configuration lives in
 * EnvironmentVariables (AI_*); these bound storage and transport and are mirrored by database CHECKs where they apply
 * (AiPhase1Schema1786720220000).
 */

/** Messages per conversation (user + assistant). Mirrors `ai_message_seq_check` / `ai_conversation_message_count_check`. */
export const AI_MAX_MESSAGES_PER_CONVERSATION = 200;
/** Stored characters per message. Mirrors `ai_message_content_check`. */
export const AI_MAX_STORED_CONTENT_CHARS = 16_000;
/** Conversation title. Mirrors `ai_conversation_title_check`. */
export const AI_MAX_TITLE_CHARS = 120;
/** Prior messages sent to the model with a new question (bounded history). */
export const AI_HISTORY_MAX_MESSAGES = 20;
/** Rows a tool may return to the model, whatever it asks for. */
export const AI_TOOL_MAX_ROWS = 25;
/** Input-token allowance per model step used to size the per-turn token reservation (see AiConfigService). */
export const AI_STEP_INPUT_TOKEN_ALLOWANCE = 4_000;
/** Per model call (step) timeout (security 4.5). The turn timeout (AI_TURN_TIMEOUT_SECONDS) still bounds the whole turn. */
export const AI_STEP_TIMEOUT_MS = 60_000;

/** Worker lease on a running turn; renewed while the turn runs. An expired lease = the Worker died. */
export const AI_TURN_LEASE_MS = 60_000;
export const AI_TURN_LEASE_RENEW_MS = 15_000;
/** How often the Worker checks the cancel flag while a turn runs. */
export const AI_CANCEL_POLL_MS = 500;
/** Text deltas are coalesced before they are written to the Redis stream (bounded write rate). */
export const AI_STREAM_FLUSH_MS = 120;
export const AI_STREAM_FLUSH_CHARS = 200;

/** Redis stream of one turn: at most this many entries (MAXLEN ~) and kept this long after its last write. */
export const AI_STREAM_MAX_ENTRIES = 2_000;
export const AI_STREAM_TTL_SECONDS = 900;
/** SSE: Redis poll interval, events per read, re-validation period, longest connection and per-user connection cap. */
export const AI_SSE_POLL_MS = 250;
export const AI_SSE_READ_COUNT = 200;
export const AI_SSE_REVALIDATE_MS = 10_000;
export const AI_SSE_MAX_DURATION_MS = 10 * 60_000;
export const AI_SSE_MAX_CONNECTIONS_PER_USER = 3;

/** Conversation list page size. */
export const AI_LIST_DEFAULT_LIMIT = 20;
export const AI_LIST_MAX_LIMIT = 50;

/** Retention purge: conversations per function call, calls per organisation per cycle. */
export const AI_RETENTION_BATCH_SIZE = 500;
export const AI_RETENTION_MAX_BATCHES_PER_ORG = 20;

/**
 * Test seam (PHASE1_TWENTY_PLAN §5, C6): extra in-process `test` models a TEST module supplies with
 * `overrideProvider(AI_TEST_MODEL_CATALOGUE)` (src/__tests__/support/ai/). Production code holds only this symbol and
 * provides `null`; AiConfigService honours a value ONLY when NODE_ENV=test. The mock model itself is not in `dist`.
 */
export const AI_TEST_MODEL_CATALOGUE = Symbol('AI_TEST_MODEL_CATALOGUE');

/** Chat (and later agents) use the `fast` tier by default, like Twenty. */
export const AI_CHAT_TIER = 'fast' as const;
