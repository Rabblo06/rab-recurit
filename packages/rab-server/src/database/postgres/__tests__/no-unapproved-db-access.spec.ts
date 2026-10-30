import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

/**
 * Phase B (B1) static guard: every database connection in production code comes from the connection factory
 * (src/database/postgres). This spec parses the source (TypeScript AST, so comments and strings never match) and fails on:
 *   - a read of a database URL variable from an environment object: `process.env.X`, `env.X`, `env['X']`, or
 *     `const { X } = process.env`, where X contains DATABASE_…URL, or starts with PG_/DB_ and contains URL, or is
 *     DB_POOL_MAX / PG_POOL_*;
 *   - `new Pool(` / `new Client(` imported from 'pg' (or `new pg.Pool(` / `new pg.Client(`), and `new DataSource(` (or
 *     any `new …DataSource(`) — a connection constructed outside the factory.
 *
 * Allowed without a list: the factory itself and tests and test helpers (`__tests__/`, `*.spec.ts`, `jest-*`). The Worker
 * bundle launcher (packages/rab-docker/…/start-worker-bundle.cjs) is outside the scanned roots. Security review L-5: the
 * migration scripts directory (src/database/typeorm/scripts) is no longer exempt as a whole — it ships in dist/ — so each
 * script that genuinely needs a raw read or construction has its own BASELINE entry, and a new script is scanned.
 *
 * Everything else that exists today is in BASELINE with its exact count of hits. A new hit anywhere fails; a file whose
 * count DROPS also fails until its entry is lowered or removed, so the list only ever shrinks.
 */
const REPO = path.resolve(__dirname, '../../../../../..');
const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src', 'tools'];
const ALLOWED_PREFIXES = ['packages/rab-server/src/database/postgres/'];

/** file → exact number of hits allowed today, each with the reason and who moves it to the factory. */
const BASELINE: Record<string, { hits: number; why: string }> = {
  // (Phase B A7: the identity guards — runtime-database-guard.ts, database-target.ts, the boot gates and db:bind-identity —
  // now resolve and connect through the factory only, so their entries are gone.)
  // Test routing (TEST_DATABASE_URL* → DATABASE_URL*). (L-5: the posture snapshot's clients now come from the factory.)
  'packages/rab-server/src/database/typeorm/core/test-database-guard.ts': { hits: 3, why: 'Jest routing writes DATABASE_URL*, probe Client' },
  // Constructs the TypeORM migration DataSource class around the factory's options (the options ARE from the factory).
  'packages/rab-server/src/database/typeorm/core/core.datasource.ts': { hits: 1, why: 'GuardedMigrationDataSource built from factory options' },
  // Worker call sites that take a config/string the factory now produces (pgClientConfig / pgConnectionString).
  'packages/rab-worker/src/core/database/reconnecting-pg-client.ts': { hits: 1, why: 'wrapper: new Client(config); callers pass a factory config' },
  'packages/rab-worker/src/queues/rab-maintenance/workspace-schema-drift.job.ts': { hits: 1, why: 'drift Client from a factory pgClientConfig' },
  // Developer tool.
  'tools/generate-workspace-schema-v1.js': { hits: 1, why: 'developer template generator (HWS_TEMPLATE_SOURCE_URL)' },
  // Security review L-5: the migration / operator scripts, one entry each (the directory used to be exempt wholesale).
  'packages/rab-server/src/database/typeorm/scripts/check-db-security-posture.ts': {
    hits: 1,
    why: 'operator script reads its own POSTURE_DATABASE_URL; connects through the factory (security-posture.ts createPgClientForUrl)',
  },
  'packages/rab-server/src/database/typeorm/scripts/check-workspace-schema-drift.ts': {
    hits: 1,
    why: 'operator script reads its own DRIFT_DATABASE_URL; connects through the factory (createPgClientForUrl)',
  },
  'packages/rab-server/src/database/typeorm/scripts/check-pending-migrations.ts': { hits: 1, why: 'TypeORM DataSource built from core.datasource factory options' },
  'packages/rab-server/src/database/typeorm/scripts/migrate-workspace-schemas.ts': { hits: 1, why: 'TypeORM DataSource built from factory options' },
  'packages/rab-server/src/database/typeorm/scripts/migrate/locked-migration-runner.ts': { hits: 1, why: 'the migration DataSource, built from pgTypeOrmConnectionOptions' },
  'packages/rab-server/src/database/typeorm/scripts/migrate/migration-database-url.ts': { hits: 1, why: 'names which variable the migration URL came from (the factory resolves it)' },
  'packages/rab-server/src/database/typeorm/scripts/migration-security-check.ts': {
    hits: 11,
    why: 'the M2 CI harness: builds disposable databases as the bootstrap superuser and hands each identity URL to the guarded DataSource',
  },
};

