import {
  AI_PROPOSAL_LIMITS,
  AI_PROPOSAL_STEP_UP_ACTION,
  AI_PROPOSAL_TRANSITIONS,
  AI_WRITE_TOOL_NAMES,
  AiProposalApproveRequest,
  AiProposalDecisionResult,
  AiProposalFailureCode,
  AiProposalFieldView,
  AiProposalRejectRequest,
  AiProposalStatus,
  AiProposalView,
  AiProposeActionMode,
  assertTransition,
  PermissionFlagType,
  InvalidTransitionError,
} from '@rab/shared';
import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { z } from 'zod';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_AGENT_EXECUTION_APPROVED } from '../contracts/agents';
import { AiProposalServiceContract, AiProposeActionResult } from '../contracts/actions';
import { AiTurnIds } from '../contracts/turn';
import { AiNotAvailableException, AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import {
  AiProposalExpiredException,
  AiProposalInvalidEditException,
  AiProposalNotDecidableError,
  AiProposalNotPendingException,
  AiProposalReasonRequiredException,
  AiProposalStaleError,
  AiProposalStaleException,
} from '../exceptions/ai-proposal.exceptions';
import { assessImpact, maxImpact } from './ai-impact';
import { AiProposalAccessService } from './ai-proposal-access.service';
import { AiProposalExecutorService } from './ai-proposal-executor.service';
import { AI_PROPOSAL_COLUMNS, AiProposalRow, proposalAuditMetadata } from './ai-proposal.rows';
import { AI_FORBIDDEN_ARGUMENT_KEYS, AiPrepared, AiWriteTool } from './ai-write-tool.types';
import { AiWriteToolsService } from './ai-write-tools';
import { AiContinuationService } from '../services/ai-continuation.service';

/** The server-side envelope of `propose_action` (5b wires the model tool to `createFromTool`). Strict: unknown keys refused. */
export const proposeActionEnvelope = z.strictObject({
  tool: z.enum(AI_WRITE_TOOL_NAMES),
  arguments: z.record(z.string(), z.unknown()),
  alternativeOf: z.uuid().optional(),
});
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;
const MAX_LISTED = 200;

/** Issue PATHS only (never a value, never the model's text) for an invalid tool input. */
const issuePaths = (error: z.ZodError, prefix: string): string[] =>
  [...new Set(error.issues.map((i) => [prefix, ...i.path.map(String)].filter(Boolean).join('.')))].slice(0, 20);

/** Fixed failure code for a domain refusal (PHASE5_TWENTY_PLAN §2.4 step 6). */
export function failureCodeFor(error: unknown): AiProposalFailureCode {
  if (error instanceof AiProposalStaleError) return 'stale';
  if (error instanceof InvalidTransitionError) return 'conflict';
  if (error instanceof z.ZodError) return 'invalid';
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === HttpStatus.FORBIDDEN) return 'not_permitted';
    if (status === HttpStatus.NOT_FOUND) return 'not_found';
    if (status === HttpStatus.CONFLICT) return 'conflict';
    if (status === HttpStatus.BAD_REQUEST) return 'invalid';
  }
  return 'internal';
}

/**
 * AI write proposals, API side (PHASE5_TWENTY_PLAN §2.4; security rules 6.1–6.6). Every method re-checks access itself
 * (layer 2, `AiProposalAccessService`); every row is read and written under the OWNER's RLS context (layer 4), with the
 * eligibility predicate on every write and the transition trigger behind it (layer 5).
 *
 *  - `createFromTool`: what 5b's `propose_action` calls. Re-parses strictly, re-checks the write tool's flag, runs
 *    `prepare()` in a READ ONLY transaction, inserts PENDING as the user (≤ 5 per turn, ≤ 3 per alternatives group).
 *  - `list`: the conversation's proposals (lazy expiry applied first).
 *  - `approve`: edits only the proposed fields; step-up + reason for high impact; then ONE transaction through the
 *    executor. Stale / domain failure → rollback, then FAILED with a fixed code in a separate transaction; never retried.
 *  - `reject`: compare-and-set PENDING → REJECTED with the reason; nothing else changes.
 * 5b adds `listInputRequests` / `answer` (questions and forms) and the continuation turn; until then
 * `continuationTurnId` is always null and the card shows the result.
 */
@Injectable()
export class AiProposalService implements Omit<AiProposalServiceContract, 'listInputRequests' | 'answer'> {
  private readonly logger = new Logger(AiProposalService.name);

