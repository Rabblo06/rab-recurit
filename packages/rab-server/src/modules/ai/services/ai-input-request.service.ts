import {
  AI_INPUT_REQUEST_TRANSITIONS,
  AI_TURN_TRANSITIONS,
  AiInputAnswerRequest,
  AiInputRequestPartState,
  AiInputRequestView,
  AiProposeActionMode,
  AiTurnStatus,
  assertTransition,
} from '@rab/shared';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiProposalAccessService } from '../actions/ai-proposal-access.service';
import { AiTurnIds } from '../contracts/turn';
import { AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import { AiInputExpiredException, AiInputInvalidException, AiInputNotPendingException } from '../exceptions/ai-proposal.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiContinuationService } from './ai-continuation.service';
import { AiInputKind, AiInputSpec, parseForm, parseQuestion, specView, validateAnswer } from './ai-input-spec';
import { returningRows } from './ai-query-rows';

/** What the model sees after `ask_question` / `request_form` (fixed shape; never the user's text at this point). */
export type AiAskResult = { status: 'awaiting_user'; requestId: string } | { error: 'invalid_input'; issues: string[] } | { error: 'input_request_limit' };

interface RequestRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  tool_call_id: string;
  kind: AiInputKind;
  spec: AiInputSpec;
  state: AiInputRequestPartState;
  answer: unknown;
  expires_at: Date;
  expired: boolean;
  db_now: Date;
}

const COLUMNS = `r.id, r.conversation_id, r.turn_id, r.tool_call_id, r.kind, r.spec, r.state, r.answer, r.expires_at, (r.expires_at <= now()) AS expired, now() AS db_now`;
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LISTED = 200;

/**
 * AI Phase 5c (Batch 3 S7, docs/ai/PHASE5_TWENTY_PLAN.md §2.1) — questions and forms the assistant asks, and the user's
 * answer. NOTHING here writes domain data: an answer is stored on its own request row and only feeds a continuation turn
 * (the 5b mechanism), where the model sees it as a wrapped, untrusted tool result.
 *
 *  - `createFromTool` (Worker, `ask_question` / `request_form`): interactive turns only (an agent or triggered run can
 *    never ask — refused here as well as never offered); strict parse + sanitising + the personal-data refusal
 *    (ai-input-spec.ts); the turn must be RUNNING and have no proposal; ONE request per turn (UNIQUE turn_id), idempotent
 *    per tool call; inserted as the turn's user under RLS (owner + eligibility). The runner then pauses the turn.
 *  - `list` / `answer` (API, `AiDecidableGuard` → the same uniform 404 as the proposal routes; layer 2 re-checks here and
 *    again inside the transaction): owner RLS (someone else's request is a 404), lazy expiry, the answer validated
 *    against the stored spec (400 paths only), compare-and-set awaiting_input → answered (409 when already answered,
 *    superseded or expired), the waiting turn → completed (assertTransition), audit, then the continuation (rate-exempt,
 *    still metered; none when AI is unavailable — the answer stands).
 *  - `supersedeOpenTx` / `cancelWaitingTx` (a new question, or cancelling the waiting turn): open requests → superseded.
 */
@Injectable()
export class AiInputRequestService {
  private readonly logger = new Logger(AiInputRequestService.name);

  constructor(
    private readonly access: AiProposalAccessService,
    private readonly config: AiConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    @Optional() private readonly continuation?: AiContinuationService,
  ) {}

  // ───────────────────────────────────────────────────────────── create (Worker: the pause tools)

