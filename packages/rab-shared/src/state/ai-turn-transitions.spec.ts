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

  it('5c: only a RUNNING turn can pause; a waiting turn only ends (completed / cancelled / failed), never runs or queues again', () => {
    expect(() => assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.RUNNING, AiTurnStatus.WAITING_FOR_INPUT)).not.toThrow();
    expect(() => assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.QUEUED, AiTurnStatus.WAITING_FOR_INPUT)).toThrow(InvalidTransitionError);
    for (const to of [AiTurnStatus.COMPLETED, AiTurnStatus.CANCELLED, AiTurnStatus.FAILED]) expect(() => assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.WAITING_FOR_INPUT, to)).not.toThrow();
    for (const to of [AiTurnStatus.RUNNING, AiTurnStatus.QUEUED, AiTurnStatus.WAITING_FOR_INPUT]) {
      expect(() => assertTransition(AI_TURN_TRANSITIONS, AiTurnStatus.WAITING_FOR_INPUT, to)).toThrow(InvalidTransitionError);
    }
    for (const from of [AiTurnStatus.COMPLETED, AiTurnStatus.FAILED, AiTurnStatus.CANCELLED]) {
      expect(() => assertTransition(AI_TURN_TRANSITIONS, from, AiTurnStatus.WAITING_FOR_INPUT)).toThrow(InvalidTransitionError);
    }
  });

  it('refuses an unknown state (fail closed)', () => {
    expect(() => assertTransition(AI_TURN_TRANSITIONS, 'streaming' as never, AiTurnStatus.COMPLETED)).toThrow(InvalidTransitionError);
  });
});
