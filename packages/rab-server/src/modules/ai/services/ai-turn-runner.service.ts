import { randomUUID } from 'node:crypto';

import {
  AI_TURN_TRANSITIONS,
  AiAnyErrorCodeType,
  AiErrorCode,
  AiErrorCodeType,
  AiToolCallSummary,
  AiToolCallSummaryV2,
  AiTurnStatus,
  AiTurnStatusType,
  assertTransition,
} from '@rab/shared';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiTurnJobDataV2 } from '../../../engine/worker-shared/ai-jobs.contract';
import { AiTurnJobData, aiTurnDeferredJobId, aiTurnPromotedJobId } from '../../../engine/worker-shared/ai-queue.constants';
import {
  AI_CANCEL_POLL_MS,
  AI_HEARTBEAT_MAX_CONSECUTIVE_ERRORS,
  AI_HISTORY_MAX_MESSAGES,
  AI_MAX_STORED_CONTENT_CHARS,
  AI_QUEUED_WAIT_EXTRA_MS,
  AI_STREAM_FLUSH_CHARS,
  AI_STREAM_FLUSH_MS,
  AI_TURN_DEFER_MAX_MS,
  AI_TURN_DEFER_MIN_MS,
  AI_TURN_HEARTBEAT_MS,
  AI_TURN_LEASE_MS,
  AI_TURN_LEASE_RENEW_MS,
} from '../constants/ai.constants';
import {
  AiCheckpointResult,
  AiClaimResult,
  AiHeartbeatTick,
  AiTurnCheckpoint,
  AiTurnFinalisation,
  AiTurnHeartbeat,
  AiTurnIds,
  AiTurnOutcomeV2,
  AiTurnStatePrimitives,
} from '../contracts/turn';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { AiStepUsage, stepCostUsdMicros, worstCaseStepUsdMicros } from '../../../engine/core-modules/ai/models/cost';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { AiBeforeStepInfo, AiStepRefusedError, ModelGatewayService } from '../gateway/model-gateway.service';
import { buildSystemPrompt } from '../prompt/system-prompt';
import { maskSensitiveText } from '../tools/ai-output-guard';
import { AiToolRegistry, AiToolRunContext } from '../tools/ai-tool-registry.service';
import { AiAccessService, AiActor, PLATFORM_NOT_READY, REAL_PROVIDER_NOT_PERMITTED } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiCostBudgetExhaustedError, AiCostMeterService } from './ai-cost-meter.service';
import { AiQuotaService, utcDay } from './ai-quota.service';
import { returningRows } from './ai-query-rows';
import { AiRedisSubscriberProvider } from './ai-redis-subscriber.provider';
import { AiStreamService, parseCancel } from './ai-stream.service';
import { AiTurnQueueService } from './ai-turn-queue.service';
import { AiUsageService } from './ai-usage.service';

/** What the Worker processor receives for one `ai-turn` job (Phase 2 adds `deferred`; `waiting_for_input` is Phase 5b). */
export type AiTurnOutcome = Exclude<AiTurnOutcomeV2, 'waiting_for_input'>;
type AbortReason =
  | 'timeout'
  | 'cancel'
  | 'shutdown'
  | 'token_limit'
  | 'access_revoked'
  | 'budget'
  | 'meter_unavailable'
  | 'content_refused'
  | 'not_ready'
  | 'heartbeat_failed';

interface ClaimedTurn {
  id: string;
  conversationId: string;
  requestMessageId: string;
  sessionId: string;
  reservedTokens: number;
  createdAt: Date;
  leaseToken: string;
}

interface TurnRow {
  id: string;
  status: AiTurnStatusType;
  session_id: string;
  reserved_tokens: number;
  request_message_id: string;
  lease_expires_at: Date | null;
  created_at: Date;
  waited_ms?: string | number | null;
}

type ClaimOutcome =
  | { kind: 'claimed'; turn: ClaimedTurn; interruptedPredecessor: { id: string; content: string } | null }
  | { kind: 'skipped'; reason: 'not_found' | 'not_queued' | 'cancelled' }
  /** This turn's own Worker died (expired lease): ended AI_WORKER_INTERRUPTED, its last checkpoint kept. */
  | { kind: 'interrupted'; content: string; successorId: string | null }
  | { kind: 'deferred'; waitedMs: number }
  | { kind: 'wait_cap_exceeded'; reservedTokens: number; createdAt: Date };

/** Local calendar day (`YYYY-MM-DD`) in `timeZone`. */
export function localToday(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const MAX_TOOL_CALL_SUMMARIES = 32;

/**
 * The ids of an `ai-turn` job, or null for anything malformed (the job is then skipped, nothing read). A Phase 1 v1 job
 * still in Redis at deploy is accepted as `{ v: 2, kind: 'turn' }` (ai-jobs.contract.ts). Every field is a LOOKUP INPUT.
 */
export function turnJobIds(job: unknown): AiTurnIds | null {
  if (!job || typeof job !== 'object') return null;
  const j = job as Partial<AiTurnJobData> & Partial<Omit<AiTurnJobDataV2, 'v'>> & { v?: unknown };
  if (!(j.v === 1 || (j.v === 2 && j.kind === 'turn'))) return null;
  const ids = [j.turnId, j.conversationId, j.organisationId, j.workspaceId, j.userId];
  // Present, bounded strings; whether they name a real row is decided by the RLS-bound lookup (a forged one matches none).
  if (!ids.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 64)) return null;
  return { turnId: j.turnId!, conversationId: j.conversationId!, organisationId: j.organisationId!, workspaceId: j.workspaceId!, userId: j.userId! };
}

/** Back-off of a deferred claim: 1 s at first, growing with the wait, never above 5 s. */
export function deferDelayMs(waitedMs: number): number {
  return Math.min(AI_TURN_DEFER_MAX_MS, Math.max(AI_TURN_DEFER_MIN_MS, Math.round((Number.isFinite(waitedMs) ? waitedMs : 0) / 3)));
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (error as { code?: string })?.code;
  return (error instanceof QueryFailedError || typeof code === 'string') && code === '23505';
}

/**
 * The bounded history as model messages. For a REAL provider every user-typed message is masked first (security 3.4 /
 * D18): anything shaped like an email address, a UK NI number, a sort code / account number or a phone number is
 * replaced. Stored text is unchanged. This cannot police free text completely (a name, an address written in words or
 * a deliberately disguised number still gets through); the system prompt, the synthetic-data-only rule and the tools'
 * output allowlists are the other layers.
 */
