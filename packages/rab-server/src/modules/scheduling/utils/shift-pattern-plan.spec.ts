import { ShiftPatternDefinition, patternDefinitionError, patternOccurrences, weekdayOf, zonedInstant } from './shift-pattern-plan';

const LONDON = 'Europe/London';
const base: ShiftPatternDefinition = {
  venueId: 'v1',
  jobRoleId: 'r1',
  startDate: '2026-03-23', // Monday
  endDate: '2026-04-05', // Sunday, two weeks later
  weekdays: ['Monday', 'Friday'],
  startTime: '18:00',
  endTime: '23:00',
  intervalWeeks: 1,
  breakMinutes: 30,
  requiredCount: 2,
  chargeRatePence: 0,
  notes: null,
};

describe('zonedInstant', () => {
  it('is the local wall time on either side of the UK spring clock change (29 March 2026)', () => {
    expect(zonedInstant('2026-03-27', '18:00', LONDON).toISOString()).toBe('2026-03-27T18:00:00.000Z'); // GMT
    expect(zonedInstant('2026-03-30', '18:00', LONDON).toISOString()).toBe('2026-03-30T17:00:00.000Z'); // BST
    expect(zonedInstant('2026-10-26', '00:00', LONDON).toISOString()).toBe('2026-10-26T00:00:00.000Z'); // back on GMT
  });
});

describe('patternOccurrences', () => {
  it('creates the chosen weekdays in the range at the local time, keyed by date', () => {
    const rows = patternOccurrences(base, LONDON);
    expect(rows.map((r) => r.key)).toEqual(['2026-03-23', '2026-03-27', '2026-03-30', '2026-04-03']);
    expect(rows.map((r) => weekdayOf(r.key))).toEqual(['Monday', 'Friday', 'Monday', 'Friday']);
    expect(rows[2]!.startsAt.toISOString()).toBe('2026-03-30T17:00:00.000Z'); // 18:00 BST
    expect(rows[2]!.endsAt.getTime() - rows[2]!.startsAt.getTime()).toBe(5 * 3_600_000);
    expect(rows[0]).toMatchObject({ venueId: 'v1', jobRoleId: 'r1', breakMinutes: 30, requiredCount: 2, address: null });
  });

  it('every other week counts from the week containing the start date', () => {
    const rows = patternOccurrences({ ...base, startDate: '2026-03-25', endDate: '2026-04-19', weekdays: ['Monday'], intervalWeeks: 2 }, LONDON);
    // Weeks of 23 Mar (start, but its Monday is before startDate), 6 Apr, 20 Apr (after end) → only 6 Apr.
    expect(rows.map((r) => r.key)).toEqual(['2026-04-06']);
  });

  it('an end time at or before the start time ends the next local day (overnight)', () => {
    const [night] = patternOccurrences({ ...base, startDate: '2026-06-01', endDate: '2026-06-01', weekdays: ['Monday'], startTime: '22:00', endTime: '06:00' }, LONDON);
    expect(night!.startsAt.toISOString()).toBe('2026-06-01T21:00:00.000Z');
    expect(night!.endsAt.toISOString()).toBe('2026-06-02T05:00:00.000Z');
  });
});

describe('patternDefinitionError', () => {
  it('accepts a valid definition', () => {
    expect(patternDefinitionError(base)).toBeNull();
  });

  it.each([
    [{ startDate: '2026-02-30' }, 'real dates'],
    [{ endDate: '2026-03-01' }, 'on or after'],
    [{ endDate: '2026-07-01' }, 'at most 92 days'],
    [{ weekdays: [] }, 'at least one weekday'],
    [{ weekdays: ['Funday'] }, 'at least one weekday'],
    [{ startTime: '24:00' }, 'HH:MM'],
    [{ endTime: '18:00' }, 'end after it starts'],
    [{ intervalWeeks: 0 }, '1 to 4 weeks'],
    [{ intervalWeeks: 5 }, '1 to 4 weeks'],
    [{ requiredCount: 0 }, 'at least 1'],
    [{ breakMinutes: 300 }, 'shorter than the shift'],
    [{ chargeRatePence: 1.5 }, 'whole number of pence'],
  ])('refuses %j', (patch, message) => {
    expect(patternDefinitionError({ ...base, ...(patch as Partial<ShiftPatternDefinition>) })).toContain(message);
  });
});
