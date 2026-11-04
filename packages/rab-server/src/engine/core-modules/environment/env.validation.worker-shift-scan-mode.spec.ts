import { validate } from './env.validation';
import { COMBINED_SHIFT_SCAN_MEMBER_KEYS, COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS, combinedShiftScanTickSeconds } from './worker-scan-intervals';

/**
 * Phase D-Q4a (owner approval 2026-11-04, OD-1): WORKER_SHIFT_SCAN_MODE separate|combined, default separate, strict.
 * Combined mode ticks at the greatest common divisor of the four member intervals and refuses to boot below 30 s.
 * Separate mode (the default) must accept every configuration it accepts today, including ones with no common tick.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('WORKER_SHIFT_SCAN_MODE (Phase D-Q4a)', () => {
  it('defaults to separate (unset or empty), other Worker defaults unchanged', () => {
    expect(validate({ ...base })).toMatchObject({ WORKER_SHIFT_SCAN_MODE: 'separate', WORKER_SCHEDULER: 'interval', WORKER_CLAIM_MODE: 'per_scope' });
    expect(validate({ ...base, WORKER_SHIFT_SCAN_MODE: '' }).WORKER_SHIFT_SCAN_MODE).toBe('separate');
  });

  it('accepts exactly separate and combined', () => {
    expect(validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'separate' }).WORKER_SHIFT_SCAN_MODE).toBe('separate');
    expect(validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'combined' }).WORKER_SHIFT_SCAN_MODE).toBe('combined');
  });

  it.each(['Combined', 'COMBINED', ' combined', 'combined ', 'combine', 'true', '1', 'on', 'separated', 'merged'])('refuses WORKER_SHIFT_SCAN_MODE=%p', (value) => {
    expect(() => validate({ ...base, WORKER_SHIFT_SCAN_MODE: value })).toThrow(/WORKER_SHIFT_SCAN_MODE must be exactly separate or combined/);
  });

  it('the members are exactly the four 300-s scans (OD-1); late clock-in is not one', () => {
    expect(COMBINED_SHIFT_SCAN_MEMBER_KEYS).toEqual([
      'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS',
      'WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS',
      'WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS',
      'WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS',
    ]);
    expect(COMBINED_SHIFT_SCAN_MEMBER_KEYS).not.toContain('WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS');
    expect(COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS).toBe(30);
  });

  it('combined tick = greatest common divisor of the member intervals', () => {
    expect(combinedShiftScanTickSeconds([300, 300, 300, 300])).toBe(300);
    expect(combinedShiftScanTickSeconds([60, 120, 180, 300])).toBe(60);
    expect(combinedShiftScanTickSeconds([600, 900, 300, 450])).toBe(150);
    expect(combinedShiftScanTickSeconds([301, 300, 300, 300])).toBe(1);
    expect(() => combinedShiftScanTickSeconds([])).toThrow(/no member intervals/);
    expect(() => combinedShiftScanTickSeconds([300, 0])).toThrow(/positive whole seconds/);
    expect(() => combinedShiftScanTickSeconds([300, 1.5])).toThrow(/positive whole seconds/);
  });

  it('combined mode refuses to boot when the common tick is under 30 s', () => {
    expect(() => validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'combined', WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '301' })).toThrow(
      /WORKER_SHIFT_SCAN_MODE=combined needs the greatest common divisor .* at least 30 s \(it is 1 s\)/,
    );
    expect(() =>
      validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'combined', WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '60', WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: '100' }),
    ).toThrow(/it is 20 s/);
  });

  it('combined mode accepts a common tick of 30 s or more', () => {
    expect(validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'combined', WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '30', WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: '90', WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: '60', WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: '120' }).WORKER_SHIFT_SCAN_MODE).toBe('combined');
  });

  it('separate mode (default) never applies the tick rule: a configuration valid today stays valid', () => {
    expect(validate({ ...base, WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '301' }).WORKER_SHIFT_MONITOR_INTERVAL_SECONDS).toBe(301);
    expect(validate({ ...base, WORKER_SHIFT_SCAN_MODE: 'separate', WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '301' }).WORKER_SHIFT_SCAN_MODE).toBe('separate');
  });
});
