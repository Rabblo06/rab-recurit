/**
 * AI contracts C0 — CONVERSATION TURNS AND STREAMING (docs/ai/AI_CONTRACTS.md §2.2). Types only: no behaviour.
 *
 * Naming (resolution X-1 / XD-2): there is no `ai_thread` or `ai_turn` table. thread = `core.ai_conversation`; turn = the
 * assistant `core.ai_message` row (status, lease, cancel, tokens, model). Phases 5, 6 and 7 target those tables.
 *
 * `…V2` = the TARGET shape of an existing Phase 1 type in `./ai`. The Phase 1 type stays the one in use until the owning
 * phase merges; at that merge Agent 9 turns the Phase 1 name into an alias of the V2 type (one release), so no consumer
 * breaks mid-batch. Implement against V2; never edit `./ai`.
 */
import type { AiErrorCodeType } from './ai';
import type { AiProposalHttpErrorCodeType, AiProposalStatusType } from './ai-proposals';
import type { AiSkillErrorCodeType } from './ai-skills';
import type { AiModelErrorCodeType, AiModelEffort, AiModelLevel } from './ai-models';
import type { AiPlanStep, AiToolCallOutcome, AiToolCallSummaryV2 } from './ai-tools';
import type { AiTurnUsageView, AiUsageErrorCodeType, AiUsageTotals } from './ai-usage';
import type { AiAgentErrorCodeType } from './ai-agents';

/**
 * Turn lifecycle, target shape. `waiting_for_input` is added by Phase 5b (migration `AiTurnWaitingForInput`, required —
 * resolution X-3) together with its rows in `AI_TURN_TRANSITIONS`:
 *   running → waiting_for_input → completed | cancelled | failed.
 * A waiting turn holds no lease, no org slot and no cost reservation, and is neither "running" nor "queued" for the
 * Phase 2 one-running / one-queued indexes. Until 5b merges, `AI_TURN_TRANSITIONS` (state/ai-turn-transitions.ts) is
 * the only table in force and this value must never be written.
 */
export const AiTurnStatusV2 = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_INPUT: 'waiting_for_input',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type AiTurnStatusV2Type = (typeof AiTurnStatusV2)[keyof typeof AiTurnStatusV2];

/** Where a turn came from (Phase 6 M6.5 `ai_message.origin`; `chat` is the default and the only value before 6b). */
export type AiTurnOrigin = 'chat' | 'agent_manual' | 'agent_schedule' | 'agent_event';

/** Why a continuation turn exists (Phase 5b). A continuation is a NEW assistant turn; the paused one ends `completed`. */
export type AiTurnContinuationCause = 'proposal_decided' | 'input_answered';

/** Every error code a turn, a stream or an AI route can carry, across all phases. Stored turn codes need a DB CHECK change. */
export type AiAnyErrorCodeType =
  | AiErrorCodeType
  | AiUsageErrorCodeType
  | AiSkillErrorCodeType
  | AiProposalHttpErrorCodeType
  | AiAgentErrorCodeType
  | AiModelErrorCodeType;

/** `POST /rest/v1/ai/conversations/:id/messages` body, target shape (forbidNonWhitelisted; anything else is a 400). */
export interface AiSubmitMessageRequest {
  /** 1..AI_MAX_INPUT_CHARS (absolute cap 8000). */
  content: string;
  /** uuid-v4 idempotency key. */
  clientRequestId?: string;
  /** Phase 4: 0..AI_SKILL_LIMITS.maxTaggedPerMessage skill NAMES (never content). Checked active + readable at submit. */
  skills?: string[];
  /**
   * C1 (CD-1 / TW-D2): the level for THIS question — an enum value only (anything else is a 400). Not in the
   * organisation's `allowedLevels`, or unable to run now → 409 `AI_LEVEL_UNAVAILABLE`; never a fallback the user did not
   * see. Omitted = the organisation's chat level.
   */
  level?: AiModelLevel;
}

/**
 * `202` answer of a submit, target shape (P2-C10). The Phase 1 fields stay; Phase 2 adds `messageId` (= `userMessageId`)
 * and `streamId` (= `turnId`: one stream per turn). `status` is `queued` for a new turn behind a running one.
 */
export interface AiSubmitResult {
  conversationId: string;
  userMessageId: string;
  turnId: string;
  messageId: string;
  streamId: string;
  status: AiTurnStatusV2Type;
  replayed: boolean;
}

/** `ai_conversation.title_source` (Phase 2 M1): who wrote the title. A `user` title is never regenerated. */
export type AiConversationTitleSource = 'auto' | 'pending' | 'model' | 'user';

/**
 * One displayable part of an assistant turn, in order. Phase 2 builds `text` and `tool` parts from `content` +
 * `tool_calls` (each call carries its `offset` into `content`). Phase 5b adds the card parts, stored in
 * `core.ai_message_part` (owned by Phase 5 — resolution X-2 / XD-1). A card part carries ids only; the card's data comes
 * from its own route (`AiProposalView`, `AiInputRequestView`).
 */
export type AiMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; outcome: AiToolCallOutcome; rows: number | null; offset: number }
  | { kind: 'approval'; partId: string; proposalId: string; status: AiProposalStatusType }
  | { kind: 'question'; partId: string; requestId: string; state: AiInputRequestPartState }
  | { kind: 'form'; partId: string; requestId: string; state: AiInputRequestPartState };

