import { AI_PROPOSAL_TRANSITIONS, AiProposalImpact, AiProposalStatus, assertTransition } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AiProposalExecutorContract } from '../contracts/actions';
import { AiProposalNotDecidableError, AiProposalStaleError } from '../exceptions/ai-proposal.exceptions';
import { AiProposalAccessService } from './ai-proposal-access.service';
import { AI_PROPOSAL_COLUMNS, AiProposalRow, proposalAuditMetadata } from './ai-proposal.rows';
import { AiWriteToolsService } from './ai-write-tools';

/** What the approving request decided before the transaction (impact may have risen through an edit). */
export interface AiProposalDecision {
  impact: AiProposalImpact;
  affectedCount: number;
  reason: string | null;
  /** Names of the fields the approver edited (audit metadata; never their values). */
  editedFields: string[];
}

/** Fixed sibling-rejection reason (an alternative of the same group was approved). */
export const AI_ALTERNATIVE_CHOSEN_REASON = 'alternative_chosen';

/**
 * The ONLY caller of `AiWriteToolDefinition.apply` (static test T5-C1). Runs entirely inside the caller's ONE
 * `runInWorkspaceContext(approverCtx)` transaction, in the approver's own HTTP request, as the approver
 * (security rule 6.3, PHASE5_TWENTY_PLAN §2.4 step 5):
 *   (a) access re-read from PostgreSQL (404 if AI / the organisation was switched off or eligibility lost);
 *   (b) compare-and-set PENDING → APPROVED before expiry (`decided_by` = the bound user = the owner, enforced by the
 *       trigger); 0 rows ⇒ `AiProposalNotDecidableError` (a concurrent approver waits on the row lock, then sees it
 *       decided — exactly one execution);
 *   (c) the target rows locked and re-hashed; a mismatch ⇒ `AiProposalStaleError` (the caller rolls back and records
 *       FAILED `stale` in a separate transaction);
 *   (d) `apply()` = the domain service's Tx method, which re-checks its own flag, ownership, `assertTransition` and the
 *       archive rules under the approver's RLS context;
 *   (e) APPROVED → EXECUTED with the result ids; (f) pending siblings of an alternatives group → REJECTED;
 *   (g) audit approved + executed (+ rejected siblings), metadata only.
 * Any error rolls the whole transaction back: nothing is written, and the caller records FAILED separately. Never retried.
 */
@Injectable()
export class AiProposalExecutorService implements AiProposalExecutorContract {
  constructor(
    private readonly tools: AiWriteToolsService,
    private readonly access: AiProposalAccessService,
    private readonly audit: AuditService,
  ) {}

  async executeApproved(
    m: EntityManager,
    approverCtx: AuthContext,
    proposalId: string,
    finalArguments: Record<string, unknown>,
    decision?: AiProposalDecision,
  ): Promise<{ entityType: string; entityId: string }> {
    await this.access.assertDecidableTx(m, approverCtx);

    const [current] = (await m.query(`SELECT ${AI_PROPOSAL_COLUMNS} FROM core.ai_action_proposal p WHERE p.id = $1`, [proposalId])) as AiProposalRow[];
    if (!current || current.status !== AiProposalStatus.PENDING) throw new AiProposalNotDecidableError();
    const tool = this.tools.get(current.tool);
    if (!tool) throw new AiProposalNotDecidableError();
    // Re-parsed strictly here too: the executor never trusts that its caller validated the arguments.
    const input = tool.input.parse(finalArguments) as Record<string, unknown>;
    const impact = decision?.impact ?? current.impact;
    const affectedCount = decision?.affectedCount ?? current.affectedCount;

    assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.APPROVED);
    const [approved] = (await m.query(
      `UPDATE core.ai_action_proposal
          SET status = 'APPROVED', decided_by = core.current_uid(), decided_at = now(), final_arguments = $2::jsonb,
              impact = $3, affected_count = $4, decision_reason = $5
        WHERE id = $1 AND status = 'PENDING' AND expires_at > now()
        RETURNING id`,
      [proposalId, JSON.stringify(input), impact, affectedCount, decision?.reason ?? null],
    )) as [Array<{ id: string }>, number];
    if (approved.length === 0) throw new AiProposalNotDecidableError();

    const hash = await tool.lockAndHash(m, approverCtx, input);
    if (hash !== current.snapshotHash) throw new AiProposalStaleError();

    const result = await tool.apply(m, approverCtx, input);

    assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.APPROVED, AiProposalStatus.EXECUTED);
    const [executed] = (await m.query(
      `UPDATE core.ai_action_proposal SET status = 'EXECUTED', executed_at = now(), result_entity_type = $2, result_entity_id = $3
        WHERE id = $1 AND status = 'APPROVED' RETURNING id`,
      [proposalId, result.entityType, result.entityId],
    )) as [Array<{ id: string }>, number];
    if (executed.length === 0) throw new AiProposalNotDecidableError();

    const meta = proposalAuditMetadata({ ...current, impact, affectedCount });
    const groupId = current.groupId ?? current.id;
    assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.REJECTED);
    const [siblings] = (await m.query(
      `UPDATE core.ai_action_proposal
          SET status = 'REJECTED', decided_by = core.current_uid(), decided_at = now(), decision_reason = $3
        WHERE (id = $2 OR group_id = $2) AND id <> $1 AND status = 'PENDING'
        RETURNING id, conversation_id AS "conversationId", turn_id AS "turnId", tool, target_type AS "targetType", target_id AS "targetId",
                  impact, affected_count AS "affectedCount", group_id AS "groupId"`,
      [proposalId, groupId, AI_ALTERNATIVE_CHOSEN_REASON],
    )) as [Array<Pick<AiProposalRow, 'id' | 'conversationId' | 'turnId' | 'tool' | 'targetType' | 'targetId' | 'impact' | 'affectedCount' | 'groupId'>>, number];

    await this.audit.record(m, approverCtx, AuditAction.AI_PROPOSAL_APPROVED, {
      entityType: 'ai_action_proposal',
      entityId: proposalId,
      metadata: { ...meta, reason: decision?.reason ?? null, editedFields: decision?.editedFields ?? [] },
    });
    await this.audit.record(m, approverCtx, AuditAction.AI_PROPOSAL_EXECUTED, {
      entityType: 'ai_action_proposal',
      entityId: proposalId,
      metadata: { ...meta, resultEntityType: result.entityType, resultEntityId: result.entityId },
    });
    for (const sibling of siblings) {
      await this.audit.record(m, approverCtx, AuditAction.AI_PROPOSAL_REJECTED, {
        entityType: 'ai_action_proposal',
        entityId: sibling.id,
        metadata: proposalAuditMetadata(sibling, { reason: AI_ALTERNATIVE_CHOSEN_REASON, chosenProposalId: proposalId }),
      });
    }
    return result;
  }
}
