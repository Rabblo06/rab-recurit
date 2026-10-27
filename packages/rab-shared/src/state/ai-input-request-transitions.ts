import type { AiInputRequestPartState } from '../types/ai-turns';
import { TransitionTable } from './assert-transition';

/**
 * AI Phase 5c (Batch 3 S7) — lifecycle of one question / form the assistant asked (`core.ai_input_request`). Driven only
 * by the server; no client ever sends a state. The user's named answer action, a new question in the conversation (or a
 * cancel of the waiting turn), and the server's lazy expiry move an open request; nothing moves it back.
 *
 *   awaiting_input → answered   (POST …/inputs/:requestId/answer, compare-and-set, before expiry)
 *                  | superseded (the user asked something else, or cancelled the waiting turn)
 *                  | expired    (read or answered after `expires_at`)
 *   answered, superseded, expired: terminal (an answer is never replaced; a request is never re-opened).
 *
 * Mirrored exactly by the database trigger `core.ai_input_request_guard()` (AiInputRequest1786721070000).
 */
export const AiInputRequestState = {
  AWAITING_INPUT: 'awaiting_input',
  ANSWERED: 'answered',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
} as const satisfies Record<string, AiInputRequestPartState>;

export const AI_INPUT_REQUEST_TRANSITIONS: TransitionTable<AiInputRequestPartState> = {
  [AiInputRequestState.AWAITING_INPUT]: [AiInputRequestState.ANSWERED, AiInputRequestState.SUPERSEDED, AiInputRequestState.EXPIRED],
  [AiInputRequestState.ANSWERED]: [],
  [AiInputRequestState.SUPERSEDED]: [],
  [AiInputRequestState.EXPIRED]: [],
};
