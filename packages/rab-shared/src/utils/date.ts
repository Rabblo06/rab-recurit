/**
 * Europe/London-aware date helpers. Pay periods and shift-boundary logic
 * must be computed from wall-clock London time, then converted to UTC
 * instants — never by adding/subtracting fixed hour offsets, which breaks
 * across the BST/GMT change (see rab-workforce-architecture.md §13).
 */

export const LONDON_TIMEZONE = 'Europe/London';

export interface LondonDateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  /** ISO weekday: 1 = Monday ... 7 = Sunday */
  weekday: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function getLondonDateParts(instant: Date): LondonDateParts {
  const parts = partsFormatter.formatToParts(instant);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    weekday: ISO_WEEKDAY[lookup.weekday],
  };
}

/**
 * Minutes `timeZone` is ahead of UTC at `instant` (e.g. Europe/London in
 * BST → 60). Reads the zone's wall-clock time at that instant via
 * `formatToParts` and diffs it against the instant itself — no string
 * round-trip through `Date`, so it is correct regardless of the running
 * process's own local timezone. (An earlier version of this file used a
 * `toLocaleString` + `new Date(string)` round-trip, which silently returned
 * the wrong instant whenever the process's local timezone happened to equal
 * `timeZone` — `new Date(string)` parses using local time, so the "London"
 * offset got applied twice in that case, cancelling itself out.)
 */
function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24; // ICU can format midnight as "24"
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * Converts a wall-clock date/time in a given IANA time zone to the UTC
 * instant it represents. Accurate everywhere except the ambiguous/skipped
 * local hour at a DST transition itself, which pay-period boundaries
 * (00:00) never land in for London.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * 60_000);
}

export interface PayPeriod {
  /** Inclusive start: Monday 00:00 Europe/London. */
  startsOn: Date;
  /** Exclusive end: the following Monday 00:00 Europe/London. */
  endsOnExclusive: Date;
}

/**
 * Weekly pay period containing `instant`, Mon 00:00 – Sun 23:59:59.999
 * Europe/London (A7). A shift belongs to the period containing its
 * *scheduled start* — callers pass the shift's scheduled start, not "now".
 */
export function getWeeklyPayPeriod(instant: Date): PayPeriod {
  const { year, month, day, weekday } = getLondonDateParts(instant);
  const daysSinceMonday = weekday - 1;

  // Step back to Monday using a noon UTC guess (clear of any DST edge),
  // then re-derive the London calendar date for that instant so the
  // Monday's Y/M/D is always correct even if `instant` was itself near
  // midnight.
  const mondayNoonGuess = new Date(Date.UTC(year, month - 1, day - daysSinceMonday, 12));
  const monday = getLondonDateParts(mondayNoonGuess);

  const startsOn = zonedTimeToUtc(monday.year, monday.month, monday.day, 0, 0, 0, LONDON_TIMEZONE);

  const nextMondayNoonGuess = new Date(Date.UTC(monday.year, monday.month - 1, monday.day + 7, 12));
  const nextMonday = getLondonDateParts(nextMondayNoonGuess);
  const endsOnExclusive = zonedTimeToUtc(
    nextMonday.year,
    nextMonday.month,
    nextMonday.day,
    0,
    0,
    0,
    LONDON_TIMEZONE,
  );

  return { startsOn, endsOnExclusive };
}

export function isWithinPayPeriod(instant: Date, period: PayPeriod): boolean {
  return instant >= period.startsOn && instant < period.endsOnExclusive;
}