export function toModelHistory(rows: Array<{ role: 'user' | 'assistant'; content: string }>, opts: { maskUserInput: boolean }): ModelMessage[] {
  return rows.map((r) => ({ role: r.role, content: opts.maskUserInput && r.role === 'user' ? maskSensitiveText(r.content) : r.content }) as ModelMessage);
}

/**
 * Tool summaries with their `offset` into the turn's content (AiToolCallSummaryV2, step ordering): the n-th summary of a
 * tool takes the content length at that tool's n-th `tool-call` stream part. Metadata only, bounded.
 */
export function withOffsets(calls: readonly AiToolCallSummaryV2[], offsets: ReadonlyArray<{ name: string; offset: number }>): AiToolCallSummaryV2[] {
  const used = new Set<number>();
  return calls.slice(0, MAX_TOOL_CALL_SUMMARIES).map((c) => {
    if (typeof c.offset === 'number') return { ...c };
    const i = offsets.findIndex((o, idx) => !used.has(idx) && o.name === c.name);
    if (i < 0) return { ...c };
    used.add(i);
    return { ...c, offset: offsets[i]!.offset };
  });
}

/**
 * THE 2-second turn heartbeat (Phase 2 §2.2, resolution X-10 — ONE timer per turn): each tick runs the built-in steps
 * (access re-check → checkpoint → slot refresh) and then every `onTick` subscriber, in registration order. A tick never
 * overlaps the previous one (a slow tick skips the next interval rather than queueing it). A subscriber that throws stops
 * the remaining subscribers of that tick and is reported to `onSubscriberError`, which aborts the turn (fail closed).
 * Phase 3 (3w) registers its permission fingerprint re-check here; nothing may start a second interval for it.
 */
export class AiTurnHeartbeatTimer implements AiTurnHeartbeat {
  private readonly subscribers = new Set<(tick: AiHeartbeatTick) => Promise<void> | void>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private ticks = 0;

  constructor(
    private readonly steps: (tick: AiHeartbeatTick) => Promise<void>,
    private readonly onSubscriberError: (error: unknown) => void,
    readonly intervalMs: number = AI_TURN_HEARTBEAT_MS,
  ) {}

  onTick(subscriber: (tick: AiHeartbeatTick) => Promise<void> | void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscribers.clear();
  }

  /** One tick (public for tests). Returns false when it was skipped (stopped, or the previous tick is still running). */
  async tick(): Promise<boolean> {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const tick: AiHeartbeatTick = { tickNumber: ++this.ticks, at: new Date() };
      await this.steps(tick);
      for (const subscriber of [...this.subscribers]) {
        if (this.stopped) break;
        try {
          await subscriber(tick);
        } catch (error) {
          this.onSubscriberError(error);
          break;
        }
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}

/** Running cost of one turn (estimated micro-USD) and the open per-step reservations not yet settled. */
interface CostLedger {
  model: AiCatalogueModel | null;
  day: string;
  settledMicros: number;
  open: number[];
}

const NO_USAGE = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsdMicros: 0, steps: 0 });

/**
 * The rab-ai Worker step loop (docs/ai/PHASE1_PLAN.md §2, PHASE2_TWENTY_PLAN.md §2.1–§2.2). Runs ONLY in the Worker
 * process (`AiWorkerCoreModule`, P2-C11), on the restricted `crewflow_app` connection, through TenantContextService —
 * never an owner or bypass credential.
 *
 *  1. CLAIM the turn (queued → running, lease token) under RLS bound to the job's ids; a forged id matches nothing; a
 *     duplicate delivery of a running turn is skipped; a running turn whose lease expired (dead Worker) ends
 *     AI_WORKER_INTERRUPTED with its last checkpoint kept — the model is never called twice for one turn. A queued
 *     successor whose predecessor is still running DEFERS (row unchanged, a delayed `ai-turn.<id>.w<n>` job), and fails
 *     AI_SERVICE_UNAVAILABLE (refunded) once it has waited AI_TURN_TIMEOUT_SECONDS + 60 s.
 *  2. REBUILD authority from PostgreSQL (session, membership/workspace, account, organisation, maintenance, ai.use,
 *     eligibility, both switches); anything missing stops the turn before the model is called.
 *  3. Load the bounded history in its own short transaction (closed before the model runs — no transaction is ever held
 *     across a model call; each tool, checkpoint and lease renewal opens its own).
 *  4. Offer only the tools the actor may use; call the model gateway (step limit, output limit, timeout, abort).
 *  5. Stream coalesced text deltas and tool names to the turn's Redis stream. THE 2 s heartbeat re-checks access,
 *     checkpoints `content` + `tool_calls` under the lease compare-and-set and refreshes the conversation's org slot; the
 *     cancel flag (500 ms), the cancel channel hint (re-confirmed against the flag / the database), the lease (15 s),
 *     the per-turn token ceiling and the timeout are watched too.
 *  6. FINALISE exactly once (compare-and-set on status + lease token): bounded content, tool metadata, token counts,
 *     `ai_usage_daily`, audit — in one transaction; then reconcile the budget reservation, hand the conversation's slot
 *     to the queued successor (promotion job) or release it, and publish `done`.
 */
@Injectable()
export class AiTurnRunnerService implements Omit<AiTurnStatePrimitives, 'pause'> {
  private readonly logger = new Logger('AiTurnRunner');
  private readonly inflight = new Map<string, (reason: AbortReason) => void>();
  private readonly ledgers = new Map<string, CostLedger>();
  private readonly lastCheckpoint = new Map<string, string>();
  private readonly heartbeatObservers = new Set<(turnId: string, heartbeat: AiTurnHeartbeat) => void>();

  constructor(
    private readonly config: AiConfigService,
    private readonly access: AiAccessService,
    private readonly quota: AiQuotaService,
    private readonly streams: AiStreamService,
    private readonly usage: AiUsageService,
    private readonly costMeter: AiCostMeterService,
    private readonly gateway: ModelGatewayService,
    private readonly registry: AiToolRegistry,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    // Phase 2. Always provided by AiWorkerCoreModule; optional only so a hand-built unit harness keeps compiling. Without
    // the queue a successor that must defer fails closed (AI_SERVICE_UNAVAILABLE); without the subscriber the cancel flag
    // and the database remain the (slower) cancel paths.
    @Optional() private readonly queue?: AiTurnQueueService,
    @Optional() private readonly subscriber?: AiRedisSubscriberProvider,
  ) {}

