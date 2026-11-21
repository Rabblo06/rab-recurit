import { ShiftAssignmentStatus, ShiftStatus } from '../types';
import { assertTransition } from './assert-transition';
import { OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS, SHIFT_ASSIGNMENT_TRANSITIONS, SHIFT_TRANSITIONS } from './shift-transitions';
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

describe('OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS (M4 D6, offline sync only)', () => {
  it('names exactly one edge: a provisional no-show superseded by an offline clock-in (no_show -> confirmed)', () => {
    expectExhaustiveTransitionTable(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS, Object.values(ShiftAssignmentStatus));
    const edges = Object.entries(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS).flatMap(([from, to]) => to.map((t) => `${from}->${t}`));
    expect(edges).toEqual(['no_show->confirmed']);
  });

  it('the general table still refuses no_show -> confirmed: no other caller gains the edge', () => {
    expect(() => assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus.NO_SHOW, ShiftAssignmentStatus.CONFIRMED)).toThrow();
    expect(Object.isFrozen(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS)).toBe(true);
  });
});
