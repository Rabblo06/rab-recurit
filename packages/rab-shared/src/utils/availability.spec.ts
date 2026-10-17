import { findAvailabilityConflicts, formatWeekdayList, hasDeclaredAvailability, londonCalendarDays } from './availability';

// 2026-10-19 is a Monday. UK clocks go back (BST → GMT) at 02:00 BST on Sunday 2026-10-25,
// and forward (GMT → BST) at 01:00 GMT on Sunday 2026-03-29.
const TUE_SUN = ['Tuesday', 'Sunday'];

describe('londonCalendarDays', () => {
  it('maps each weekday Monday–Sunday from a London daytime shift', () => {
    const names = [19, 20, 21, 22, 23, 24, 25].map((d) => {
      const start = new Date(`2026-10-${d}T09:00:00+01:00`);
      return londonCalendarDays(start, new Date(start.getTime() + 4 * 3600_000))[0].weekday;
    });
    expect(names).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  });

  it('uses the London date, not UTC: 00:30 BST Monday is still Sunday in UTC', () => {
    const start = new Date('2026-10-19T00:30:00+01:00'); // 2026-10-18T23:30Z (Sunday UTC)
    expect(londonCalendarDays(start, new Date('2026-10-19T04:00:00+01:00'))).toEqual([{ date: '2026-10-19', weekday: 'Monday' }]);
  });

  it('includes both days of an overnight Sunday → Monday shift', () => {
    expect(londonCalendarDays(new Date('2026-10-18T22:00:00+01:00'), new Date('2026-10-19T06:00:00+01:00'))).toEqual([
      { date: '2026-10-18', weekday: 'Sunday' },
      { date: '2026-10-19', weekday: 'Monday' },
    ]);
  });

  it('does not count the next day when a shift ends exactly at midnight', () => {
    expect(londonCalendarDays(new Date('2026-10-20T18:00:00+01:00'), new Date('2026-10-21T00:00:00+01:00'))).toEqual([
      { date: '2026-10-20', weekday: 'Tuesday' },
    ]);
  });

  it('handles the BST → GMT change (25-hour night)', () => {
    // Sat 24 Oct 20:00 BST → Sun 25 Oct 08:00 GMT
    expect(londonCalendarDays(new Date('2026-10-24T20:00:00+01:00'), new Date('2026-10-25T08:00:00Z')).map((d) => d.weekday)).toEqual(['Saturday', 'Sunday']);
  });

  it('handles the GMT → BST change (23-hour night)', () => {
    // Sat 28 Mar 23:30 GMT → Sun 29 Mar 07:00 BST
    expect(londonCalendarDays(new Date('2026-03-28T23:30:00Z'), new Date('2026-03-29T07:00:00+01:00'))).toEqual([
      { date: '2026-03-28', weekday: 'Saturday' },
      { date: '2026-03-29', weekday: 'Sunday' },
    ]);
  });
});

describe('findAvailabilityConflicts', () => {
  it('permits a Tuesday shift and a Sunday shift for Tuesday/Sunday staff', () => {
    expect(findAvailabilityConflicts(TUE_SUN, new Date('2026-10-20T09:00:00+01:00'), new Date('2026-10-20T17:00:00+01:00'))).toEqual([]);
    expect(findAvailabilityConflicts(TUE_SUN, new Date('2026-10-25T09:00:00Z'), new Date('2026-10-25T17:00:00Z'))).toEqual([]);
  });

  it('reports Monday for Tuesday/Sunday staff', () => {
    expect(findAvailabilityConflicts(TUE_SUN, new Date('2026-10-19T09:00:00+01:00'), new Date('2026-10-19T17:00:00+01:00'))).toEqual([
      { date: '2026-10-19', weekday: 'Monday' },
    ]);
  });

  it('reports only the uncovered day of an overnight shift', () => {
    expect(findAvailabilityConflicts(TUE_SUN, new Date('2026-10-18T22:00:00+01:00'), new Date('2026-10-19T06:00:00+01:00'))).toEqual([
      { date: '2026-10-19', weekday: 'Monday' },
    ]);
  });

  it('treats missing availability as unknown, never as unavailable', () => {
    const start = new Date('2026-10-19T09:00:00+01:00');
    const end = new Date('2026-10-19T17:00:00+01:00');
    expect(findAvailabilityConflicts(null, start, end)).toBeNull();
    expect(findAvailabilityConflicts(undefined, start, end)).toBeNull();
    expect(findAvailabilityConflicts([], start, end)).toBeNull();
    expect(hasDeclaredAvailability([])).toBe(false);
  });
});

describe('formatWeekdayList', () => {
  it('lists days in calendar order with "and"', () => {
    expect(formatWeekdayList(['Sunday', 'Tuesday'])).toBe('Tuesday and Sunday');
    expect(formatWeekdayList(['Friday', 'Monday', 'Wednesday'])).toBe('Monday, Wednesday and Friday');
    expect(formatWeekdayList(['Monday'])).toBe('Monday');
  });
});
