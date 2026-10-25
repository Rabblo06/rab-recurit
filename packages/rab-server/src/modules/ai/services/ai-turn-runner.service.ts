import { randomUUID } from 'node:crypto';

import { AI_TURN_TRANSITIONS, AiErrorCode, AiErrorCodeType, AiToolCallSummary, AiTurnStatus, AiTurnStatusType, assertTransition } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiTurnJobData } from '../../../engine/worker-shared/ai-queue.constants';
import {
  AI_CANCEL_POLL_MS,
  AI_HISTORY_MAX_MESSAGES,
  AI_MAX_STORED_CONTENT_CHARS,
  AI_STREAM_FLUSH_CHARS,
  AI_STREAM_FLUSH_MS,
  AI_TURN_LEASE_MS,
  AI_TURN_LEASE_RENEW_MS,
} from '../constants/ai.constants';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { stepCostUsdMicros, worstCaseStepUsdMicros } from '../../../engine/core-modules/ai/models/cost';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { AiBeforeStepInfo, AiStepRefusedError, ModelGatewayService } from '../gateway/model-gateway.service';
import { buildSystemPrompt } from '../prompt/system-prompt';
import { maskSensitiveText } from '../tools/ai-output-guard';
import { AiToolRegistry, AiToolRunContext } from '../tools/ai-tool-registry.service';
import { AiAccessService, AiActor, PLATFORM_NOT_READY, REAL_PROVIDER_NOT_PERMITTED } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiCostBudgetExhaustedError, AiCostMeterService } from './ai-cost-meter.service';
import { AiQuotaService, utcDay } from './ai-quota.service';
import { AiStreamService } from './ai-stream.service';
import { AiUsageService } from './ai-usage.service';

export type AiTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'skipped';
type AbortReason = 'timeout' | 'cancel' | 'shutdown' | 'token_limit' | 'access_revoked' | 'budget' | 'meter_unavailable' | 'content_refused';

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
}

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
 * The bounded history as model messages. For a REAL provider every user-typed message is masked first (security 3.4 /
 * D18): anything shaped like an email address, a UK NI number, a sort code / account number or a phone number is
 * replaced. Stored text is unchanged. This cannot police free text completely (a name, an address written in words or
 * a deliberately disguised number still gets through); the system prompt, the synthetic-data-only rule and the tools'
 * output allowlists are the other layers.
 */
export function toModelHistory(rows: Array<{ role: 'user' | 'assistant'; content: string }>, opts: { maskUserInput: boolean }): ModelMessage[] {
  return rows.map((r) => ({ role: r.role, content: opts.maskUserInput && r.role === 'user' ? maskSensitiveText(r.content) : r.content }) as ModelMessage);
}

/** Running cost of one turn (estimated micro-USD) and the open per-step reservations not yet settled. */
interface CostLedger {
  model: AiCatalogueModel | null;
  day: string;
  settledMicros: number;
  open: number[];
}

/**
 * The rab-ai Worker step loop (docs/ai/PHASE1_PLAN.md §2). Runs in the Worker process (`rab-worker/src/queues/rab-ai`),
 * on the restricted `crewflow_app` connection, through TenantContextService — never an owner or bypass credential.
 *
 *  1. CLAIM the turn (queued → running, lease token) under RLS bound to the job's ids; a forged id matches nothing; a
 *     duplicate delivery of a running turn is skipped; a running turn whose lease expired (dead Worker) ends
 *     AI_WORKER_INTERRUPTED — the model is never called twice for one turn.
 *  2. REBUILD authority from PostgreSQL (session, membership/workspace, account, organisation, maintenance, ai.use,
 *     eligibility, both switches); anything missing stops the turn before the model is called.
 *  3. Load the bounded history in its own short transaction (closed before the model runs — no transaction is ever held
 *     across a model call; each tool opens its own).
 *  4. Offer only the tools the actor may use; call the model gateway (step limit, output limit, timeout, abort).
 *  5. Stream coalesced text deltas and tool names to the turn's Redis stream; watch the cancel flag, the lease, the
 *     per-turn token ceiling and the timeout.
 *  6. FINALISE exactly once (compare-and-set on status + lease token): bounded content, tool metadata, token counts,
 *     `ai_usage_daily`, audit — in one transaction; then reconcile the budget reservation, release the org slot and
 *     publish `done`.
 */
