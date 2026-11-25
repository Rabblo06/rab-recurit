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

const CURRENCY_SYMBOL: Readonly<Record<'GBP', string>> = Object.freeze({ GBP: '£' });

/**
 * Formats pence exactly, e.g. `-£1,234.56`: the en-GB currency format this function has always printed (sign first,
 * comma thousands separators, two decimals). The pounds/pence split is integer arithmetic, never a float division:
 * dividing by 100 as a float printed `formatPence(2^53 - 1)` as `£90,071,992,547,409.90` instead of `.91`.
 *
 * Accepts a `number` that is a safe integer (`assertSafePence`: past 2^53 - 1 a number no longer holds the exact
 * pence, so it is refused rather than printed as a plausible-looking wrong amount), or a `bigint` of any size (exact by
 * construction, e.g. a database bigint read without converting it). `-0` keeps printing `-£0.00`, as before.
 */
export function formatPence(pence: Pence | bigint, currency: 'GBP' = 'GBP'): string {
  const symbol = Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOL, currency) ? CURRENCY_SYMBOL[currency] : undefined;
  if (!symbol) throw new RangeError(`formatPence: unsupported currency ${String(currency)}`);
  let negative: boolean;
  let pounds: string;
  let penny: string;
  if (typeof pence === 'bigint') {
    negative = pence < 0n;
    const abs = negative ? -pence : pence;
    pounds = (abs / 100n).toString();
    penny = (abs % 100n).toString();
  } else {
    assertSafePence(pence, 'formatPence value');
    negative = pence < 0 || Object.is(pence, -0);
    const abs = Math.abs(pence);
    const rem = abs % 100; // exact for integers
    pounds = String((abs - rem) / 100); // an exact multiple of 100 in the safe range: the quotient is exact
    penny = String(rem);
  }
  const grouped = pounds.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${penny.padStart(2, '0')}`;
}

/**
 * Pence as a plain decimal string for machine-read files (payroll provider CSV): `-1234.56`, no currency symbol, no
 * thousands separator, two decimals. Integer arithmetic only (never `pence / 100` as a float), so every safe integer
 * prints exactly. A non-safe-integer is refused (assertSafePence).
 */
export function penceToDecimalString(pence: Pence): string {
  assertSafePence(pence, 'penceToDecimalString value');
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const rem = abs % 100;
  return `${negative ? '-' : ''}${(abs - rem) / 100}.${String(rem).padStart(2, '0')}`;
}

/**
 * Owner decision 4 (21 Nov 2026, assumption A3): the UK rolled-up holiday pay rate, 12.07% (5.6 weeks / 46.4 working
 * weeks), in basis points. The organisation setting may choose another rate, or "our payroll provider handles it".
 */
export const UK_ROLLED_UP_HOLIDAY_RATE_BPS = 1207;

/** Basis points in 100%. A rate is an integer number of basis points (12.07% = 1207). */
export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * Rolled-up holiday pay on one approved shift's gross pay, in pence. ROUNDING RULE (the repo's, stated once): the exact
 * product `basePence × rateBps / 10000` is rounded to the NEAREST penny, a half penny rounding UP (half-up; identical to
 * multiplyPence / payForMinutes for the non-negative amounts used here). It is computed with BigInt integer arithmetic,
 * never a float, so `4142 × 1207 / 10000 = 499.9394` gives exactly 500 and a true half (`x.5`) always rounds up. Rounding
 * happens ONCE per shift line; period and run totals are sums of the rounded lines and are never re-rounded.
 *
 * Fails closed (RangeError): a negative or non-integer base (holiday pay accrues on approved shift pay, which is never
 * negative), a rate that is not an integer between 0 and 10000 basis points, or a result outside the safe-integer range.
 */
export function rolledUpHolidayPayPence(basePence: Pence, rateBps: number): Pence {
  assertSafePence(basePence, 'rolledUpHolidayPayPence base');
  if (basePence < 0) throw new RangeError(`rolledUpHolidayPayPence base must not be negative, got ${basePence}`);
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > BASIS_POINTS_PER_UNIT) {
    throw new RangeError(`rolledUpHolidayPayPence rate must be an integer between 0 and ${BASIS_POINTS_PER_UNIT} basis points, got ${rateBps}`);
  }
  const units = BigInt(BASIS_POINTS_PER_UNIT);
  const rounded = (BigInt(basePence) * BigInt(rateBps) + units / 2n) / units;
  return assertSafePence(Number(rounded), 'rolledUpHolidayPayPence result');
}
