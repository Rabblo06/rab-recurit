import { randomUUID } from 'node:crypto';

import { AI_STATE_MESSAGE, AI_TURN_TRANSITIONS, AiErrorCode, AiToolCallSummary, AiTurnStatus, AiUnavailableReason, assertTransition } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
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
import { AiQuotaService, utcDay } from './ai-quota.service';
import { AiStreamService } from './ai-stream.service';
import { AiTurnQueueService } from './ai-turn-queue.service';
import { AiUsageService } from './ai-usage.service';

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
  content: string;
  errorCode: string | null;
  toolCalls: AiToolCallSummary[];
  createdAt: string;
  completedAt: string | null;
}

export interface AiSubmitResult {
  conversationId: string;
  userMessageId: string;
  turnId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  replayed: boolean;
}

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function toConversation(r: Record<string, unknown>): AiConversationView {
  return { id: r.id as string, title: (r.title as string) ?? null, messageCount: Number(r.message_count), lastMessageAt: iso(r.last_message_at), createdAt: iso(r.created_at) };
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

/**
 * AI conversations and questions (API side). Every method re-checks AI availability itself (layer 2 — a guard is never
 * the only check) and runs under the caller's tenant context, so RLS adds the owner predicate (organisation AND
 * workspace AND user) on every row; an id belonging to anyone else is a 404 indistinguishable from "does not exist".
 * Bodies never accept an organisation, workspace, user, status or role (forbidNonWhitelisted DTOs).
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
  ) {}

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
        const message = state.setup === 'provider' ? AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER : AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL;
        return { available: false as const, reason: state.reason, setup: state.setup, message, limits, usage: null };
      }
      if (state.reason === AiUnavailableReason.DEMO_DATA_ONLY) return { available: false as const, reason: state.reason, message: AI_STATE_MESSAGE.DEMO_DATA_ONLY, limits, usage: null };
      return { available: false as const, reason: state.reason, limits, usage: null };
    }
    const day = utcDay();
    const used = await this.quota.currentBudgetUse(ctx.organisationId!, day).catch(() => null);
    return {
      available: true as const,
      reason: null,
      limits,
      usage: { day, tokensUsedOrReserved: used ?? 0 },
      model: { id: state.model.id, label: state.model.label, tier: state.model.tier, source: state.source },
    };
  }

  async create(ctx: AuthContext, dto: CreateAiConversationDto): Promise<AiConversationView> {
    await this.access.assertAvailable(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.access.assertAvailableTx(m, ctx);
      const title = dto.title?.trim().slice(0, AI_MAX_TITLE_CHARS) || null;
      const [row] = await m.query(
        `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id, title) VALUES ($1, $2, $3, $4)
         RETURNING id, title, message_count, last_message_at, created_at`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId, title],
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
        `SELECT id, role, status, content, error_code, tool_calls, created_at, completed_at FROM core.ai_message
          WHERE conversation_id = $1 AND organisation_id = $2 AND user_id = $3 ORDER BY seq`,
        [id, ctx.organisationId, ctx.userId],
      );
      return {
        conversation: toConversation(conversation),
        messages: rows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          role: r.role as 'user' | 'assistant',
          // A user message carries no state in the database (NULL); the API reports it as `sent`.
          status: (r.status ?? 'sent') as AiMessageView['status'],
          content: r.content as string,
          errorCode: (r.error_code as string) ?? null,
          toolCalls: (r.tool_calls as AiToolCallSummary[]) ?? [],
          createdAt: iso(r.created_at),
          completedAt: isoOrNull(r.completed_at),
        })),
      };
    });
  }

  /**
   * The owner deletes a conversation (and, by cascade, its messages). Allowed whatever the AI switches say: erasing one's
   * own data never depends on a feature being on. Refused while inspecting (read-only). A running turn ends harmlessly:
   * its finalisation finds no row and only reconciles its reservation.
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
        // Never claimed: refund the reservation and free the slot (a running one is reconciled by its Worker).
        await this.quota.adjustBudget(orgId, utcDay(new Date(t.created_at)), -Number(t.reserved_tokens));
        await this.quota.releaseSlot(orgId, t.id);
      } else {
        await this.streams.requestCancel(t.id).catch(() => undefined);
      }
    }
  }

  /**
   * Submit a question. Order (each a fail-closed gate): availability → input bound → conversation ownership, replay,
   * capacity and one-active-turn → per-user rate (429) → per-org active slot (429) → per-org daily budget reservation
   * (429) → availability AGAIN inside the insert transaction (+ the insert's RLS eligibility check) → enqueue (IDs only).
   * Any failure after a reservation releases it. Redis unavailable → 503 and nothing is queued.
   */
  async submit(ctx: AuthContext, conversationId: string, dto: PostAiMessageDto): Promise<AiSubmitResult> {
    const resolved = await this.access.assertAvailable(ctx);
    const content = dto.content.trim();
    if (!content || content.length > this.config.maxInputChars) throw new AiInputTooLongException(this.config.maxInputChars);
    const orgId = ctx.organisationId!;

    const replay = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const conversation = await this.ownConversation(m, ctx, conversationId);
      const existing = await this.replayOf(m, conversationId, dto.clientRequestId);
      if (existing) return existing;
      if (Number(conversation.message_count) + 2 > AI_MAX_MESSAGES_PER_CONVERSATION) throw new AiConflictException(AiErrorCode.CONVERSATION_FULL);
      const [active] = await m.query(`SELECT 1 FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('queued', 'running')`, [conversationId]);
      if (active) throw new AiConflictException(AiErrorCode.TURN_IN_PROGRESS);
      return null;
    });
    if (replay) return replay;

    const turnId = randomUUID();
    const day = utcDay();
    const reservation = this.config.turnTokenReservation;
    let slotHeld = false;
    let reserved = false;
    try {
      await this.quota.consumeUserRate(ctx.userId);
      await this.quota.acquireSlot(orgId, turnId);
      slotHeld = true;
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

      const userMessageId = await this.tenantContext.runInTenantContext(ctx, async (m) => {
        // The model as resolved in THIS snapshot is stamped on the queued turn; the Worker re-resolves at start (authoritative).
        const model = await this.access.assertAvailableTx(m, ctx);
        const conversation = await this.ownConversation(m, ctx, conversationId, true);
        const seq = Number(conversation.message_count);
        const [userMessage] = await m.query(
          `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content, client_request_id)
           VALUES ($1, $2, $3, $4, $5, 'user', $6, $7) RETURNING id`,
          [orgId, ctx.workspaceId, ctx.userId, conversationId, seq + 1, content, dto.clientRequestId ?? null],
        );
        await m.query(
          `INSERT INTO core.ai_message (id, organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, reserved_tokens, session_id, model)
           VALUES ($1, $2, $3, $4, $5, $6, 'assistant', 'queued', $7, $8, $9, $10)`,
          [turnId, orgId, ctx.workspaceId, ctx.userId, conversationId, seq + 2, userMessage.id, reservation, ctx.sessionId, model.id],
        );
        await m.query(
          `UPDATE core.ai_conversation SET message_count = message_count + 2, last_message_at = now(), updated_at = now(), title = COALESCE(title, $2) WHERE id = $1`,
          [conversationId, content.replace(/\s+/g, ' ').slice(0, AI_MAX_TITLE_CHARS)],
        );
        await this.audit.record(m, ctx, AuditAction.AI_TURN_STARTED, {
          entityType: 'ai_turn',
          entityId: turnId,
          metadata: { conversationId, reservedTokens: reservation, inputChars: content.length },
        });
        return userMessage.id as string;
      });

      try {
        await this.queue.enqueue({ turnId, conversationId, organisationId: orgId, workspaceId: ctx.workspaceId!, userId: ctx.userId });
      } catch {
        await this.failQueuedTurn(ctx, turnId);
        throw new AiServiceUnavailableException();
      }
      await this.streams.publishQuietly(turnId, { type: 'status', turnId, status: 'queued' });
      return { conversationId, userMessageId, turnId, status: 'queued', replayed: false };
    } catch (error) {
      if (reserved) await this.quota.adjustBudget(orgId, day, -reservation);
      if (slotHeld) await this.quota.releaseSlot(orgId, turnId);
      if (error instanceof AiQuotaUnavailableError) throw new AiServiceUnavailableException();
      if (error instanceof AiTooManyRequestsException) {
        await this.recordRefusal(ctx, conversationId, (error.getResponse() as { code: string }).code);
        throw error;
      }
      if (isUniqueViolation(error)) {
        // A concurrent submit won the race: the same client request (replay) or another question (one active turn).
        const again = dto.clientRequestId ? await this.tenantContext.runInTenantContext(ctx, (m) => this.replayOf(m, conversationId, dto.clientRequestId)) : null;
        if (again) return again;
        throw new AiConflictException(AiErrorCode.TURN_IN_PROGRESS);
      }
      throw error;
    }
  }

  /**
   * Named cancel action (never a client-sent status). A queued turn is cancelled at once (reservation refunded); a
   * running turn gets a durable cancel request (DB) plus a fast flag (Redis) that the Worker polls; a finished turn is
   * returned unchanged (idempotent).
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
      if (turn.status === AiTurnStatus.QUEUED) {
        assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.CANCELLED);
        await m.query(`UPDATE core.ai_message SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued'`, [turnId]);
        const day = utcDay(new Date(turn.created_at));
        await this.usage.recordTurn(m, ctx.organisationId!, day, { model: turn.model || 'unknown', costUsdMicros: 0, inputTokens: 0, outputTokens: 0, outcome: 'cancelled', toolCalls: 0 });
        await this.audit.record(m, ctx, AuditAction.AI_TURN_CANCELLED, { entityType: 'ai_turn', entityId: turnId, metadata: { conversationId, stage: 'queued' } });
        return { status: 'cancelled', refund: Number(turn.reserved_tokens), day };
      }
      if (turn.status === AiTurnStatus.RUNNING) {
        await m.query(`UPDATE core.ai_message SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now() WHERE id = $1 AND status = 'running'`, [turnId]);
        return { status: 'cancelling', refund: 0, day: '' };
      }
      return { status: turn.status, refund: 0, day: '' };
    });
    if (result.status === 'cancelled') {
      await this.quota.adjustBudget(ctx.organisationId!, result.day, -result.refund);
      await this.quota.releaseSlot(ctx.organisationId!, turnId);
      await this.streams.publishQuietly(turnId, { type: 'done', turnId, status: 'cancelled', errorCode: null, content: '' });
    } else if (result.status === 'cancelling') {
      await this.streams.requestCancel(turnId).catch(() => undefined);
    }
    return { turnId, status: result.status };
  }

  /** The caller's own conversation row, or the uniform 404. */
  async ownConversation(m: EntityManager, ctx: AuthContext, id: string, forUpdate = false): Promise<Record<string, unknown>> {
    const [row] = await m.query(
      `SELECT id, title, message_count, last_message_at, created_at FROM core.ai_conversation
        WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND user_id = $4${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, ctx.organisationId, ctx.workspaceId, ctx.userId],
    );
    if (!row) throw new AiRecordNotFoundException();
    return row;
  }

  private async replayOf(m: EntityManager, conversationId: string, clientRequestId: string | undefined): Promise<AiSubmitResult | null> {
    if (!clientRequestId) return null;
    const [row] = await m.query(
      `SELECT u.id AS user_message_id, a.id AS turn_id, a.status
         FROM core.ai_message u JOIN core.ai_message a ON a.request_message_id = u.id
        WHERE u.conversation_id = $1 AND u.client_request_id = $2`,
      [conversationId, clientRequestId],
    );
    return row ? { conversationId, userMessageId: row.user_message_id, turnId: row.turn_id, status: row.status, replayed: true } : null;
  }

  private async failQueuedTurn(ctx: AuthContext, turnId: string): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, async (m) => {
        const [row] = await m.query(
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
