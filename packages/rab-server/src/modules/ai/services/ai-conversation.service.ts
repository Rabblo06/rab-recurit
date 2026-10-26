import { randomUUID } from 'node:crypto';

import {
  AI_RESIDENCY_STATE_MESSAGE,
  AI_STATE_MESSAGE,
  AI_TURN_TRANSITIONS,
  AiErrorCode,
  AiMessagePart,
  AiModelEffort,
  AiModelLevel,
  AiSubmitResult,
  AiToolCallSummaryV2,
  AiTurnStatus,
  AiUnavailableReason,
  assertTransition,
} from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_LIST_DEFAULT_LIMIT, AI_LIST_MAX_LIMIT, AI_MAX_MESSAGES_PER_CONVERSATION, AI_MAX_TITLE_CHARS } from '../constants/ai.constants';
import { CreateAiConversationDto } from '../dto/create-ai-conversation.dto';
import { ListAiConversationsDto } from '../dto/list-ai-conversations.dto';
import { PostAiMessageDto } from '../dto/post-ai-message.dto';
import {
  AiConflictException,
  AiInputTooLongException,
  AiQuotaUnavailableError,
  AiRecordNotFoundException,
  AiServiceUnavailableException,
  AiTooManyRequestsException,
} from '../exceptions/ai.exceptions';
import { AiAccessService } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiCostMeterService } from './ai-cost-meter.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiModelSettingsService } from './ai-model-settings.service';
import { returningRows } from './ai-query-rows';
import { AiQuotaService, utcDay } from './ai-quota.service';
import { AiStreamService } from './ai-stream.service';
import { AiTurnQueueService } from './ai-turn-queue.service';
import { AiUsageService } from './ai-usage.service';

export type { AiSubmitResult } from '@rab/shared';

