import { EnvironmentVariables } from './environment-variables';
import { productionConfigurationProblems, validate, WORKER_GLOBAL_CLAIMS_PRODUCTION_APPROVED } from './env.validation';

/**
 * Phase X SJ-05 (owner decision 2026-11-11): production refuses global claims and event dispatch at env validation, not
 * only in the compose gate, so a Worker (or API) started outside the gated compose path cannot boot in global mode.
 * Development and test keep every combination (CI's Phase D suites run WORKER_CLAIM_MODE=global).
 */
const SECURE: Partial<EnvironmentVariables> = {
  NODE_ENV: 'production',
  EMAIL_DRIVER: 'SMTP',
  STORAGE_DRIVER: 'S3',
  PUSH_ENABLED: false,
  PUSH_PROVIDER: 'FAKE',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://accounts.example.com',
  CORS_ORIGINS: 'https://app.example.com,https://accounts.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.12.7/32,2001:db8::1',
  WORKER_CLAIM_MODE: 'per_scope',
  WORKER_DISPATCH_MODE: 'poll',
};
const problems = (over: Partial<EnvironmentVariables>) => productionConfigurationProblems({ ...SECURE, ...over } as EnvironmentVariables);
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('SJ-05: global claims and event dispatch are refused in production', () => {
  it('the approval is a code constant and is false (flipping it is the reviewed J5 change)', () => {
    expect(WORKER_GLOBAL_CLAIMS_PRODUCTION_APPROVED).toBe(false);
  });

  it('per_scope + poll (the defaults) is accepted', () => {
    expect(problems({})).toEqual([]);
  });

  it('refuses WORKER_CLAIM_MODE=global with poll', () => {
    const p = problems({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'poll' });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^WORKER_CLAIM_MODE=global is not approved for production/);
  });

  it('refuses global + event with both reasons', () => {
    const p = problems({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event' }).join('\n');
    expect(p).toMatch(/WORKER_CLAIM_MODE=global is not approved for production/);
    expect(p).toMatch(/WORKER_DISPATCH_MODE=event is not approved for production/);
  });

  it('the refusal names the variables and the decision only, never a value of the configuration', () => {
    for (const msg of problems({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event' })) {
      expect(msg).not.toMatch(/postgres:|redis:|a{32}/);
    }
  });

  it('validate(): a production process with global claims refuses to boot (the full validation path)', () => {
    // STORAGE_DRIVER=LOCAL keeps this fixture free of S3 secrets: it is itself a production refusal, so every run throws the
    // one combined production message, and the assertion is whether the claim-mode refusal is IN it.
    const prod = { ...base, ...SECURE, STORAGE_DRIVER: 'LOCAL' } as unknown as Record<string, unknown>;
    const run = (over: Record<string, string>) => {
      try {
        validate({ ...prod, ...over });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(run({ WORKER_CLAIM_MODE: 'global' })).toMatch(/Invalid environment configuration for production:[\s\S]*WORKER_CLAIM_MODE=global is not approved for production/);
    expect(run({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event' })).toMatch(/WORKER_DISPATCH_MODE=event is not approved for production/);
    expect(run({ WORKER_CLAIM_MODE: 'per_scope', WORKER_DISPATCH_MODE: 'poll' })).not.toMatch(/WORKER_CLAIM_MODE|WORKER_DISPATCH_MODE/);
  });

  it.each(['development', 'test'])('%s keeps every supported combination (CI runs the Phase D suites in global mode)', (nodeEnv) => {
    for (const [claim, dispatch] of [['per_scope', 'poll'], ['global', 'poll'], ['global', 'event']]) {
      expect(() => validate({ ...base, NODE_ENV: nodeEnv, WORKER_CLAIM_MODE: claim, WORKER_DISPATCH_MODE: dispatch })).not.toThrow(/WORKER_CLAIM_MODE|WORKER_DISPATCH_MODE/);
    }
  });
});
