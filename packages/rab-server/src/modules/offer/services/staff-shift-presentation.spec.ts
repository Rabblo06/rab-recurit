import { resolveStaffShiftPresentation as resolve } from './staff-shift-presentation';

const out = new Date('2026-09-22T17:00:00Z');
const base = {
  offerStatus: 'manager_confirmed',
  assignmentStatus: 'completed',
  shiftStatus: 'completed',
  attendanceStatus: 'clocked_out',
  clockInAt: new Date('2026-09-22T09:00:00Z'),
  clockOutAt: out,
  startsAt: new Date('2026-09-22T09:00:00Z'),
  endsAt: out,
  timezone: 'Europe/London',
  serverNow: out,
};
describe('staff shift display lifecycle (persisted worker milestones)', () => {
  it.each([
    [-1, 'live'],
    [0, 'clockedOut'],
    [7199, 'clockedOut'],
    [7200, 'complete'],
    [21599, 'complete'],
    [21600, 'expired'],
  ])('clock-out plus %s seconds is %s', (seconds, state) => {
    expect(
      resolve({
        ...base,
        serverNow: new Date(out.getTime() + Number(seconds) * 1000),
        completedAt:
          Number(seconds) >= 7200 ? new Date(out.getTime() + 7200000) : null,
        expiredAt:
          Number(seconds) >= 21600 ? new Date(out.getTime() + 21600000) : null,
      }).state,
    ).toBe(state);
  });
  it('returns the exact next reconciliation boundary', () => {
    expect(resolve(base).nextTransitionAt?.toISOString()).toBe(
      '2026-09-22T19:00:00.000Z',
    );
    expect(
      resolve({
        ...base,
        serverNow: new Date('2026-09-22T20:00:00Z'),
        completedAt: new Date('2026-09-22T19:00:00Z'),
      }).nextTransitionAt?.toISOString(),
    ).toBe('2026-09-22T23:00:00.000Z');
  });
  it('waits for the worker rather than advancing a read', () => {
    expect(
      resolve({ ...base, serverNow: new Date(out.getTime() + 7 * 3600000) })
        .state,
    ).toBe('clockedOut');
  });
  it('does not call a staff acceptance confirmed', () => {
    expect(
      resolve({
        ...base,
        clockInAt: null,
        clockOutAt: null,
        offerStatus: 'staff_accepted',
        assignmentStatus: 'staff_accepted',
      }).state,
    ).toBe('pending');
  });
  it('distinguishes offer expiry from post-attendance display expiry', () => {
    expect(
      resolve({
        ...base,
        clockInAt: null,
        clockOutAt: null,
        offerStatus: 'expired',
      }).state,
    ).toBe('expired');
    expect(base.offerStatus).toBe('manager_confirmed');
  });
  it('uses the organisation day across midnight and DST', () => {
    const p = resolve({
      ...base,
      clockInAt: null,
      clockOutAt: null,
      assignmentStatus: 'confirmed',
      shiftStatus: 'confirmed',
      serverNow: new Date('2026-09-22T23:30:00Z'),
      startsAt: new Date('2026-09-23T08:00:00Z'),
      endsAt: new Date('2026-09-23T16:00:00Z'),
    });
    expect(p.isToday).toBe(true);
    expect(p.homeLabel).toBe("Today's Shift");
    expect(
      resolve({
        ...base,
        clockInAt: null,
        clockOutAt: null,
        assignmentStatus: 'confirmed',
        shiftStatus: 'confirmed',
        serverNow: new Date('2026-09-21T12:00:00Z'),
      }).homeLabel,
    ).toBe('Next Shift');
  });
  it('restores from persisted timestamps after three and seven hours', () => {
    expect(
      resolve({
        ...base,
        serverNow: new Date(out.getTime() + 3 * 3600000),
        completedAt: new Date(out.getTime() + 7200000),
      }).state,
    ).toBe('complete');
    expect(
      resolve({
        ...base,
        serverNow: new Date(out.getTime() + 7 * 3600000),
        completedAt: new Date(out.getTime() + 7200000),
        expiredAt: new Date(out.getTime() + 21600000),
      }).state,
    ).toBe('expired');
  });
});
