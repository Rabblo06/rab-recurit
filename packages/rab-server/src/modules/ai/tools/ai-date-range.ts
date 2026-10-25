import { z } from 'zod';

/**
 * Tool date inputs are LOCAL calendar days (`YYYY-MM-DD`) in the organisation's timezone; a range [from, to] covers both
 * days completely. Converted to absolute instants here, never by the model. Pure.
 */
export const isoDay = z.iso.date();

/** `from`/`to` local days (strict object: unknown keys are rejected). */
export const rangeShape = {
  from: isoDay.describe('First day, YYYY-MM-DD (organisation local date).'),
  to: isoDay.describe('Last day, YYYY-MM-DD, inclusive.'),
};

/** A range is valid when `to` is on/after `from` and it spans at most `maxDays` days. */
export function rangeWithin(maxDays: number) {
  return (v: { from: string; to: string }) => v.to >= v.from && dayDiff(v.from, v.to) < maxDays;
}

export function rangeInput(maxDays: number) {
  return z.strictObject(rangeShape).refine(rangeWithin(maxDays), { message: `"to" must be on or after "from" and the range at most ${maxDays} days.` });
}

export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
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

/** The instant local midnight of `day` occurs in `timeZone` (DST-correct; an unknown zone falls back to Europe/London). */
export function zonedMidnight(day: string, timeZone: string): Date {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'Europe/London';
  const guess = Date.parse(`${day}T00:00:00Z`);
  let instant = guess - offsetMs(new Date(guess), zone);
  instant = guess - offsetMs(new Date(instant), zone);
  return new Date(instant);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** [local midnight of `from`, local midnight of the day after `to`). */
export function localRange(from: string, to: string, timeZone: string): { from: Date; to: Date } {
  return { from: zonedMidnight(from, timeZone), to: zonedMidnight(addDays(to, 1), timeZone) };
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
