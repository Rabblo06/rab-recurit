import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { TEST_DATABASE_ADMIN_URL, TEST_DATABASE_ADMIN_URL_NAMES, TEST_DATABASE_URL_UNPOOLED } from './test-database-guard';

/**
 * X3.5-S7 (audit DBT-08 step 6), release 1: the test admin URL (the disposable cluster's bootstrap SUPERUSER) has a new name,
 * TEST_DATABASE_ADMIN_URL, and the deprecated TEST_DATABASE_URL_UNPOOLED is still accepted. Every place that keeps the admin
 * URL away from a child process (the migrate / RLS-gate children, the e2e API, Worker, Vite and Playwright, spec-spawned
 * runtime children) must handle BOTH names; one that only knows the old name would hand the superuser URL to the child as
 * soon as a developer or CI sets the new one (the DBT-12 class).
 *
 * Review A-3: so this is not a list of known files. EVERY tracked code file is scanned, and every code line naming the
 * deprecated name must name the new one too. The TypeScript strip sites import TEST_DATABASE_ADMIN_URL_NAMES instead of
 * spelling the names. Exempt: tests (they plant either name on purpose), immutable migrations, docs, and the files listed in
 * OLD_NAME_ONLY_ALLOWED with the reason.
 */
const REPO = path.resolve(__dirname, '../../../../../..');
const CODE_FILE = /\.(ts|tsx|js|cjs|mjs|sh|ya?ml)$/;
const TEST_FILE = /\.(spec|test)\.(ts|cjs|js|mjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-cjs', 'dist-esm', 'coverage', '.nx', 'docs', 'migrations', 'test-results', 'build']);

/** Files that may name only the old name, each with why. Paths are repository-relative with forward slashes. */
const OLD_NAME_ONLY_ALLOWED: Record<string, string> = {
  'packages/rab-server/src/database/typeorm/core/test-database-guard.ts': 'defines and resolves both names',
  'packages/rab-server/src/__tests__/integration/twenty/twenty-kit.ts':
    'a reader, not a strip list; the guard writes both names (moves to the gate helper in DEAD-07 B-2)',
  '.github/workflows/ci-security.yaml': 'lead-owned setter, not a strip list; draft in LEGACY-NAMES-PLAN.md §5.1 (required at release 2)',
  '.github/workflows/ci-migration-security.yaml': 'lead-owned reader of the helper output, which emits both names; draft in LEGACY-NAMES-PLAN.md §5.1',
};

const isCommentLine = (line: string): boolean => /^\s*(#|\/\/|\*|\/\*)/.test(line);

/** Code lines naming the deprecated admin name without the new one (prose comments excluded). */
function oldNameOnlyLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !isCommentLine(line) && line.includes(TEST_DATABASE_URL_UNPOOLED) && !line.includes(TEST_DATABASE_ADMIN_URL))
    .map((line) => line.trim().slice(0, 100));
}

function trackedCodeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (CODE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.relative(REPO, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of ['packages', 'tools', '.github', 'deploy']) {
    if (fs.existsSync(path.join(REPO, root))) walk(path.join(REPO, root));
  }
  return out;
}

describe('X3.5-S7 the test admin URL names everywhere they are stripped, set or emitted', () => {
  it('the guard knows exactly the two names, new name first', () => {
    expect(TEST_DATABASE_ADMIN_URL_NAMES).toEqual([TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL_UNPOOLED]);
  });

  it('the checker flags a strip list that knows only the old name (fixtures), and accepts both names or prose', () => {
    for (const bad of [
      'env -u DATABASE_URL -u TEST_DATABASE_URL_UNPOOLED node api.js',
      'unset TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED',
      "for (const k of ['TEST_DATABASE_URL_UNPOOLED', 'APP_SECRET']) delete childEnv[k];",
      'STRIPPED=(TEST_DATABASE_URL_UNPOOLED MIGRATION_SECURITY_ADMIN_URL)',
      'delete env.TEST_DATABASE_URL_UNPOOLED;',
    ]) {
      expect(oldNameOnlyLines(`const a = 1;\n${bad}\n`)).toHaveLength(1);
    }
    for (const ok of [
      'env -u TEST_DATABASE_ADMIN_URL -u TEST_DATABASE_URL_UNPOOLED node api.js',
      '# prose naming TEST_DATABASE_URL_UNPOOLED, wrapped',
      ' * TEST_DATABASE_URL_UNPOOLED in a doc comment',
      "for (const k of [...TEST_DATABASE_ADMIN_URL_NAMES, 'APP_SECRET']) delete childEnv[k];",
    ]) {
      expect(oldNameOnlyLines(ok)).toEqual([]);
    }
  });

  it('no tracked code file (tests, migrations and docs aside) names only the deprecated admin name', () => {
    const files = trackedCodeFiles();
    expect(files.length).toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const file of files) {
      if (file in OLD_NAME_ONLY_ALLOWED) continue;
      for (const line of oldNameOnlyLines(fs.readFileSync(path.join(REPO, file), 'utf8'))) offenders.push(`${file}: ${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the TypeScript strip sites use the shared list, not spelled names', () => {
    for (const file of [
      'packages/rab-server/src/database/typeorm/scripts/migration-security-check.ts',
      'packages/rab-server/src/database/typeorm/scripts/migrate/owner-login/owner-login-lifecycle-check.ts',
      'packages/rab-worker/src/__tests__/integration/helpers/runtime-child-env.ts',
    ]) {
      expect([file, fs.readFileSync(path.join(REPO, file), 'utf8').includes('...TEST_DATABASE_ADMIN_URL_NAMES')]).toEqual([file, true]);
    }
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
