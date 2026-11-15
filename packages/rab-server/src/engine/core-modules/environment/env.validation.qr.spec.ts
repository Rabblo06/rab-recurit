import { validate } from './env.validation';

/**
 * QR review L2 (2026-11-14): the attendance QR settings fail closed at boot. QR_POST_SHIFT_GRACE_MINUTES is the one
 * clock-out grace (0..1440), QR_MAX_AGE_DAYS the Shift QR age ceiling (1..90, whole days), and the pre-shift report window
 * must stay below that ceiling so a printed report never carries an already-dead QR.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('attendance QR environment variables', () => {
  it('defaults: 120-minute grace, 14-day ceiling, 180-minute report window', () => {
    expect(validate({ ...base })).toMatchObject({ QR_POST_SHIFT_GRACE_MINUTES: 120, QR_MAX_AGE_DAYS: 14, REPORT_AVAILABLE_BEFORE_MINUTES: 180 });
  });

  it('accepts the boundaries', () => {
    expect(validate({ ...base, QR_POST_SHIFT_GRACE_MINUTES: '1440' }).QR_POST_SHIFT_GRACE_MINUTES).toBe(1440);
    expect(validate({ ...base, QR_POST_SHIFT_GRACE_MINUTES: '0' }).QR_POST_SHIFT_GRACE_MINUTES).toBe(0);
    expect(validate({ ...base, QR_MAX_AGE_DAYS: '1' }).QR_MAX_AGE_DAYS).toBe(1);
    expect(validate({ ...base, QR_MAX_AGE_DAYS: '90' }).QR_MAX_AGE_DAYS).toBe(90);
  });

  it.each(['1441', String(2 ** 31), '-1', '1.5', 'abc'])('refuses QR_POST_SHIFT_GRACE_MINUTES=%p', (value) => {
    expect(() => validate({ ...base, QR_POST_SHIFT_GRACE_MINUTES: value })).toThrow(/QR_POST_SHIFT_GRACE_MINUTES/);
  });

  it.each(['0', '91', '1.5', 'abc'])('refuses QR_MAX_AGE_DAYS=%p', (value) => {
    expect(() => validate({ ...base, QR_MAX_AGE_DAYS: value })).toThrow(/QR_MAX_AGE_DAYS/);
  });

  it('refuses a pre-shift report window at or beyond the QR age ceiling; one minute under is fine', () => {
    expect(() => validate({ ...base, QR_MAX_AGE_DAYS: '1', REPORT_AVAILABLE_BEFORE_MINUTES: '1440' })).toThrow(/REPORT_AVAILABLE_BEFORE_MINUTES must be less than QR_MAX_AGE_DAYS/);
    expect(() => validate({ ...base, QR_MAX_AGE_DAYS: '1', REPORT_AVAILABLE_BEFORE_MINUTES: '5000' })).toThrow(/REPORT_AVAILABLE_BEFORE_MINUTES/);
    expect(validate({ ...base, QR_MAX_AGE_DAYS: '1', REPORT_AVAILABLE_BEFORE_MINUTES: '1439' }).REPORT_AVAILABLE_BEFORE_MINUTES).toBe(1439);
  });
});
