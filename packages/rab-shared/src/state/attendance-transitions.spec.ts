import { AttendanceStatus } from '../types';
import { ATTENDANCE_TRANSITIONS } from './attendance-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('ATTENDANCE_TRANSITIONS', () => {
  it('exhaustively matches the documented table (§1.1)', () => {
    expectExhaustiveTransitionTable(ATTENDANCE_TRANSITIONS, Object.values(AttendanceStatus));
  });

  it('approved is terminal — reopening requires an attendance_correction row, not a status write', () => {
    expect(ATTENDANCE_TRANSITIONS[AttendanceStatus.APPROVED]).toEqual([]);
  });

  it('a scheduled shift can only become clocked-in or absent', () => {
    expect(ATTENDANCE_TRANSITIONS[AttendanceStatus.SCHEDULED]).toEqual(
      expect.arrayContaining([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ABSENT]),
    );
  });

  it('M4: an attendance left on a break past the grace is flagged missing_clock_out (the monitor never leaves it open)', () => {
    expect(ATTENDANCE_TRANSITIONS[AttendanceStatus.ON_BREAK]).toEqual([AttendanceStatus.CLOCKED_IN, AttendanceStatus.CLOCKED_OUT, AttendanceStatus.MISSING_CLOCK_OUT]);
  });
});
