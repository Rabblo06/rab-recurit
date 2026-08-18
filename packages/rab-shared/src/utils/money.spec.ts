import { addPence, formatPence, multiplyPence, payForMinutes, subtractPence } from './money';

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
});
