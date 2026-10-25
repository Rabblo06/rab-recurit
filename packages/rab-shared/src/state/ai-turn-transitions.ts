import { TransitionTable } from './assert-transition';

/**
 * AI Phase 1 — lifecycle of one assistant turn (`core.ai_message` with role `assistant`). Driven only by the server: the
 * API creates a turn `queued`; the rab-ai Worker claims it (`running`) and finalises it; a user's named cancel action
 * moves `queued`/`running` to `cancelled`. No client ever sends a status. Every write goes through
 * `assertTransition(AI_TURN_TRANSITIONS, …)` AND a compare-and-set `WHERE status = <from>` in SQL, so a redelivered job
 * or a second cancel can never apply twice.
 *
 * Terminal states (`completed`, `failed`, `cancelled`) have no way out — a new question is a new turn.
 */
export const AiTurnStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type AiTurnStatusType = (typeof AiTurnStatus)[keyof typeof AiTurnStatus];

export const AI_TURN_TRANSITIONS: TransitionTable<AiTurnStatusType> = {
  [AiTurnStatus.QUEUED]: [AiTurnStatus.RUNNING, AiTurnStatus.CANCELLED, AiTurnStatus.FAILED],
  [AiTurnStatus.RUNNING]: [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED],
  [AiTurnStatus.COMPLETED]: [],
  [AiTurnStatus.FAILED]: [],
  [AiTurnStatus.CANCELLED]: [],
};

export const AI_TERMINAL_TURN_STATUSES: readonly AiTurnStatusType[] = [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED];
