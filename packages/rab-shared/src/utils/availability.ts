import { getLondonDateParts } from './date';

/**
 * Staff weekday availability (`staff_profile.available_days`), as stored: full English weekday names. This is the one
 * definition of "which calendar days does a shift touch, and which of them did the staff member not mark as available",
 * shared by the offer dispatch boundary (server) and any client that previews the same answer.
 *
 * Days are UK calendar days (Europe/London): no venue-level timezone exists, and the replacement-staff worker already
 * reads availability the same way. Working on London civil dates (not 24-hour steps) makes BST/GMT changes irrelevant.
 */
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

export interface LondonCalendarDay {
  /** YYYY-MM-DD in Europe/London. */
  date: string;
  weekday: WeekdayName;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Guard against a malformed window producing an unbounded loop; real shifts span one or two days. */
const MAX_DAYS = 31;

function civilDay(utcMidnightMs: number): LondonCalendarDay {
  const d = new Date(utcMidnightMs);
  const iso = d.toISOString().slice(0, 10);
  // getUTCDay: 0 = Sunday … 6 = Saturday → WEEKDAY_NAMES index (0 = Monday).
  return { date: iso, weekday: WEEKDAY_NAMES[(d.getUTCDay() + 6) % 7] };
}

/**
 * Every London calendar day the window [startsAt, endsAt) touches, in order. A shift ending exactly at midnight does not
 * touch the next day; an overnight shift (22:00 Mon → 06:00 Tue) touches both.
 */
export function londonCalendarDays(startsAt: Date, endsAt: Date): LondonCalendarDay[] {
  const start = getLondonDateParts(startsAt);
  const lastInstant = new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1));
  const end = getLondonDateParts(lastInstant);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  const last = Date.UTC(end.year, end.month - 1, end.day);
  const days: LondonCalendarDay[] = [];
  for (let t = first; t <= last && days.length < MAX_DAYS; t += DAY_MS) days.push(civilDay(t));
  return days;
}

/** True when the staff member has declared availability at all. NULL and [] both mean "not provided", never "none". */
export function hasDeclaredAvailability(availableDays: readonly string[] | null | undefined): availableDays is readonly string[] {
  return Array.isArray(availableDays) && availableDays.length > 0;
}

/**
 * The calendar days of [startsAt, endsAt) that fall outside the declared weekdays, or `null` when availability was never
 * provided (unknown is not a conflict). An empty array means every touched day is a declared available day.
 */
export function findAvailabilityConflicts(
  availableDays: readonly string[] | null | undefined,
  startsAt: Date,
  endsAt: Date,
): LondonCalendarDay[] | null {
  if (!hasDeclaredAvailability(availableDays)) return null;
  const allowed = new Set(availableDays);
  return londonCalendarDays(startsAt, endsAt).filter((day) => !allowed.has(day.weekday));
}

/** "Tuesday and Sunday", "Monday, Wednesday and Friday" — declared days in calendar order. */
export function formatWeekdayList(days: readonly string[]): string {
  const ordered = WEEKDAY_NAMES.filter((name) => days.includes(name));
  if (ordered.length <= 1) return ordered.join('');
  return `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}`;
}
