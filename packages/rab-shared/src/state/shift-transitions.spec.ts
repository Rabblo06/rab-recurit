import { ShiftAssignmentStatus, ShiftStatus } from '../types';
import { SHIFT_ASSIGNMENT_TRANSITIONS, SHIFT_TRANSITIONS } from './shift-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('SHIFT_TRANSITIONS', () => {
  it('exhaustively matches the documented table (§1.1)', () => {
    expectExhaustiveTransitionTable(SHIFT_TRANSITIONS, Object.values(ShiftStatus));
  });

  it('has no transitions out of completed or cancelled', () => {
    expect(SHIFT_TRANSITIONS[ShiftStatus.COMPLETED]).toEqual([]);
    expect(SHIFT_TRANSITIONS[ShiftStatus.CANCELLED]).toEqual([]);
  });
});

describe('SHIFT_ASSIGNMENT_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(SHIFT_ASSIGNMENT_TRANSITIONS, Object.values(ShiftAssignmentStatus));
  });
});
