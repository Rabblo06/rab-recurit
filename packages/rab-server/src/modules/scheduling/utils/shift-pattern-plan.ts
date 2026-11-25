import { WEEKDAY_NAMES, WeekdayName } from '@rab/shared';

import { addDays, dayDiff } from '../../ai/tools/ai-date-range';
import { DraftCandidate } from './draft-batch-plan';

/**
 * Pure occurrence generator for the recurring shift pattern ("every Mon/Wed/Fri 18:00–23:00 from A to B, every N
 * weeks"). Dates and times are the organisation's wall clock: an occurrence is 18:00 local on its own date, whatever
 * the UTC offset that day (so a clock change moves the UTC instant, never the local time). An end time at or before
 * the start time means the shift ends on the next local day.
 */

/** The longest pattern one request may span (inclusive days). */
export const SHIFT_PATTERN_MAX_DAYS = 92;
export const SHIFT_PATTERN_MAX_INTERVAL_WEEKS = 4;

export interface ShiftPatternDefinition {
  venueId: string;
  jobRoleId: string;
  /** First and last organisation-local day, YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  weekdays: WeekdayName[];
  /** HH:MM, 24-hour. */
  startTime: string;
  endTime: string;
  /** 1 = every week, 2 = every other week (counted from the week containing `startDate`, Monday-first). */
  intervalWeeks: number;
  breakMinutes: number;
  requiredCount: number;
  chargeRatePence: number;
  notes: string | null;
}

/** Why a definition is refused outright (the whole request is a 400, nothing is planned). */
export function patternDefinitionError(def: ShiftPatternDefinition): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(def.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(def.endDate)) return 'Start and end dates must be YYYY-MM-DD.';
  if (Number.isNaN(Date.parse(`${def.startDate}T00:00:00Z`)) || Number.isNaN(Date.parse(`${def.endDate}T00:00:00Z`))) return 'Start and end dates must be real dates.';
  if (new Date(`${def.startDate}T00:00:00Z`).toISOString().slice(0, 10) !== def.startDate || new Date(`${def.endDate}T00:00:00Z`).toISOString().slice(0, 10) !== def.endDate) {
    return 'Start and end dates must be real dates.';
  }
  if (def.endDate < def.startDate) return 'The end date must be on or after the start date.';
  if (dayDiff(def.startDate, def.endDate) >= SHIFT_PATTERN_MAX_DAYS) return `A pattern can cover at most ${SHIFT_PATTERN_MAX_DAYS} days.`;
  if (!Array.isArray(def.weekdays) || def.weekdays.length === 0 || def.weekdays.some((d) => !WEEKDAY_NAMES.includes(d))) return 'Choose at least one weekday.';
  if (!isTime(def.startTime) || !isTime(def.endTime)) return 'Times must be HH:MM (24-hour).';
  if (def.startTime === def.endTime) return 'A shift must end after it starts.';
  if (!Number.isInteger(def.intervalWeeks) || def.intervalWeeks < 1 || def.intervalWeeks > SHIFT_PATTERN_MAX_INTERVAL_WEEKS) {
    return `Repeat every 1 to ${SHIFT_PATTERN_MAX_INTERVAL_WEEKS} weeks.`;
  }
  if (!Number.isInteger(def.requiredCount) || def.requiredCount < 1) return 'The number of people needed must be a whole number of at least 1.';
  if (!Number.isInteger(def.breakMinutes) || def.breakMinutes < 0) return 'Break minutes must be a whole number of at least 0.';
  if (def.breakMinutes >= nominalMinutes(def.startTime, def.endTime)) return 'The break must be shorter than the shift.';
  if (!Number.isInteger(def.chargeRatePence) || def.chargeRatePence < 0) return 'The charge rate must be a whole number of pence, at least 0.';
  return null;
}

/** Wall-clock length of HH:MM → HH:MM (overnight when the end is at or before the start), ignoring clock changes. */
function nominalMinutes(start: string, end: string): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const diff = toMin(end) - toMin(start);
  return diff > 0 ? diff : diff + 24 * 60;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant `time` on local `day` occurs in `timeZone`. A wall time inside a spring-forward gap (01:30 on the UK
 * change day) resolves to the instant one hour later on the new offset, the usual convention.
 */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T${time}:00Z`);
  let instant = guess - offsetMs(new Date(guess), timeZone);
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Monday-first weekday name of a YYYY-MM-DD civil date. */
export function weekdayOf(day: string): WeekdayName {
  return WEEKDAY_NAMES[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

/** Every occurrence of a VALID definition, as draft candidates keyed by their local date. */
export function patternOccurrences(def: ShiftPatternDefinition, timeZone: string): DraftCandidate[] {
  const days = new Set(def.weekdays);
  const firstMonday = addDays(def.startDate, -WEEKDAY_NAMES.indexOf(weekdayOf(def.startDate)));
  const overnight = def.endTime <= def.startTime;
  const out: DraftCandidate[] = [];
  for (let day = def.startDate; day <= def.endDate; day = addDays(day, 1)) {
    if (!days.has(weekdayOf(day))) continue;
    const weekIndex = Math.floor(dayDiff(firstMonday, day) / 7);
    if (weekIndex % def.intervalWeeks !== 0) continue;
    out.push({
      key: day,
      venueId: def.venueId,
      jobRoleId: def.jobRoleId,
      startsAt: zonedInstant(day, def.startTime, timeZone),
      endsAt: zonedInstant(overnight ? addDays(day, 1) : day, def.endTime, timeZone),
      breakMinutes: def.breakMinutes,
      requiredCount: def.requiredCount,
      chargeRatePence: def.chargeRatePence,
      notes: def.notes,
      address: null,
    });
  }
  return out;
}
