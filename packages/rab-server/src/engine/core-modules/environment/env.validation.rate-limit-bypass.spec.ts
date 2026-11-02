import { validate } from './env.validation';

/**
 * X1.4 (cleanup audit DUP-03): a production process refuses to boot while the Jest rate-limit switch (JEST_WORKER_ID,
 * RAB_DISABLE_RATE_LIMIT) is present, so a misconfigured or hostile service environment cannot silently switch off the
 * per-IP, login/MFA and attendance limiters. The env objects are explicit (this Jest process's own JEST_WORKER_ID is not
 * involved).
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

describe('env validation: the Jest rate-limit switch is refused in production (X1.4)', () => {
  it.each<[string, Record<string, string>]>([
    ['JEST_WORKER_ID', { JEST_WORKER_ID: '1' }],
    ['RAB_DISABLE_RATE_LIMIT=true', { RAB_DISABLE_RATE_LIMIT: 'true' }],
    ['RAB_DISABLE_RATE_LIMIT=false (dormant)', { RAB_DISABLE_RATE_LIMIT: 'false' }],
    ['a blank JEST_WORKER_ID', { JEST_WORKER_ID: '' }],
    ['both', { JEST_WORKER_ID: '3', RAB_DISABLE_RATE_LIMIT: 'true' }],
  ])('NODE_ENV=production + %s -> refused to boot, naming the variable only', (_name, extra) => {
    const message = errorOf({ ...BASE, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', ...extra });
    expect(message).toMatch(/Invalid environment configuration for production/);
    for (const name of Object.keys(extra)) expect(message).toContain(name);
    expect(message).toMatch(/must not be present in production/);
  });

  it('RAB_RUNTIME_ENV=production with another NODE_ENV is still refused', () => {
    const message = errorOf({ ...BASE, NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' });
    expect(message).toMatch(/Invalid environment configuration for production:\nJEST_WORKER_ID, RAB_DISABLE_RATE_LIMIT must not be present/);
  });

  it('a production configuration without the switch raises no rate-limit problem (other production rules are unchanged)', () => {
    expect(errorOf({ ...BASE, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' })).not.toMatch(/JEST_WORKER_ID|RAB_DISABLE_RATE_LIMIT/);
  });

  it('development and test keep the switch (the Jest suite depends on it)', () => {
    expect(errorOf({ ...BASE, NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' })).not.toMatch(/JEST_WORKER_ID|RAB_DISABLE_RATE_LIMIT/);
    expect(errorOf({ ...BASE, NODE_ENV: 'development', RAB_DISABLE_RATE_LIMIT: 'true' })).not.toMatch(/JEST_WORKER_ID|RAB_DISABLE_RATE_LIMIT/);
  });
});