  constructor(
    private readonly tools: AiWriteToolsService,
    private readonly executor: AiProposalExecutorService,
    private readonly access: AiProposalAccessService,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    // 5b: the continuation turn after a decision (AiCoreModule). Optional only for hand-built unit harnesses.
    @Optional() private readonly continuation?: AiContinuationService,
  ) {}

  // ───────────────────────────────────────────────────────────── create (server side of propose_action, 5b caller)

  /**
   * 5b: what `propose_action` may name — the write tools' names, flags and strict input schemas ONLY (never prepare / apply).
   * The registry reads this instead of importing the write-tool definitions (static T5-C1: tools/ never sees an apply()).
   */
  proposableTools(): ReadonlyArray<{ name: string; permission: PermissionFlagType; input: z.ZodType }> {
    return this.tools.names().map((name) => {
      const t = this.tools.get(name)!;
      return { name: t.name, permission: t.permission, input: t.input };
    });
  }

  async createFromTool(ids: AiTurnIds, call: { toolCallId: string; input: unknown }, mode: AiProposeActionMode = 'interactive'): Promise<AiProposeActionResult> {
    // EX-3 is not approved: an agent-origin proposal can never be written before it is (origin CHECK = 'chat' only).
    if (mode !== 'interactive' || AI_AGENT_EXECUTION_APPROVED) throw new Error('AI proposals: only interactive chat proposals exist before EX-3');
    if (typeof call.toolCallId !== 'string' || !TOOL_CALL_ID.test(call.toolCallId)) return { error: 'invalid_input', issues: ['toolCallId'] };
    const envelope = proposeActionEnvelope.safeParse(call.input);
    if (!envelope.success) return { error: 'invalid_input', issues: issuePaths(envelope.error, '') };
    const tool = this.tools.get(envelope.data.tool);
    if (!tool) return { error: 'invalid_input', issues: ['tool'] };
    const parsed = tool.input.safeParse(envelope.data.arguments);
    if (!parsed.success) return { error: 'invalid_input', issues: issuePaths(parsed.error, 'arguments') };
    const args = parsed.data as Record<string, unknown>;
    if (Object.keys(args).some((k) => AI_FORBIDDEN_ARGUMENT_KEYS.includes(k))) return { error: 'invalid_input', issues: ['arguments'] };
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > AI_PROPOSAL_LIMITS.maxArgumentsBytes) return { error: 'invalid_input', issues: ['arguments'] };

    const ctx: AuthContext = { organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, role: '' };

