import { randomUUID } from 'node:crypto';

import { AiErrorCode } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_MAX_MESSAGES_PER_CONVERSATION } from '../constants/ai.constants';
import { AiAccessService } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiCostMeterService } from './ai-cost-meter.service';
import { AiQuotaService, utcDay } from './ai-quota.service';
import { AiStreamService } from './ai-stream.service';
import { AiTurnQueueService } from './ai-turn-queue.service';
import { AiUsageService } from './ai-usage.service';

/** Why no continuation was started (metadata for the audit row only; the decision itself always stands). */
type NoContinuationReason = 'not_available' | 'not_latest' | 'limited' | 'failed';

/**
 * AI 5b: the CONTINUATION turn after a person decided an AI write proposal (p5 DOC-DRAFTS §5, migration
 * AiTurnContinuation1786721020000). A continuation is a NEW queued assistant turn that continues the paused turn; its
 * history carries ONLY a server-written tool result for the decided proposal (built by the Worker from the proposal row:
 * proposal id, status, result code, result entity id — never a note body or an argument value).
 *
 * It is started only when every gate a question needs still holds for the decider (AI on, eligible, a model resolves:
 * `assertAvailableLevel`, then `assertAvailableTx` inside the insert) and the paused turn is still the conversation's LAST
 * message. It passes the same per-user rate limit, the organisation's slot and the daily token reservation as a question.
 * Any refusal leaves NO continuation (the decision is already committed and stands); it is never retried silently.
 * At most one continuation per proposal (unique `ai_message_one_continuation`).
 */
@Injectable()
export class AiContinuationService {
  private readonly logger = new Logger(AiContinuationService.name);

  constructor(
    private readonly access: AiAccessService,
    private readonly config: AiConfigService,
    private readonly quota: AiQuotaService,
    private readonly usage: AiUsageService,
    private readonly costMeter: AiCostMeterService,
    private readonly queue: AiTurnQueueService,
    private readonly streams: AiStreamService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Returns the continuation turn id, or null when none was started (see the class comment). Never throws. */
  async startAfterDecision(ctx: AuthContext, ref: { proposalId: string; conversationId: string; pausedTurnId: string }): Promise<string | null> {
    try {
      return await this.start(ctx, ref);
    } catch (error) {
      this.logger.warn(`no continuation for proposal ${ref.proposalId} (${(error as Error)?.name ?? 'Error'})`);
      await this.note(ctx, ref, 'failed');
      return null;
    }
  }

  private async start(ctx: AuthContext, ref: { proposalId: string; conversationId: string; pausedTurnId: string }): Promise<string | null> {
    let resolved: Awaited<ReturnType<AiAccessService['assertAvailableLevel']>>;
    try {
      resolved = await this.access.assertAvailableLevel(ctx);
    } catch {
      await this.note(ctx, ref, 'not_available');
      return null;
    }
    const orgId = ctx.organisationId!;
    const latest = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [last] = await m.query<Array<{ id: string; role: string; status: string | null }>>(
        `SELECT id, role, status FROM core.ai_message WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 1`,
        [ref.conversationId],
      );
      return !!last && last.id === ref.pausedTurnId && last.role === 'assistant' && last.status === 'completed';
    });
    if (!latest) {
      await this.note(ctx, ref, 'not_latest');
      return null;
    }

