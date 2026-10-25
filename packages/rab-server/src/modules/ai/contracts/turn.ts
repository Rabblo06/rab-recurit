/**
 * AI contracts C0 — TURNS AND STREAMING, server side (docs/ai/AI_CONTRACTS.md §2.2). Types only: no behaviour.
 *
 * Implemented by Agent 2 (Phase 2) in the runner, stream and SSE services; consumed by Agents 3 (recheck on the tick),
 * 5 (pause), 6 (agent mode, later) and 7 (usage at finalise). Every write to a turn row is a compare-and-set on
 * (status, lease_token) in its own short `runInTenantContext` transaction, never open across a model call (rule 2.2).
 */
import type { AiAnyErrorCodeType, AiToolCallSummaryV2 } from '@rab/shared';

/** The ids every turn primitive is bound to (RLS: a forged combination matches no row). */
export interface AiTurnIds {
  turnId: string;
  conversationId: string;
  organisationId: string;
  workspaceId: string;
  userId: string;
}

export type AiClaimResult =
  | { outcome: 'claimed'; leaseToken: string }
  /** A running predecessor exists (or the claim hit 23505): the row is unchanged and a delayed job is re-added. */
  | { outcome: 'deferred'; retryInMs: number }
  | { outcome: 'skipped'; reason: 'not_found' | 'not_queued' | 'cancelled' | 'wait_cap_exceeded' };

export interface AiTurnCheckpoint {
  content: string;
  toolCalls: readonly AiToolCallSummaryV2[];
}

/** `lease_lost` = the CAS matched 0 rows: the turn aborts (`shutdown`) and never writes again. */
export type AiCheckpointResult = 'written' | 'unchanged' | 'lease_lost';

/** Per-turn usage persisted by the terminal CAS (Phase 7 adds the cache split and cost columns). */
export interface AiTurnUsageV2 {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  steps: number;
}

export interface AiTurnFinalisation {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode: AiAnyErrorCodeType | null;
  /** Kept on failure too (checkpointed partial text, P2-C14 / P7-D7-7). */
  content: string;
  toolCalls: readonly AiToolCallSummaryV2[];
  usage: AiTurnUsageV2;
}

/** Phase 5b: `running → waiting_for_input`; clears the lease, releases the slot, settles the cost reservation. */
export interface AiTurnPause {
  partId: string;
  partKind: 'approval' | 'question' | 'form';
}

/** The turn CAS primitives (P2 §7). `finalise` / `pause` return false when they lost the CAS (someone else finished it). */
export interface AiTurnStatePrimitives {
  claim(ids: AiTurnIds): Promise<AiClaimResult>;
  checkpoint(ids: AiTurnIds, leaseToken: string, checkpoint: AiTurnCheckpoint): Promise<AiCheckpointResult>;
  finalise(ids: AiTurnIds, leaseToken: string, result: AiTurnFinalisation): Promise<boolean>;
  pause(ids: AiTurnIds, leaseToken: string, pause: AiTurnPause): Promise<boolean>;
}

/** What one 2-second tick runs, in order, never overlapping itself (resolution X-10: ONE timer). */
export interface AiHeartbeatTick {
  tickNumber: number;
  /** Server time of the tick. */
  at: Date;
}

/**
 * The 2-second turn heartbeat (P2 §2.2, P3 §2.3): access re-check → checkpoint → slot refresh, and the subscribers
 * registered with `onTick` (Phase 3 fingerprint recheck; Phase 7 nothing). A subscriber that throws aborts the turn (fail
 * closed); three consecutive fingerprint errors abort with AI_SERVICE_UNAVAILABLE. Stopped while a turn waits (5b).
 */
export interface AiTurnHeartbeat {
  readonly intervalMs: number;
  /** Returns an unsubscribe function. */
  onTick(subscriber: (tick: AiHeartbeatTick) => Promise<void> | void): () => void;
}

/** Final outcome reported to the Worker processor. `deferred` is a normal result (no retry consumed, job not failed). */
export type AiTurnOutcomeV2 = 'completed' | 'failed' | 'cancelled' | 'skipped' | 'deferred' | 'waiting_for_input';

/** Redis pub/sub payloads (hints only, never text — P2-C4). The SSE re-reads the STREAM; the Worker acts only on a turn it holds. */
export interface AiWakeMessage {
  /** turnId */
  t: string;
  /** Redis stream entry id */
  id: string;
}
export interface AiCancelMessage {
  /** turnId */
  t: string;
}

/**
 * Redis key/channel names (rule 9.2), all `crewflow:{env}:ai:conv:{conversationId}:…`:
 *   stream      `…:turn:{turnId}:stream` (STREAM, TTL 900 s after the last write)
 *   wake        `…:wake`   (PUBLISH AiWakeMessage)
 *   cancel      `…:cancel` (PUBLISH AiCancelMessage) + flag `…:turn:{turnId}:cancel` (SET EX 3600)
 */
export interface AiStreamKeys {
  stream(conversationId: string, turnId: string): string;
  wake(conversationId: string): string;
  cancel(conversationId: string): string;
  cancelFlag(conversationId: string, turnId: string): string;
}

/** Phase 2 titles: one internal gateway call (no tools, stepCountIs(1), 32 output tokens, EX-1 + payload scan + meter). */
export type AiTitleOutcome = 'written' | 'skipped' | 'refused' | 'failed';
