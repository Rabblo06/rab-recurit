import { validate } from './env.validation';

/**
 * Owner decision 2026-11-15: CLOCK_IN_CONFIRM_FLOOR_HOURS is the hard floor for a manager-entered clock-in (always
 * refused earlier than own start minus this many hours, even with the confirmation). Whole hours 1..48, default 12;
 * anything else refuses to boot.
 */
const base = { PG_DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('CLOCK_IN_CONFIRM_FLOOR_HOURS', () => {
  it('defaults to 12 hours', () => {
    expect(validate({ ...base }).CLOCK_IN_CONFIRM_FLOOR_HOURS).toBe(12);
  });

  it('accepts the boundaries 1 and 48', () => {
    expect(validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: '1' }).CLOCK_IN_CONFIRM_FLOOR_HOURS).toBe(1);
    expect(validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: '48' }).CLOCK_IN_CONFIRM_FLOOR_HOURS).toBe(48);
  });

  it.each(['0', '49', '-1', '1.5', 'abc'])('refuses CLOCK_IN_CONFIRM_FLOOR_HOURS=%p', (value) => {
    expect(() => validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: value })).toThrow(/CLOCK_IN_CONFIRM_FLOOR_HOURS/);
  });

  it('refuses a floor at or inside the normal clock-in allowance; one minute beyond it is fine', () => {
    expect(() => validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: '1', CLOCK_IN_EARLY_MINUTES: '60' })).toThrow(
      /CLOCK_IN_CONFIRM_FLOOR_HOURS x 60 must be greater than CLOCK_IN_EARLY_MINUTES/,
    );
    expect(() => validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: '2', CLOCK_IN_EARLY_MINUTES: '180' })).toThrow(/CLOCK_IN_CONFIRM_FLOOR_HOURS/);
    expect(validate({ ...base, CLOCK_IN_CONFIRM_FLOOR_HOURS: '1', CLOCK_IN_EARLY_MINUTES: '59' }).CLOCK_IN_EARLY_MINUTES).toBe(59);
  });
});
