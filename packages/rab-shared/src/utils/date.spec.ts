import { getLondonDateParts, getWeeklyPayPeriod, isWithinPayPeriod } from './date';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('getWeeklyPayPeriod', () => {
  it('always starts on a London Monday at 00:00', () => {
    const period = getWeeklyPayPeriod(new Date('2026-08-13T15:30:00Z'));
    const parts = getLondonDateParts(period.startsOn);
    expect(parts.weekday).toBe(1);

    const londonMidnight = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(period.startsOn);
    expect(londonMidnight).toBe('00:00');
  });

  it('is exactly 7 days for a week with no clock change', () => {
    const period = getWeeklyPayPeriod(new Date('2026-06-15T12:00:00Z'));
    expect(period.endsOnExclusive.getTime() - period.startsOn.getTime()).toBe(SEVEN_DAYS_MS);
  });

  it('shortens or lengthens by exactly one hour across the UK clock-change week', () => {
    let found = false;
    for (let d = 0; d < 365; d++) {
      const probe = new Date(Date.UTC(2026, 0, 1 + d, 12));
      const period = getWeeklyPayPeriod(probe);
      const lengthMs = period.endsOnExclusive.getTime() - period.startsOn.getTime();
      if (lengthMs !== SEVEN_DAYS_MS) {
        found = true;
        expect(Math.abs(lengthMs - SEVEN_DAYS_MS)).toBe(ONE_HOUR_MS);
      }
    }
    expect(found).toBe(true);
  });

  it('places a shift by its scheduled start, not by "now"', () => {
    const scheduledStart = new Date('2026-08-10T05:00:00Z'); // Monday
    const period = getWeeklyPayPeriod(scheduledStart);
    expect(isWithinPayPeriod(scheduledStart, period)).toBe(true);

    const nextWeekInstant = new Date(scheduledStart.getTime() + SEVEN_DAYS_MS);
    expect(isWithinPayPeriod(nextWeekInstant, period)).toBe(false);
  });
});
