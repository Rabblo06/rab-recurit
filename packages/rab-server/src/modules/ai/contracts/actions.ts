/**
 * AI contracts C0 — PROPOSAL APPROVALS, server side (docs/ai/AI_CONTRACTS.md §2.5). Types only: no behaviour.
 *
 * Implemented by Agent 5. The write-tool contract follows PHASE5_TWENTY_PLAN §2.2 exactly: a write tool has `prepare()`
 * (read-only) and `apply()`, and NO `run`. Only `AiProposalExecutorService` calls `apply()` (static test T5-C1), inside
 * the same transaction as the CAS PENDING → APPROVED → EXECUTED, in the APPROVER's HTTP request, as the approver.
 * Write definitions never reach the SDK ToolSet. `organisationId` / `workspaceId` come only from the approver's session.
 */
import type {
  AiInputAnswerRequest,
  AiInputRequestView,
  AiProposalApproveRequest,
  AiProposalDecisionResult,
  AiProposalFieldType,
  AiProposalImpact,
  AiProposalRejectRequest,
  AiProposalTargetType,
  AiProposalView,
  AiWriteToolName,
  PermissionFlagType,
} from '@rab/shared';
import type { EntityManager } from 'typeorm';
import type { z } from 'zod';

import type { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';

/** What `prepare()` computes from the parsed input and looked-up names (server-written; no model text except a quoted note body). */
export interface AiPrepared {
  summary: string;
  target: { type: AiProposalTargetType; id: string } | null;
  /** SHA-256 hex of the canonical JSON of the target's snapshot fields (re-computed under FOR UPDATE at approval). */
  snapshotHash: string;
  affectedCount: number;
  /** Literal `false`: checked at boot. A tool that touches pay or deletes cannot be registered. */
  touchesPay: false;
  deletes: false;
}

export interface AiWriteToolDefinition<I extends Record<string, unknown> = Record<string, unknown>> {
  /** Mirrored by the DB CHECK on `ai_action_proposal.tool`. */
  name: AiWriteToolName;
  /** schedule.create | schedule.create | staff.edit. Re-checked at proposal time AND inside the domain Tx method at apply. */
  permission: PermissionFlagType;
  /** `.strict()`; never organisationId / workspaceId / userId / status / payRatePence / chargeRatePence. */
  input: z.ZodType<I>;
  /** Every field except the target id. */
  editableFields: readonly (keyof I & string)[];
  prepare(m: EntityManager, ctx: AuthContext, input: I): Promise<AiPrepared>;
  apply(m: EntityManager, ctx: AuthContext, input: I): Promise<{ entityType: string; entityId: string }>;
  /** p5 merge (Agent 5 Q1): how each editable argument is shown on the card (fixed server text). */
  fields?: readonly AiWriteToolFieldSpec[];
  /** p5 merge (Agent 5 Q1): inside the executor transaction, lock the snapshot rows FOR UPDATE and return the re-computed hash. */
  lockAndHash?(m: EntityManager, ctx: AuthContext, input: I): Promise<string>;
}

/** How a card renders one editable argument (`AiProposalFieldView` without the value). */
export interface AiWriteToolFieldSpec {
  key: string;
  label: string;
  type: AiProposalFieldType;
  min?: number;
  max?: number;
  maxLength?: number;
}

/** p5 merge (Agent 5 Q2): what the approval request decided before the executor transaction (written by the CAS). */
export interface AiProposalDecision {
  impact: AiProposalImpact;
  affectedCount: number;
  reason: string | null;
  editedFields: readonly string[];
}

/** `propose_action` input (strict). `tool` is an enum of the write tools THIS actor may use (filtered by permission). */
export interface AiProposeActionInput {
  tool: AiWriteToolName;
  arguments: Record<string, unknown>;
  /** Groups up to AI_PROPOSAL_LIMITS.alternativesPerGroup alternatives; approving one rejects its siblings. */
  alternativeOf?: string;
}

/** The fixed result the model sees. `interactive` pauses the turn; `agent` (6b only, EX-3) continues. */
export type AiProposeActionResult =
  | { status: 'awaiting_user'; proposalId: string; summary: string }
  | { status: 'queued_for_review'; proposalId: string; summary: string }
  | { error: 'invalid_input'; issues: string[] }
  | { error: 'proposal_limit' };

export interface AiAskQuestionInput {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

export interface AiRequestFormInput {
  title: string;
  fields: { key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options?: string[]; required: boolean }[];
}

/** The API-side proposal service (controller → service → executor). Every method re-checks access itself (layer 2). */
export interface AiProposalServiceContract {
  list(ctx: AuthContext, conversationId: string): Promise<AiProposalView[]>;
  approve(ctx: AuthContext, proposalId: string, body: AiProposalApproveRequest): Promise<AiProposalDecisionResult>;
  reject(ctx: AuthContext, proposalId: string, body: AiProposalRejectRequest): Promise<AiProposalDecisionResult>;
  /** 5b. */
  listInputRequests(ctx: AuthContext, conversationId: string): Promise<AiInputRequestView[]>;
  /** 5b. */
  answer(ctx: AuthContext, conversationId: string, requestId: string, body: AiInputAnswerRequest): Promise<{ request: AiInputRequestView; continuationTurnId: string | null }>;
}

/** The ONLY caller of `AiWriteToolDefinition.apply`. Phase 3's `registry.executeApproved` (3w) is a thin delegate to it. */
export interface AiProposalExecutorContract {
  /**
   * Inside the caller's one `runInWorkspaceContext(approverCtx)` transaction: CAS PENDING→APPROVED (expiry, decided_by =
   * the owner), lock + re-hash the target, `apply()` (domain Tx method: flag, ownership, assertTransition, archived),
   * APPROVED→EXECUTED, siblings → REJECTED, audit. Any failure rolls back; FAILED is then set in a separate transaction.
   */
  executeApproved(
    m: EntityManager,
    approverCtx: AuthContext,
    proposalId: string,
    finalArguments: Record<string, unknown>,
    decision?: AiProposalDecision,
  ): Promise<{ entityType: string; entityId: string }>;
}
