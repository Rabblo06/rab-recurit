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

// ── AI Phase 2 (docs/ai/PHASE2_TWENTY_PLAN.md §2–§3): queued turns, checkpoints, pub/sub hints, keepalive, titles ────
// One grouped block (appended) so the merge with other phases' constants stays mechanical. The values the client must
// agree on equal `AI_STREAM_TIMING` (@rab/shared types/ai-turns.ts); a unit test pins the equality.

/** THE 2-second turn heartbeat (resolution X-10): access re-check → checkpoint → slot refresh → `onTick` subscribers. */
export const AI_TURN_HEARTBEAT_MS = 2_000;
/** SSE keepalive + fail-closed access/ownership re-check (replaces the 10 s AI_SSE_REVALIDATE_MS). */
export const AI_SSE_KEEPALIVE_MS = 2_000;
/** SSE poll while the wake subscriber is healthy (wake-ups do the fast path); AI_SSE_POLL_MS (250 ms) while it is down. */
export const AI_SSE_POLL_FALLBACK_MS = 1_000;
/** A queued successor waits at most AI_TURN_TIMEOUT_SECONDS + this for its predecessor, then fails AI_SERVICE_UNAVAILABLE. */
export const AI_QUEUED_WAIT_EXTRA_MS = 60_000;
/** Deferral back-off of a queued successor's claim (1 s → 5 s). */
export const AI_TURN_DEFER_MIN_MS = 1_000;
export const AI_TURN_DEFER_MAX_MS = 5_000;
/** At most this many queued turns behind the running one (P2-D6); one more is 409 AI_TURN_IN_PROGRESS. */
export const AI_MAX_QUEUED_TURNS_PER_CONVERSATION = 1;
/** The cancel flag `…:turn:{t}:cancel` lives this long (the durable Redis path next to the DB `cancel_requested_at`). */
export const AI_CANCEL_FLAG_TTL_SECONDS = 3_600;
/** Consecutive non-revocation heartbeat errors (PG/Redis) before the turn stops AI_SERVICE_UNAVAILABLE (fail closed). */
export const AI_HEARTBEAT_MAX_CONSECUTIVE_ERRORS = 3;
/** Pub/sub hint payloads are tiny JSON (`{t,id}` / `{t}`); anything longer is dropped unread. */
export const AI_PUBSUB_MAX_PAYLOAD_BYTES = 256;

/** Thread titles (P2-C9): one billed fast-tier gateway call, no tools, one step. */
export const AI_TITLE_MAX_OUTPUT_TOKENS = 32;
export const AI_TITLE_TIMEOUT_MS = 20_000;
/** Text collected from the title call before it is cut off (bounds output cost while the gateway has no per-call cap). */
export const AI_TITLE_MAX_COLLECTED_CHARS = 240;

/** Phase 2 migration names, referenced through one constant each (Agent 9 renumbers at merge: change these lines only). */
export const AI_P2_MIGRATION_QUEUED_TURN_CHECKPOINT = 'AiQueuedTurnCheckpoint1786720970000';
export const AI_P2_MIGRATION_USAGE_TITLE_CALLS = 'AiUsageTitleCalls1786720980000';
