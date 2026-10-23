import { bigintAsNumber } from './bigint-transformer';

/** Wave 2 lane S2 (C1/C2): the bigint <-> number boundary is exact or refused, never rounded. */
describe('bigintAsNumber', () => {
  it('reads pg bigint strings exactly inside the safe range, including both boundaries', () => {
    expect(bigintAsNumber.from('0')).toBe(0);
    expect(bigintAsNumber.from('123456')).toBe(123456);
    expect(bigintAsNumber.from('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintAsNumber.from('-9007199254740991')).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('refuses a stored value of 2^53 + 1 (and 2^53) instead of rounding it', () => {
    expect(() => bigintAsNumber.from('9007199254740993')).toThrow(RangeError);
    expect(() => bigintAsNumber.from('9007199254740992')).toThrow(RangeError);
    expect(() => bigintAsNumber.from('-9223372036854775808')).toThrow(RangeError);
    expect(() => bigintAsNumber.from('not-a-number')).toThrow(RangeError);
  });

  it('refuses to write an unsafe or fractional number', () => {
    expect(() => bigintAsNumber.to(2 ** 53)).toThrow(RangeError);
    expect(() => bigintAsNumber.to(12.5)).toThrow(RangeError);
    expect(() => bigintAsNumber.to(Number.NaN)).toThrow(RangeError);
    expect(bigintAsNumber.to(4800)).toBe(4800);
  });

  it('keeps the previous null/undefined and FindOperator behaviour', () => {
    expect(bigintAsNumber.from(null as unknown as string)).toBe(0);
    expect(Number.isNaN(bigintAsNumber.from(undefined as unknown as string))).toBe(true);
    const op = { _type: 'moreThan', _value: 5 };
    expect(bigintAsNumber.to(op as unknown as number)).toBe(op);
    expect(bigintAsNumber.to(null as unknown as number)).toBeNull();
  });
});
