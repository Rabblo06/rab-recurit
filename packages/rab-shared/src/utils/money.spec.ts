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

// formatPence: exact formatting (integer split, never a float division by 100).
describe('formatPence', () => {
  /** The format formatPence has always printed (Intl en-GB GBP: "-£1,234.56"), computed independently with BigInt. */
  const grouping = new Intl.NumberFormat('en-GB', { useGrouping: true, maximumFractionDigits: 0 });
  const reference = (pence: bigint): string => {
    const negative = pence < 0n;
    const abs = negative ? -pence : pence;
    return `${negative ? '-' : ''}£${grouping.format(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
  };
  /** The implementation before this change (float division), kept only to prove identical output where it was exact. */
  const legacy = (pence: number): string => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

  const MAX = Number.MAX_SAFE_INTEGER;
  const BOUNDARIES = [0, 1, -1, 99, -99, 100, -100, 101, -101, 999, 1000, 99_999, 100_000, 100_000_000, MAX, -MAX, MAX - 1, -(MAX - 1), MAX - 99, MAX - 100];

  // Deterministic PRNG (same LCG style as the payForMinutes sweep): random safe integers of every magnitude.
  let seed = 0x5eed1234;
  const nextU32 = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const randomSafe = (): number => {
    const digits = 1 + (nextU32() % 16); // 1..16 digits; 2^53 - 1 has 16
    let s = '';
    for (let i = 0; i < digits; i++) s += String(nextU32() % 10);
    const big = BigInt(s) % (BigInt(MAX) + 1n);
    return (nextU32() & 1 ? -1 : 1) * Number(big);
  };
  const SAMPLES = [...BOUNDARIES, ...Array.from({ length: 20_000 }, randomSafe)];

  it('formats the documented examples', () => {
    expect(formatPence(40625)).toBe('£406.25');
    expect(formatPence(0)).toBe('£0.00');
    expect(formatPence(1)).toBe('£0.01');
    expect(formatPence(-1)).toBe('-£0.01');
    expect(formatPence(99)).toBe('£0.99');
    expect(formatPence(100)).toBe('£1.00');
    expect(formatPence(-100)).toBe('-£1.00');
    expect(formatPence(123_456_789)).toBe('£1,234,567.89');
    expect(formatPence(-123_456_789)).toBe('-£1,234,567.89');
  });

  it('is exact at ±(2^53 - 1): the float division printed .90, the value is .91', () => {
    expect(formatPence(MAX)).toBe('£90,071,992,547,409.91');
    expect(formatPence(-MAX)).toBe('-£90,071,992,547,409.91');
    expect(legacy(MAX)).toBe('£90,071,992,547,409.90'); // the defect being fixed, pinned so the reference stays honest
  });

  it('equals an exact BigInt reference for every boundary and 20,000 random safe integers', () => {
    for (const p of SAMPLES) expect(formatPence(p)).toBe(reference(BigInt(p)));
  });

  it('prints exactly what the previous implementation printed wherever that one was exact', () => {
    let compared = 0;
    for (const p of SAMPLES) {
      const old = legacy(p);
      if (old !== reference(BigInt(p))) continue; // float rounding: the old output was wrong for this value
      expect(formatPence(p)).toBe(old);
      compared++;
    }
    // Every value up to 10^13 pence (£100bn) was exact before, so the old and new outputs agree on all of them.
    for (let i = 0; i < 5_000; i++) {
      const p = (nextU32() & 1 ? -1 : 1) * ((nextU32() * 2_329 + nextU32()) % 10_000_000_000_000);
      expect(formatPence(p)).toBe(legacy(p));
    }
    expect(compared).toBeGreaterThan(SAMPLES.length / 2);
  });

  it('keeps the previous output for -0 (Intl printed "-£0.00")', () => {
    expect(legacy(-0)).toBe('-£0.00');
    expect(formatPence(-0)).toBe('-£0.00');
  });

  it('accepts bigint, with the same output as the number form, and exactly beyond 2^53', () => {
    for (const p of SAMPLES) expect(formatPence(BigInt(p))).toBe(formatPence(p));
    expect(formatPence(9_007_199_254_740_993n)).toBe('£90,071,992,547,409.93');
    expect(formatPence(-123_456_789_012_345_678_901n)).toBe('-£1,234,567,890,123,456,789.01');
    expect(formatPence(0n)).toBe('£0.00');
    expect(formatPence(-1n)).toBe('-£0.01');
  });

  it('refuses a number that is not a safe integer instead of printing a rounded amount', () => {
    for (const bad of [2 ** 53, -(2 ** 53), 1e21, 0.5, -1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => formatPence(bad)).toThrow(RangeError);
    }
  });

  it('refuses an unsupported currency instead of printing a wrong symbol', () => {
    expect(() => formatPence(100, 'EUR' as 'GBP')).toThrow(RangeError);
  });
});
