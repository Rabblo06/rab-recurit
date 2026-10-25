import { assertTransition } from './assert-transition';
import { AI_TURN_TRANSITIONS, AiTurnStatus } from './ai-turn-transitions';
import { InvalidTransitionError } from './invalid-transition-error';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('AI_TURN_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(AI_TURN_TRANSITIONS, Object.values(AiTurnStatus));
  });

  it('terminal states never move again (no re-run of a finished turn)', () => {
    for (const from of [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED]) {
      for (const to of Object.values(AiTurnStatus)) expect(() => assertTransition(AI_TURN_TRANSITIONS, from, to)).toThrow(InvalidTransitionError);
    }
  });

  it('refuses an unknown state (fail closed)', () => {
    expect(() => assertTransition(AI_TURN_TRANSITIONS, 'streaming' as never, AiTurnStatus.COMPLETED)).toThrow(InvalidTransitionError);
  });
});
