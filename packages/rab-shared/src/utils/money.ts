/**
 * All money in this system is an integer number of pence. Never a float —
 * floating-point pence silently drifts across enough shifts to misstate a
 * payslip. Every function here operates on and returns integers.
 */

export type Pence = number;

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer number of pence, got ${value}`);
  }
}

/**
 * `Pence` is a JS `number`, while the database column is `bigint`. A JS number is exact only up to
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1 pence, about £90 trillion); above that, distinct database values collapse onto
 * the same number and arithmetic silently loses pennies. No real amount gets near the limit, so crossing it is
 * treated as corruption: refuse instead of rounding (fail closed). Used by the server's bigint column transformer
 * on every read and write, and safe to call anywhere a pence value enters from outside.
 */
export function assertSafePence(value: number, label = 'pence value'): Pence {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer number of pence (|value| <= ${Number.MAX_SAFE_INTEGER}), got ${value}`);
  }
  return value;
}

export function addPence(...values: Pence[]): Pence {
  return values.reduce((sum, value) => {
    assertInteger(value, 'addPence operand');
    return sum + value;
  }, 0);
}

export function subtractPence(a: Pence, b: Pence): Pence {
  assertInteger(a, 'subtractPence minuend');
  assertInteger(b, 'subtractPence subtrahend');
  return a - b;
}

/**
 * Multiplies pence by a rational factor (e.g. an overtime multiplier or a
 * holiday accrual rate) and rounds to the nearest whole penny. Ties round
 * UP, towards +infinity (`Math.round` semantics): 2.5 -> 3 but -2.5 -> -2,
 * so a negative tie is NOT rounded away from zero. Every current caller
 * passes non-negative amounts, where this equals half-up. Rounding happens
 * once, at the line — never chained.
 */
export function multiplyPence(pence: Pence, factor: number): Pence {
  assertInteger(pence, 'multiplyPence base');
  return Math.round(pence * factor);
}

/**
 * Pro-rates a per-hour rate (in pence) across a whole number of worked
 * minutes. Rounds to the nearest penny, ties towards +infinity (see
 * multiplyPence).
 */
export function payForMinutes(ratePerHourPence: Pence, minutes: number): Pence {
  assertInteger(ratePerHourPence, 'payForMinutes rate');
  assertInteger(minutes, 'payForMinutes minutes');
  return Math.round((ratePerHourPence * minutes) / 60);
}

export function formatPence(pence: Pence, currency: 'GBP' = 'GBP'): string {
  assertInteger(pence, 'formatPence value');
  const pounds = pence / 100;
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pounds);
}
