import { validate } from './env.validation';

/**
 * X1.2 (audit XA-01 / DUP-03): a production process refuses to boot while the one rate-limit switch, RAB_DISABLE_RATE_LIMIT,
 * holds anything but unset, blank or false, so no service environment can switch off the per-IP, login/MFA and attendance
 * limiters in production. JEST_WORKER_ID is no longer part of any bypass and is not refused. The env objects are explicit
 * (this Jest process's own variables are not involved).
 */
const BASE = {
  APP_SECRET: 'x'.repeat(64),
  PG_DATABASE_URL: 'postgres://crewflow_app:pw@localhost:5432/rab',
  REDIS_URL: 'redis://localhost:6379',
};

function errorOf(config: Record<string, unknown>): string {
  try {
    validate(config);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

const RULE = /RAB_DISABLE_RATE_LIMIT must not be set in production/;

describe('env validation: the rate-limit switch is refused in production (X1.2)', () => {
  it.each<[string, Record<string, string>]>([
    ['RAB_DISABLE_RATE_LIMIT=true', { RAB_DISABLE_RATE_LIMIT: 'true' }],
    ['RAB_DISABLE_RATE_LIMIT=TRUE', { RAB_DISABLE_RATE_LIMIT: 'TRUE' }],
    ['RAB_DISABLE_RATE_LIMIT=1', { RAB_DISABLE_RATE_LIMIT: '1' }],
  ])('NODE_ENV=production + %s -> refused to boot, naming the variable only', (_name, extra) => {
    const message = errorOf({ ...BASE, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', ...extra });
    expect(message).toMatch(/Invalid environment configuration for production/);
    expect(message).toMatch(RULE);
    expect(message).not.toMatch(/RAB_DISABLE_RATE_LIMIT=/);
  });

  it('RAB_RUNTIME_ENV=production with another NODE_ENV is still refused', () => {
    const message = errorOf({ ...BASE, NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' });
    expect(message).toMatch(/Invalid environment configuration for production:\nRAB_DISABLE_RATE_LIMIT must not be set/);
  });

  it.each<[string, Record<string, string>]>([
    ['unset', {}],
    ['blank', { RAB_DISABLE_RATE_LIMIT: '' }],
    ['false', { RAB_DISABLE_RATE_LIMIT: 'false' }],
    ['JEST_WORKER_ID present (no longer a bypass)', { JEST_WORKER_ID: '1' }],
  ])('production with the switch %s raises no rate-limit problem (other production rules are unchanged)', (_name, extra) => {
    expect(errorOf({ ...BASE, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', ...extra })).not.toMatch(/RAB_DISABLE_RATE_LIMIT|JEST_WORKER_ID/);
  });

  it('development and test keep the switch (the Jest suite depends on it)', () => {
    expect(errorOf({ ...BASE, NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' })).not.toMatch(/RAB_DISABLE_RATE_LIMIT/);
    expect(errorOf({ ...BASE, NODE_ENV: 'development', RAB_DISABLE_RATE_LIMIT: 'true' })).not.toMatch(/RAB_DISABLE_RATE_LIMIT/);
  });
});
