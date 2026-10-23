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

  it('a provisional no-show can only be superseded by recorded attendance (completed), never re-confirmed or cancelled', () => {
    expect(SHIFT_ASSIGNMENT_TRANSITIONS[ShiftAssignmentStatus.NO_SHOW]).toEqual([ShiftAssignmentStatus.COMPLETED]);
    expect(SHIFT_ASSIGNMENT_TRANSITIONS[ShiftAssignmentStatus.COMPLETED]).toEqual([]);
  });
});
