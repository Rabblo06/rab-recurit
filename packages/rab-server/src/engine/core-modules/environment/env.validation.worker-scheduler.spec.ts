import { validate } from './env.validation';

/**
 * Lane A (BullMQ worker migration) flags: fail closed on a bad mode or prefix; interval is the default; the legacy
 * `bull` prefix can never be chosen for the scan queues (it holds rab-email/rab-push/rab-shift-statements).
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('worker scheduler environment variables', () => {
  it('defaults: interval mode, no explicit prefix (derived at runtime), 60 s reconcile', () => {
    const env = validate({ ...base });
    expect(env.WORKER_SCHEDULER).toBe('interval');
    expect(env.BULLMQ_PREFIX).toBeUndefined();
    expect(env.WORKER_SCHEDULER_RECONCILE_SECONDS).toBe(60);
  });

  it('accepts bullmq and a valid env-specific prefix', () => {
    const env = validate({ ...base, WORKER_SCHEDULER: 'bullmq', BULLMQ_PREFIX: 'crewflow:production:bull', WORKER_SCHEDULER_RECONCILE_SECONDS: '30' });
    expect(env).toMatchObject({ WORKER_SCHEDULER: 'bullmq', BULLMQ_PREFIX: 'crewflow:production:bull', WORKER_SCHEDULER_RECONCILE_SECONDS: 30 });
  });

  it.each(['BullMQ', 'cron', 'true', 'interval '])('refuses to boot with WORKER_SCHEDULER=%p', (value) => {
    expect(() => validate({ ...base, WORKER_SCHEDULER: value })).toThrow(/WORKER_SCHEDULER/);
  });

  it.each(['bull', 'bull:crewflow', 'crewflow:', ':x', 'crewflow::bull', 'crewflow bull', 'crewflow:{x}:bull', 'x'.repeat(81)])(
    'refuses to boot with BULLMQ_PREFIX=%p',
    (value) => {
      expect(() => validate({ ...base, BULLMQ_PREFIX: value })).toThrow(/BULLMQ_PREFIX/);
    },
  );

  it.each(['9', '3601', 'abc'])('refuses WORKER_SCHEDULER_RECONCILE_SECONDS=%p', (value) => {
    expect(() => validate({ ...base, WORKER_SCHEDULER_RECONCILE_SECONDS: value })).toThrow(/WORKER_SCHEDULER_RECONCILE_SECONDS/);
  });

  it('a prefix that merely contains "bull" later is fine (only the legacy namespace itself is refused)', () => {
    expect(validate({ ...base, BULLMQ_PREFIX: 'crewflow:qa:bull' }).BULLMQ_PREFIX).toBe('crewflow:qa:bull');
    expect(validate({ ...base, BULLMQ_PREFIX: 'bullseye' }).BULLMQ_PREFIX).toBe('bullseye');
  });
});