  async createFromTool(ids: AiTurnIds, call: { toolCallId: string; kind: AiInputKind; input: unknown }, mode: AiProposeActionMode): Promise<AiAskResult> {
    // An agent / triggered run never asks a person (Phase 6 rule; agents are off anyway). Fail closed.
    if (mode !== 'interactive') throw new Error('input requests are interactive only');
    if (!TOOL_CALL_ID.test(call.toolCallId)) return { error: 'invalid_input', issues: ['toolCallId'] };
    const parsed = call.kind === 'question' ? parseQuestion(call.input) : parseForm(call.input);
    if (!parsed.ok) return { error: 'invalid_input', issues: parsed.issues };
    const ctx: AuthContext = { organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [turn] = await m.query<Array<{ status: string }>>(
        `SELECT status FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' FOR UPDATE`,
        [ids.turnId, ids.conversationId],
      );
      if (!turn || turn.status !== AiTurnStatus.RUNNING) return { error: 'input_request_limit' as const };
      const [existing] = await m.query<Array<{ id: string; tool_call_id: string }>>(`SELECT id, tool_call_id FROM core.ai_input_request WHERE turn_id = $1`, [ids.turnId]);
      if (existing) return existing.tool_call_id === call.toolCallId ? { status: 'awaiting_user' as const, requestId: existing.id } : { error: 'input_request_limit' as const };
      const [proposal] = await m.query(`SELECT 1 FROM core.ai_action_proposal WHERE turn_id = $1 LIMIT 1`, [ids.turnId]);
      if (proposal) return { error: 'input_request_limit' as const };
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.ai_input_request (organisation_id, workspace_id, user_id, conversation_id, turn_id, tool_call_id, kind, spec)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
        [ids.organisationId, ids.workspaceId, ids.userId, ids.conversationId, ids.turnId, call.toolCallId, call.kind, JSON.stringify(parsed.spec)],
      );
      const spec = parsed.spec;
      await this.audit.record(m, ctx, AuditAction.AI_INPUT_REQUESTED, {
        entityType: 'ai_input_request',
        entityId: row!.id,
        metadata: {
          conversationId: ids.conversationId,
          turnId: ids.turnId,
          kind: call.kind,
          ...('question' in spec ? { options: spec.question.options.length, allowFreeText: spec.question.allowFreeText } : { fields: spec.form.fields.length }),
        },
      });
      return { status: 'awaiting_user' as const, requestId: row!.id };
    });
  }

  // ───────────────────────────────────────────────────────────── list (API)

  async list(ctx: AuthContext, conversationId: string): Promise<AiInputRequestView[]> {
    await this.access.assertDecidable(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.access.assertDecidableTx(m, ctx);
      await this.ownConversation(m, conversationId);
      await this.expireDueTx(m, ctx, `r.conversation_id = $1`, [conversationId]);
      const rows = await m.query<RequestRow[]>(`SELECT ${COLUMNS} FROM core.ai_input_request r WHERE r.conversation_id = $1 ORDER BY r.created_at, r.id LIMIT ${MAX_LISTED}`, [conversationId]);
      return rows.map(toView);
    });
  }

  // ───────────────────────────────────────────────────────────── answer (API)

  async answer(ctx: AuthContext, conversationId: string, requestId: string, body: AiInputAnswerRequest): Promise<{ request: AiInputRequestView; continuationTurnId: string | null }> {
    await this.access.assertDecidable(ctx);
    const outcome = await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.access.assertDecidableTx(m, ctx);
      await this.ownConversation(m, conversationId);
      const [row] = await m.query<RequestRow[]>(`SELECT ${COLUMNS} FROM core.ai_input_request r WHERE r.id = $1 AND r.conversation_id = $2 FOR UPDATE`, [requestId, conversationId]);
      if (!row) throw new AiRecordNotFoundException();
      if (row.state === 'awaiting_input' && row.expired) return { kind: 'expired' as const };
      if (row.state !== 'awaiting_input') throw new AiInputNotPendingException();
      const checked = validateAnswer(row.kind, row.spec, body?.answer, this.config.maxInputChars);
      if (!checked.ok) throw new AiInputInvalidException(checked.issues);

      assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'awaiting_input', 'answered');
      const [answered] = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_input_request SET state = 'answered', answer = $2::jsonb, answered_at = now()
          WHERE id = $1 AND state = 'awaiting_input' AND expires_at > now() RETURNING id`,
        [requestId, JSON.stringify(checked.value)],
      );
      if (!answered) throw new AiInputNotPendingException();
      // The paused turn ends `completed` (its text stands); the answer feeds a NEW continuation turn.
      assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.WAITING_FOR_INPUT, AiTurnStatus.COMPLETED);
      const [turn] = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_message SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND conversation_id = $2 AND status = 'waiting_for_input' RETURNING id`,
        [row.turn_id, conversationId],
      );
      if (!turn) throw new AiInputNotPendingException(); // fail closed: never an answer without its waiting turn
      await this.audit.record(m, ctx, AuditAction.AI_INPUT_ANSWERED, {
        entityType: 'ai_input_request',
        entityId: requestId,
        metadata: {
          conversationId,
          turnId: row.turn_id,
          kind: row.kind,
          answerChars: checked.chars,
          ...(typeof checked.value === 'object' ? { fields: Object.keys(checked.value).filter((k) => (checked.value as Record<string, unknown>)[k] !== null) } : {}),
        },
      });
      const [fresh] = await m.query<RequestRow[]>(`SELECT ${COLUMNS} FROM core.ai_input_request r WHERE r.id = $1`, [requestId]);
      return { kind: 'answered' as const, view: toView(fresh!), turnId: row.turn_id };
    });
    if (outcome.kind === 'expired') {
      await this.tenantContext.runInWorkspaceContext(ctx, (m) => this.expireDueTx(m, ctx, `r.id = $1`, [requestId]));
      throw new AiInputExpiredException();
    }
    const continuationTurnId = this.continuation ? await this.continuation.startAfterAnswer(ctx, { requestId, conversationId, pausedTurnId: outcome.turnId }) : null;
    return { request: outcome.view, continuationTurnId };
  }

  // ───────────────────────────────────────────────────────────── supersede / cancel (inside the caller's transaction)

  /**
   * A new question in the conversation: every open request is superseded and its waiting turn ends `completed` (its
   * text stays in the history; the question is simply no longer asked). Returns how many turns it ended.
   */
  async supersedeOpenTx(m: EntityManager, ctx: AuthContext, conversationId: string): Promise<number> {
    return this.endWaitingTx(m, ctx, conversationId, null, AiTurnStatus.COMPLETED);
  }

  /** The user cancelled the waiting turn: its open request is superseded and the turn ends `cancelled`. True = it was waiting. */
  async cancelWaitingTx(m: EntityManager, ctx: AuthContext, conversationId: string, turnId: string): Promise<boolean> {
    return (await this.endWaitingTx(m, ctx, conversationId, turnId, AiTurnStatus.CANCELLED)) > 0;
  }

  private async endWaitingTx(m: EntityManager, ctx: AuthContext, conversationId: string, turnId: string | null, to: 'completed' | 'cancelled'): Promise<number> {
    assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'awaiting_input', 'superseded');
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.WAITING_FOR_INPUT, to);
    const params: unknown[] = [conversationId];
    let only = '';
    if (turnId) {
      params.push(turnId);
      only = ' AND turn_id = $2';
    }
    await m.query(`UPDATE core.ai_input_request SET state = 'superseded' WHERE conversation_id = $1 AND state = 'awaiting_input'${only}`, params);
    const ended = await returningRows<{ id: string }>(
      m,
      `UPDATE core.ai_message SET status = '${to}', completed_at = now(), updated_at = now()
        WHERE conversation_id = $1 AND role = 'assistant' AND status = 'waiting_for_input'${turnId ? ' AND id = $2' : ''} RETURNING id`,
      params,
    );
    for (const t of ended) {
      await this.audit.record(m, ctx, to === 'cancelled' ? AuditAction.AI_TURN_CANCELLED : AuditAction.AI_TURN_COMPLETED, {
        entityType: 'ai_turn',
        entityId: t.id,
        metadata: { conversationId, stage: to === 'cancelled' ? 'waiting_cancelled' : 'waiting_superseded' },
      });
    }
    return ended.length;
  }

  /** Lazy expiry (the DB clock decides): open requests past `expires_at` → expired; their waiting turns end `completed`. */
  private async expireDueTx(m: EntityManager, ctx: AuthContext, where: string, params: unknown[]): Promise<void> {
    assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'awaiting_input', 'expired');
    const expired = await returningRows<{ id: string; turn_id: string; conversation_id: string }>(
      m,
      `UPDATE core.ai_input_request r SET state = 'expired' WHERE ${where} AND r.state = 'awaiting_input' AND r.expires_at <= now() RETURNING r.id, r.turn_id, r.conversation_id`,
      params,
    );
    if (expired.length === 0) return;
    assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.WAITING_FOR_INPUT, AiTurnStatus.COMPLETED);
    for (const r of expired) {
      const ended = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_message SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'waiting_for_input' RETURNING id`,
        [r.turn_id],
      );
      if (ended.length) {
        await this.audit.record(m, ctx, AuditAction.AI_TURN_COMPLETED, { entityType: 'ai_turn', entityId: r.turn_id, metadata: { conversationId: r.conversation_id, stage: 'waiting_expired' } });
      }
    }
  }

  /** The caller's own conversation (RLS owner predicate), or the uniform 404. */
  private async ownConversation(m: EntityManager, conversationId: string): Promise<void> {
    const [row] = await m.query(`SELECT 1 AS ok FROM core.ai_conversation WHERE id = $1`, [conversationId]);
    if (!row) throw new AiRecordNotFoundException();
  }
}

function toView(r: RequestRow): AiInputRequestView {
  const iso = (d: Date | string) => new Date(d).toISOString();
  return {
    requestId: r.id,
    turnId: r.turn_id,
    inputKind: r.kind,
    state: r.state === 'awaiting_input' && r.expired ? 'expired' : r.state,
    ...specView(r.kind, r.spec),
    expiresAt: iso(r.expires_at),
    serverNow: iso(r.db_now),
  };
}