    const turnId = randomUUID();
    const day = utcDay();
    const reservation = this.config.turnTokenReservationFor(this.config.levelOutputTokens(resolved.model, resolved.level.maxOutputTokens));
    let slotAcquired = false;
    let reserved = false;
    try {
      await this.quota.consumeUserRate(ctx.userId);
      slotAcquired = (await this.quota.acquireSlot(orgId, ref.conversationId)) === 'acquired';
      const seed = (await this.quota.budgetKeyExists(orgId, day)) ? null : await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayTokens(m, orgId, day));
      await this.quota.reserveBudget(orgId, day, reservation, seed);
      reserved = true;
      if (resolved.model.price.inputUsdMicrosPerMTok > 0 || resolved.model.price.outputUsdMicrosPerMTok > 0) {
        const spent = await this.costMeter.current(orgId, day);
        const persisted = spent === null ? await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayCostMicros(m, orgId, day)) : spent;
        if (persisted >= this.config.dailyBudgetUsdMicros) throw new ContinuationLimited();
      }
      await this.tenantContext.runInTenantContext(ctx, async (m) => {
        const model = await this.access.assertAvailableTx(m, ctx);
        const [conversation] = await m.query<Array<{ message_count: number }>>(`SELECT message_count FROM core.ai_conversation WHERE id = $1 FOR UPDATE`, [ref.conversationId]);
        if (!conversation || Number(conversation.message_count) + 1 > AI_MAX_MESSAGES_PER_CONVERSATION) throw new ContinuationLimited();
        await m.query(
          `INSERT INTO core.ai_message (id, organisation_id, workspace_id, user_id, conversation_id, seq, role, status, continues_turn_id, continuation_ref, reserved_tokens, session_id, model)
           VALUES ($1, $2, $3, $4, $5, $6, 'assistant', 'queued', $7, $8, $9, $10, $11)`,
          [turnId, orgId, ctx.workspaceId, ctx.userId, ref.conversationId, Number(conversation.message_count) + 1, ref.pausedTurnId, ref.proposalId, reservation, ctx.sessionId, model.id],
        );
        await m.query(`UPDATE core.ai_conversation SET message_count = message_count + 1, last_message_at = now(), updated_at = now() WHERE id = $1`, [ref.conversationId]);
        await this.audit.record(m, ctx, AuditAction.AI_TURN_STARTED, {
          entityType: 'ai_turn',
          entityId: turnId,
          metadata: { conversationId: ref.conversationId, reservedTokens: reservation, inputChars: 0, continuation: true, continuesTurnId: ref.pausedTurnId, proposalId: ref.proposalId },
        });
      });
      const ids = { turnId, conversationId: ref.conversationId, organisationId: orgId, workspaceId: ctx.workspaceId!, userId: ctx.userId };
      try {
        await this.queue.enqueueResume(ids, { pausedTurnId: ref.pausedTurnId, cause: 'proposal_decided', refId: ref.proposalId });
      } catch {
        await this.failQueued(ctx, turnId);
        throw new ContinuationLimited();
      }
      await this.streams.publishQuietly(ref.conversationId, turnId, { type: 'status', turnId, status: 'queued' });
      return turnId;
    } catch (error) {
      if (reserved) await this.quota.adjustBudget(orgId, day, -reservation).catch(() => undefined);
      if (slotAcquired) await this.releaseSlotIfIdle(ctx, ref.conversationId);
      await this.note(ctx, ref, error instanceof ContinuationLimited ? 'limited' : 'failed');
      return null;
    }
  }

  /** The queued continuation could not be enqueued: fail it (no model call ever happens for it). */
  private async failQueued(ctx: AuthContext, turnId: string): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, (m) =>
        m.query(`UPDATE core.ai_message SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued'`, [turnId, AiErrorCode.SERVICE_UNAVAILABLE]),
      )
      .catch(() => undefined);
  }

  private async releaseSlotIfIdle(ctx: AuthContext, conversationId: string): Promise<void> {
    const busy = await this.tenantContext
      .runInTenantContext(ctx, (m) => m.query(`SELECT 1 FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('queued', 'running') LIMIT 1`, [conversationId]))
      .then((rows: unknown[]) => rows.length > 0)
      .catch(() => true);
    if (!busy) await this.quota.releaseSlot(ctx.organisationId!, conversationId).catch(() => undefined);
  }

  /** Metadata-only audit of a decision that started no continuation (never a note body or argument). Best effort. */
  private async note(ctx: AuthContext, ref: { proposalId: string; conversationId: string; pausedTurnId: string }, reason: NoContinuationReason): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, (m) =>
        this.audit.record(m, ctx, AuditAction.AI_TURN_REFUSED, {
          entityType: 'ai_turn',
          entityId: ref.pausedTurnId,
          metadata: { conversationId: ref.conversationId, reason: `continuation_${reason}`, stage: 'continuation', proposalId: ref.proposalId },
        }),
      )
      .catch(() => undefined);
  }
}

class ContinuationLimited extends Error {}