  /** Graceful Worker shutdown: every in-flight turn is aborted and finalised as AI_WORKER_INTERRUPTED (checkpoint kept). */
  abortAll(): number {
    for (const abort of this.inflight.values()) abort('shutdown');
    return this.inflight.size;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Registers a callback told about every turn's heartbeat when the turn starts (e.g. a Phase 3 fingerprint re-check
   * registering on `onTick`, or a test's dummy subscriber). Returns its removal function.
   */
  observeHeartbeats(observer: (turnId: string, heartbeat: AiTurnHeartbeat) => void): () => void {
    this.heartbeatObservers.add(observer);
    return () => {
      this.heartbeatObservers.delete(observer);
    };
  }

  async run(job: AiTurnJobData | AiTurnJobDataV2): Promise<AiTurnOutcome> {
    const ids = turnJobIds(job);
    if (!ids) return 'skipped';
    const ctx = this.ctxOf(ids);
    let claimed: ClaimOutcome;
    try {
      claimed = await this.claimTurn(ctx, ids);
    } catch (error) {
      // A concurrent claim of this conversation won the one-running index: the row is unchanged, try again shortly.
      if (isUniqueViolation(error)) claimed = { kind: 'deferred', waitedMs: 0 };
      else throw error;
    }
    switch (claimed.kind) {
      case 'skipped':
        return 'skipped';
      case 'interrupted':
        // The reservation stays charged (the dead attempt may have consumed tokens); the slot passes to a queued successor
        // or is released, and the stream is closed with the kept checkpoint.
        await this.afterTerminal(ids, claimed.successorId);
        await this.streams.publishQuietly(ids.conversationId, ids.turnId, { type: 'done', turnId: ids.turnId, status: 'failed', errorCode: AiErrorCode.WORKER_INTERRUPTED, content: claimed.content });
        return 'failed';
      case 'deferred':
        return this.defer(ctx, ids, claimed.waitedMs);
      case 'wait_cap_exceeded':
        await this.quota.adjustBudget(ids.organisationId, utcDay(claimed.createdAt), -claimed.reservedTokens);
        await this.streams.publishQuietly(ids.conversationId, ids.turnId, { type: 'done', turnId: ids.turnId, status: 'failed', errorCode: AiErrorCode.SERVICE_UNAVAILABLE, content: '' });
        return 'failed';
      case 'claimed':
        if (claimed.interruptedPredecessor) {
          const p = claimed.interruptedPredecessor;
          await this.streams.publishQuietly(ids.conversationId, p.id, { type: 'done', turnId: p.id, status: 'failed', errorCode: AiErrorCode.WORKER_INTERRUPTED, content: p.content });
        }
        return this.execute(ctx, ids, claimed.turn);
    }
  }

  /** Contract primitive (P2 §7): the claim alone. `run` is the Worker entry point and uses the same transaction. */
  async claim(ids: AiTurnIds): Promise<AiClaimResult> {
    const outcome = await this.claimTurn(this.ctxOf(ids), ids).catch((error) => {
      if (isUniqueViolation(error)) return { kind: 'deferred' as const, waitedMs: 0 };
      throw error;
    });
    switch (outcome.kind) {
      case 'claimed':
        return { outcome: 'claimed', leaseToken: outcome.turn.leaseToken };
      case 'deferred':
        return { outcome: 'deferred', retryInMs: deferDelayMs(outcome.waitedMs) };
      case 'wait_cap_exceeded':
        return { outcome: 'skipped', reason: 'wait_cap_exceeded' };
      case 'interrupted':
        return { outcome: 'skipped', reason: 'not_queued' };
      case 'skipped':
        return { outcome: 'skipped', reason: outcome.reason };
    }
  }

  /**
   * Contract primitive: writes `content` + `tool_calls` + `checkpointed_at` while THIS lease still holds (compare-and-set
   * on status + lease token, its own short transaction). `lease_lost` = 0 rows: the caller aborts and never writes again.
   */
  async checkpoint(ids: AiTurnIds, leaseToken: string, checkpoint: AiTurnCheckpoint): Promise<AiCheckpointResult> {
    const content = checkpoint.content.slice(0, AI_MAX_STORED_CONTENT_CHARS);
    const toolCalls = JSON.stringify(checkpoint.toolCalls.slice(0, MAX_TOOL_CALL_SUMMARIES));
    const signature = `${content.length}:${toolCalls}`;
    if (this.lastCheckpoint.get(ids.turnId) === signature) return 'unchanged';
    const rows = await this.tenantContext.runInTenantContext(this.ctxOf(ids), (m) =>
      returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_message SET content = $3, tool_calls = $4::jsonb, checkpointed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running' AND lease_token = $2 RETURNING id`,
        [ids.turnId, leaseToken, content, toolCalls],
      ),
    );
    if (!rows || rows.length === 0) return 'lease_lost';
    if (this.inflight.has(ids.turnId)) this.lastCheckpoint.set(ids.turnId, signature);
    return 'written';
  }

