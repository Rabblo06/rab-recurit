import { AiProposalStatus, AiProposalStatusType } from '../types/ai-proposals';
import { TransitionTable } from './assert-transition';

/**
 * AI Phase 5 — lifecycle of one AI write proposal (`core.ai_action_proposal`, PHASE5_TWENTY_PLAN §2.4). Driven only by
 * the server; no client ever sends a status. A person's named action (approve / reject) or the server's lazy expiry
 * moves a PENDING proposal; only the executor, in the approver's own request and transaction, moves APPROVED on.
 *
 *   PENDING  → APPROVED (approve: compare-and-set, before expiry) | REJECTED (reject, or a sibling alternative was
 *              approved) | EXPIRED (read or decided after `expires_at`) | FAILED (stale snapshot or domain refusal)
 *   APPROVED → EXECUTED (the domain write committed in the same transaction) | FAILED
 *   REJECTED, EXECUTED, FAILED, EXPIRED: terminal (a proposal never runs twice and never comes back).
 *
 * Mirrored exactly by the database trigger `core.ai_action_proposal_guard()` (AiActionProposalActivate1786720960000),
 * so a write that skips this check is still refused by PostgreSQL.
 */
export const AI_PROPOSAL_TRANSITIONS: TransitionTable<AiProposalStatusType> = {
  [AiProposalStatus.PENDING]: [AiProposalStatus.APPROVED, AiProposalStatus.REJECTED, AiProposalStatus.EXPIRED, AiProposalStatus.FAILED],
  [AiProposalStatus.APPROVED]: [AiProposalStatus.EXECUTED, AiProposalStatus.FAILED],
  [AiProposalStatus.REJECTED]: [],
  [AiProposalStatus.EXECUTED]: [],
  [AiProposalStatus.FAILED]: [],
  [AiProposalStatus.EXPIRED]: [],
};

export const AI_TERMINAL_PROPOSAL_STATUSES: readonly AiProposalStatusType[] = [
  AiProposalStatus.REJECTED,
  AiProposalStatus.EXECUTED,
  AiProposalStatus.FAILED,
  AiProposalStatus.EXPIRED,
];
