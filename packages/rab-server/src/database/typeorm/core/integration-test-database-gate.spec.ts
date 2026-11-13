import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

import { integrationTestDatabaseReady } from './integration-test-database-gate';
import { TEST_DATABASE_URL, TEST_DATABASE_URL_UNPOOLED, TestDatabaseConfigError } from './test-database-guard';

/**
 * DEAD-07 (cleanup audit 2026-11-02, C1; X3.5 PR B). The spec skip-gates use integrationTestDatabaseReady(), which keys on
 * NODE_ENV=test and the validated TEST_* pair and throws instead of returning false. Two halves:
 *   1. the gate itself: true for a valid pair, a TestDatabaseConfigError (never `false`, never a silent skip) otherwise;
 *   2. a static scan: no spec decides whether to SKIP from a database connection variable (the legacy primary / elevated
 *      names, the TEST_* names, PG_DATABASE_URL), directly or through a top-level const, so a later change to what the
 *      routing writes can never turn suites into silent skips.
 */
const SECRET = 'S3cret-PW-do-not-print';
const APP = `postgres://crewflow_owner:${SECRET}@127.0.0.1:55462/rab_test_gate`;
const ADMIN = `postgres://ci_bootstrap:${SECRET}@127.0.0.1:55462/rab_test_gate`;

