import { TransitionTable } from './assert-transition';

/**
 * AI Phase 1 — lifecycle of one assistant turn (`core.ai_message` with role `assistant`). Driven only by the server: the
 * API creates a turn `queued`; the rab-ai Worker claims it (`running`) and finalises it; a user's named cancel action
 * moves `queued`/`running` to `cancelled`. No client ever sends a status. Every write goes through
 * `assertTransition(AI_TURN_TRANSITIONS, …)` AND a compare-and-set `WHERE status = <from>` in SQL, so a redelivered job
 * or a second cancel can never apply twice.
 *
 * Phase 5c (Batch 3 S7, resolution X-3): a running turn that asked the user a question or for a form PAUSES as
 * `waiting_for_input` (no lease, no org slot, no cost reservation; in neither the one-running nor the one-queued index).
 * It leaves that state only by a named action: the user's answer or a new question (→ `completed`; the answer feeds a
 * NEW continuation turn), the user's cancel (→ `cancelled`), or a server failure (→ `failed`). It never runs again.
 *
 * Terminal states (`completed`, `failed`, `cancelled`) have no way out — a new question is a new turn.
 */
export const AiTurnStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_INPUT: 'waiting_for_input',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type AiTurnStatusType = (typeof AiTurnStatus)[keyof typeof AiTurnStatus];

export const AI_TURN_TRANSITIONS: TransitionTable<AiTurnStatusType> = {
  [AiTurnStatus.QUEUED]: [AiTurnStatus.RUNNING, AiTurnStatus.CANCELLED, AiTurnStatus.FAILED],
  [AiTurnStatus.RUNNING]: [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED, AiTurnStatus.WAITING_FOR_INPUT],
  [AiTurnStatus.WAITING_FOR_INPUT]: [AiTurnStatus.COMPLETED, AiTurnStatus.CANCELLED, AiTurnStatus.FAILED],
  [AiTurnStatus.COMPLETED]: [],
  [AiTurnStatus.FAILED]: [],
  [AiTurnStatus.CANCELLED]: [],
};

export const AI_TERMINAL_TURN_STATUSES: readonly AiTurnStatusType[] = [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED];