    // (1) Read-only: access, the write tool's own flag, prepare(). The database refuses any write in this transaction.
    let prepared: AiPrepared;
    try {
      prepared = await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        await this.access.assertDecidableTx(m, ctx);
        if (!(await this.permissions.userHasPermissionTx(m, ctx, tool.permission))) throw new ToolNotPermitted();
        return tool.prepare(m, ctx, args);
      });
    } catch (error) {
      if (error instanceof AiNotAvailableException) throw error;
      // Not permitted, not found, out of scope, archived, not a draft, bad window: the model learns only "invalid".
      if (error instanceof ToolNotPermitted) return { error: 'invalid_input', issues: ['tool'] };
      if (error instanceof HttpException || error instanceof InvalidTransitionError) return { error: 'invalid_input', issues: ['arguments'] };
      throw error;
    }
    if (prepared.touchesPay !== false || prepared.deletes !== false) throw new Error(`AI write tool ${tool.name} touches pay or deletes`);
    let impact;
    try {
      impact = assessImpact(prepared);
    } catch {
      return { error: 'invalid_input', issues: ['arguments'] };
    }
    const editableFields = tool.editableFields.filter((k) => args[k] !== undefined);

    // (2) Insert PENDING as the user (RLS WITH CHECK: owner + eligibility + PENDING + undecided).
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.access.assertDecidableTx(m, ctx);
      const [turn] = (await m.query(
        `SELECT 1 AS ok FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' AND status = 'running'`,
        [ids.turnId, ids.conversationId],
      )) as Array<{ ok: number }>;
      if (!turn) throw new AiRecordNotFoundException();
      // Idempotent per tool call: a redelivered call returns the proposal it already created.
      const [existing] = (await m.query(`SELECT id, summary FROM core.ai_action_proposal WHERE turn_id = $1 AND tool_call_id = $2`, [ids.turnId, call.toolCallId])) as Array<{ id: string; summary: string }>;
      if (existing) return { status: 'awaiting_user' as const, proposalId: existing.id, summary: existing.summary };
      const [{ n: perTurn }] = (await m.query(`SELECT count(*)::int AS n FROM core.ai_action_proposal WHERE turn_id = $1`, [ids.turnId])) as Array<{ n: number }>;
      if (perTurn >= AI_PROPOSAL_LIMITS.perTurn) return { error: 'proposal_limit' as const };
      let groupId: string | null = null;
      if (envelope.data.alternativeOf) {
        const [anchor] = (await m.query(`SELECT id, group_id AS "groupId", status FROM core.ai_action_proposal WHERE id = $1 AND conversation_id = $2`, [
          envelope.data.alternativeOf,
          ids.conversationId,
        ])) as Array<{ id: string; groupId: string | null; status: string }>;
        if (!anchor || anchor.status !== AiProposalStatus.PENDING) return { error: 'invalid_input' as const, issues: ['alternativeOf'] };
        groupId = anchor.groupId ?? anchor.id;
        const [{ n: inGroup }] = (await m.query(`SELECT count(*)::int AS n FROM core.ai_action_proposal WHERE id = $1 OR group_id = $1`, [groupId])) as Array<{ n: number }>;
        if (inGroup >= AI_PROPOSAL_LIMITS.alternativesPerGroup) return { error: 'proposal_limit' as const };
      }
      const [row] = (await m.query(
        `INSERT INTO core.ai_action_proposal
           (organisation_id, workspace_id, user_id, conversation_id, turn_id, tool_call_id, group_id, tool, arguments, summary,
            editable_fields, target_type, target_id, snapshot_hash, impact, affected_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::text[], $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          ids.organisationId,
          ids.workspaceId,
          ids.userId,
          ids.conversationId,
          ids.turnId,
          call.toolCallId,
          groupId,
          tool.name,
          JSON.stringify(args),
          prepared.summary,
          editableFields,
          prepared.target?.type ?? null,
          prepared.target?.id ?? null,
          prepared.snapshotHash,
          impact,
          prepared.affectedCount,
        ],
      )) as Array<{ id: string }>;
      await this.audit.record(m, ctx, AuditAction.AI_PROPOSAL_CREATED, {
        entityType: 'ai_action_proposal',
        entityId: row!.id,
        metadata: proposalAuditMetadata({
          conversationId: ids.conversationId,
          turnId: ids.turnId,
          tool: tool.name,
          targetType: prepared.target?.type ?? null,
          targetId: prepared.target?.id ?? null,
          impact,
          affectedCount: prepared.affectedCount,
          groupId,
        }),
      });
      return { status: 'awaiting_user' as const, proposalId: row!.id, summary: prepared.summary };
    });
  }

  // ───────────────────────────────────────────────────────────── list

  async list(ctx: AuthContext, conversationId: string): Promise<AiProposalView[]> {
    await this.access.assertDecidable(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.access.assertDecidableTx(m, ctx);
      const [conversation] = (await m.query(`SELECT 1 AS ok FROM core.ai_conversation WHERE id = $1`, [conversationId])) as Array<{ ok: number }>;
      if (!conversation) throw new AiRecordNotFoundException();
      await this.expireDueTx(m, ctx, `p.conversation_id = $1`, [conversationId]);
      const rows = (await m.query(`SELECT ${AI_PROPOSAL_COLUMNS} FROM core.ai_action_proposal p WHERE p.conversation_id = $1 ORDER BY p.created_at, p.id LIMIT ${MAX_LISTED}`, [
        conversationId,
      ])) as AiProposalRow[];
      return this.toViews(m, rows);
    });
  }

  // ───────────────────────────────────────────────────────────── approve

  async approve(ctx: AuthContext, proposalId: string, body: AiProposalApproveRequest): Promise<AiProposalDecisionResult> {
    await this.access.assertDecidable(ctx);
    const row = await this.loadDecidable(ctx, proposalId);
    const tool = this.tools.get(row.tool);
    if (!tool) throw new AiProposalNotPendingException();

    // Edits: only the fields the assistant proposed (editable_fields), only scalar values; then the strict schema again.
    const edits = body?.edits ?? {};
    if (typeof edits !== 'object' || edits === null || Array.isArray(edits)) throw new AiProposalInvalidEditException(['edits']);
    const editedFields = Object.keys(edits);
    if (editedFields.length > AI_PROPOSAL_LIMITS.maxEditableFields) throw new AiProposalInvalidEditException(['edits']);
    const refused = editedFields.filter((k) => !row.editableFields.includes(k));
    if (refused.length > 0) throw new AiProposalInvalidEditException(refused.map((k) => (FIELD_KEY.test(k) ? `edits.${k}` : 'edits')));
    const merged: Record<string, unknown> = { ...row.arguments };
    for (const key of editedFields) {
      const value = edits[key];
      if (value === null) delete merged[key];
      else if (typeof value === 'string' || typeof value === 'number') merged[key] = value;
      else throw new AiProposalInvalidEditException([`edits.${key}`]);
    }
    const reparsed = tool.input.safeParse(merged);
    if (!reparsed.success) throw new AiProposalInvalidEditException(issuePaths(reparsed.error, 'edits'));
    const finalArguments = reparsed.data as Record<string, unknown>;

    // Impact: recomputed by the server, never lowered below what was stored. An edit re-runs prepare() (read only).
    let affectedCount = row.affectedCount;
    let impact = maxImpact(row.impact, assessImpact({ affectedCount, touchesPay: false, deletes: false }));
    if (editedFields.length > 0) {
      const prepared = await this.prepareForDecision(ctx, row, tool, finalArguments);
      affectedCount = prepared.affectedCount;
      impact = maxImpact(row.impact, assessImpact(prepared));
    }

    const reason = typeof body?.reason === 'string' ? body.reason.trim() : null;
    if (reason !== null && (reason.length < AI_PROPOSAL_LIMITS.reasonMinChars || reason.length > AI_PROPOSAL_LIMITS.reasonMaxChars)) throw new AiProposalReasonRequiredException();
    if (impact === 'high') {
      if (!reason) throw new AiProposalReasonRequiredException();
      await this.stepUp.assertRecentStepUp(ctx, AI_PROPOSAL_STEP_UP_ACTION);
    }

    try {
      await this.tenantContext.runInWorkspaceContext(ctx, (m) =>
        this.executor.executeApproved(m, ctx, proposalId, finalArguments, { impact, affectedCount, reason: reason || null, editedFields }),
      );
    } catch (error) {
      await this.afterFailedExecution(ctx, row, error);
    }
    // 5b: the decision is committed; the assistant continues in a NEW turn that sees only the server-written result.
    return { proposal: await this.view(ctx, proposalId), continuationTurnId: await this.continueAfter(ctx, row) };
  }

  // ───────────────────────────────────────────────────────────── reject

  async reject(ctx: AuthContext, proposalId: string, body: AiProposalRejectRequest): Promise<AiProposalDecisionResult> {
    await this.access.assertDecidable(ctx);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < AI_PROPOSAL_LIMITS.reasonMinChars || reason.length > AI_PROPOSAL_LIMITS.reasonMaxChars) throw new AiProposalReasonRequiredException();
    const row = await this.loadDecidable(ctx, proposalId);
    const rejected = await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.access.assertDecidableTx(m, ctx);
      assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.REJECTED);
      const [done] = (await m.query(
        `UPDATE core.ai_action_proposal SET status = 'REJECTED', decided_by = core.current_uid(), decided_at = now(), decision_reason = $2
          WHERE id = $1 AND status = 'PENDING' AND expires_at > now() RETURNING id`,
        [proposalId, reason],
      )) as [Array<{ id: string }>, number];
      if (done.length === 0) return false;
      await this.audit.record(m, ctx, AuditAction.AI_PROPOSAL_REJECTED, { entityType: 'ai_action_proposal', entityId: proposalId, metadata: proposalAuditMetadata(row, { reason }) });
      return true;
    });
    if (!rejected) await this.classifyNotDecidable(ctx, proposalId);
    return { proposal: await this.view(ctx, proposalId), continuationTurnId: await this.continueAfter(ctx, row) };
  }

  // ───────────────────────────────────────────────────────────── internals

  /** The owner's PENDING, unexpired proposal — else 404 (not this caller's) / 409 EXPIRED (expired now, recorded) / 409. */
  private async loadDecidable(ctx: AuthContext, proposalId: string): Promise<AiProposalRow> {
    const row = await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      const [found] = (await m.query(`SELECT ${AI_PROPOSAL_COLUMNS} FROM core.ai_action_proposal p WHERE p.id = $1`, [proposalId])) as AiProposalRow[];
      return found ?? null;
    });
    if (!row) throw new AiRecordNotFoundException();
    if (row.status === AiProposalStatus.PENDING && row.expired) {
      await this.expireOne(ctx, proposalId);
      throw new AiProposalExpiredException();
    }
    if (row.status === AiProposalStatus.EXPIRED) throw new AiProposalExpiredException();
    if (row.status !== AiProposalStatus.PENDING) throw new AiProposalNotPendingException();
    return row;
  }

  /** After a compare-and-set matched nothing: say why (and record a lazy expiry). Always throws. */
  private async classifyNotDecidable(ctx: AuthContext, proposalId: string): Promise<never> {
    await this.loadDecidable(ctx, proposalId);
    // Still PENDING and unexpired, yet the CAS missed: a concurrent decision is in flight.
    throw new AiProposalNotPendingException();
  }

  private async prepareForDecision(ctx: AuthContext, row: AiProposalRow, tool: AiWriteTool, finalArguments: Record<string, unknown>): Promise<AiPrepared> {
    try {
      return await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        return tool.prepare(m, ctx, finalArguments);
      });
    } catch (error) {
      // A bad edit (400) can be corrected by the approver: refused, the proposal stays PENDING.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.BAD_REQUEST) throw new AiProposalInvalidEditException(['edits']);
      // Anything else (403 / 404 / 409): the proposal can no longer run as proposed.
      await this.markFailed(ctx, row, failureCodeFor(error));
      throw error;
    }
  }

  /** Maps a rolled-back execution to its answer; records FAILED (fixed code) in a separate transaction. Always throws. */
  /**
   * 5b: start the continuation turn for a proposal THIS call decided (never for an agent-origin proposal). An alternative
   * sibling rejected with the chosen one does not continue separately. Null = none started (the decision stands).
   */
  private async continueAfter(ctx: AuthContext, row: AiProposalRow): Promise<string | null> {
    if (!this.continuation || row.origin !== 'chat') return null;
    return this.continuation.startAfterDecision(ctx, { proposalId: row.id, conversationId: row.conversationId, pausedTurnId: row.turnId });
  }

  private async afterFailedExecution(ctx: AuthContext, row: AiProposalRow, error: unknown): Promise<never> {
    if (error instanceof AiProposalNotDecidableError) return this.classifyNotDecidable(ctx, row.id);
    if (error instanceof AiNotAvailableException) throw error;
    const code = failureCodeFor(error);
    await this.markFailed(ctx, row, code);
    if (error instanceof AiProposalStaleError) throw new AiProposalStaleException();
    if (code === 'internal') this.logger.error(`AI proposal ${row.id} (${row.tool}) failed: ${(error as Error)?.name ?? 'Error'}`);
    throw error;
  }

  private async markFailed(ctx: AuthContext, row: AiProposalRow, code: AiProposalFailureCode): Promise<void> {
    try {
      await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
        assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.FAILED);
        const [done] = (await m.query(
          `UPDATE core.ai_action_proposal SET status = 'FAILED', decided_by = core.current_uid(), decided_at = now(), error_code = $2
            WHERE id = $1 AND status = 'PENDING' RETURNING id`,
          [row.id, code],
        )) as [Array<{ id: string }>, number];
        if (done.length === 0) return;
        await this.audit.record(m, ctx, AuditAction.AI_PROPOSAL_FAILED, { entityType: 'ai_action_proposal', entityId: row.id, metadata: proposalAuditMetadata(row, { errorCode: code }) });
      });
    } catch (e) {
      // The proposal then simply expires (it can never run after 15 minutes); the original error is still answered.
      this.logger.warn(`AI proposal ${row.id}: could not record FAILED (${(e as Error)?.name ?? 'Error'})`);
    }
  }

  private async expireOne(ctx: AuthContext, proposalId: string): Promise<void> {
    await this.tenantContext.runInWorkspaceContext(ctx, (m) => this.expireDueTx(m, ctx, `p.id = $1`, [proposalId]));
  }

  /** Lazy expiry (D6): PENDING rows past `expires_at` become EXPIRED, each audited. The DB clock decides. */
  private async expireDueTx(m: EntityManager, ctx: AuthContext, where: string, params: unknown[]): Promise<void> {
    assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.EXPIRED);
    const [rows] = (await m.query(
      `UPDATE core.ai_action_proposal p SET status = 'EXPIRED', decided_by = core.current_uid(), decided_at = now()
        WHERE ${where} AND p.status = 'PENDING' AND p.expires_at <= now()
        RETURNING ${AI_PROPOSAL_COLUMNS}`,
      params,
    )) as [AiProposalRow[], number];
    for (const r of rows) {
      await this.audit.record(m, ctx, AuditAction.AI_PROPOSAL_EXPIRED, { entityType: 'ai_action_proposal', entityId: r.id, metadata: proposalAuditMetadata(r) });
    }
  }

  private async view(ctx: AuthContext, proposalId: string): Promise<AiProposalView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      const rows = (await m.query(`SELECT ${AI_PROPOSAL_COLUMNS} FROM core.ai_action_proposal p WHERE p.id = $1`, [proposalId])) as AiProposalRow[];
      if (rows.length === 0) throw new AiRecordNotFoundException();
      return (await this.toViews(m, rows))[0]!;
    });
  }

  /** Card views. Target labels are resolved live under the caller's RLS (a name is never stored in the proposal). */
  private async toViews(m: EntityManager, rows: AiProposalRow[]): Promise<AiProposalView[]> {
    const idsOf = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId).map((r) => r.targetId!))];
    const labels = new Map<string, string>();
    const venueIds = idsOf('venue');
    if (venueIds.length) for (const v of (await m.query(`SELECT id::text AS id, name FROM venue WHERE id = ANY($1::uuid[])`, [venueIds])) as Array<{ id: string; name: string }>) labels.set(v.id, v.name);
    const shiftIds = idsOf('shift');
    if (shiftIds.length) {
      for (const s of (await m.query(`SELECT s.id::text AS id, v.name AS venue FROM shift s LEFT JOIN venue v ON v.id = s.venue_id WHERE s.id = ANY($1::uuid[])`, [shiftIds])) as Array<{ id: string; venue: string | null }>) {
        labels.set(s.id, s.venue ? `Draft shift at ${s.venue}` : 'Draft shift');
      }
    }
    const staffIds = idsOf('staff_profile');
    if (staffIds.length) {
      for (const p of (await m.query(
        `SELECT sp.id::text AS id, u.first_name AS "firstName", u.last_name AS "lastName"
           FROM staff_profile sp JOIN core."user" u ON u.id = sp.user_id
          WHERE sp.id = ANY($1::uuid[]) AND sp.created_by = core.current_uid()`,
        [staffIds],
      )) as Array<{ id: string; firstName: string | null; lastName: string | null }>) {
        labels.set(p.id, [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Staff member');
      }
    }
    return rows.map((r) => this.toView(r, labels));
  }

  private toView(r: AiProposalRow, labels: ReadonlyMap<string, string>): AiProposalView {
    const tool = this.tools.get(r.tool);
    const args = r.finalArguments ?? r.arguments;
    const pending = r.status === AiProposalStatus.PENDING && !r.expired;
    const fields: AiProposalFieldView[] = (tool?.fields ?? [])
      .filter((f) => args[f.key] !== undefined)
      .map((f) => {
        const raw = args[f.key];
        return {
          key: f.key,
          label: f.label,
          type: f.type,
          value: typeof raw === 'string' || typeof raw === 'number' ? raw : null,
          editable: pending && r.editableFields.includes(f.key),
          ...(f.min !== undefined ? { min: f.min } : {}),
          ...(f.max !== undefined ? { max: f.max } : {}),
          ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
        };
      });
    const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
    return {
      id: r.id,
      conversationId: r.conversationId,
      turnId: r.turnId,
      groupId: r.groupId,
      origin: r.origin,
      tool: r.tool,
      summary: r.summary,
      // A PENDING row past its expiry is shown as EXPIRED even before the lazy write lands (the DB refuses it anyway).
      status: r.status === AiProposalStatus.PENDING && r.expired ? AiProposalStatus.EXPIRED : r.status,
      impact: r.impact,
      affectedCount: r.affectedCount,
      target: r.targetType && r.targetId ? { type: r.targetType, id: r.targetId, label: labels.get(r.targetId) ?? null } : null,
      fields,
      requiresStepUp: r.impact === 'high',
      requiresReason: r.impact === 'high',
      expiresAt: iso(r.expiresAt)!,
      serverNow: iso(r.dbNow)!,
      createdAt: iso(r.createdAt)!,
      decidedAt: iso(r.decidedAt),
      failureCode: r.errorCode,
      result: r.resultEntityType && r.resultEntityId ? { entityType: r.resultEntityType, entityId: r.resultEntityId } : null,
    };
  }
}

/** Internal: the write tool's flag is not held (the model is told only "invalid tool"). */
class ToolNotPermitted extends Error {}
