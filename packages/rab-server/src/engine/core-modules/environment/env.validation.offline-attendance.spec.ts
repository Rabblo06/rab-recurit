import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EnvironmentVariables } from './environment-variables';
import { productionConfigurationProblems, validate } from './env.validation';

/**
 * M4 offline clock-in, owner HARD RULE (2026-11-21): offline stays OFF everywhere until M5 payroll adjustments exist and
 * /attendance/me/sync has been pen-tested (docs/plans/m4-offline/DESIGN.md, ROLLOUT-CHECKLIST.md). The global kill switch
 * OFFLINE_ATTENDANCE_ENABLED defaults to false, is a strict boolean, and `true` in production refuses to boot. There is no
 * approval flag that could turn it on: that is built later, in its own reviewed change.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

const SECURE_PRODUCTION: Partial<EnvironmentVariables> = {
  NODE_ENV: 'production',
  EMAIL_DRIVER: 'SMTP',
  STORAGE_DRIVER: 'S3',
  PUSH_ENABLED: false,
  PUSH_PROVIDER: 'FAKE',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://accounts.example.com',
  CORS_ORIGINS: 'https://app.example.com,https://accounts.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.12.7/32,2001:db8::1',
};
const productionProblems = (over: Record<string, unknown>) => productionConfigurationProblems({ ...SECURE_PRODUCTION, ...over } as unknown as EnvironmentVariables);

describe('OFFLINE_ATTENDANCE_ENABLED (M4 global kill switch; owner HARD RULE: off until M5 adjustments + pen test)', () => {
  it('defaults to false, and so do the limits to the owner-approved values', () => {
    const env = validate({ ...base });
    expect(env.OFFLINE_ATTENDANCE_ENABLED).toBe(false);
    expect(env.OFFLINE_MAX_CAPTURE_AGE_HOURS).toBe(16);
    expect(env.OFFLINE_SYNC_MAX_DELAY_HOURS).toBe(72);
    expect(env.OFFLINE_SYNC_MAX_BATCH).toBe(25);
    expect(env.OFFLINE_CLOCK_SKEW_FLAG_SECONDS).toBe(300);
  });

  it('an empty value (KEY= in a .env file) is "not provided" → false', () => {
    expect(validate({ ...base, OFFLINE_ATTENDANCE_ENABLED: '' }).OFFLINE_ATTENDANCE_ENABLED).toBe(false);
  });

  it('accepts exactly "true" / "false" outside production (development and test may switch it on for disposable tests)', () => {
    expect(validate({ ...base, OFFLINE_ATTENDANCE_ENABLED: 'false' }).OFFLINE_ATTENDANCE_ENABLED).toBe(false);
    expect(validate({ ...base, NODE_ENV: 'test', OFFLINE_ATTENDANCE_ENABLED: 'true' }).OFFLINE_ATTENDANCE_ENABLED).toBe(true);
  });

  it.each(['TRUE', 'True', '1', 'yes', 'on', 'true ', ' false', 'flase'])('a malformed value %p refuses to boot (never silently true)', (value) => {
    expect(() => validate({ ...base, OFFLINE_ATTENDANCE_ENABLED: value })).toThrow(/OFFLINE_ATTENDANCE_ENABLED/);
  });

  it('production + true is refused, naming the hard rule', () => {
    const problems = productionProblems({ OFFLINE_ATTENDANCE_ENABLED: true }).join('\n');
    expect(problems).toMatch(/OFFLINE_ATTENDANCE_ENABLED=true is not allowed in production/);
    expect(problems).toMatch(/M5 payroll adjustments/);
    expect(problems).toMatch(/pen-tested/);
    expect(productionProblems({ OFFLINE_ATTENDANCE_ENABLED: false }).join('\n')).not.toMatch(/OFFLINE_ATTENDANCE_ENABLED/);
  });

  it('production + true refuses the whole boot through validate()', () => {
    expect(() => validate({ ...base, NODE_ENV: 'production', OFFLINE_ATTENDANCE_ENABLED: 'true' })).toThrow(/OFFLINE_ATTENDANCE_ENABLED=true is not allowed in production/);
  });

  it('there is no approval constant or environment variable that could allow it (not built, by owner rule)', () => {
    const src = readFileSync(join(__dirname, 'env.validation.ts'), 'utf8');
    expect(src).not.toMatch(/OFFLINE_ATTENDANCE_[A-Z_]*APPROVED/);
    expect(Object.keys(new EnvironmentVariables()).filter((k) => k.startsWith('OFFLINE_'))).toEqual([
      'OFFLINE_ATTENDANCE_ENABLED',
      'OFFLINE_MAX_CAPTURE_AGE_HOURS',
      'OFFLINE_SYNC_MAX_DELAY_HOURS',
      'OFFLINE_SYNC_MAX_BATCH',
      'OFFLINE_CLOCK_SKEW_FLAG_SECONDS',
    ]);
  });

  it.each([
    ['OFFLINE_MAX_CAPTURE_AGE_HOURS', '17'],
    ['OFFLINE_MAX_CAPTURE_AGE_HOURS', '0'],
    ['OFFLINE_SYNC_MAX_DELAY_HOURS', '73'],
    ['OFFLINE_SYNC_MAX_BATCH', '26'],
    ['OFFLINE_CLOCK_SKEW_FLAG_SECONDS', '29'],
    ['OFFLINE_SYNC_MAX_BATCH', '2.5'],
  ])('%s=%s (looser than the owner-approved value, or not a whole number) refuses to boot', (key, value) => {
    expect(() => validate({ ...base, [key]: value })).toThrow(new RegExp(key));
  });

  it('a stricter limit is accepted', () => {
    const env = validate({ ...base, OFFLINE_MAX_CAPTURE_AGE_HOURS: '8', OFFLINE_SYNC_MAX_DELAY_HOURS: '24', OFFLINE_SYNC_MAX_BATCH: '10' });
    expect([env.OFFLINE_MAX_CAPTURE_AGE_HOURS, env.OFFLINE_SYNC_MAX_DELAY_HOURS, env.OFFLINE_SYNC_MAX_BATCH]).toEqual([8, 24, 10]);
  });
});
