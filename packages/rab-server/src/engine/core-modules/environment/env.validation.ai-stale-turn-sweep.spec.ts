import { validate } from './env.validation';

/**
 * Phase D-Q2 env vars. AI_STALE_TURN_SWEEP is strictly parsed like the other on/off flags (review F46-1): only the exact
 * strings 'true' / 'false' are accepted, so a mistyped value refuses to boot instead of silently leaving the sweep off
 * while the operator believes it is on.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('Phase D-Q2 AI stale-turn sweep environment variables', () => {
  it('unset (or `KEY=`, which env.validation treats as unset for every key): the sweep is off, threshold 15 min, interval 5 min', () => {
    expect(validate({ ...base, AI_STALE_TURN_SWEEP: '' }).AI_STALE_TURN_SWEEP).toBe(false);
    expect(validate({ ...base })).toMatchObject({
      AI_STALE_TURN_SWEEP: false,
      AI_STALE_TURN_THRESHOLD_MINUTES: 15,
      AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: 5,
    });
  });

  it('"true" turns it on, "false" keeps it off', () => {
    expect(validate({ ...base, AI_STALE_TURN_SWEEP: 'true' }).AI_STALE_TURN_SWEEP).toBe(true);
    expect(validate({ ...base, AI_STALE_TURN_SWEEP: 'false' }).AI_STALE_TURN_SWEEP).toBe(false);
  });

  it.each(['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'flase', '0'])('%j refuses to boot (never silently off)', (value) => {
    expect(() => validate({ ...base, AI_STALE_TURN_SWEEP: value })).toThrow(/AI_STALE_TURN_SWEEP/);
  });

  it('threshold: 11–1440 minutes (floor above the longest legitimate queued wait); interval: 1–60 minutes', () => {
    expect(validate({ ...base, AI_STALE_TURN_THRESHOLD_MINUTES: '11' }).AI_STALE_TURN_THRESHOLD_MINUTES).toBe(11);
    expect(validate({ ...base, AI_STALE_TURN_THRESHOLD_MINUTES: '1440' }).AI_STALE_TURN_THRESHOLD_MINUTES).toBe(1440);
    for (const bad of ['10', '1441', '15.5', 'x']) {
      expect(() => validate({ ...base, AI_STALE_TURN_THRESHOLD_MINUTES: bad })).toThrow(/AI_STALE_TURN_THRESHOLD_MINUTES/);
    }
    expect(validate({ ...base, AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: '1' }).AI_STALE_TURN_SWEEP_INTERVAL_MINUTES).toBe(1);
    expect(validate({ ...base, AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: '60' }).AI_STALE_TURN_SWEEP_INTERVAL_MINUTES).toBe(60);
    for (const bad of ['0', '61']) {
      expect(() => validate({ ...base, AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: bad })).toThrow(/AI_STALE_TURN_SWEEP_INTERVAL_MINUTES/);
    }
  });
});