  /**
   * Contract primitive: the terminal compare-and-set (status + lease token) with content, tool metadata, tokens, usage
   * and audit in ONE transaction; then the reservation is reconciled, the slot handed on or released, `done` published.
   * False when the CAS was lost (someone else finished it). `known` = what the Worker already holds about the turn (its
   * creation time and reservation), needed when the conversation was deleted meanwhile.
   */
  async finalise(ids: AiTurnIds, leaseToken: string, result: AiTurnFinalisation, known?: { createdAt: Date; reservedTokens: number }): Promise<boolean> {
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.RUNNING, result.status);
    const bounded = result.content.slice(0, AI_MAX_STORED_CONTENT_CHARS);
    const summaries = result.toolCalls.slice(0, MAX_TOOL_CALL_SUMMARIES);
    const ctx = this.ctxOf(ids);
    const outcome = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [updated] = await returningRows<{ id: string; created_at?: Date; reserved_tokens?: number }>(
        m,
        `UPDATE core.ai_message SET status = $3, error_code = $4, content = $5, tool_calls = $6::jsonb, input_tokens = $7, output_tokens = $8,
                completed_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'running' AND lease_token = $2 RETURNING id, created_at, reserved_tokens`,
        [ids.turnId, leaseToken, result.status, result.errorCode, bounded, JSON.stringify(summaries), result.usage.inputTokens, result.usage.outputTokens],
      );
      if (!updated) {
        const [exists] = await m.query(`SELECT 1 FROM core.ai_message WHERE id = $1`, [ids.turnId]);
        return exists ? { kind: 'lost' as const } : { kind: 'missing' as const };
      }
      const createdAt = known?.createdAt ?? new Date(updated.created_at as Date);
      await m.query(`UPDATE core.ai_conversation SET last_message_at = now(), updated_at = now() WHERE id = $1`, [ids.conversationId]);
      await this.recordTerminal(m, ctx, ids, createdAt, result.status, result.errorCode, { ...result.usage, calls: summaries, model: this.ledgers.get(ids.turnId)?.model?.id ?? null });
      const successorId = await this.queuedSuccessor(m, ids);
      return { kind: 'finalised' as const, createdAt, reservedTokens: known?.reservedTokens ?? Number(updated.reserved_tokens ?? 0), successorId };
    });
    if (outcome.kind === 'lost') return false; // another actor (lease expiry) already finalised and released it
    // Exactly once (tied to the terminal transition above, or the turn was deleted with its conversation).
    const createdAt = outcome.kind === 'finalised' ? outcome.createdAt : (known?.createdAt ?? new Date());
    const reserved = outcome.kind === 'finalised' ? outcome.reservedTokens : (known?.reservedTokens ?? 0);
    await this.quota.adjustBudget(ids.organisationId, utcDay(createdAt), result.usage.inputTokens + result.usage.outputTokens - reserved);
    await this.afterTerminal(ids, outcome.kind === 'finalised' ? outcome.successorId : null);
    await this.streams.clearCancel(ids.conversationId, ids.turnId);
    await this.streams.publishQuietly(ids.conversationId, ids.turnId, {
      type: 'done',
      turnId: ids.turnId,
      status: result.status,
      errorCode: result.errorCode,
      content: outcome.kind === 'missing' ? '' : bounded,
    });
    return true;
  }

  private ctxOf(ids: Pick<AiTurnIds, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext {
    return { organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, role: '' };
  }

  /** The cap on a queued successor's wait for its predecessor (the turn timeout + 60 s). */
  private get queuedWaitCapMs(): number {
    return this.config.turnTimeoutMs + AI_QUEUED_WAIT_EXTRA_MS;
  }

  private async claimTurn(ctx: AuthContext, ids: AiTurnIds): Promise<ClaimOutcome> {
    const leaseToken = randomUUID();
    return this.tenantContext.runInTenantContext(ctx, async (m): Promise<ClaimOutcome> => {
      const [row] = await m.query<TurnRow[]>(
        `SELECT id, status, session_id, reserved_tokens, request_message_id, lease_expires_at, created_at,
                floor(extract(epoch FROM (now() - created_at)) * 1000)::bigint AS waited_ms
           FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' FOR UPDATE`,
        [ids.turnId, ids.conversationId],
      );
      if (!row) return { kind: 'skipped', reason: 'not_found' };
      if (row.status === AiTurnStatus.RUNNING) {
        if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) return { kind: 'skipped', reason: 'not_queued' };
        // The Worker that held this turn died (lease expired): end it, never re-run the model. Its last checkpoint stays.
        const content = await this.interruptExpired(m, ctx, { ...ids }, new Date(row.created_at));
        if (content === null) return { kind: 'skipped', reason: 'not_queued' };
        return { kind: 'interrupted', content, successorId: await this.queuedSuccessor(m, ids) };
      }
      if (row.status !== AiTurnStatus.QUEUED) return { kind: 'skipped', reason: row.status === AiTurnStatus.CANCELLED ? 'cancelled' : 'not_queued' };

      // A queued successor runs only after its predecessor (one running turn per conversation, P2-C5).
      const [predecessor] = await m.query<Array<{ id: string; created_at: Date; expired: boolean }>>(
        `SELECT id, created_at, (lease_expires_at IS NULL OR lease_expires_at <= now()) AS expired
           FROM core.ai_message WHERE conversation_id = $2 AND role = 'assistant' AND status = 'running' AND id <> $1 LIMIT 1`,
        [ids.turnId, ids.conversationId],
      );
      let interruptedPredecessor: { id: string; content: string } | null = null;
      if (predecessor) {
        if (predecessor.expired === true) {
          // The predecessor's Worker died and nothing re-delivered it: end it now (checkpoint kept), then claim this turn.
          const content = await this.interruptExpired(m, ctx, { ...ids, turnId: predecessor.id }, new Date(predecessor.created_at));
          if (content !== null) interruptedPredecessor = { id: predecessor.id, content };
        } else {
          const waitedMs = Number(row.waited_ms ?? 0);
          if (waitedMs <= this.queuedWaitCapMs) return { kind: 'deferred', waitedMs };
          assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.FAILED);
          const [failed] = await returningRows<{ id: string }>(
            m,
            `UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id`,
            [ids.turnId, AiErrorCode.SERVICE_UNAVAILABLE],
          );
          if (!failed) return { kind: 'skipped', reason: 'not_queued' };
          await this.recordTerminal(m, ctx, ids, new Date(row.created_at), 'failed', AiErrorCode.SERVICE_UNAVAILABLE, { ...NO_USAGE, calls: [], model: null, stage: 'queued_wait' });
          return { kind: 'wait_cap_exceeded', reservedTokens: Number(row.reserved_tokens), createdAt: new Date(row.created_at) };
        }
      }

      assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.RUNNING);
      await m.query(
        `UPDATE core.ai_message SET status = 'running', lease_token = $2, lease_expires_at = now() + ($3 || ' milliseconds')::interval,
                started_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'queued'`,
        [row.id, leaseToken, String(AI_TURN_LEASE_MS)],
      );
      return {
        kind: 'claimed',
        interruptedPredecessor,
        turn: {
          id: row.id,
          conversationId: ids.conversationId,
          requestMessageId: row.request_message_id,
          sessionId: row.session_id,
          reservedTokens: Number(row.reserved_tokens),
          createdAt: new Date(row.created_at),
          leaseToken,
        },
      };
    });
  }

  /** Ends a running turn whose lease expired as AI_WORKER_INTERRUPTED (content = its last checkpoint). Null = lost. */
  private async interruptExpired(m: EntityManager, ctx: AuthContext, ids: AiTurnIds, createdAt: Date): Promise<string | null> {
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.RUNNING, AiTurnStatus.FAILED);
    const [updated] = await returningRows<{ content: string }>(
      m,
      `UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING content`,
      [ids.turnId, AiErrorCode.WORKER_INTERRUPTED],
    );
    if (!updated) return null;
    await this.recordTerminal(m, ctx, ids, createdAt, 'failed', AiErrorCode.WORKER_INTERRUPTED, { ...NO_USAGE, calls: [], model: null });
    return updated.content ?? '';
  }

  /** The conversation's queued successor, if any (read inside the caller's tenant transaction). */
  private async queuedSuccessor(m: EntityManager, ids: AiTurnIds): Promise<string | null> {
    const [row] = await m.query<Array<{ id: string }>>(
      `SELECT id FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status = 'queued' AND id <> $2 LIMIT 1`,
      [ids.conversationId, ids.turnId],
    );
    return row?.id ?? null;
  }

  /**
   * After a terminal transition: a queued successor inherits the conversation's org slot and is promoted at once
   * (`ai-turn.<id>.next`, deduplicated — best effort: its own deferral covers a missed promotion); otherwise the slot is
   * released (best effort: it expires by itself).
   */
  private async afterTerminal(ids: AiTurnIds, successorId: string | null): Promise<void> {
    if (successorId) {
      await this.queue?.enqueueTurn({ ...ids, turnId: successorId }, { jobId: aiTurnPromotedJobId(successorId) }).catch(() => undefined);
      return;
    }
    await this.quota.releaseSlot(ids.organisationId, ids.conversationId);
  }

  /**
   * A queued successor whose predecessor still runs: the row is unchanged and a delayed job is re-added (deterministic id
   * per whole second waited, so concurrent deferrals deduplicate). The job ends `deferred` (no retry consumed). If the
   * deferral cannot be scheduled the turn fails AI_SERVICE_UNAVAILABLE (refunded) instead of being stranded.
   */
  private async defer(ctx: AuthContext, ids: AiTurnIds, waitedMs: number): Promise<AiTurnOutcome> {
    const delayMs = deferDelayMs(waitedMs);
    try {
      if (!this.queue) throw new Error('no queue');
      await this.queue.enqueueTurn(ids, { jobId: aiTurnDeferredJobId(ids.turnId, Math.floor(waitedMs / 1000)), delayMs });
      return 'deferred';
    } catch {
      const failed = await this.tenantContext
        .runInTenantContext(ctx, async (m) => {
          const [row] = await returningRows<{ created_at: Date; reserved_tokens: number }>(
            m,
            `UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING created_at, reserved_tokens`,
            [ids.turnId, AiErrorCode.SERVICE_UNAVAILABLE],
          );
          if (!row) return null;
          await this.recordTerminal(m, ctx, ids, new Date(row.created_at), 'failed', AiErrorCode.SERVICE_UNAVAILABLE, { ...NO_USAGE, calls: [], model: null, stage: 'defer' });
          return row;
        })
        .catch(() => null);
      if (!failed) return 'skipped';
      await this.quota.adjustBudget(ids.organisationId, utcDay(new Date(failed.created_at)), -Number(failed.reserved_tokens));
      await this.streams.publishQuietly(ids.conversationId, ids.turnId, { type: 'done', turnId: ids.turnId, status: 'failed', errorCode: AiErrorCode.SERVICE_UNAVAILABLE, content: '' });
      return 'failed';
    }
  }

  private async execute(ctx: AuthContext, ids: AiTurnIds, turn: ClaimedTurn): Promise<AiTurnOutcome> {
    const controller = new AbortController();
    let abortReason: AbortReason | null = null;
    const abort = (reason: AbortReason) => {
      if (abortReason) return;
      abortReason = reason;
      controller.abort(new Error(`ai turn aborted: ${reason}`));
    };
    this.inflight.set(turn.id, abort);
    const timers: NodeJS.Timeout[] = [];
    const calls: AiToolCallSummary[] = [];
    const toolOffsets: Array<{ name: string; offset: number }> = [];
    let content = '';
    // CD-7 / TW-D7: reasoning DURATION only (server clock). Every reasoning delta and provider signature is discarded
    // here — never buffered, streamed, checkpointed, persisted, logged or audited.
    const reasoningOpen = new Map<string, number>();
    let reasoningMs: number | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let modelError = false;
    let heartbeat: AiTurnHeartbeatTimer | null = null;
    let unsubscribeCancel: (() => void) | null = null;
    const ledger: CostLedger = { model: null, day: utcDay(turn.createdAt), settledMicros: 0, open: [] };
    this.ledgers.set(turn.id, ledger);
    const summaries = () => withOffsets(calls, toolOffsets);
    const finish = (status: 'completed' | 'failed' | 'cancelled', errorCode: AiErrorCodeType | null) =>
      this.finishTurn(ids, turn, status, errorCode, content, summaries(), inputTokens, outputTokens, ledger, reasoningMs);
    const publish = (event: Parameters<AiStreamService['publishQuietly']>[2]) => this.streams.publishQuietly(turn.conversationId, turn.id, event);

    try {
      await publish({ type: 'status', turnId: turn.id, status: 'running' });
      let actor: AiActor;
      try {
        actor = await this.access.rebuildForWorker({ organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, sessionId: turn.sessionId });
      } catch (error) {
        const reason = error instanceof AiAccessRevokedError ? error.reason : 'unknown';
        await this.auditQuietly(ctx, AuditAction.AI_TURN_REFUSED, turn.id, { conversationId: turn.conversationId, reason, stage: 'worker_start' });
        // A misconfigured platform or a real provider this organisation may not use is "temporarily unavailable" (fixed
        // safe message), not "your access was revoked". Nothing was sent to any model.
        const code = reason === PLATFORM_NOT_READY || reason === REAL_PROVIDER_NOT_PERMITTED ? AiErrorCode.SERVICE_UNAVAILABLE : AiErrorCode.ACCESS_REVOKED;
        return await finish('failed', code);
      }
      if (!(await this.holdSlot(ids))) {
        // The slot expired while the job waited and the organisation is now at its cap (or Redis is unavailable): do not
        // run beyond the organisation's cap.
        return await finish('failed', AiErrorCode.SERVICE_UNAVAILABLE);
      }

      // The model was resolved at Worker start with the API's resolver (org pin → env default → nearest tier → any). It is
      // stamped on the turn now and never re-resolved: before every step the gateway and the access re-check refuse it if
      // it stopped being usable.
      const entry = actor.model;
      ledger.model = entry;
      await this.stampModel(ctx, turn, entry.id);
      const { messages: history, rawUserTexts } = await this.loadHistory(ctx, turn, { maskUserInput: isRealProvider(entry) });
      const run: AiToolRunContext = { actor, turnId: turn.id, conversationId: turn.conversationId, abortTurn: () => abort('access_revoked'), calls };
      const tools = this.registry.buildToolSet(run);
      const offered = new Set(Object.keys(tools));
      const ceiling = turn.reservedTokens > 0 ? turn.reservedTokens : this.config.turnTokenReservation;

      timers.push(setTimeout(() => abort('timeout'), this.config.turnTimeoutMs));
      timers.push(setInterval(() => {
        void this.streams.isCancelRequested(turn.conversationId, turn.id).then((yes) => yes && abort('cancel'));
      }, AI_CANCEL_POLL_MS));
      timers.push(setInterval(() => {
        void this.renewLease(ctx, turn).then((state) => {
          if (state === 'cancel') abort('cancel');
          if (state === 'lost') abort('shutdown');
        }).catch(() => undefined);
      }, AI_TURN_LEASE_RENEW_MS));

      // THE 2 s heartbeat: access → checkpoint → slot → onTick subscribers (one timer, X-10).
      let consecutiveErrors = 0;
      const heartbeatError = () => {
        consecutiveErrors += 1;
        if (consecutiveErrors >= AI_HEARTBEAT_MAX_CONSECUTIVE_ERRORS) abort('heartbeat_failed');
      };
      heartbeat = new AiTurnHeartbeatTimer(
        async () => {
          try {
            await this.access.assertStillAllowed(actor);
          } catch (error) {
            // A long model call (no tool in between) is re-authorised too: session, account, organisation, ai.use, switches.
            if (error instanceof AiAccessRevokedError) abort('access_revoked');
            else heartbeatError();
            return;
          }
          let written: AiCheckpointResult | 'error';
          try {
            written = await this.checkpoint(ids, turn.leaseToken, { content, toolCalls: summaries() });
          } catch {
            written = 'error';
          }
          // Unchanged content writes nothing; the lease is still verified every tick, so a lost lease stops the turn
          // within one heartbeat whether or not new text arrived.
          if (written === 'unchanged' && !(await this.leaseHeld(ctx, turn).catch(() => true))) written = 'lease_lost';
          if (written === 'lease_lost') {
            abort('shutdown'); // another actor owns the turn now: never write again
            return;
          }
          if (written === 'error') {
            heartbeatError();
            return;
          }
          consecutiveErrors = 0;
          await this.quota.refreshSlot(ids.organisationId, turn.conversationId).catch(() => undefined);
        },
        (error) => abort(error instanceof AiAccessRevokedError ? 'access_revoked' : 'heartbeat_failed'),
      );
      for (const observer of this.heartbeatObservers) {
        try {
          observer(turn.id, heartbeat);
        } catch {
          // An observer never breaks the turn.
        }
      }
      heartbeat.start();

      // The cancel channel (fast path). A hint names a turn id only; it is acted on only for THIS in-flight turn, and only
      // after the durable paths confirm it (the Redis flag or the database `cancel_requested_at`), so a forged or foreign
      // message changes nothing.
      if (this.subscriber) {
        unsubscribeCancel = await this.subscriber.subscribe(this.streams.cancel(turn.conversationId), (payload) => {
          const hint = parseCancel(payload);
          if (!hint || hint.t !== turn.id) return;
          void this.cancelConfirmed(ctx, turn).then((yes) => yes && abort('cancel')).catch(() => undefined);
        });
      }

      let buffer = '';
      let lastFlush = Date.now();
      const flush = async (force = false) => {
        if (!buffer || (!force && buffer.length < AI_STREAM_FLUSH_CHARS && Date.now() - lastFlush < AI_STREAM_FLUSH_MS)) return;
        const text = buffer;
        buffer = '';
        lastFlush = Date.now();
        await publish({ type: 'delta', turnId: turn.id, text });
      };
      // Text that arrives just before a long pause (e.g. a slow model) is still delivered promptly.
      timers.push(setInterval(() => void flush(true), AI_STREAM_FLUSH_MS));

      try {
        let refusalAudited = false;
        const onRefused = (error: AiStepRefusedError) => {
          if (error.reason === 'not_ready') {
            // The turn's model stopped being usable (key removed, disabled, approval revoked): no further call is made.
            abort('not_ready');
            return;
          }
          abort('content_refused');
          if (refusalAudited) return;
          refusalAudited = true;
          void this.auditQuietly(ctx, AuditAction.AI_TURN_REFUSED, turn.id, {
            conversationId: turn.conversationId,
            reason: 'content_refused',
            // Fixed category / reason codes only (email, phone, ni_number, …, non_synthetic_user): never the matched text.
            categories: [...error.categories],
            stage: 'before_model_request',
          });
        };
        const result = this.gateway.stream({
          model: entry,
          system: buildSystemPrompt(localToday(actor.timezone)),
          messages: history,
          tools,
          abortSignal: controller.signal,
          realProviderPermitted: actor.realProviderPermitted,
          // Before EVERY model call: the kill switch / readiness / access re-check, then the cost reservation.
          beforeStep: (info) => this.beforeStep(ctx, actor, ledger, info, abort),
          // Owner-approved Part A exception (real providers only; the gateway refuses without it): request-time synthetic
          // re-verification, and the unmasked input for the payload scan. A refusal is audited with codes only.
          realRequestGuard: async () => {
            const check = await this.access.syntheticCheckForRealRequest(actor);
            if (check !== 'ok') {
              const refusal = new AiStepRefusedError('content_refused', [check]);
              onRefused(refusal);
              throw refusal;
            }
          },
          unmaskedUserTexts: rawUserTexts,
          onRefused: (error) => onRefused(error),
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta': {
              const room = AI_MAX_STORED_CONTENT_CHARS - content.length;
              if (room <= 0) break;
              const piece = part.text.slice(0, room);
              content += piece;
              buffer += piece;
              await flush();
              break;
            }
            case 'reasoning-start':
              if (!reasoningOpen.has(part.id)) {
                reasoningOpen.set(part.id, Date.now());
                await publish({ type: 'reasoning', turnId: turn.id, phase: 'started' });
              }
              break;
            case 'reasoning-delta':
              // Discarded: the text (and any provider signature in its metadata) never leaves this loop.
              break;
            case 'reasoning-end': {
              const startedAt = reasoningOpen.get(part.id);
              if (startedAt === undefined) break;
              reasoningOpen.delete(part.id);
              const durationMs = Math.max(0, Date.now() - startedAt);
              reasoningMs = (reasoningMs ?? 0) + durationMs;
              await publish({ type: 'reasoning', turnId: turn.id, phase: 'finished', durationMs });
              break;
            }
            case 'tool-call': {
              await flush(true);
              if (!offered.has(part.toolName)) await this.registry.recordUnknownToolCall(run, part.toolName);
              const name = offered.has(part.toolName) ? part.toolName : 'unavailable_tool';
              toolOffsets.push({ name: part.toolName, offset: content.length });
              await publish({ type: 'tool', turnId: turn.id, name, phase: 'started', offset: content.length });
              break;
            }
            case 'tool-result':
              await publish({ type: 'tool', turnId: turn.id, name: part.toolName, phase: 'finished', outcome: 'ok', offset: content.length });
              break;
            case 'tool-error':
              // The SDK refused the call before `execute` (unknown tool, schema violation) or `execute` threw.
              if (offered.has(part.toolName) && !calls.some((c) => c.name === part.toolName)) calls.push({ name: part.toolName, outcome: 'invalid_input', rows: null });
              await publish({ type: 'tool', turnId: turn.id, name: offered.has(part.toolName) ? part.toolName : 'unavailable_tool', phase: 'finished', outcome: 'error', offset: content.length });
              break;
            case 'finish-step':
              inputTokens += part.usage.inputTokens ?? 0;
              outputTokens += part.usage.outputTokens ?? 0;
              await this.settleStep(ids.organisationId, ledger, part.usage);
              if (inputTokens + outputTokens > ceiling) abort('token_limit');
              break;
            case 'error':
              modelError = true;
              break;
            default:
              break;
          }
        }
        await flush(true);
      } catch {
        // Aborts and provider failures both end here; the reason decides the outcome below. Never log the error itself.
        if (!abortReason) modelError = true;
      }
      heartbeat.stop();

      const reason = abortReason as AbortReason | null;
      if (reason === 'cancel') return await finish('cancelled', null);
      if (reason) {
        const code: AiErrorCodeType =
          reason === 'timeout' ? AiErrorCode.MODEL_TIMEOUT
            : reason === 'token_limit' ? AiErrorCode.TURN_TOKEN_LIMIT
              : reason === 'access_revoked' ? AiErrorCode.ACCESS_REVOKED
                : reason === 'budget' ? AiErrorCode.BUDGET_EXHAUSTED
                  : reason === 'meter_unavailable' || reason === 'content_refused' || reason === 'not_ready' || reason === 'heartbeat_failed' ? AiErrorCode.SERVICE_UNAVAILABLE
                    : AiErrorCode.WORKER_INTERRUPTED;
        return await finish('failed', code);
      }
      if (modelError || !content) return await finish('failed', AiErrorCode.MODEL_ERROR);
      return await finish('completed', null);
    } catch (error) {
      this.logger.error(`turn ${turn.id} failed internally (${(error as Error)?.name ?? 'Error'})`);
      return await finish('failed', AiErrorCode.INTERNAL).catch(() => 'failed' as const);
    } finally {
      heartbeat?.stop();
      unsubscribeCancel?.();
      for (const t of timers) clearTimeout(t);
      this.inflight.delete(turn.id);
      this.ledgers.delete(turn.id);
      this.lastCheckpoint.delete(turn.id);
    }
  }

  private async finishTurn(
    ids: AiTurnIds,
    turn: ClaimedTurn,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: AiErrorCodeType | null,
    content: string,
    calls: AiToolCallSummaryV2[],
    inputTokens: number,
    outputTokens: number,
    ledger: CostLedger,
    reasoningMs: number | null,
  ): Promise<AiTurnOutcome> {
    const finalised = await this.finalise(
      ids,
      turn.leaseToken,
      // `reasoningMs` travels in the finalisation for Agent 9's CD-7 column (AiTurnLevelReasoning); no column is added here.
      { status, errorCode, content, toolCalls: calls, usage: { ...NO_USAGE, inputTokens, outputTokens, costUsdMicros: ledger.settledMicros }, reasoningMs },
      { createdAt: turn.createdAt, reservedTokens: turn.reservedTokens },
    );
    return finalised ? status : 'skipped';
  }

  /** The conversation's org slot for this turn: refreshed, or re-acquired within the cap if it was lost to a race. */
  private async holdSlot(ids: AiTurnIds): Promise<boolean> {
    if (await this.quota.refreshSlot(ids.organisationId, ids.conversationId).catch(() => false)) return true;
    try {
      await this.quota.acquireSlot(ids.organisationId, ids.conversationId);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether THIS Worker still holds the turn (status running + its lease token), read-only. */
  private async leaseHeld(ctx: AuthContext, turn: ClaimedTurn): Promise<boolean> {
    const rows = await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ held: number }>>(`SELECT 1 AS held FROM core.ai_message WHERE id = $1 AND status = 'running' AND lease_token = $2`, [turn.id, turn.leaseToken]),
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /** A cancel hint is acted on only when a durable path agrees: the Redis flag, or `cancel_requested_at` under this lease. */
  private async cancelConfirmed(ctx: AuthContext, turn: ClaimedTurn): Promise<boolean> {
    if (await this.streams.isCancelRequested(turn.conversationId, turn.id)) return true;
    const [row] = await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ cancel: boolean }>>(
        `SELECT cancel_requested_at IS NOT NULL AS cancel FROM core.ai_message WHERE id = $1 AND status = 'running' AND lease_token = $2`,
        [turn.id, turn.leaseToken],
      ),
    );
    return row?.cancel === true;
  }

  /**
   * prepareStep hook (ModelGatewayService): runs before every model call. Throwing stops the turn BEFORE the call.
   *   1. Access + kill switch + readiness + the real-provider clearance, re-read from PostgreSQL.
   *   2. Owner decision 6: reserve this step's worst-case estimated cost (input upper bound + the full output allowance,
   *      at catalogue prices) against AI_DAILY_BUDGET_USD in one atomic Redis script. Over budget ⇒ AI_BUDGET_EXHAUSTED;
   *      Redis or the seed read unavailable ⇒ AI_SERVICE_UNAVAILABLE (fail closed). A zero-price model (the mock) reserves 0.
   */
  private async beforeStep(ctx: AuthContext, actor: AiActor, ledger: CostLedger, info: AiBeforeStepInfo, abort: (reason: AbortReason) => void): Promise<void> {
    try {
      await this.access.assertStillAllowed(actor);
    } catch {
      abort('access_revoked');
      throw new AiStepRefusedError('access_revoked');
    }
    const amount = worstCaseStepUsdMicros(info.model, info.maxInputTokens, info.maxOutputTokens);
    if (amount <= 0) {
      ledger.open.push(0);
      return;
    }
    try {
      await this.costMeter.reserve(actor.organisationId, ledger.day, amount, () => this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayCostMicros(m, actor.organisationId, ledger.day)));
    } catch (error) {
      if (error instanceof AiCostBudgetExhaustedError) {
        abort('budget');
        throw new AiStepRefusedError('budget');
      }
      abort('meter_unavailable');
      // AiQuotaUnavailableError (Redis or the seed read) and anything unexpected alike: never run the step unmetered.
      throw new AiStepRefusedError('meter_unavailable');
    }
    ledger.open.push(amount);
  }

  /**
   * After a step: its actual estimated cost (cache-aware: no-cache, cache-read and cache-write input tokens at their own
   * catalogue prices, D13) joins the turn total and the reservation is settled (actual − reserved).
   */
  private async settleStep(organisationId: string, ledger: CostLedger, usage: AiStepUsage): Promise<void> {
    const reserved = ledger.open.shift() ?? 0;
    const actual = ledger.model ? stepCostUsdMicros(ledger.model, usage) : 0;
    ledger.settledMicros += actual;
    if (actual !== reserved) await this.costMeter.settle(organisationId, ledger.day, actual - reserved);
  }

  /** Stamps the turn's resolved catalogue id (`ai_message.model`) while this Worker holds the lease. */
  private async stampModel(ctx: AuthContext, turn: ClaimedTurn, modelId: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query(`UPDATE core.ai_message SET model = $3, updated_at = now() WHERE id = $1 AND status = 'running' AND lease_token = $2`, [turn.id, turn.leaseToken, modelId]),
    );
  }

  /** Bounded history (oldest first): earlier user questions and COMPLETED answers of this conversation, plus the question. */
  private async loadHistory(ctx: AuthContext, turn: ClaimedTurn, opts: { maskUserInput: boolean }): Promise<{ messages: ModelMessage[]; rawUserTexts: string[] }> {
    const rows = await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ id: string; role: 'user' | 'assistant'; status: string; content: string }>>(
        `SELECT id, role, status, content FROM core.ai_message
          WHERE conversation_id = $1 AND (role = 'user' OR (role = 'assistant' AND status = 'completed'))
          ORDER BY seq DESC LIMIT $2`,
        [turn.conversationId, AI_HISTORY_MAX_MESSAGES + 1],
      ),
    );
    const ordered = rows.reverse();
    const question = ordered.findIndex((r) => r.id === turn.requestMessageId);
    const upTo = question >= 0 ? ordered.slice(0, question + 1) : ordered;
    const bounded = upTo.slice(-AI_HISTORY_MAX_MESSAGES);
    return { messages: toModelHistory(bounded, opts), rawUserTexts: bounded.filter((r) => r.role === 'user').map((r) => r.content) };
  }

  private async renewLease(ctx: AuthContext, turn: ClaimedTurn): Promise<'ok' | 'cancel' | 'lost'> {
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      // returningRows: a lost lease (0 rows) is now actually seen as lost (TypeORM returns [rows, count] for UPDATE).
      const [row] = await returningRows<{ cancel: boolean }>(
        m,
        `UPDATE core.ai_message SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
          WHERE id = $1 AND status = 'running' AND lease_token = $2
          RETURNING cancel_requested_at IS NOT NULL AS cancel`,
        [turn.id, turn.leaseToken, String(AI_TURN_LEASE_MS)],
      );
      if (!row) return 'lost';
      return row.cancel ? 'cancel' : 'ok';
    });
  }

  /** Usage counters + audit for a terminal turn, inside the transition's transaction. Metadata only. */
  private async recordTerminal(
    m: EntityManager,
    ctx: AuthContext,
    ids: AiTurnIds,
    createdAt: Date,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: AiAnyErrorCodeType | null,
    usage: { inputTokens: number; outputTokens: number; costUsdMicros: number; calls: readonly AiToolCallSummaryV2[]; model: string | null; stage?: string },
  ): Promise<void> {
    await this.usage.recordTurn(m, ids.organisationId, utcDay(createdAt), {
      // A turn refused before any model resolved (Worker start) is attributed to no model.
      model: usage.model ?? 'unknown',
      // Settled steps only. A step that never reported usage (aborted mid-call) stays charged at its worst case in the
      // Redis meter, which therefore only ever over-states what is persisted here.
      costUsdMicros: usage.costUsdMicros,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      outcome: status,
      toolCalls: usage.calls.filter((c) => c.outcome === 'ok').length,
    });
    const action = status === 'completed' ? AuditAction.AI_TURN_COMPLETED : status === 'cancelled' ? AuditAction.AI_TURN_CANCELLED : AuditAction.AI_TURN_FAILED;
    await this.audit.record(m, ctx, action, {
      entityType: 'ai_turn',
      entityId: ids.turnId,
      metadata: {
        conversationId: ids.conversationId,
        errorCode,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        tools: usage.calls.map((c) => `${c.name}:${c.outcome}`),
        model: usage.model,
        ...(usage.stage ? { stage: usage.stage } : {}),
      },
    });
  }

  private async auditQuietly(ctx: AuthContext, action: typeof AuditAction.AI_TURN_REFUSED, turnId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (m) => this.audit.record(m, ctx, action, { entityType: 'ai_turn', entityId: turnId, metadata })).catch(() => undefined);
  }
}
