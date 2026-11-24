import { getLondonDateParts } from './date';

/**
 * Calendar dates (YYYY-MM-DD) in Europe/London, for rules that are about a DAY, not an instant (document expiry dates).
 * Shared by the API and the Worker so both decide "today" and "days left" the same way.
 */
export function londonCalendarDate(instant: Date): string {
  const p = getLondonDateParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); UTC arithmetic so a BST change never shifts a day. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}
