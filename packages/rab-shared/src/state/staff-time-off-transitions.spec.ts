import { StaffTimeOffStatus } from '../types';
import { STAFF_TIME_OFF_TRANSITIONS } from './staff-time-off-transitions';
import { assertTransition } from './assert-transition';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('STAFF_TIME_OFF_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(
      STAFF_TIME_OFF_TRANSITIONS,
      Object.values(StaffTimeOffStatus),
    );
  });

  it('a request may be approved, declined or cancelled', () => {
    expect(
      [...STAFF_TIME_OFF_TRANSITIONS[StaffTimeOffStatus.REQUESTED]].sort(),
    ).toEqual(['approved', 'cancelled', 'declined']);
  });

  it('approved time off can only be cancelled; it is never re-decided or declined afterwards', () => {
    expect(STAFF_TIME_OFF_TRANSITIONS[StaffTimeOffStatus.APPROVED]).toEqual([
      StaffTimeOffStatus.CANCELLED,
    ]);
    expect(() =>
      assertTransition(
        STAFF_TIME_OFF_TRANSITIONS,
        StaffTimeOffStatus.APPROVED,
        StaffTimeOffStatus.DECLINED,
      ),
    ).toThrow();
  });

  it('declined and cancelled are final; nothing returns to requested', () => {
    expect(STAFF_TIME_OFF_TRANSITIONS[StaffTimeOffStatus.DECLINED]).toEqual([]);
    expect(STAFF_TIME_OFF_TRANSITIONS[StaffTimeOffStatus.CANCELLED]).toEqual(
      [],
    );
    for (const from of Object.values(StaffTimeOffStatus)) {
      expect(STAFF_TIME_OFF_TRANSITIONS[from]).not.toContain(
        StaffTimeOffStatus.REQUESTED,
      );
    }
  });

  it('an unknown state is refused, never passed through', () => {
    expect(() =>
      assertTransition(
        STAFF_TIME_OFF_TRANSITIONS,
        'archived' as never,
        StaffTimeOffStatus.CANCELLED,
      ),
    ).toThrow();
  });
});