export type AiInputRequestPartState = 'awaiting_input' | 'answered' | 'superseded' | 'expired';

/** One message of `GET /rest/v1/ai/conversations/:id`, target shape. `content` stays authoritative for the text. */
export interface AiMessageViewV2 {
  id: string;
  role: 'user' | 'assistant';
  /** `sent` for a user message. */
  status: 'sent' | AiTurnStatusV2Type;
  content: string;
  errorCode: AiAnyErrorCodeType | null;
  toolCalls: AiToolCallSummaryV2[];
  /** Assistant turns only (empty for a user message). */
  parts: AiMessagePart[];
  /** User messages only: tagged skill names (Phase 4), never content. */
  skills: string[];
  origin: AiTurnOrigin;
  createdAt: string;
  completedAt: string | null;
  /** C1 (CD-1): assistant turns; null for rows older than the level migration. Optional until the CD-1 merge. */
  level?: AiModelLevel | null;
  effort?: AiModelEffort | null;
  /** C1 (CD-7): measured reasoning time (server clock). The reasoning TEXT is discarded in the Worker and never stored. */
  reasoningMs?: number | null;
  /** C1 (CD-6): the caller's OWN assistant turns only (owner RLS). Optional until Phase 7 lands it. */
  usage?: AiTurnUsageView;
  /** Batch 3 (S1): the catalogue id the assistant turn ran on; null for a user message or a turn that never ran. */
  modelId?: string | null;
}

/** `GET /rest/v1/ai/conversations/:id`, target shape (C1 / CD-6 adds the conversation's own usage totals). */
export interface AiConversationDetailViewV2 {
  conversation: { id: string; title: string | null; messageCount: number; lastMessageAt: string; createdAt: string };
  messages: AiMessageViewV2[];
  usageTotals?: AiUsageTotals;
}

/**
 * One Server-Sent Event on `GET /rest/v1/ai/conversations/:id/stream?turnId=` (Phase 2 may also accept `streamId`, equal
 * to `turnId`), target shape. The SSE `event:` field equals `type`; every event except `keepalive` carries an SSE `id`
 * (the Redis stream id, the resume cursor). Unknown `type`s are dropped by the client. Model text never goes through
 * pub/sub or the realtime envelope (rules 9.1–9.3): `delta` and `title` are read only from the per-turn Redis STREAM.
 */
export type AiStreamEventV2 =
  | { type: 'status'; turnId: string; status: 'queued' | 'running' }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'tool'; turnId: string; name: string; phase: 'started' | 'finished'; outcome?: AiToolCallOutcome; offset?: number }
  /**
   * Every AI_STREAM_TIMING.keepaliveMs after a fail-closed access re-check. Its SSE id is the connection's CURRENT cursor,
   * never a new position (p2 merge, C-REQ-1: Nest `@Sse` numbers id-less frames, which a client would echo back as an
   * invalid `Last-Event-ID`). The same holds for every frame that is not a stream entry (the database `done`, `error`).
   */
  | { type: 'keepalive'; turnId: string }
  /** Phase 2 titles: plain text, already sanitised and ≤ 120 characters. Render as text, never Markdown. */
  | { type: 'title'; turnId: string; title: string }
  /**
   * C1 (CD-7 / TW-D7): reasoning DURATION only. There is deliberately no text field: the Worker discards every
   * reasoning delta and provider signature (rule 11.2; injected text; rule 3.6). `durationMs` on `finished` (server clock).
   */
  | { type: 'reasoning'; turnId: string; phase: 'started' | 'finished'; durationMs?: number }
  /** C1 (CD-7 / TW-D8): the `update_plan` checklist; labels masked server-side, rendered as plain text. Informational only. */
  | { type: 'plan'; turnId: string; steps: AiPlanStep[] }
  /** Phase 5b: a server-written summary and ids only. */
  | { type: 'proposal'; turnId: string; proposalId: string; summary: string }
  | { type: 'input_request'; turnId: string; requestId: string; inputKind: 'question' | 'form' }
  /** Phase 5b: the turn paused (`waiting_for_input`). Ends the SSE without being terminal. */
  | { type: 'waiting'; turnId: string; partId: string }
  | { type: 'done'; turnId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: AiAnyErrorCodeType | null; content: string }
  | { type: 'error'; turnId: string; errorCode: AiAnyErrorCodeType };

/** Stream timing both sides agree on (Phase 2 §2.4). The server owns the values in `ai.constants.ts`; these must match. */
export const AI_STREAM_TIMING = {
  /** Keepalive + access re-check cadence (replaces the 10 s re-validation). */
  keepaliveMs: 2_000,
  /** The client reconnects with `Last-Event-ID` when it sees no frame for this long. */
  clientWatchdogMs: 8_000,
  /** Redis STREAM TTL after the last write (P2-D4). */
  streamTtlSeconds: 900,
  /** At most this many queued turns behind the running one per conversation; one more is 409 AI_TURN_IN_PROGRESS (P2-D6). */
  maxQueuedTurnsPerConversation: 1,
} as const;
