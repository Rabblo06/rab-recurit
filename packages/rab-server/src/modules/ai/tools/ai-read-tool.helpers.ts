import { z } from 'zod';

import { isoDay, rangeShape, rangeWithin } from './ai-date-range';

/** Percentage with one decimal, or null when there is nothing to divide (never a guessed 0 % / 100 %). */
export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** A strict `{from, to, ...extra}` input with the range bound (organisation-local days, `to` inclusive). */
export function rangeWith<T extends z.ZodRawShape>(maxDays: number, extra: T) {
  return z.strictObject({ ...rangeShape, ...extra }).refine((v) => rangeWithin(maxDays)(v as { from: string; to: string }), { message: `"to" must be on or after "from" and the range at most ${maxDays} days.` });
}

/** An OPTIONAL range: both days or neither. */
export function optionalRange(maxDays: number) {
  return z
    .strictObject({ from: isoDay.optional().describe('First day, YYYY-MM-DD (organisation local date). Give both or neither.'), to: isoDay.optional().describe('Last day, YYYY-MM-DD, inclusive.') })
    .refine((v) => (v.from === undefined) === (v.to === undefined) && (v.from === undefined || rangeWithin(maxDays)({ from: v.from, to: v.to! })), {
      message: `Give both "from" and "to" (at most ${maxDays} days) or neither.`,
    });
}

/** `limit` argument: 1..max rows, default applied by the tool. */
export const limitArg = (max: number) => z.number().int().min(1).max(max).optional().describe(`How many rows to list (at most ${max}; default 10).`);
