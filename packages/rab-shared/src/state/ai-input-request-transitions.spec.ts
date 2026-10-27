import { assertTransition } from './assert-transition';
import { AI_INPUT_REQUEST_TRANSITIONS, AiInputRequestState } from './ai-input-request-transitions';
import { InvalidTransitionError } from './invalid-transition-error';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('AI_INPUT_REQUEST_TRANSITIONS (Batch 3 S7)', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(AI_INPUT_REQUEST_TRANSITIONS, Object.values(AiInputRequestState));
  });

  it('only an open request moves; answered / superseded / expired never move again (no double answer, no re-open)', () => {
    for (const to of ['answered', 'superseded', 'expired'] as const) expect(() => assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'awaiting_input', to)).not.toThrow();
    for (const from of ['answered', 'superseded', 'expired'] as const) {
      for (const to of Object.values(AiInputRequestState)) expect(() => assertTransition(AI_INPUT_REQUEST_TRANSITIONS, from, to)).toThrow(InvalidTransitionError);
    }
  });

  it('refuses an unknown state (fail closed)', () => {
    expect(() => assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'pending' as never, 'answered')).toThrow(InvalidTransitionError);
    expect(() => assertTransition(AI_INPUT_REQUEST_TRANSITIONS, 'awaiting_input', 'pending' as never)).toThrow(InvalidTransitionError);
  });
});
