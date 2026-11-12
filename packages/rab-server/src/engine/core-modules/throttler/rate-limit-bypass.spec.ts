import * as fs from 'fs';
import * as path from 'path';

import { isRateLimitBypassEnabled, RATE_LIMIT_BYPASS_ENV_NAME, rateLimitBypassProductionProblem } from './rate-limit-bypass';

describe('the one rate-limit switch (X1.2, audit XA-01 / DUP-03)', () => {
  it.each<[string, Record<string, string | undefined>, boolean]>([
    ['the Jest suite with the flag on', { NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, true],
    ['development with the flag on, no JEST_WORKER_ID (the flag alone is the switch)', { NODE_ENV: 'development', RAB_DISABLE_RATE_LIMIT: 'true' }, true],
    ['a suite that turned real throttling back on', { NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'false' }, false],
    // Abuse cases: the old hidden bypass (`JEST_WORKER_ID set && flag !== 'false'`) skipped every limiter for these.
    ['JEST_WORKER_ID alone, flag unset', { NODE_ENV: 'development', JEST_WORKER_ID: '1' }, false],
    ['JEST_WORKER_ID with a non-"true" flag value', { JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: '1' }, false],
    ['a mis-cased flag', { RAB_DISABLE_RATE_LIMIT: 'TRUE' }, false],
    ['a padded flag', { RAB_DISABLE_RATE_LIMIT: ' true ' }, false],
    ['a blank flag', { RAB_DISABLE_RATE_LIMIT: '' }, false],
    // Never in a production runtime, whatever the flag says.
    ['NODE_ENV=production with the flag on', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['RAB_RUNTIME_ENV=production with the flag on', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['DB_TARGET=production with the flag on (pg-config counts it as production)', { NODE_ENV: 'test', DB_TARGET: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['a padded, mis-cased production with the flag on', { NODE_ENV: ' Production ', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['DB_TARGET=local in the Jest suite keeps the bypass', { NODE_ENV: 'test', DB_TARGET: 'local', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, true],
    ['nothing set', {}, false],
  ])('%s -> bypass %s', (_name, env, expected) => {
    expect(isRateLimitBypassEnabled(env)).toBe(expected);
  });

  it('is on in this Jest process (jest-setup.ts sets the flag), so the suite keeps its shared-IP bypass', () => {
    expect(process.env.RAB_DISABLE_RATE_LIMIT).toBe('true');
    expect(isRateLimitBypassEnabled()).toBe(true);
  });

  describe('production boot refusal (env validation calls this)', () => {
    it.each<[string, Record<string, string | undefined>]>([
      ['NODE_ENV=production + flag true', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }],
      ['RAB_RUNTIME_ENV=production + flag true', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }],
      ['DB_TARGET=production + flag true', { DB_TARGET: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }],
      ['a mis-cased production + flag true', { NODE_ENV: 'PRODUCTION', RAB_DISABLE_RATE_LIMIT: 'true' }],
      ['production + an intent-to-disable value that is not exactly true', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: '1' }],
      ['production + TRUE', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'TRUE' }],
    ])('refuses %s, naming the variable only', (_name, env) => {
      const problem = rateLimitBypassProductionProblem(env);
      expect(problem).toMatch(/^RAB_DISABLE_RATE_LIMIT must not be set in production/);
      expect(problem).not.toMatch(/=\s*(true|TRUE|1)\b/);
    });

    it.each<[string, Record<string, string | undefined>]>([
      ['production, flag unset', { NODE_ENV: 'production' }],
      ['production, flag blank', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: '' }],
      ['production, flag false', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'false' }],
      ['production, flag FALSE', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: ' FALSE ' }],
      ['production, JEST_WORKER_ID present (no longer read by any limiter)', { NODE_ENV: 'production', JEST_WORKER_ID: '1' }],
      ['test with the flag on', { NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }],
      ['development with the flag on', { NODE_ENV: 'development', RAB_DISABLE_RATE_LIMIT: 'true' }],
    ])('accepts %s', (_name, env) => {
      expect(rateLimitBypassProductionProblem(env)).toBeNull();
    });
  });

  it('is the only reader of the switch: neither name appears in any other server or Worker source, in any syntax', () => {
    // A plain-text search (not a `process.env.X` pattern), so destructuring, computed keys spelled out as a string,
    // EnvironmentService.get('...'), shell scripts and comments that would invite a copy all count. Test code (specs,
    // __tests__) is excluded: suites set the flag to 'false' to exercise real throttling. Allow-listed: this helper, the two
    // Jest setups that set the flag, and env validation (the production boot refusal).
    const packages = path.resolve(__dirname, '../../../../..');
    const roots = [path.join(packages, 'rab-server'), path.join(packages, 'rab-worker')];
    const allowed = new Set(
      [
        'rab-server/src/engine/core-modules/throttler/rate-limit-bypass.ts',
        'rab-server/src/jest-setup.ts',
        'rab-worker/src/jest-setup.ts',
        'rab-server/src/engine/core-modules/environment/env.validation.ts',
      ].map((file) => path.join(packages, file)),
    );
    const skippedDirs = new Set(['node_modules', '__tests__', 'dist', 'dist-cjs', 'dist-esm', 'coverage', '.nx']);
    const names = [RATE_LIMIT_BYPASS_ENV_NAME, 'JEST_WORKER_ID'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skippedDirs.has(entry.name)) walk(full);
        } else if (/\.(ts|js|cjs|mjs|sh|json|ya?ml|env|example)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && !allowed.has(full)) {
          const text = fs.readFileSync(full, 'utf8');
          if (names.some((name) => text.includes(name))) offenders.push(path.relative(packages, full));
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });

  it('the three limiters use it', () => {
    const src = path.resolve(__dirname, '../../..');
    for (const file of [
      'engine/core-modules/throttler/throttler-options.factory.ts',
      'engine/core-modules/auth/services/login-attempt-limiter.service.ts',
      'modules/attendance/guards/attendance-per-user-throttle.guard.ts',
    ]) {
      expect(fs.readFileSync(path.join(src, file), 'utf8')).toMatch(/isRateLimitBypassEnabled\(process\.env\)/);
    }
  });
});
