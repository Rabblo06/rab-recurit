import { EnvironmentVariables } from './environment-variables';
import { WORKER_INVITE_AUTO_DELETE_PRODUCTION_APPROVED, productionConfigurationProblems, validate } from './env.validation';

/**
 * Phase D wave 2 (owner decision 2026-11-01) — retention flag WORKER_INVITE_AUTO_DELETE_ENABLED, default false.
 * OFF ⇒ the account-invite cleanup never deletes a user account automatically. Enabling it needs a SEPARATE owner approval
 * of the retention policy; until that approval is recorded in code, a production deployment with the flag on refuses to
 * boot. Test/development may switch it on for disposable tests. Strict boolean: a typo never becomes true.
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
const productionProblems = (over: Record<string, unknown>) =>
  productionConfigurationProblems({ ...SECURE_PRODUCTION, ...over } as unknown as EnvironmentVariables);

describe('WORKER_INVITE_AUTO_DELETE_ENABLED (Phase D retention flag)', () => {
  it('defaults to false (no automatic deletion of user accounts)', () => {
    const env = validate({ ...base });
    expect(env.WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(false);
  });

  it('accepts exactly "true" and "false" (and the booleans)', () => {
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: 'false' }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(false);
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: 'true' }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(true);
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: false }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(false);
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: true }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(true);
  });

  it('an empty value (KEY= in a .env file) is "not provided" → the default false', () => {
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: '' }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(false);
  });

  it.each(['flase', 'TRUE', 'True', '1', '0', 'yes', 'on', 'true ', ' false'])('a malformed value %p refuses to boot (never silently true)', (value) => {
    expect(() => validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: value })).toThrow(/WORKER_INVITE_AUTO_DELETE_ENABLED/);
  });

  it('production + true is refused, naming the missing owner approval', () => {
    const problems = productionProblems({ WORKER_INVITE_AUTO_DELETE_ENABLED: true }).join('\n');
    expect(problems).toMatch(/WORKER_INVITE_AUTO_DELETE_ENABLED=true/);
    expect(problems).toMatch(/owner/i);
    expect(problems).toMatch(/approv/i);
  });

  it('production approval is a code constant, still false (flipping it is a reviewed change recording the owner approval)', () => {
    expect(WORKER_INVITE_AUTO_DELETE_PRODUCTION_APPROVED).toBe(false);
  });

  it('production + true refuses the whole boot through validate()', () => {
    expect(() => validate({ ...base, NODE_ENV: 'production', WORKER_INVITE_AUTO_DELETE_ENABLED: 'true' })).toThrow(
      /for production:[\s\S]*WORKER_INVITE_AUTO_DELETE_ENABLED=true/,
    );
  });

  it('production + false (or unset) raises no problem of its own', () => {
    expect(productionProblems({ WORKER_INVITE_AUTO_DELETE_ENABLED: false })).toEqual([]);
    expect(productionProblems({})).toEqual([]);
    let message = '';
    try {
      validate({ ...base, NODE_ENV: 'production', WORKER_INVITE_AUTO_DELETE_ENABLED: 'false' });
    } catch (error) {
      message = (error as Error).message; // other production rules may refuse this minimal env; never this flag
    }
    expect(message).not.toMatch(/WORKER_INVITE_AUTO_DELETE_ENABLED/);
  });

  it.each(['test', 'development'])('NODE_ENV=%s may switch it on (disposable tests)', (nodeEnv) => {
    expect(validate({ ...base, NODE_ENV: nodeEnv, WORKER_INVITE_AUTO_DELETE_ENABLED: 'true' }).WORKER_INVITE_AUTO_DELETE_ENABLED).toBe(true);
  });

  it('the other five Phase D defaults are unchanged', () => {
    expect(validate({ ...base })).toMatchObject({
      WORKER_CLAIM_MODE: 'per_scope',
      WORKER_DISPATCH_MODE: 'poll',
      WORKER_SCHEDULER: 'interval',
      REALTIME_ENABLED: false,
      PUSH_ENABLED: false,
      WORKER_INVITE_AUTO_DELETE_ENABLED: false,
    });
  });

  it('switching it on changes none of the other Phase D defaults', () => {
    expect(validate({ ...base, WORKER_INVITE_AUTO_DELETE_ENABLED: 'true' })).toMatchObject({
      WORKER_CLAIM_MODE: 'per_scope',
      WORKER_DISPATCH_MODE: 'poll',
      WORKER_SCHEDULER: 'interval',
      REALTIME_ENABLED: false,
      PUSH_ENABLED: false,
    });
  });
});