describe('DEAD-07 integration test database gate', () => {
  describe('the gate', () => {
    it('is true for NODE_ENV=test and a valid TEST pair, and reads no legacy connection name', () => {
      expect(integrationTestDatabaseReady({ NODE_ENV: 'test', [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN })).toBe(true);
    });

    it('is true in this Jest process (setupFiles routed it; globalSetup proved the pair live)', () => {
      expect(integrationTestDatabaseReady()).toBe(true);
    });

    it.each<[string, Record<string, string | undefined>, RegExp]>([
      ['the TEST pair missing (the legacy names alone never count)', { NODE_ENV: 'test', DATABASE_URL: APP, DATABASE_URL_UNPOOLED: ADMIN, PG_DATABASE_URL: APP }, /TEST_DATABASE_URL is required/],
      ['the admin half missing', { NODE_ENV: 'test', [TEST_DATABASE_URL]: APP }, /TEST_DATABASE_URL_UNPOOLED is required|TEST_DATABASE_ADMIN_URL is required/],
      ['NODE_ENV not test (an Nx-loaded .env)', { NODE_ENV: 'development', [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN }, /not "test"/],
      ['NODE_ENV unset', { [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN }, /not "test"/],
      [
        'the pair on two databases',
        { NODE_ENV: 'test', [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN.replace('rab_test_gate', 'rab_other') },
        /different databases/,
      ],
      [
        'a remote pair without the override',
        {
          NODE_ENV: 'test',
          [TEST_DATABASE_URL]: APP.replace('127.0.0.1:55462', 'db.example.test'),
          [TEST_DATABASE_URL_UNPOOLED]: ADMIN.replace('127.0.0.1:55462', 'db.example.test'),
        },
        /Remote test database/,
      ],
      ['the development database', { NODE_ENV: 'test', [TEST_DATABASE_URL]: APP.replace('55462', '15432'), [TEST_DATABASE_URL_UNPOOLED]: ADMIN.replace('55462', '15432') }, /development database/],
    ])('throws (never returns false) for %s, without echoing a value', (_name, env, pattern) => {
      let result: unknown = 'not called';
      let message = '';
      try {
        result = integrationTestDatabaseReady(env);
      } catch (error) {
        expect(error).toBeInstanceOf(TestDatabaseConfigError);
        message = (error as Error).message;
      }
      expect(result).toBe('not called');
      expect(message).toMatch(pattern);
      expect(message).not.toContain(SECRET);
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
    });
  });

  describe('static scan: no spec skip-gate reads a database connection variable', () => {
    const REPO = path.resolve(__dirname, '../../../../../..');
    const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
    const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'coverage', '.nx']);
    /**
     * `process.env.X` / `process.env['X']` for the names the routing writes or validates (the legacy primary / elevated /
     * lock names, PG_DATABASE_URL, the TEST pair under either admin name). The optional logins (TEST_DATABASE_WORKER_URL,
     * TEST_DATABASE_CREWFLOW_URL, ...) stay allowed: a gate on them is a deliberate opt-in, not a routing check.
     */
    const CONNECTION_ENV_READ =
      /process\.env(?:\.|\[\s*['"`])(?:(?:PG_)?DATABASE_URL|DATABASE_URL_UNPOOLED|DATABASE_DIRECT_URL|TEST_DATABASE_URL(?:_UNPOOLED)?|TEST_DATABASE_ADMIN_URL)\b/;

    const isSkip = (node: ts.Expression): boolean => {
      const text = node.getText().replace(/\s+/g, '');
      return /^(describe|it|test)\.skip$/.test(text) || /^\((describe|it|test)\.skip\)$/.test(text);
    };

    /** Every skip conditional's condition, expanded through the top-level consts it names (transitively). */
    function offendingGates(fileName: string, source: string): string[] {
      const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const topLevel = new Map<string, ts.Expression>();
      for (const statement of sf.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) topLevel.set(decl.name.text, decl.initializer);
        }
      }
      const expand = (expr: ts.Node, seen: Set<string>): string[] => {
        const texts = [expr.getText()];
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && topLevel.has(node.text) && !seen.has(node.text)) {
            seen.add(node.text);
            texts.push(...expand(topLevel.get(node.text) as ts.Expression, seen));
          }
          ts.forEachChild(node, visit);
        };
        visit(expr);
        return texts;
      };
      const offenders: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isConditionalExpression(node) && (isSkip(node.whenTrue) || isSkip(node.whenFalse))) {
          if (expand(node.condition, new Set()).some((text) => CONNECTION_ENV_READ.test(text))) {
            offenders.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return offenders;
    }

    it('the scan catches the old shapes (direct, combined, through a const) and accepts the gate', () => {
      const old = [
        "const RUN = Boolean(process.env.DATABASE_URL);\nconst d = RUN ? describe : describe.skip;",
        "const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);\n(RUN ? describe : describe.skip)('x', () => {});",
        "const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;",
        "const DB_URL = process.env.DATABASE_URL;\nconst describeIf = REDIS_URL && DB_URL ? describe : describe.skip;",
        "const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);\nconst it2 = RUN ? it : it.skip;",
        "const A = process.env['PG_DATABASE_URL'];\nconst B = A;\nconst d = B ? describe : describe.skip;",
      ];
      for (const source of old) expect(offendingGates('fixture.spec.ts', source)).toHaveLength(1);
      const ok = [
        "const RUN = integrationTestDatabaseReady();\nconst d = RUN ? describe : describe.skip;",
        "const DB_URL = process.env.DATABASE_URL;\nconst describeIf = REDIS_URL && integrationTestDatabaseReady() ? describe : describe.skip;\nopen(DB_URL);",
        "const RUN = integrationTestDatabaseReady() && process.env.RUN_PERF_BASELINE === 'true';\nconst d = RUN ? describe : describe.skip;",
        "const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;\nconst RUN = Boolean(WORKER_URL) && integrationTestDatabaseReady();\nconst d = RUN ? describe : describe.skip;",
      ];
      for (const source of ok) expect(offendingGates('fixture.spec.ts', source)).toEqual([]);
    });

    it('no rab-server or rab-worker spec gates on a connection variable (they use integrationTestDatabaseReady)', () => {
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) walk(full);
          } else if (/\.(spec|test)\.ts$/.test(entry.name)) {
            offenders.push(...offendingGates(path.relative(REPO, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')));
          }
        }
      };
      for (const root of ROOTS) walk(path.join(REPO, root));
      expect(offenders).toEqual([]);
    });
  });
});
