import { computeWorkedDuration, computeWorkedMinutes } from './duration';

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

  // ---- M4 (owner decisions D7 / D9, 2026-11-21) ----
  const at = (hhmmss: string) => new Date(`2026-08-10T${hhmmss}Z`);

  it('D9: adds break milliseconds and rounds once (two 29.5-minute breaks deduct 59, not 60)', () => {
    const result = computeWorkedMinutes({
      clockInAt: at('06:00:00'),
      clockOutAt: at('14:00:00'),
      breaks: [
        { startedAt: at('09:00:00'), endedAt: at('09:29:30'), isPaid: false },
        { startedAt: at('12:00:00'), endedAt: at('12:29:30'), isPaid: false },
      ],
    });
    expect(result.unpaidBreakMinutes).toBe(59);
    expect(result.workedMinutes).toBe(421);
  });

  it('D9: a break is clamped to the attendance (started before clock-in, ended after clock-out)', () => {
    const result = computeWorkedMinutes({
      clockInAt: at('06:00:00'),
      clockOutAt: at('14:00:00'),
      breaks: [
        { startedAt: at('05:50:00'), endedAt: at('06:10:00'), isPaid: false },
        { startedAt: at('13:50:00'), endedAt: at('14:30:00'), isPaid: false },
      ],
    });
    expect(result.unpaidBreakMinutes).toBe(20);
    expect(result.workedMinutes).toBe(460);
  });

  it('D9: a break entirely outside the attendance deducts nothing', () => {
    const result = computeWorkedMinutes({
      clockInAt: at('06:00:00'),
      clockOutAt: at('14:00:00'),
      breaks: [{ startedAt: at('15:00:00'), endedAt: at('15:30:00'), isPaid: false }],
    });
    expect(result.unpaidBreakMinutes).toBe(0);
    expect(result.workedMinutes).toBe(480);
  });

  it('D9: overlapping breaks are refused (RangeError), touching breaks are fine', () => {
    expect(() =>
      computeWorkedMinutes({
        clockInAt: at('06:00:00'),
        clockOutAt: at('14:00:00'),
        breaks: [
          { startedAt: at('10:00:00'), endedAt: at('10:30:00'), isPaid: false },
          { startedAt: at('10:29:00'), endedAt: at('10:40:00'), isPaid: true },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeWorkedMinutes({
        clockInAt: at('06:00:00'),
        clockOutAt: at('14:00:00'),
        breaks: [
          { startedAt: at('10:00:00'), endedAt: null, isPaid: false },
          { startedAt: at('11:00:00'), endedAt: at('11:10:00'), isPaid: false },
        ],
      }),
    ).toThrow('breaks must not overlap');
    const touching = computeWorkedMinutes({
      clockInAt: at('06:00:00'),
      clockOutAt: at('14:00:00'),
      breaks: [
        { startedAt: at('10:00:00'), endedAt: at('10:30:00'), isPaid: false },
        { startedAt: at('10:30:00'), endedAt: at('10:40:00'), isPaid: false },
      ],
    });
    expect(touching.unpaidBreakMinutes).toBe(40);
  });

  it('a break that ends before it starts is refused', () => {
    expect(() =>
      computeWorkedMinutes({
        clockInAt: at('06:00:00'),
        clockOutAt: at('14:00:00'),
        breaks: [{ startedAt: at('10:30:00'), endedAt: at('10:00:00'), isPaid: false }],
      }),
    ).toThrow(RangeError);
  });

  it('D7: any offline break floors the deduction at the scheduled break, decided inside duration.ts', () => {
    const base = { clockInAt: at('06:00:00'), clockOutAt: at('14:00:00'), scheduledBreakMinutes: 30 };
    const offlineShort = computeWorkedMinutes({ ...base, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:12:00'), isPaid: false, source: 'offline' }] });
    expect(offlineShort).toEqual({ grossMinutes: 480, unpaidBreakMinutes: 30, workedMinutes: 450 });
    // The same short break recorded online: A4, the recorded break wins (12 minutes).
    const onlineShort = computeWorkedMinutes({ ...base, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:12:00'), isPaid: false, source: 'online' }] });
    expect(onlineShort.unpaidBreakMinutes).toBe(12);
    expect(computeWorkedMinutes({ ...base, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:12:00'), isPaid: false }] }).unpaidBreakMinutes).toBe(12);
    // One offline break among online ones still floors the total; a longer recorded total stands.
    const mixed = computeWorkedMinutes({
      ...base,
      breaks: [
        { startedAt: at('09:00:00'), endedAt: at('09:05:00'), isPaid: false },
        { startedAt: at('12:00:00'), endedAt: at('12:10:00'), isPaid: false, source: 'offline' },
      ],
    });
    expect(mixed.unpaidBreakMinutes).toBe(30);
    const longOffline = computeWorkedMinutes({ ...base, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:45:00'), isPaid: false, source: 'offline' }] });
    expect(longOffline.unpaidBreakMinutes).toBe(45);
    // A paid offline break does not count as unpaid time; the floor still applies.
    const paidOffline = computeWorkedMinutes({ ...base, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:45:00'), isPaid: true, source: 'offline' }] });
    expect(paidOffline.unpaidBreakMinutes).toBe(30);
    // breaksPaidByDefault: the schedule deducts nothing, so neither does the floor.
    expect(computeWorkedMinutes({ ...base, breaksPaidByDefault: true, breaks: [{ startedAt: at('10:00:00'), endedAt: at('10:05:00'), isPaid: false, source: 'offline' }] }).unpaidBreakMinutes).toBe(5);
  });

  it('D7 precedence: a manager-confirmed break beats recorded breaks (offline floor included) and the schedule', () => {
    const base = { clockInAt: at('06:00:00'), clockOutAt: at('14:00:00'), scheduledBreakMinutes: 30 };
    const recorded = [{ startedAt: at('10:00:00'), endedAt: at('10:45:00'), isPaid: false, source: 'offline' as const }];
    expect(computeWorkedMinutes({ ...base, breaks: recorded, confirmedBreakMinutes: 20 })).toEqual({ grossMinutes: 480, unpaidBreakMinutes: 20, workedMinutes: 460 });
    expect(computeWorkedMinutes({ ...base, confirmedBreakMinutes: 0 }).workedMinutes).toBe(480);
    expect(computeWorkedMinutes({ ...base, breaks: recorded, confirmedBreakMinutes: null }).unpaidBreakMinutes).toBe(45);
  });

  it('a negative or fractional scheduled / confirmed break is refused (it would inflate worked time)', () => {
    for (const bad of [-1, -30, 1.5, Number.NaN]) {
      expect(() => computeWorkedMinutes({ clockInAt: at('06:00:00'), clockOutAt: at('14:00:00'), scheduledBreakMinutes: bad })).toThrow(RangeError);
      expect(() => computeWorkedMinutes({ clockInAt: at('06:00:00'), clockOutAt: at('14:00:00'), confirmedBreakMinutes: bad })).toThrow(RangeError);
    }
  });

  it('gross - break = worked exactly in minutes (worked rounded once), even when the break exceeds the shift', () => {
    const tiny = computeWorkedMinutes({
      clockInAt: at('06:00:00'),
      clockOutAt: at('06:20:00'),
      scheduledBreakMinutes: 30,
      breaks: [{ startedAt: at('06:05:00'), endedAt: at('06:10:00'), isPaid: false, source: 'offline' }],
    });
    expect(tiny).toEqual({ grossMinutes: 20, unpaidBreakMinutes: 20, workedMinutes: 0 });
    for (const [inAt, outAt, bStart, bEnd] of [
      ['06:00:00', '09:10:45', '07:00:00', '07:20:15'],
      ['06:00:20', '13:59:50', '10:00:40', '10:29:30'],
      ['06:00:31', '06:59:29', '06:10:29', '06:20:31'],
    ]) {
      const r = computeWorkedMinutes({ clockInAt: at(inAt!), clockOutAt: at(outAt!), breaks: [{ startedAt: at(bStart!), endedAt: at(bEnd!), isPaid: false }] });
      expect(r.grossMinutes - r.unpaidBreakMinutes).toBe(r.workedMinutes);
    }
  });

  it('unchanged without recorded breaks: the scheduled break and the paid-by-default override behave as before', () => {
    const withSeconds = computeWorkedMinutes({ clockInAt: at('06:00:00'), clockOutAt: at('14:00:30'), scheduledBreakMinutes: 30 });
    expect(withSeconds).toEqual({ grossMinutes: 481, unpaidBreakMinutes: 30, workedMinutes: 451 });
    const paid = computeWorkedMinutes({ clockInAt: at('06:00:00'), clockOutAt: at('14:00:00'), scheduledBreakMinutes: 30, breaksPaidByDefault: true });
    expect(paid).toEqual({ grossMinutes: 480, unpaidBreakMinutes: 0, workedMinutes: 480 });
  });

  it('computeWorkedDuration returns the milliseconds computeWorkedMinutes rounds (one source for the live total and the payslip)', () => {
    const input = {
      clockInAt: at('06:00:00'),
      clockOutAt: at('09:10:45'),
      breaks: [{ startedAt: at('07:00:00'), endedAt: at('07:20:15'), isPaid: false }],
    };
    const ms = computeWorkedDuration(input);
    expect(ms).toEqual({ grossMs: 11_445_000, unpaidBreakMs: 1_215_000, workedMs: 10_230_000 });
    expect(computeWorkedMinutes(input)).toEqual({ grossMinutes: 191, unpaidBreakMinutes: 20, workedMinutes: 171 });
  });

  it('refuses invalid dates', () => {
    expect(() => computeWorkedMinutes({ clockInAt: new Date('nope'), clockOutAt: at('14:00:00') })).toThrow(RangeError);
  });
});

