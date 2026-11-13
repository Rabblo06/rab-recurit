import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { TEST_DATABASE_ADMIN_URL, TEST_DATABASE_ADMIN_URL_NAMES, TEST_DATABASE_URL_UNPOOLED } from './test-database-guard';

/**
 * X3.5-S7 (audit DBT-08 step 6), release 1: the test admin URL (the disposable cluster's bootstrap SUPERUSER) has a new name,
 * TEST_DATABASE_ADMIN_URL, and the deprecated TEST_DATABASE_URL_UNPOOLED is still accepted. Every committed list that keeps
 * the admin URL away from a child process (the migrate / RLS-gate children, the e2e API, Worker, Vite and Playwright) must
 * remove BOTH names; a list that only knows the old name would hand the superuser URL to the child as soon as a developer or
 * CI sets the new one (the DBT-12 class). And the two CI helpers must emit both names with one value, so neither half of the
 * dual-name check can see two values.
 */
const REPO = path.resolve(__dirname, '../../../../../..');

/** The committed strip lists (child-process environments) that name the admin URL, and the CI helpers that emit it. */
const ADMIN_NAME_LISTS = [
  'packages/rab-server/src/database/typeorm/scripts/migration-security-check.ts',
  'packages/rab-server/src/database/typeorm/scripts/migrate/owner-login/owner-login-lifecycle-check.ts',
  'packages/rab-e2e-testing/ai/runtime-env.sh',
  'packages/rab-e2e-testing/live/run-live.sh',
  'packages/rab-server/src/database/typeorm/scripts/twenty-test-env.cjs',
  'packages/rab-server/src/database/typeorm/scripts/migration-security-test-env.cjs',
];

describe('X3.5-S7 the test admin URL names in strip lists and CI helpers', () => {
  it('the guard knows exactly the two names, new name first', () => {
    expect(TEST_DATABASE_ADMIN_URL_NAMES).toEqual([TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL_UNPOOLED]);
  });

  it.each(ADMIN_NAME_LISTS)('%s: every code line naming the deprecated name names the new name too', (file) => {
    // Comment lines (#, //, *) are prose, often wrapped; only code lines are lists, loops or emitted exports.
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line));
    const naming = lines.filter((line) => line.includes(TEST_DATABASE_URL_UNPOOLED));
    expect(naming.length).toBeGreaterThan(0);
    const missing = naming.map((line) => line.trim().slice(0, 80)).filter((_l, i) => !naming[i].includes(TEST_DATABASE_ADMIN_URL));
    expect(missing).toEqual([]);
  });

  describe('the CI helpers emit both names with the same value (synthetic, loopback values only; nothing printed)', () => {
    const ADMIN = 'postgres://x35_admin:x35-sentinel-pw@127.0.0.1:1/postgres';
    const run = (script: string, args: string[]): Record<string, string> => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MIGRATION_SECURITY_ADMIN_URL: ADMIN,
        CREWFLOW_OWNER_BOOTSTRAP_PASSWORD: 'x35-owner-pw',
        CREWFLOW_APP_BOOTSTRAP_PASSWORD: 'x35-app-pw',
      };
      const result = spawnSync(process.execPath, [path.join(REPO, 'packages/rab-server/src/database/typeorm/scripts', script), ...args], {
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const exported: Record<string, string> = {};
      for (const line of String(result.stdout).split('\n')) {
        const m = /^export ([A-Z_]+)='(.*)'$/.exec(line);
        if (m) exported[m[1]] = m[2];
      }
      return exported;
    };

    it.each<[string, string[]]>([
      ['twenty-test-env.cjs', ['twa_tw_x35', '--source', 'bootstrap']],
      ['migration-security-test-env.cjs', ['x35_fresh_abc']],
    ])('%s', (script, args) => {
      const exported = run(script, args);
      expect(exported[TEST_DATABASE_ADMIN_URL]).toBeTruthy();
      expect(exported[TEST_DATABASE_URL_UNPOOLED]).toBe(exported[TEST_DATABASE_ADMIN_URL]);
      expect(new URL(exported[TEST_DATABASE_ADMIN_URL]).username).toBe('x35_admin');
    });
  });
});
