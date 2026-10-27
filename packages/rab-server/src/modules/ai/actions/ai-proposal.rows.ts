import { AiProposalFailureCode, AiProposalImpact, AiProposalOrigin, AiProposalStatusType, AiProposalTargetType, AiWriteToolName } from '@rab/shared';

/** One `core.ai_action_proposal` row as the proposal service reads it (always under the owner's RLS context). */
export interface AiProposalRow {
  id: string;
  organisationId: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  groupId: string | null;
  origin: AiProposalOrigin;
  tool: AiWriteToolName;
  arguments: Record<string, unknown>;
  finalArguments: Record<string, unknown> | null;
  summary: string;
  status: AiProposalStatusType;
  editableFields: string[];
  targetType: AiProposalTargetType | null;
  targetId: string | null;
  snapshotHash: string;
  impact: AiProposalImpact;
  affectedCount: number;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  resultEntityType: string | null;
  resultEntityId: string | null;
  executedAt: Date | null;
  errorCode: AiProposalFailureCode | null;
  expiresAt: Date;
  createdAt: Date;
  /** `expires_at <= now()` evaluated by PostgreSQL in the same statement (never the Node clock). */
  expired: boolean;
  /** The database clock when the row was read (`serverNow` on the card). */
  dbNow: Date;
}

/** Column list for `SELECT … FROM core.ai_action_proposal p` (aliases match `AiProposalRow`). */
export const AI_PROPOSAL_COLUMNS = `
  p.id, p.organisation_id AS "organisationId", p.workspace_id AS "workspaceId", p.user_id AS "userId",
  p.conversation_id AS "conversationId", p.turn_id AS "turnId", p.tool_call_id AS "toolCallId", p.group_id AS "groupId",
  p.origin, p.tool, p.arguments, p.final_arguments AS "finalArguments", p.summary, p.status, p.editable_fields AS "editableFields",
  p.target_type AS "targetType", p.target_id AS "targetId", p.snapshot_hash AS "snapshotHash", p.impact, p.affected_count AS "affectedCount",
  p.decided_by AS "decidedBy", p.decided_at AS "decidedAt", p.decision_reason AS "decisionReason",
  p.result_entity_type AS "resultEntityType", p.result_entity_id AS "resultEntityId", p.executed_at AS "executedAt",
  p.error_code AS "errorCode", p.expires_at AS "expiresAt", p.created_at AS "createdAt",
  (p.expires_at <= now()) AS expired, now() AS "dbNow"`;

/** Audit metadata for every proposal event: ids, tool, impact and counts only — never an argument or a note body. */
export function proposalAuditMetadata(row: Pick<AiProposalRow, 'conversationId' | 'turnId' | 'tool' | 'targetType' | 'targetId' | 'impact' | 'affectedCount' | 'groupId'>, extra: Record<string, unknown> = {}) {
  return {
    conversationId: row.conversationId,
    turnId: row.turnId,
    tool: row.tool,
    targetType: row.targetType,
    targetId: row.targetId,
    impact: row.impact,
    affectedCount: row.affectedCount,
    groupId: row.groupId,
    ...extra,
  };
}