@Injectable()
export class AiTurnRunnerService {
  private readonly logger = new Logger('AiTurnRunner');
  private readonly inflight = new Map<string, (reason: AbortReason) => void>();
  private readonly ledgers = new Map<string, CostLedger>();

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
  ) {}

  /** Graceful Worker shutdown: every in-flight turn is aborted and finalised as AI_WORKER_INTERRUPTED. */
  abortAll(): number {
    for (const abort of this.inflight.values()) abort('shutdown');
    return this.inflight.size;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  async run(job: AiTurnJobData): Promise<AiTurnOutcome> {
    if (job?.v !== 1 || !job.turnId || !job.conversationId || !job.organisationId || !job.workspaceId || !job.userId) return 'skipped';
    const ctx: AuthContext = { organisationId: job.organisationId, workspaceId: job.workspaceId, userId: job.userId, role: '' };
    const claimed = await this.claim(ctx, job);
    if (claimed === 'skipped' || claimed === 'failed') return claimed;
    return this.execute(ctx, job, claimed);
  }

  private async claim(ctx: AuthContext, job: AiTurnJobData): Promise<ClaimedTurn | 'skipped' | 'failed'> {
    const leaseToken = randomUUID();
    const result = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [row] = await m.query<TurnRow[]>(
        `SELECT id, status, session_id, reserved_tokens, request_message_id, lease_expires_at, created_at
           FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' FOR UPDATE`,
        [job.turnId, job.conversationId],
      );
      if (!row) return { kind: 'skipped' as const };
      if (row.status === AiTurnStatus.RUNNING) {
        if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) return { kind: 'skipped' as const };
        // The Worker that held this turn died (lease expired): end it, never re-run the model.
        assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.RUNNING, AiTurnStatus.FAILED);
        const [updated] = await m.query(
          `UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING id`,
          [row.id, AiErrorCode.WORKER_INTERRUPTED],
        );
        if (!updated) return { kind: 'skipped' as const };
        await this.recordTerminal(m, ctx, job, row.created_at, 'failed', AiErrorCode.WORKER_INTERRUPTED, { inputTokens: 0, outputTokens: 0, calls: [] });
        return { kind: 'interrupted' as const, row };
      }
      if (row.status !== AiTurnStatus.QUEUED) return { kind: 'skipped' as const };
      assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.RUNNING);
      await m.query(
        `UPDATE core.ai_message SET status = 'running', lease_token = $2, lease_expires_at = now() + ($3 || ' milliseconds')::interval,
                started_at = now(), model = $4, updated_at = now()
          WHERE id = $1 AND status = 'queued'`,
        [row.id, leaseToken, String(AI_TURN_LEASE_MS), this.config.model],
      );
      return { kind: 'claimed' as const, row };
    });
    if (result.kind === 'skipped') return 'skipped';
    if (result.kind === 'interrupted') {
      // The reservation stays charged (the dead attempt may have consumed tokens); the slot and stream are closed.
      await this.quota.releaseSlot(job.organisationId, job.turnId);
      await this.streams.publishQuietly(job.turnId, { type: 'done', turnId: job.turnId, status: 'failed', errorCode: AiErrorCode.WORKER_INTERRUPTED, content: '' });
      return 'failed';
    }
    return {
      id: result.row.id,
      conversationId: job.conversationId,
      requestMessageId: result.row.request_message_id,
      sessionId: result.row.session_id,
      reservedTokens: Number(result.row.reserved_tokens),
      createdAt: new Date(result.row.created_at),
      leaseToken,
    };
  }

  private async execute(ctx: AuthContext, job: AiTurnJobData, turn: ClaimedTurn): Promise<AiTurnOutcome> {
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
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let modelError = false;
    const ledger: CostLedger = { model: null, day: utcDay(turn.createdAt), settledMicros: 0, open: [] };
    this.ledgers.set(turn.id, ledger);

    try {
      await this.streams.publishQuietly(turn.id, { type: 'status', turnId: turn.id, status: 'running' });
      let actor: AiActor;
      try {
        actor = await this.access.rebuildForWorker({ organisationId: job.organisationId, workspaceId: job.workspaceId, userId: job.userId, sessionId: turn.sessionId });
      } catch (error) {
        const reason = error instanceof AiAccessRevokedError ? error.reason : 'unknown';
        await this.auditQuietly(ctx, AuditAction.AI_TURN_REFUSED, turn.id, { conversationId: turn.conversationId, reason, stage: 'worker_start' });
        // A misconfigured platform or a real provider this organisation may not use is "temporarily unavailable" (fixed
        // safe message), not "your access was revoked". Nothing was sent to any model.
        const code = reason === PLATFORM_NOT_READY || reason === REAL_PROVIDER_NOT_PERMITTED ? AiErrorCode.SERVICE_UNAVAILABLE : AiErrorCode.ACCESS_REVOKED;
        return await this.finalise(ctx, job, turn, 'failed', code, '', calls, 0, 0);
      }
      if (!(await this.quota.refreshSlot(job.organisationId, turn.id).catch(() => false))) {
        // The slot expired while the job waited (or Redis is unavailable): do not run beyond the organisation's cap.
        return await this.finalise(ctx, job, turn, 'failed', AiErrorCode.SERVICE_UNAVAILABLE, '', calls, 0, 0);
      }

      const entry = this.config.modelEntry;
      ledger.model = entry;
      const { messages: history, rawUserTexts } = await this.loadHistory(ctx, turn, { maskUserInput: !entry || isRealProvider(entry) });
      const run: AiToolRunContext = { actor, turnId: turn.id, conversationId: turn.conversationId, abortTurn: () => abort('access_revoked'), calls };
      const tools = this.registry.buildToolSet(run);
      const offered = new Set(Object.keys(tools));
      const ceiling = turn.reservedTokens > 0 ? turn.reservedTokens : this.config.turnTokenReservation;

      timers.push(setTimeout(() => abort('timeout'), this.config.turnTimeoutMs));
      timers.push(setInterval(() => {
        void this.streams.isCancelRequested(turn.id).then((yes) => yes && abort('cancel'));
      }, AI_CANCEL_POLL_MS));
      timers.push(setInterval(() => {
        void this.renewLease(ctx, turn).then((state) => {
          if (state === 'cancel') abort('cancel');
          if (state === 'lost') abort('shutdown');
        }).catch(() => undefined);
        void this.quota.refreshSlot(job.organisationId, turn.id).catch(() => undefined);
        // A long model call (no tool in between) is re-authorised too: session, account, organisation, ai.use, switches.
        void this.access.assertStillAllowed(actor).catch((error) => {
          if (error instanceof AiAccessRevokedError) abort('access_revoked');
        });
      }, AI_TURN_LEASE_RENEW_MS));

      let buffer = '';
      let lastFlush = Date.now();
      const flush = async (force = false) => {
        if (!buffer || (!force && buffer.length < AI_STREAM_FLUSH_CHARS && Date.now() - lastFlush < AI_STREAM_FLUSH_MS)) return;
        const text = buffer;
        buffer = '';
        lastFlush = Date.now();
        await this.streams.publishQuietly(turn.id, { type: 'delta', turnId: turn.id, text });
      };
      // Text that arrives just before a long pause (e.g. a slow model) is still delivered promptly.
      timers.push(setInterval(() => void flush(true), AI_STREAM_FLUSH_MS));

      try {
        let refusalAudited = false;
      const onRefused = (error: AiStepRefusedError) => {
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
            const result = await this.access.syntheticCheckForRealRequest(actor);
            if (result !== 'ok') {
              const refusal = new AiStepRefusedError('content_refused', [result]);
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
            case 'tool-call':
              await flush(true);
              if (!offered.has(part.toolName)) await this.registry.recordUnknownToolCall(run, part.toolName);
              await this.streams.publishQuietly(turn.id, { type: 'tool', turnId: turn.id, name: offered.has(part.toolName) ? part.toolName : 'unavailable_tool', phase: 'started' });
              break;
            case 'tool-result':
              await this.streams.publishQuietly(turn.id, { type: 'tool', turnId: turn.id, name: part.toolName, phase: 'finished', outcome: 'ok' });
              break;
            case 'tool-error':
              // The SDK refused the call before `execute` (unknown tool, schema violation) or `execute` threw.
              if (offered.has(part.toolName) && !calls.some((c) => c.name === part.toolName)) calls.push({ name: part.toolName, outcome: 'invalid_input', rows: null });
              await this.streams.publishQuietly(turn.id, { type: 'tool', turnId: turn.id, name: offered.has(part.toolName) ? part.toolName : 'unavailable_tool', phase: 'finished', outcome: 'error' });
              break;
            case 'finish-step':
              inputTokens += part.usage.inputTokens ?? 0;
              outputTokens += part.usage.outputTokens ?? 0;
              await this.settleStep(job.organisationId, ledger, part.usage.inputTokens ?? 0, part.usage.outputTokens ?? 0);
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

      const reason = abortReason as AbortReason | null;
      if (reason === 'cancel') return await this.finalise(ctx, job, turn, 'cancelled', null, content, calls, inputTokens, outputTokens);
      if (reason) {
        const code: AiErrorCodeType =
          reason === 'timeout' ? AiErrorCode.MODEL_TIMEOUT
            : reason === 'token_limit' ? AiErrorCode.TURN_TOKEN_LIMIT
              : reason === 'access_revoked' ? AiErrorCode.ACCESS_REVOKED
                : reason === 'budget' ? AiErrorCode.BUDGET_EXHAUSTED
                  : reason === 'meter_unavailable' || reason === 'content_refused' ? AiErrorCode.SERVICE_UNAVAILABLE
                    : AiErrorCode.WORKER_INTERRUPTED;
        return await this.finalise(ctx, job, turn, 'failed', code, content, calls, inputTokens, outputTokens);
      }
      if (modelError || !content) return await this.finalise(ctx, job, turn, 'failed', AiErrorCode.MODEL_ERROR, content, calls, inputTokens, outputTokens);
      return await this.finalise(ctx, job, turn, 'completed', null, content, calls, inputTokens, outputTokens);
    } catch (error) {
      this.logger.error(`turn ${turn.id} failed internally (${(error as Error)?.name ?? 'Error'})`);
      return await this.finalise(ctx, job, turn, 'failed', AiErrorCode.INTERNAL, content, calls, inputTokens, outputTokens).catch(() => 'failed' as const);
    } finally {
      for (const t of timers) clearTimeout(t);
      this.inflight.delete(turn.id);
      this.ledgers.delete(turn.id);
    }
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

  /** After a step: its actual estimated cost joins the turn total and the reservation is settled (actual − reserved). */
  private async settleStep(organisationId: string, ledger: CostLedger, inputTokens: number, outputTokens: number): Promise<void> {
    const reserved = ledger.open.shift() ?? 0;
    const actual = ledger.model ? stepCostUsdMicros(ledger.model, inputTokens, outputTokens) : 0;
    ledger.settledMicros += actual;
    if (actual !== reserved) await this.costMeter.settle(organisationId, ledger.day, actual - reserved);
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
      const [row] = await m.query<Array<{ cancel: boolean }>>(
        `UPDATE core.ai_message SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
          WHERE id = $1 AND status = 'running' AND lease_token = $2
          RETURNING cancel_requested_at IS NOT NULL AS cancel`,
        [turn.id, turn.leaseToken, String(AI_TURN_LEASE_MS)],
      );
      if (!row) return 'lost';
      return row.cancel ? 'cancel' : 'ok';
    });
  }

  private async finalise(
    ctx: AuthContext,
    job: AiTurnJobData,
    turn: ClaimedTurn,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: AiErrorCodeType | null,
    content: string,
    calls: AiToolCallSummary[],
    inputTokens: number,
    outputTokens: number,
  ): Promise<AiTurnOutcome> {
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.RUNNING, status);
    const bounded = content.slice(0, AI_MAX_STORED_CONTENT_CHARS);
    const summaries = calls.slice(0, MAX_TOOL_CALL_SUMMARIES);
    const outcome = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [updated] = await m.query(
        `UPDATE core.ai_message SET status = $3, error_code = $4, content = $5, tool_calls = $6::jsonb, input_tokens = $7, output_tokens = $8,
                completed_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'running' AND lease_token = $2 RETURNING id`,
        [turn.id, turn.leaseToken, status, errorCode, bounded, JSON.stringify(summaries), inputTokens, outputTokens],
      );
      if (!updated) {
        const [exists] = await m.query(`SELECT 1 FROM core.ai_message WHERE id = $1`, [turn.id]);
        return exists ? 'lost' : 'missing';
      }
      await m.query(`UPDATE core.ai_conversation SET last_message_at = now(), updated_at = now() WHERE id = $1`, [turn.conversationId]);
      await this.recordTerminal(m, ctx, job, turn.createdAt, status, errorCode, { inputTokens, outputTokens, calls: summaries });
      return 'finalised';
    });
    if (outcome === 'lost') return 'skipped'; // another actor (lease expiry) already finalised and released it
    // Exactly once (tied to the terminal transition above, or the turn was deleted with its conversation).
    await this.quota.adjustBudget(job.organisationId, utcDay(turn.createdAt), inputTokens + outputTokens - turn.reservedTokens);
    await this.quota.releaseSlot(job.organisationId, turn.id);
    await this.streams.clearCancel(turn.id);
    await this.streams.publishQuietly(turn.id, { type: 'done', turnId: turn.id, status, errorCode, content: outcome === 'missing' ? '' : bounded });
    return status;
  }

  /** Usage counters + audit for a terminal turn, inside the transition's transaction. Metadata only. */
  private async recordTerminal(
    m: EntityManager,
    ctx: AuthContext,
    job: AiTurnJobData,
    createdAt: Date,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: AiErrorCodeType | null,
    usage: { inputTokens: number; outputTokens: number; calls: AiToolCallSummary[] },
  ): Promise<void> {
    const ledger = this.ledgers.get(job.turnId);
    await this.usage.recordTurn(m, job.organisationId, utcDay(createdAt), {
      model: ledger?.model?.id ?? (this.config.model || 'unknown'),
      // Settled steps only. A step that never reported usage (aborted mid-call) stays charged at its worst case in the
      // Redis meter, which therefore only ever over-states what is persisted here.
      costUsdMicros: ledger?.settledMicros ?? 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      outcome: status,
      toolCalls: usage.calls.filter((c) => c.outcome === 'ok').length,
    });
    const action = status === 'completed' ? AuditAction.AI_TURN_COMPLETED : status === 'cancelled' ? AuditAction.AI_TURN_CANCELLED : AuditAction.AI_TURN_FAILED;
    await this.audit.record(m, ctx, action, {
      entityType: 'ai_turn',
      entityId: job.turnId,
      metadata: {
        conversationId: job.conversationId,
        errorCode,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        tools: usage.calls.map((c) => `${c.name}:${c.outcome}`),
        model: this.config.model,
      },
    });
  }

  private async auditQuietly(ctx: AuthContext, action: typeof AuditAction.AI_TURN_REFUSED, turnId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (m) => this.audit.record(m, ctx, action, { entityType: 'ai_turn', entityId: turnId, metadata })).catch(() => undefined);
  }
}
