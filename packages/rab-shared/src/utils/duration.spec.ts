import { computeWorkedMinutes } from './duration';

describe('computeWorkedMinutes', () => {
  it('deducts the scheduled unpaid break by default when no break was recorded', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T14:00:00Z'),
      scheduledBreakMinutes: 30,
    });

    expect(result.grossMinutes).toBe(480);
    expect(result.unpaidBreakMinutes).toBe(30);
    expect(result.workedMinutes).toBe(450);
  });

  it('does not deduct anything when the venue/role marks breaks paid by default', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T14:00:00Z'),
      scheduledBreakMinutes: 30,
      breaksPaidByDefault: true,
    });

    expect(result.unpaidBreakMinutes).toBe(0);
    expect(result.workedMinutes).toBe(480);
  });

  it('prefers staff-recorded breaks over the scheduled default', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T14:00:00Z'),
      scheduledBreakMinutes: 30,
      breaks: [
        {
          startedAt: new Date('2026-08-10T10:00:00Z'),
          endedAt: new Date('2026-08-10T10:45:00Z'),
          isPaid: false,
        },
      ],
    });

    expect(result.unpaidBreakMinutes).toBe(45);
    expect(result.workedMinutes).toBe(435);
  });

  it('does not deduct a break explicitly marked paid', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T14:00:00Z'),
      breaks: [
        {
          startedAt: new Date('2026-08-10T10:00:00Z'),
          endedAt: new Date('2026-08-10T10:20:00Z'),
          isPaid: true,
        },
      ],
    });

    expect(result.unpaidBreakMinutes).toBe(0);
    expect(result.workedMinutes).toBe(480);
  });

  it('treats a still-open break as ending at clock-out', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T14:00:00Z'),
      breaks: [{ startedAt: new Date('2026-08-10T13:30:00Z'), endedAt: null, isPaid: false }],
    });

    expect(result.unpaidBreakMinutes).toBe(30);
    expect(result.workedMinutes).toBe(450);
  });

  it('never goes negative when breaks exceed the shift length', () => {
    const result = computeWorkedMinutes({
      clockInAt: new Date('2026-08-10T06:00:00Z'),
      clockOutAt: new Date('2026-08-10T06:30:00Z'),
      scheduledBreakMinutes: 60,
    });

    expect(result.workedMinutes).toBe(0);
  });

  it('rejects a clock-out before clock-in', () => {
    expect(() =>
      computeWorkedMinutes({
        clockInAt: new Date('2026-08-10T14:00:00Z'),
        clockOutAt: new Date('2026-08-10T06:00:00Z'),
      }),
    ).toThrow(RangeError);
  });
});
