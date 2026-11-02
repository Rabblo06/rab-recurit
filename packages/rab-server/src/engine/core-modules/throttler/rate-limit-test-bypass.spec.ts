import * as fs from 'fs';
import * as path from 'path';

import { isTestRateLimitBypassActive, RATE_LIMIT_BYPASS_ENV_NAMES, testRateLimitBypassProductionProblem } from './rate-limit-test-bypass';

describe('Jest rate-limit bypass predicate (X1.4, audit DUP-03)', () => {
  it.each<[string, Record<string, string | undefined>, boolean]>([
    ['the Jest suite with the flag on', { NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, true],
    ['a suite that turned real throttling back on', { NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'false' }, false],
    // Abuse cases: the old copies (`!== 'false'`) treated every one of these as "skip rate limiting".
    ['JEST_WORKER_ID alone, flag unset', { NODE_ENV: 'development', JEST_WORKER_ID: '1' }, false],
    ['JEST_WORKER_ID with a non-"true" flag value', { JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: '1' }, false],
    ['JEST_WORKER_ID with a mis-cased flag', { JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'TRUE' }, false],
    ['a blank JEST_WORKER_ID', { JEST_WORKER_ID: ' ', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['the flag without JEST_WORKER_ID', { NODE_ENV: 'test', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['NODE_ENV=production with both set', { NODE_ENV: 'production', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['RAB_RUNTIME_ENV=production with both set', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['a mis-cased, padded production with both set', { NODE_ENV: ' Production ', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' }, false],
    ['nothing set', {}, false],
  ])('%s -> bypass %s', (_name, env, expected) => {
    expect(isTestRateLimitBypassActive(env)).toBe(expected);
  });

  it('is active in this Jest process (jest-setup.ts sets the flag), so the suite keeps its shared-IP bypass', () => {
    expect(process.env.RAB_DISABLE_RATE_LIMIT).toBe('true');
    expect(isTestRateLimitBypassActive()).toBe(true);
  });

  describe('production boot refusal', () => {
    it.each<[string, Record<string, string | undefined>, RegExp]>([
      ['JEST_WORKER_ID', { NODE_ENV: 'production', JEST_WORKER_ID: '1' }, /^JEST_WORKER_ID must not be present in production/],
      ['RAB_DISABLE_RATE_LIMIT', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'true' }, /^RAB_DISABLE_RATE_LIMIT must not be present/],
      ['RAB_DISABLE_RATE_LIMIT=false (dormant)', { NODE_ENV: 'production', RAB_DISABLE_RATE_LIMIT: 'false' }, /RAB_DISABLE_RATE_LIMIT must not be present/],
      ['a blank JEST_WORKER_ID', { NODE_ENV: 'production', JEST_WORKER_ID: '' }, /JEST_WORKER_ID must not be present/],
      ['both, under RAB_RUNTIME_ENV=production', { RAB_RUNTIME_ENV: 'production', JEST_WORKER_ID: '7', RAB_DISABLE_RATE_LIMIT: 'true' }, /^JEST_WORKER_ID, RAB_DISABLE_RATE_LIMIT must not be present/],
    ])('refuses %s', (_name, env, pattern) => {
      const problem = testRateLimitBypassProductionProblem(env);
      expect(problem).toMatch(pattern);
      // Names only, never a value.
      expect(problem).not.toMatch(/=\s*(true|false|1|7)\b/);
    });

    it('ignores non-production runtimes (development, test, Jest itself)', () => {
      expect(testRateLimitBypassProductionProblem({ NODE_ENV: 'test', JEST_WORKER_ID: '1', RAB_DISABLE_RATE_LIMIT: 'true' })).toBeNull();
      expect(testRateLimitBypassProductionProblem({ NODE_ENV: 'development', RAB_DISABLE_RATE_LIMIT: 'true' })).toBeNull();
      expect(testRateLimitBypassProductionProblem({ NODE_ENV: 'production' })).toBeNull();
    });
  });

  it('is the only bypass predicate in the server source (no copy of the old condition survives)', () => {
    const root = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && !/^jest-/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (RATE_LIMIT_BYPASS_ENV_NAMES.some((name) => new RegExp(`process\\.env\\.${name}\\b`).test(text))) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
