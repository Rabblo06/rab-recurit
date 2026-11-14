import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

import { integrationTestDatabase, integrationTestDatabaseReady } from './integration-test-database-gate';
import {
  FORBIDDEN_IN_TEST_DATABASE_URL_NAMES,
  INHERITED_DATABASE_URL_NAMES,
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_UNPOOLED,
  TestDatabaseConfigError,
} from './test-database-guard';

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

    it('integrationTestDatabase() hands an opt-in the validated identity, and throws (never null) on an invalid pair', () => {
      const resolved = integrationTestDatabase({ NODE_ENV: 'test', [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN });
      expect(resolved.app.login).toBe('crewflow_owner');
      expect(resolved.app.port).toBe('55462');
      expect(() => integrationTestDatabase({ NODE_ENV: 'test', [TEST_DATABASE_URL]: APP })).toThrow(TestDatabaseConfigError);
      expect(() => integrationTestDatabase({ NODE_ENV: 'development', [TEST_DATABASE_URL]: APP, [TEST_DATABASE_URL_UNPOOLED]: ADMIN })).toThrow(TestDatabaseConfigError);
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

  describe('static scan: no spec skip-gate (or admin connection) comes from an environment connection variable', () => {
    const REPO = path.resolve(__dirname, '../../../../../..');
    const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
    const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'coverage', '.nx']);
    /**
     * The names the routing writes or validates, plus every inherited / forbidden connection name the guard knows (review
     * B-1). The optional logins (TEST_DATABASE_WORKER_URL, TEST_DATABASE_CREWFLOW_URL, TEST_DATABASE_TWENTY_OWNER_URL) stay
     * allowed in gates: a gate on them is a deliberate opt-in, not a routing check.
     */
    const GATE_NAMES = new Set<string>([
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
      'PG_WORKER_DATABASE_URL',
      'TEST_DATABASE_URL',
      'TEST_DATABASE_URL_UNPOOLED',
      'TEST_DATABASE_ADMIN_URL',
      ...INHERITED_DATABASE_URL_NAMES,
      ...FORBIDDEN_IN_TEST_DATABASE_URL_NAMES,
    ]);
    const isGateName = (name: string): boolean => GATE_NAMES.has(name) || /^CREWFLOW_\w*_DATABASE_URL$/.test(name);
    /** Review B-2: a spec never takes the admin / elevated connection from the environment (integrationTestDatabase().adminUrl). */
    const ADMIN_NAMES = new Set<string>(['TEST_DATABASE_URL_UNPOOLED', 'TEST_DATABASE_ADMIN_URL', 'DATABASE_URL_UNPOOLED']);

    interface Analysis {
      skipGates: string[];
      adminReads: string[];
    }

    function analyse(fileName: string, source: string): Analysis {
      const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const line = (node: ts.Node): string => `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      // Every declaration in the file, any scope (consts inside describe callbacks included); shadowed names are unioned.
      const declarations = new Map<string, ts.VariableDeclaration[]>();
      const destructured = new Map<string, { from: ts.Expression; key: string }>();
      const visitDecl = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node)) {
          if (ts.isIdentifier(node.name)) {
            declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
          } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
            for (const el of node.name.elements) {
              if (!ts.isIdentifier(el.name)) continue;
              const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : el.name.text;
              destructured.set(el.name.text, { from: node.initializer, key });
            }
          }
        }
        ts.forEachChild(node, visitDecl);
      };
      visitDecl(sf);

      const isEnvObject = (expr: ts.Expression, seen = new Set<string>()): boolean => {
        const e = ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr) ? expr.expression : expr;
        if (ts.isPropertyAccessExpression(e) && e.name.text === 'env' && ts.isIdentifier(e.expression) && e.expression.text === 'process') return true;
        if (ts.isIdentifier(e) && !seen.has(e.text)) {
          seen.add(e.text);
          return (declarations.get(e.text) ?? []).some((d) => d.initializer !== undefined && isEnvObject(d.initializer, seen));
        }
        return false;
      };
      const keyOf = (arg: ts.Expression, seen = new Set<string>()): string | null => {
        if (ts.isStringLiteralLike(arg)) return arg.text;
        if (ts.isIdentifier(arg) && !seen.has(arg.text)) {
          seen.add(arg.text);
          for (const d of declarations.get(arg.text) ?? []) {
            const k = d.initializer ? keyOf(d.initializer, seen) : null;
            if (k) return k;
          }
        }
        return null;
      };
      const isWrite = (node: ts.Node): boolean => {
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
        return ts.isDeleteExpression(parent);
      };
      /** The environment name a node reads directly (property, computed key, destructured binding), or null. */
      const directRead = (node: ts.Node): string | null => {
        if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) return node.name.text;
        if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)) return keyOf(node.argumentExpression);
        if (ts.isIdentifier(node)) {
          const d = destructured.get(node.text);
          if (d && isEnvObject(d.from) && !(ts.isBindingElement(node.parent) && node.parent.name === node)) return d.key;
        }
        return null;
      };
      /** An identifier in reference position (not a property name, an object-literal key or a declared name). */
      const isReference = (n: ts.Identifier): boolean => {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
        if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n) return false;
        if ((ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) && p.name === n) return false;
        return true;
      };
      /** True when `node`, or any declaration it names (transitively, any scope), reads one of `names` from the environment. */
      const readsAny = (node: ts.Node, match: (name: string) => boolean, seen = new Set<string>()): boolean => {
        let found = false;
        const visit = (n: ts.Node): void => {
          if (found) return;
          const name = directRead(n);
          if (name !== null && match(name)) {
            found = true;
            return;
          }
          if (ts.isIdentifier(n) && isReference(n) && !seen.has(n.text)) {
            seen.add(n.text);
            for (const d of declarations.get(n.text) ?? []) {
              if (d.initializer && readsAny(d.initializer, match, seen)) {
                found = true;
                return;
              }
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(node);
        return found;
      };
      const hasSkip = (node: ts.Node): boolean => {
        let found = false;
        const visit = (n: ts.Node): void => {
          if (found) return;
          if (ts.isPropertyAccessExpression(n) && n.name.text === 'skip') found = true;
          else ts.forEachChild(n, visit);
        };
        visit(node);
        return found;
      };
      const exitsEarly = (stmt: ts.Statement): boolean =>
        ts.isReturnStatement(stmt) || (ts.isBlock(stmt) && stmt.statements.some((s) => ts.isReturnStatement(s)));

      const skipGates: string[] = [];
      const adminReads: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isConditionalExpression(node) && (hasSkip(node.whenTrue) || hasSkip(node.whenFalse)) && readsAny(node.condition, isGateName)) {
          skipGates.push(line(node));
        }
        if (
          ts.isIfStatement(node) &&
          (hasSkip(node.thenStatement) || (node.elseStatement !== undefined && hasSkip(node.elseStatement)) || exitsEarly(node.thenStatement)) &&
          readsAny(node.expression, isGateName)
        ) {
          skipGates.push(line(node));
        }
        const name = directRead(node);
        if (name !== null && ADMIN_NAMES.has(name) && !isWrite(node)) adminReads.push(line(node));
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return { skipGates, adminReads };
    }

    it('the gate scan flags every known shape (review B-1 fixtures) and accepts the gate', () => {
      const mustFlag = [
        // the original shapes
        'const RUN = Boolean(process.env.DATABASE_URL);\nconst d = RUN ? describe : describe.skip;',
        "const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);\n(RUN ? describe : describe.skip)('x', () => {});",
        'const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;',
        'const DB_URL = process.env.DATABASE_URL;\nconst describeIf = REDIS_URL && DB_URL ? describe : describe.skip;',
        'const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);\nconst it2 = RUN ? it : it.skip;',
        "const A = process.env['PG_DATABASE_URL'];\nconst B = A;\nconst d = B ? describe : describe.skip;",
        "const appUser = new URL(process.env.TEST_DATABASE_URL ?? '').username;\nconst OWNER = appUser === 'crewflow_owner';\nconst suite = OWNER ? describe : describe.skip;",
        // B-1: the call form (server-path-provisioning-db.integration.spec.ts:54 shape)
        "const ok = Boolean(process.env.DATABASE_URL);\nok ? it('t', () => {}) : it.skip('t', () => {});",
        // B-1: describe.skip.each
        'const d = process.env.DATABASE_URL ? describe.each : describe.skip.each;',
        // B-1: an if / else with .skip, and an early exit
        "if (process.env.PG_DATABASE_URL) describe('x', () => {}); else describe.skip('x', () => {});",
        'beforeAll(() => { if (!process.env.DATABASE_URL) return; });',
        "it('t', async () => { const u = process.env.TEST_DATABASE_URL; if (!u) { return; } });",
        // B-1: a const inside a describe callback (enclosing scope)
        "describe('o', () => { const U = process.env.DATABASE_URL; (U ? it : it.skip)('t', () => {}); });",
        // B-1: aliases of process.env, destructuring (plain and renamed), computed keys through a const
        'const e = process.env;\nconst d = e.DATABASE_URL ? describe : describe.skip;',
        'const { DATABASE_URL } = process.env;\nconst d = DATABASE_URL ? describe : describe.skip;',
        "const { PG_DATABASE_URL: u } = process.env;\nconst d = u ? describe : describe.skip;",
        "const K = 'DATABASE_URL';\nconst d = process.env[K] ? describe : describe.skip;",
        // B-1: the inherited / forbidden names
        'const d = process.env.CREWFLOW_PROVISIONER_DATABASE_URL ? describe : describe.skip;',
        'const d = process.env.PG_DATABASE_REPLICA_URL ? describe : describe.skip;',
        'const d = process.env.PG_WORKER_DATABASE_URL ? describe : describe.skip;',
        'const d = process.env.CREWFLOW_MIGRATION_DATABASE_URL ? describe : describe.skip;',
      ];
      for (const source of mustFlag) expect([source, analyse('fixture.spec.ts', source).skipGates.length]).toEqual([source, 1]);
      const ok = [
        'const RUN = integrationTestDatabaseReady();\nconst d = RUN ? describe : describe.skip;',
        'const DB_URL = process.env.DATABASE_URL;\nconst describeIf = REDIS_URL && integrationTestDatabaseReady() ? describe : describe.skip;\nopen(DB_URL);',
        "const RUN = integrationTestDatabaseReady() && process.env.RUN_PERF_BASELINE === 'true';\nconst d = RUN ? describe : describe.skip;",
        'const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;\nconst RUN = Boolean(WORKER_URL) && integrationTestDatabaseReady();\nconst d = RUN ? describe : describe.skip;',
        "const env = integrationTestDatabase();\nconst OWNER = env.app.login === 'crewflow_owner';\nconst suite = OWNER ? describe : describe.skip;",
        "it('t', async () => { const rows = await q(); if (!rows.length) return; });",
        // a property name is not a reference: `process.env` must not resolve to an unrelated `const env` reading the app URL
        [
          'const APP_URL = process.env.TEST_DATABASE_URL;',
          "const RUN = process.env.PHASE_D_SQL_APPROVED === 'true';",
          'const d = RUN ? describe : describe.skip;',
          'function f() { const env = connect({ url: APP_URL }); }',
        ].join('\n'),
      ];
      for (const source of ok) expect([source, analyse('fixture.spec.ts', source).skipGates]).toEqual([source, []]);
    });

    it('the admin-read rule (review B-2) flags a spec taking the admin / elevated URL from the environment, not a write', () => {
      const mustFlag = [
        'admin = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });',
        "const owner = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL_UNPOOLED });",
        "const who = new URL(process.env['TEST_DATABASE_URL_UNPOOLED']!).username;",
        'const { DATABASE_URL_UNPOOLED: u } = process.env;\nconnect(u);',
        'const e = process.env;\nconnect(e.TEST_DATABASE_ADMIN_URL);',
      ];
      for (const source of mustFlag) expect([source, analyse('fixture.spec.ts', source).adminReads.length > 0]).toEqual([source, true]);
      const ok = [
        "process.env.DATABASE_URL_UNPOOLED = 'postgres://x@127.0.0.1/db';",
        'delete process.env.DATABASE_URL_UNPOOLED;',
        'admin = new Client({ connectionString: integrationTestDatabase().adminUrl });',
        "const env = { DATABASE_URL_UNPOOLED: 'x' };\nexpect(env.DATABASE_URL_UNPOOLED).toBe('x');",
      ];
      for (const source of ok) expect([source, analyse('fixture.spec.ts', source).adminReads]).toEqual([source, []]);
    });

    it('no rab-server or rab-worker spec or test helper gates on a connection variable or reads the admin URL from the environment', () => {
      const skipGates: string[] = [];
      const adminReads: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(REPO, full).split(path.sep).join('/');
          if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) walk(full);
          } else if (/\.(spec|test)\.ts$/.test(entry.name) || (/\/__tests__\//.test(rel) && /\.ts$/.test(entry.name))) {
            const a = analyse(rel, fs.readFileSync(full, 'utf8'));
            skipGates.push(...a.skipGates);
            adminReads.push(...a.adminReads);
          }
        }
      };
      for (const root of ROOTS) walk(path.join(REPO, root));
      expect({ skipGates, adminReads }).toEqual({ skipGates: [], adminReads: [] });
    });
  });
});