export interface AiConversationView {
  id: string;
  title: string | null;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface AiMessageView {
  id: string;
  role: 'user' | 'assistant';
  status: 'sent' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** For a running turn: its last 2 s checkpoint (Phase 2); for an interrupted one: the partial answer that was kept. */
  content: string;
  errorCode: string | null;
  toolCalls: AiToolCallSummaryV2[];
  /** Phase 2: an assistant turn's text and tool steps in order, derived from `content` + `toolCalls[].offset`. */
  parts: AiMessagePart[];
  createdAt: string;
  completedAt: string | null;
  /** C1 (CD-1 / CD-7): assistant turns only (null for a user message and for rows older than the level migration). */
  level: AiModelLevel | null;
  effort: AiModelEffort | null;
  reasoningMs: number | null;
}

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function toConversation(r: Record<string, unknown>): AiConversationView {
  return { id: r.id as string, title: (r.title as string) ?? null, messageCount: Number(r.message_count), lastMessageAt: iso(r.last_message_at), createdAt: iso(r.created_at) };
}

/**
 * Text and tool parts of an assistant turn, in order (AiMessagePart `text` / `tool`): each tool summary sits at its
 * `offset` into `content` (clamped); an absent offset means 0 (the runner omits it for a call before any text). Pure.
 */
export function buildMessageParts(content: string, toolCalls: readonly AiToolCallSummaryV2[]): AiMessagePart[] {
  const tools = toolCalls
    .map((c, i) => ({ c, i, at: typeof c.offset === 'number' && Number.isFinite(c.offset) ? Math.max(0, Math.min(content.length, Math.trunc(c.offset))) : 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const parts: AiMessagePart[] = [];
  let cursor = 0;
  for (const { c, at } of tools) {
    if (at > cursor) parts.push({ kind: 'text', text: content.slice(cursor, at) });
    cursor = Math.max(cursor, at);
    parts.push({ kind: 'tool', name: c.name, outcome: c.outcome, rows: c.rows ?? null, offset: at });
  }
  if (cursor < content.length) parts.push({ kind: 'text', text: content.slice(cursor) });
  return parts;
}

export function encodeAiCursor(lastMessageAt: string, id: string): string {
  return Buffer.from(`${lastMessageAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeAiCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at: new Date(at), id };
}

function secondsToUtcMidnight(now: Date = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error as QueryFailedError & { code?: string }).code === '23505';
}

interface CancelledQueued {
  turnId: string;
  refund: number;
  day: string;
}

/**
 * AI conversations and questions (API side). Every method re-checks AI availability itself (layer 2 — a guard is never
 * the only check) and runs under the caller's tenant context, so RLS adds the owner predicate (organisation AND
 * workspace AND user) on every row; an id belonging to anyone else is a 404 indistinguishable from "does not exist".
 * Bodies never accept an organisation, workspace, user, status or role (forbidNonWhitelisted DTOs).
 *
 * Phase 2 (docs/ai/PHASE2_TWENTY_PLAN.md §2.1): a second question while a turn RUNS is queued behind it (one queued turn
 * per conversation, enforced by the database's one-running / one-queued indexes); a third is 409 AI_TURN_IN_PROGRESS.
 * The per-organisation slot belongs to the CONVERSATION (P2-D10), so running + queued hold one slot. Stop cancels the
 * queued successor too (P2-D7). The conversation's first question enqueues the title job (P2-C9).
 */
@Injectable()
export class AiConversationService {
  private readonly logger = new Logger('AiConversation');

  constructor(
    private readonly access: AiAccessService,
    private readonly config: AiConfigService,
    private readonly quota: AiQuotaService,
    private readonly queue: AiTurnQueueService,
    private readonly streams: AiStreamService,
    private readonly usage: AiUsageService,
    private readonly costMeter: AiCostMeterService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly env: EnvironmentService,
    private readonly assistant: AiAssistantService,
    private readonly modelSettings: AiModelSettingsService,
  ) {}

  /** AI_TITLE_GENERATION (default true, P2-D8): whether a conversation's first question enqueues a title job. */
  private get titleGeneration(): boolean {
    return this.env.get('AI_TITLE_GENERATION') === true;
  }

  /**
   * For `GET /ai/availability` (always 200, D9): the caller's own state, limits and today's usage. The reason is disclosed
   * in the §6 order only: `not_configured` (+ `setup` and its fixed text) and `demo_data_only` (+ its fixed text) reach a
   * caller who passed every earlier gate; nobody learns which key, model or environment rule is missing.
   */
  async availability(ctx: AuthContext) {
    const state = await this.access.evaluate(ctx);
    const limits = { maxInputChars: this.config.maxInputChars, userRatePerMinute: this.config.userRatePerMinute, orgDailyTokenBudget: this.config.orgDailyTokenBudget };
    if (!state.available) {
      if (state.reason === AiUnavailableReason.NOT_CONFIGURED) {
        const message =
          state.setup === 'provider' ? AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER : state.setup === 'residency' ? AI_RESIDENCY_STATE_MESSAGE : AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL;
        return { available: false as const, reason: state.reason, setup: state.setup, message, limits, usage: null, levels: null, assistant: null };
      }
      if (state.reason === AiUnavailableReason.DEMO_DATA_ONLY) return { available: false as const, reason: state.reason, message: AI_STATE_MESSAGE.DEMO_DATA_ONLY, limits, usage: null, levels: null, assistant: null };
      return { available: false as const, reason: state.reason, limits, usage: null, levels: null, assistant: null };
    }
    const day = utcDay();
    const used = await this.quota.currentBudgetUse(ctx.organisationId!, day).catch(() => null);
    return {
      available: true as const,
      reason: null,
      limits,
      usage: { day, tokensUsedOrReserved: used ?? 0 },
      model: { id: state.model.id, label: state.model.label, tier: state.model.tier, source: state.source },
      // C1 / CD-1 + CD-3: the composer's level picker and the assistant's name/avatar (presentation only: never sent to
      // a model), read under the caller's own tenant context so the chat needs no extra fetch.
      ...(await this.tenantContext.runInTenantContext({ ...ctx, role: '' }, async (m) => ({
        levels: await this.modelSettings.availabilityLevels(m, ctx.organisationId!, state.synthetic),
        assistant: await this.assistant.profileTx(m, ctx.organisationId!),
      }))),
    };
  }

  async create(ctx: AuthContext, dto: CreateAiConversationDto): Promise<AiConversationView> {
    await this.access.assertAvailable(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.access.assertAvailableTx(m, ctx);
      const title = dto.title?.trim().slice(0, AI_MAX_TITLE_CHARS) || null;
      // A title the user typed is never regenerated (`user`); otherwise the model may write one later (`auto`).
      const [row] = await m.query(
        `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id, title, title_source) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, message_count, last_message_at, created_at`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId, title, title ? 'user' : 'auto'],
      );
      await this.audit.record(m, ctx, AuditAction.AI_CONVERSATION_CREATED, { entityType: 'ai_conversation', entityId: row.id });
      return toConversation(row);
    });
  }

  async list(ctx: AuthContext, dto: ListAiConversationsDto): Promise<{ data: AiConversationView[]; nextCursor: string | null }> {
    await this.access.assertAvailable(ctx);
    const limit = Math.min(dto.limit ?? AI_LIST_DEFAULT_LIMIT, AI_LIST_MAX_LIMIT);
    const cursor = decodeAiCursor(dto.cursor);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      // Explicit owner predicate (layer 3) on top of the RLS policy (layer 4).
      const params: unknown[] = [ctx.organisationId, ctx.workspaceId, ctx.userId, limit + 1];
      let where = `organisation_id = $1 AND workspace_id = $2 AND user_id = $3`;
      if (cursor) {
        params.push(cursor.at, cursor.id);
        where += ` AND (last_message_at, id) < ($5, $6)`;
      }
      const rows = await m.query(
        `SELECT id, title, message_count, last_message_at, created_at FROM core.ai_conversation WHERE ${where}
          ORDER BY last_message_at DESC, id DESC LIMIT $4`,
        params,
      );
      const page = rows.slice(0, limit).map(toConversation);
      const last = page[page.length - 1];
      return { data: page, nextCursor: rows.length > limit && last ? encodeAiCursor(last.lastMessageAt, last.id) : null };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<{ conversation: AiConversationView; messages: AiMessageView[] }> {
    await this.access.assertAvailable(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      const conversation = await this.ownConversation(m, ctx, id);
      const rows = await m.query(
        `SELECT id, role, status, content, error_code, tool_calls, created_at, completed_at, level, effort, reasoning_ms FROM core.ai_message
          WHERE conversation_id = $1 AND organisation_id = $2 AND user_id = $3 ORDER BY seq`,
        [id, ctx.organisationId, ctx.userId],
      );
      return {
        conversation: toConversation(conversation),
        messages: rows.map((r: Record<string, unknown>) => {
          const role = r.role as 'user' | 'assistant';
          const content = r.content as string;
          const toolCalls = (r.tool_calls as AiToolCallSummaryV2[]) ?? [];
          return {
            id: r.id as string,
            role,
            // A user message carries no state in the database (NULL); the API reports it as `sent`.
            status: (r.status ?? 'sent') as AiMessageView['status'],
            content,
            errorCode: (r.error_code as string) ?? null,
            toolCalls,
            parts: role === 'assistant' ? buildMessageParts(content, toolCalls) : [],
            createdAt: iso(r.created_at),
            completedAt: isoOrNull(r.completed_at),
            level: role === 'assistant' ? ((r.level as AiModelLevel | null) ?? null) : null,
            effort: role === 'assistant' ? ((r.effort as AiModelEffort | null) ?? null) : null,
            reasoningMs: role === 'assistant' && r.reasoning_ms !== null && r.reasoning_ms !== undefined ? Number(r.reasoning_ms) : null,
          };
        }),
      };
    });
  }

  /**
   * The owner deletes a conversation (and, by cascade, its messages). Allowed whatever the AI switches say: erasing one's
   * own data never depends on a feature being on. Refused while inspecting (read-only). A running turn ends harmlessly:
   * its finalisation finds no row, reconciles its reservation and releases the conversation's slot.
   */
  async remove(ctx: AuthContext, id: string): Promise<void> {
    if (ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId) throw new AiRecordNotFoundException();
    const orgId = ctx.organisationId;
    const active = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.ownConversation(m, ctx, id);
      const turns = await m.query<Array<{ id: string; status: string; reserved_tokens: number; created_at: Date }>>(
        `SELECT id, status, reserved_tokens, created_at FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('queued', 'running')`,
        [id],
      );
      await m.query(`DELETE FROM core.ai_conversation WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND user_id = $4`, [id, orgId, ctx.workspaceId, ctx.userId]);
      await this.audit.record(m, ctx, AuditAction.AI_CONVERSATION_DELETED, { entityType: 'ai_conversation', entityId: id });
      return turns;
    });
    for (const t of active) {
      if (t.status === AiTurnStatus.QUEUED) {
        // Never claimed: refund the reservation (a running one is reconciled by its Worker).
        await this.quota.adjustBudget(orgId, utcDay(new Date(t.created_at)), -Number(t.reserved_tokens));
      } else {
        await this.streams.requestCancel(id, t.id).catch(() => undefined);
      }
    }
    // The conversation's slot: freed now unless a running turn still holds it (its Worker frees it when it finishes).
    if (!active.some((t) => t.status === AiTurnStatus.RUNNING)) await this.quota.releaseSlot(orgId, id);
  }

  /**
   * Submit a question. Order (each a fail-closed gate): availability → input bound → conversation ownership, replay,
   * capacity and "nothing queued yet" (a turn may RUN; then this one queues behind it) → per-user rate (429) → the
   * conversation's org slot (429 when a NEW one is needed and the org is at its cap) → per-org daily budget reservation
   * (429) → availability AGAIN inside the insert transaction (+ the insert's RLS eligibility check; the database's
   * one-queued index decides a race, 23505 → 409) → enqueue (IDs only). Any failure after a reservation releases it.
   * Redis unavailable → 503 and nothing is queued.
   */
  async submit(ctx: AuthContext, conversationId: string, dto: PostAiMessageDto): Promise<AiSubmitResult> {
    // C1 / CD-1: a level named on submit must be allowed and runnable now (409 AI_LEVEL_UNAVAILABLE, never a fallback).
    const { model: resolved, level } = await this.access.assertAvailableLevel(ctx, dto.level);
    const content = dto.content.trim();
    if (!content || content.length > this.config.maxInputChars) throw new AiInputTooLongException(this.config.maxInputChars);
    const orgId = ctx.organisationId!;

    const replay = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const conversation = await this.ownConversation(m, ctx, conversationId);
      const existing = await this.replayOf(m, conversationId, dto.clientRequestId);
      if (existing) return existing;
      if (Number(conversation.message_count) + 2 > AI_MAX_MESSAGES_PER_CONVERSATION) throw new AiConflictException(AiErrorCode.CONVERSATION_FULL);
      // At most one queued turn behind the running one (P2-D6): a turn that is already WAITING means "in progress".
      const [queued] = await m.query(`SELECT 1 FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status = 'queued'`, [conversationId]);
      if (queued) throw new AiConflictException(AiErrorCode.TURN_IN_PROGRESS);
      return null;
    });
    if (replay) return replay;

    const turnId = randomUUID();
    const day = utcDay();
    // The level's per-step output cap bounds every step, so it bounds the turn's reservation too.
    const reservation = this.config.turnTokenReservationFor(this.config.levelOutputTokens(resolved, level.maxOutputTokens));
    let slotAcquired = false;
    let reserved = false;
    try {
      await this.quota.consumeUserRate(ctx.userId);
      // The conversation's slot (P2-D10): a running predecessor already holds it (`held`), so a queued second message
      // never takes a second slot of the organisation's cap.
      slotAcquired = (await this.quota.acquireSlot(orgId, conversationId)) === 'acquired';
      const seed = (await this.quota.budgetKeyExists(orgId, day)) ? null : await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayTokens(m, orgId, day));
      await this.quota.reserveBudget(orgId, day, reservation, seed);
      reserved = true;
      // Owner decision 6: a priced model is refused at once when today's estimated-cost meter is already spent (the Worker
      // still reserves every step's worst case before each model call). Meter unavailable ⇒ 503 (fail closed).
      if (resolved.price.inputUsdMicrosPerMTok > 0 || resolved.price.outputUsdMicrosPerMTok > 0) {
        const spent = await this.costMeter.current(orgId, day);
        const persisted = spent === null ? await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayCostMicros(m, orgId, day)) : spent;
        if (persisted >= this.config.dailyBudgetUsdMicros) throw new AiTooManyRequestsException(AiErrorCode.BUDGET_EXHAUSTED, secondsToUtcMidnight());
      }

      const inserted = await this.tenantContext.runInTenantContext(ctx, async (m) => {
        // The model as resolved in THIS snapshot is stamped on the queued turn; the Worker re-resolves at start (authoritative).
        const model = await this.access.assertAvailableTx(m, ctx, dto.level);
        const conversation = await this.ownConversation(m, ctx, conversationId, true);
        const seq = Number(conversation.message_count);
        const [userMessage] = await m.query(
          `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content, client_request_id)
           VALUES ($1, $2, $3, $4, $5, 'user', $6, $7) RETURNING id`,
          [orgId, ctx.workspaceId, ctx.userId, conversationId, seq + 1, content, dto.clientRequestId ?? null],
        );
        await m.query(
          // `level` on a QUEUED turn = the level named on submit (NULL = the organisation's chat level); the Worker
          // resolves it again at start with no fallback and stamps the level and effort it actually ran at.
          `INSERT INTO core.ai_message (id, organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, reserved_tokens, session_id, model, level)
           VALUES ($1, $2, $3, $4, $5, $6, 'assistant', 'queued', $7, $8, $9, $10, $11)`,
          [turnId, orgId, ctx.workspaceId, ctx.userId, conversationId, seq + 2, userMessage.id, reservation, ctx.sessionId, model.id, dto.level ?? null],
        );
        await m.query(
          `UPDATE core.ai_conversation SET message_count = message_count + 2, last_message_at = now(), updated_at = now(), title = COALESCE(title, $2) WHERE id = $1`,
          [conversationId, content.replace(/\s+/g, ' ').slice(0, AI_MAX_TITLE_CHARS)],
        );
        await this.audit.record(m, ctx, AuditAction.AI_TURN_STARTED, {
          entityType: 'ai_turn',
          entityId: turnId,
          metadata: { conversationId, reservedTokens: reservation, inputChars: content.length, level: dto.level ?? null },
        });
        return { userMessageId: userMessage.id as string, firstQuestion: seq === 0, titleSource: conversation.title_source as string };
      });

      try {
        await this.queue.enqueue({ turnId, conversationId, organisationId: orgId, workspaceId: ctx.workspaceId!, userId: ctx.userId });
      } catch {
        await this.failQueuedTurn(ctx, turnId);
        throw new AiServiceUnavailableException();
      }
      await this.streams.publishQuietly(conversationId, turnId, { type: 'status', turnId, status: 'queued' });
      if (inserted.firstQuestion && inserted.titleSource === 'auto' && this.titleGeneration) {
        // Best effort: a title is never worth failing the question for (the first-question fallback title stays).
        await this.queue.enqueueTitle({ turnId, conversationId, organisationId: orgId, workspaceId: ctx.workspaceId!, userId: ctx.userId }).catch(() => undefined);
      }
      return { conversationId, userMessageId: inserted.userMessageId, turnId, messageId: inserted.userMessageId, streamId: turnId, status: 'queued', replayed: false };
    } catch (error) {
      if (reserved) await this.quota.adjustBudget(orgId, day, -reservation);
      if (slotAcquired) await this.releaseSlotIfIdle(ctx, conversationId);
      if (error instanceof AiQuotaUnavailableError) throw new AiServiceUnavailableException();
      if (error instanceof AiTooManyRequestsException) {
        await this.recordRefusal(ctx, conversationId, (error.getResponse() as { code: string }).code);
        throw error;
      }
      if (isUniqueViolation(error)) {
        // A concurrent submit won the race: the same client request (replay) or another question (one queued turn).
        const again = dto.clientRequestId ? await this.tenantContext.runInTenantContext(ctx, (m) => this.replayOf(m, conversationId, dto.clientRequestId)) : null;
        if (again) return again;
        throw new AiConflictException(AiErrorCode.TURN_IN_PROGRESS);
      }
      throw error;
    }
  }

  /**
   * Named cancel action (never a client-sent status). A queued turn is cancelled at once (reservation refunded); a
   * running turn gets a durable cancel request (DB) plus the fast paths (Redis flag + cancel channel hint) the Worker
   * watches, AND its queued successor is cancelled with it (P2-D7: Stop stops both); a finished turn is returned
   * unchanged (idempotent). The org slot is released only once the conversation has no queued or running turn left.
   */
  async cancel(ctx: AuthContext, conversationId: string, turnId: string): Promise<{ turnId: string; status: string }> {
    await this.access.assertAvailable(ctx);
    const result = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.ownConversation(m, ctx, conversationId);
      const [turn] = await m.query<Array<{ status: string; reserved_tokens: number; created_at: Date; model: string | null }>>(
        `SELECT status, reserved_tokens, created_at, model FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' FOR UPDATE`,
        [turnId, conversationId],
      );
      if (!turn) throw new AiRecordNotFoundException();
      const cancelled: CancelledQueued[] = [];
      let status = turn.status;
      if (turn.status === AiTurnStatus.QUEUED) {
        if (await this.cancelQueuedTx(m, ctx, conversationId, turnId, 'queued')) cancelled.push({ turnId, refund: Number(turn.reserved_tokens), day: utcDay(new Date(turn.created_at)) });
        status = 'cancelled';
      } else if (turn.status === AiTurnStatus.RUNNING) {
        await m.query(`UPDATE core.ai_message SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now() WHERE id = $1 AND status = 'running'`, [turnId]);
        const [successor] = await m.query<Array<{ id: string; reserved_tokens: number; created_at: Date }>>(
          `SELECT id, reserved_tokens, created_at FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status = 'queued' AND id <> $2 FOR UPDATE`,
          [conversationId, turnId],
        );
        if (successor && (await this.cancelQueuedTx(m, ctx, conversationId, successor.id, 'queued_successor'))) {
          cancelled.push({ turnId: successor.id, refund: Number(successor.reserved_tokens), day: utcDay(new Date(successor.created_at)) });
        }
        status = 'cancelling';
      }
      const [stillActive] = await m.query(`SELECT 1 FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('queued', 'running') LIMIT 1`, [conversationId]);
      return { status, cancelled, idle: !stillActive };
    });
    for (const c of result.cancelled) {
      await this.quota.adjustBudget(ctx.organisationId!, c.day, -c.refund);
      await this.streams.publishQuietly(conversationId, c.turnId, { type: 'done', turnId: c.turnId, status: 'cancelled', errorCode: null, content: '' });
    }
    if (result.idle && result.cancelled.length > 0) await this.quota.releaseSlot(ctx.organisationId!, conversationId);
    if (result.status === 'cancelling') await this.streams.requestCancel(conversationId, turnId).catch(() => undefined);
    return { turnId, status: result.status };
  }

  /** The caller's own conversation row, or the uniform 404. */
  async ownConversation(m: EntityManager, ctx: AuthContext, id: string, forUpdate = false): Promise<Record<string, unknown>> {
    const [row] = await m.query(
      `SELECT id, title, title_source, message_count, last_message_at, created_at FROM core.ai_conversation
        WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND user_id = $4${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, ctx.organisationId, ctx.workspaceId, ctx.userId],
    );
    if (!row) throw new AiRecordNotFoundException();
    return row;
  }

  /** queued → cancelled (compare-and-set), counted and audited in the caller's transaction. False = it was not queued. */
  private async cancelQueuedTx(m: EntityManager, ctx: AuthContext, conversationId: string, turnId: string, stage: 'queued' | 'queued_successor'): Promise<boolean> {
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.CANCELLED);
    const [row] = await returningRows<{ created_at: Date; model: string | null }>(
      m,
      `UPDATE core.ai_message SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING created_at, model`,
      [turnId],
    );
    if (!row) return false;
    await this.usage.recordTurn(m, ctx.organisationId!, utcDay(new Date(row.created_at)), { model: row.model || 'unknown', costUsdMicros: 0, inputTokens: 0, outputTokens: 0, outcome: 'cancelled', toolCalls: 0 });
    await this.audit.record(m, ctx, AuditAction.AI_TURN_CANCELLED, { entityType: 'ai_turn', entityId: turnId, metadata: { conversationId, stage } });
    return true;
  }

  /** Releases the conversation's org slot unless it still has a queued or running turn (that turn keeps it). */
  private async releaseSlotIfIdle(ctx: AuthContext, conversationId: string): Promise<void> {
    const busy = await this.tenantContext
      .runInTenantContext(ctx, (m) => m.query(`SELECT 1 FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('queued', 'running') LIMIT 1`, [conversationId]))
      .then((rows: unknown[]) => rows.length > 0)
      .catch(() => true);
    if (!busy) await this.quota.releaseSlot(ctx.organisationId!, conversationId);
  }

  private async replayOf(m: EntityManager, conversationId: string, clientRequestId: string | undefined): Promise<AiSubmitResult | null> {
    if (!clientRequestId) return null;
    const [row] = await m.query(
      `SELECT u.id AS user_message_id, a.id AS turn_id, a.status
         FROM core.ai_message u JOIN core.ai_message a ON a.request_message_id = u.id
        WHERE u.conversation_id = $1 AND u.client_request_id = $2`,
      [conversationId, clientRequestId],
    );
    return row
      ? { conversationId, userMessageId: row.user_message_id, turnId: row.turn_id, messageId: row.user_message_id, streamId: row.turn_id, status: row.status, replayed: true }
      : null;
  }

  private async failQueuedTurn(ctx: AuthContext, turnId: string): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, async (m) => {
        const [row] = await returningRows<{ created_at: Date; model: string | null }>(
          m,
          `UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING created_at, model`,
          [turnId, AiErrorCode.SERVICE_UNAVAILABLE],
        );
        if (row) {
          await this.usage.recordTurn(m, ctx.organisationId!, utcDay(new Date(row.created_at)), { model: row.model || 'unknown', costUsdMicros: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed', toolCalls: 0 });
          await this.audit.record(m, ctx, AuditAction.AI_TURN_FAILED, { entityType: 'ai_turn', entityId: turnId, metadata: { errorCode: AiErrorCode.SERVICE_UNAVAILABLE, stage: 'enqueue' } });
        }
      })
      .catch((error) => this.logger.warn(`could not mark turn ${turnId} failed after an enqueue failure (${(error as Error)?.name})`));
  }

  private async recordRefusal(ctx: AuthContext, conversationId: string, code: string): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, (m) => this.audit.record(m, ctx, AuditAction.AI_TURN_REFUSED, { entityType: 'ai_conversation', entityId: conversationId, metadata: { reason: code, stage: 'submit' } }))
      .catch(() => undefined);
  }
}
