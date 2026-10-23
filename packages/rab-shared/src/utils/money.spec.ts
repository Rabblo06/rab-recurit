import { addPence, assertSafePence, formatPence, multiplyPence, payForMinutes, subtractPence } from './money';

describe('money', () => {
  it('adds pence exactly, no float drift', () => {
    expect(addPence(1250, 1275, 100)).toBe(2625);
  });

  it('rejects non-integer operands', () => {
    expect(() => addPence(12.5)).toThrow(RangeError);
  });

  it('subtracts pence', () => {
    expect(subtractPence(1000, 375)).toBe(625);
  });

  it('rounds a multiplied amount to the nearest penny', () => {
    // 12.07% holiday accrual on £406.25 (40625p)
    expect(multiplyPence(40625, 0.1207)).toBe(4903);
  });

  it('pro-rates an hourly rate across worked minutes', () => {
    // £12.50/hr for 32.5 hours (1950 minutes) = £406.25
    expect(payForMinutes(1250, 1950)).toBe(40625);
  });

  it('formats pence as GBP', () => {
    expect(formatPence(40625)).toBe('£406.25');
  });

  // Wave 2 lane S2 (C1/C2): bigint-safe pence boundary and the documented rounding direction.
  it('assertSafePence accepts every safe integer, including both boundaries', () => {
    expect(assertSafePence(0)).toBe(0);
    expect(assertSafePence(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(assertSafePence(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('assertSafePence refuses 2^53 and beyond, fractions, NaN and infinities (no silent rounding)', () => {
    for (const bad of [2 ** 53, 2 ** 53 + 2, -(2 ** 53), 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => assertSafePence(bad, 'test')).toThrow(RangeError);
    }
  });

  it('ties round towards +infinity (Math.round), as the comment now states', () => {
    expect(multiplyPence(5, 0.5)).toBe(3); // 2.5 -> 3
    expect(multiplyPence(-5, 0.5)).toBe(-2); // -2.5 -> -2, not away from zero
    expect(payForMinutes(1, 30)).toBe(1); // 0.5 -> 1
  });

  it('payForMinutes equals an exact BigInt half-up reference across a deterministic sweep', () => {
    // Reference: floor((rate * minutes * 2 + 60) / 120) for non-negative inputs == round-half-up of rate*minutes/60.
    const ref = (rate: number, minutes: number): number =>
      Number((BigInt(rate) * BigInt(minutes) * 2n + 60n) / 120n);
    let seed = 0x2545f491;
    const next = (mod: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % mod;
    };
    for (let i = 0; i < 5000; i++) {
      const rate = next(100_000); // up to £1,000/hour
      const minutes = next(24 * 60 * 7); // up to a week
      expect(payForMinutes(rate, minutes)).toBe(ref(rate, minutes));
    }
  });
});