const URL_ENV_NAME = /DATABASE_\w*URL|^(PG|DB)_\w*URL|^DB_POOL_MAX$|^PG_POOL_/;

export interface DbAccessHit {
  line: number;
  kind: 'env-read' | 'new-connection';
  detail: string;
}

/** Exported for the self-test below. */
export function scanSource(fileName: string, text: string): DbAccessHit[] {
  const kind = /\.(c|m)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, kind);
  const hits: DbAccessHit[] = [];
  const pgNames = new Set<string>();
  const pgNamespaces = new Set<string>();
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const isEnvObject = (expr: ts.Expression): boolean =>
    (ts.isIdentifier(expr) && expr.text === 'env') || (ts.isPropertyAccessExpression(expr) && expr.name.text === 'env');

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'pg') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) pgNames.add(el.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) pgNamespaces.add(bindings.name.text);
      if (node.importClause?.name) pgNamespaces.add(node.importClause.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      if (ts.isIdentifier(call.expression) && call.expression.text === 'require' && call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'pg') {
        if (ts.isIdentifier(node.name)) pgNamespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) for (const el of node.name.elements) if (ts.isIdentifier(el.name)) pgNames.add(el.name.text);
      }
    }
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression) && URL_ENV_NAME.test(node.name.text)) {
      hits.push({ line: lineOf(node), kind: 'env-read', detail: node.name.text });
    }
    if (ts.isElementAccessExpression(node) && isEnvObject(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && URL_ENV_NAME.test(node.argumentExpression.text)) {
      hits.push({ line: lineOf(node), kind: 'env-read', detail: node.argumentExpression.text });
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isEnvObject(node.initializer)) {
      for (const el of node.name.elements) {
        const name = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
        if (URL_ENV_NAME.test(name)) hits.push({ line: lineOf(el), kind: 'env-read', detail: name });
      }
    }
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (/DataSource$/.test(callee.text) || pgNames.has(callee.text) && ['Pool', 'Client'].includes(callee.text)) {
          hits.push({ line: lineOf(node), kind: 'new-connection', detail: callee.text });
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        if (pgNamespaces.has(callee.expression.text) && ['Pool', 'Client'].includes(callee.name.text)) {
          hits.push({ line: lineOf(node), kind: 'new-connection', detail: `${callee.expression.text}.${callee.name.text}` });
        }
        if (/DataSource$/.test(callee.name.text)) hits.push({ line: lineOf(node), kind: 'new-connection', detail: callee.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function isTestFile(rel: string): boolean {
  return /\/__tests__\//.test(rel) || /\.(spec|test)\.[cm]?[jt]s$/.test(rel) || /\/jest-[^/]+$/.test(rel);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|js|cjs|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** True for a repository-relative path the scan never looks at (the factory, tests). Exported for the self-test. */
export function isExemptFromScan(rel: string): boolean {
  return isTestFile(rel) || ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

export function scanRepository(): Map<string, DbAccessHit[]> {
  const result = new Map<string, DbAccessHit[]>();
  for (const root of ROOTS) {
    for (const file of listFiles(path.join(REPO, root))) {
      const rel = path.relative(REPO, file).split(path.sep).join('/');
      if (isExemptFromScan(rel)) continue;
      const hits = scanSource(rel, fs.readFileSync(file, 'utf8'));
      if (hits.length) result.set(rel, hits);
    }
  }
  return result;
}

describe('no unapproved database access (Phase B source scan)', () => {
  it('the scanner finds real reads and constructions, and ignores comments, strings and unrelated classes', () => {
    const hits = scanSource(
      'sample.ts',
      [
        "import { Client, Pool } from 'pg';",
        "import { Client as S3Client } from 'other';",
        "import { DataSource } from 'typeorm';",
        '// process.env.DATABASE_URL in a comment, new Client( in a comment',
        "const s = 'process.env.PG_DATABASE_URL';",
        'const a = process.env.DATABASE_URL;',
        "const b = env['PG_DATABASE_URL'];",
        'const { DATABASE_DIRECT_URL, REDIS_URL } = process.env;',
        'const c = process.env.DB_POOL_MAX;',
        'const d = process.env.REDIS_URL;',
        'new Client({});',
        'new Pool({});',
        'new S3Client({});',
        'new DataSource({});',
        'new GuardedMigrationDataSource({});',
        'new Redis(x);',
      ].join('\n'),
    );
    expect(hits.map((h) => `${h.line}:${h.kind}:${h.detail}`)).toEqual([
      '6:env-read:DATABASE_URL',
      '7:env-read:PG_DATABASE_URL',
      '8:env-read:DATABASE_DIRECT_URL',
      '9:env-read:DB_POOL_MAX',
      '11:new-connection:Client',
      '12:new-connection:Pool',
      '14:new-connection:DataSource',
      '15:new-connection:GuardedMigrationDataSource',
    ]);
    expect(scanSource('x.cjs', "const pg = require('pg');\nnew pg.Client({});\nconst { Pool } = require('pg');\nnew Pool();").map((h) => h.detail)).toEqual([
      'pg.Client',
      'Pool',
    ]);
  });

  it('L-5: a script under typeorm/scripts/ is scanned like any production file (a new raw connection there fails)', () => {
    const newScript = 'packages/rab-server/src/database/typeorm/scripts/new-operator-tool.ts';
    expect(isExemptFromScan(newScript)).toBe(false);
    expect(BASELINE[newScript]).toBeUndefined();
    expect(scanSource(newScript, "import { Client } from 'pg';\nconst c = new Client({ connectionString: process.env.SOME_DATABASE_URL });").map((h) => h.kind).sort()).toEqual([
      'env-read',
      'new-connection',
    ]);
    // Only the factory and tests stay exempt.
    expect(isExemptFromScan('packages/rab-server/src/database/postgres/create-pg-pool.ts')).toBe(true);
    expect(isExemptFromScan('packages/rab-server/src/database/typeorm/scripts/migrate/migration-runner.spec.ts')).toBe(true);
  });

  it('production code reads no database URL and opens no connection outside the factory (baseline only shrinks)', () => {
    const found = scanRepository();
    const problems: string[] = [];
    for (const [file, hits] of found) {
      const allowed = BASELINE[file]?.hits ?? 0;
      if (hits.length > allowed) {
        problems.push(
          `${file}: ${hits.length} unapproved database access(es), baseline ${allowed}:\n` +
            hits.map((h) => `    line ${h.line}: ${h.kind} ${h.detail}`).join('\n') +
            '\n  Use src/database/postgres (resolvePgEnvironmentCached + pgClientConfig / createPgClient / createPgDataSource).',
        );
      }
    }
    for (const [file, entry] of Object.entries(BASELINE)) {
      const count = found.get(file)?.length ?? 0;
      if (count < entry.hits) problems.push(`${file}: baseline says ${entry.hits} but ${count} remain — lower the BASELINE entry (it only shrinks).`);
    }
    expect(problems).toEqual([]);
  });
});
