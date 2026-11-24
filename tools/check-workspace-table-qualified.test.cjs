'use strict';
/**
 * Tests for tools/check-workspace-table-qualified.cjs (Part C2-0 ratchet) and for the C2-0 exemption in
 * tools/check-sql-injection.cjs. Node built-ins plus the repo's own `typescript` (the scanner parses with it).
 *   node --test tools/check-workspace-table-qualified.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('./check-workspace-table-qualified.cjs');
const sqlLint = require('./check-sql-injection.cjs');

const TABLES = check.loadTables();
const ENTITIES = new Set(['Shift', 'Venue', 'StaffProfile']);
const FILE = 'packages/rab-server/src/modules/x/services/x.service.ts';
const rules = (src, file = FILE) => check.scanSource(file, src, TABLES, ENTITIES).map((s) => s.rule);

test('the table list is the 21 WORKSPACE_TABLES', () => {
  assert.equal(TABLES.length, 21);
  for (const t of ['shift', 'shift_assignment', 'staff_profile', 'payslip_document', 'venue_manager_staff']) assert.ok(TABLES.includes(t), t);
});

test('flags an unqualified business-table reference in a string, a template, a + chain and a join()', () => {
  assert.deepEqual(rules("m.query('SELECT id FROM shift WHERE id = $1', [id]);"), ['unqualified']);
  assert.deepEqual(rules('m.query(`SELECT 1 FROM shift_assignment sa JOIN venue v ON v.id = sa.venue_id`);'), ['unqualified', 'unqualified']);
  assert.deepEqual(rules("const sql = 'SELECT id ' + 'FROM staff_profile WHERE ' + cond;"), ['unqualified']);
  assert.deepEqual(rules("const sql = ['UPDATE job_offer', 'SET status = $1'].join(' ');"), ['unqualified']);
  assert.deepEqual(rules('m.query(`INSERT INTO "payroll_record" (id) VALUES ($1)`);'), ['unqualified']);
});

// The real primitive import, as module code (server relative path) and Worker code ('@rab/server/…') write it.
const IMPORT = "import { businessTables } from '../../../engine/core-modules/tenant/business-tables';\n";
const WORKER_IMPORT = "import { businessTables } from '@rab/server/engine/core-modules/tenant/business-tables';\n";
const WORKER_FILE = 'packages/rab-worker/src/queues/rab-shifts/x.job.ts';

test('accepts ${X.<table>} only when X is `const X = businessTables(…)` in an enclosing scope and not quoted (review #1)', () => {
  assert.deepEqual(rules(IMPORT + 'const t = businessTables(m); m.query(`SELECT 1 FROM ${t.shift} s JOIN ${t.venue} v ON v.id = s.venue_id`);'), []);
  assert.deepEqual(rules(IMPORT + 'async function f(m) { const tables = businessTables(m); return run(async () => m.query(`UPDATE ${tables.shift_assignment} SET status = $1`)); }'), []);
  assert.deepEqual(rules(IMPORT + "const t = businessTables(m); const sql = 'SELECT 1 FROM ' + t.venue + ' WHERE id = $1';"), []);
  assert.deepEqual(rules(WORKER_IMPORT + 'const t = businessTables(m); m.query(`SELECT 1 FROM ${t.attendance}`);', WORKER_FILE), []);
  assert.deepEqual(
    rules("import { businessTables } from './business-tables';\nconst t = businessTables(m); m.query(`SELECT 1 FROM ${t.venue}`);", 'packages/rab-server/src/engine/core-modules/tenant/x.ts'),
    [],
  );
  // The name alone is not enough:
  assert.deepEqual(rules(IMPORT + 'const t = body; m.query(`SELECT 1 FROM ${t.venue}`);'), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + 'm.query(`UPDATE ${tables.shift_assignment} SET status = $1`);'), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + 'let t = businessTables(m); m.query(`SELECT 1 FROM ${t.venue}`);'), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + 'const t = businessTables(m); function g(t) { return m.query(`SELECT 1 FROM ${t.venue}`); }'), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + 'const { venue } = businessTables(m); const t = { venue }; m.query(`SELECT 1 FROM ${t.venue}`);'), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + "const t = body; const sql = 'SELECT 1 FROM ' + t.venue;"), ['other-qualified']);
  // Quoted, even when it is the primitive:
  assert.deepEqual(rules(IMPORT + "const t = businessTables(m); m.query(`SELECT 1 FROM shift_log WHERE name = '${t.venue}'`);"), ['other-qualified']);
  assert.deepEqual(rules(IMPORT + 'const t = businessTables(m); m.query(`SELECT 1 FROM "${t.venue}"`);'), ['other-qualified']);
});

test('re-review MEDIUM: the businessTables CALLEE must be the real non-aliased import; a hoisted var voids the const', () => {
  const q = 'const t = businessTables(req.body); m.query(`SELECT 1 FROM ${t.shift}`);';
  // Re-check Low: only THE primitive module path counts, not any path ending in tenant/business-tables.
  assert.deepEqual(rules("import { businessTables } from './evil/tenant/business-tables';\n" + q), ['other-qualified']);
  assert.deepEqual(rules("import { businessTables } from 'evil-pkg/tenant/business-tables';\n" + q), ['other-qualified']);
  assert.deepEqual(rules("import { businessTables } from '../../tenant/business-tables';\n" + q, WORKER_FILE), ['other-qualified']); // a worker-side tenant/ dir
  assert.deepEqual(rules("import { businessTables } from '@rab/server/engine/core-modules/tenant/business-tables.evil';\n" + q, WORKER_FILE), ['other-qualified']);
  assert.deepEqual(rules("import { businessTables } from '../../../engine/core-modules/tenant/../tenant/business-tables';\n" + q), []); // resolves to it
  assert.deepEqual(rules("import { businessTables } from '../tenant/business-tables';\n" + q, 'packages/rab-server/src/engine/core-modules/user-deletion/x.ts'), []);
  assert.deepEqual(check.secondPrimitiveModules([
    'packages/rab-server/src/engine/core-modules/tenant/business-tables.ts',
    'packages/rab-server/src/modules/foo/tenant/business-tables.ts',
    'packages/rab-worker/src/tenant/business-tables.ts',
  ]).map((s) => [s.file, s.rule]), [
    ['packages/rab-server/src/modules/foo/tenant/business-tables.ts', 'business-schema-bind'],
    ['packages/rab-worker/src/tenant/business-tables.ts', 'business-schema-bind'],
  ]);
  assert.deepEqual(rules('const businessTables = (x) => x; ' + q), ['other-qualified']); // local fake callee
  assert.deepEqual(rules("import { evil as businessTables } from '../../../engine/core-modules/tenant/business-tables';\n" + q), ['other-qualified']); // aliased import
  assert.deepEqual(rules("import { businessTables } from './somewhere-else';\n" + q), ['other-qualified']); // wrong module
  assert.deepEqual(rules("import { businessTables } from './business-tables';\n" + q), ['other-qualified']); // ./business-tables outside tenant/
  assert.deepEqual(rules(q), ['other-qualified']); // missing import
  assert.deepEqual(rules(IMPORT + 'function f(businessTables) { ' + q + ' }'), ['other-qualified']); // parameter shadows the import
  assert.deepEqual(rules("import type { businessTables } from '../../../engine/core-modules/tenant/business-tables';\n" + q), ['other-qualified']); // type-only
  assert.deepEqual(rules(IMPORT + 'function f(m) { const t = businessTables(m); if (x) { var t = body; } return m.query(`SELECT 1 FROM ${t.shift}`); }'), ['other-qualified']); // var hoist
  assert.deepEqual(rules(IMPORT + 'function f(m) { const t = businessTables(m); return m.query(`SELECT 1 FROM ${t.shift}`); } function g() { var t = 1; }'), []); // var in another function
});

test('the binder-only functions are flagged outside the binders (review #3)', () => {
  const mod = 'packages/rab-server/src/modules/venue/services/venue.service.ts';
  assert.deepEqual(rules("import { bindBusinessSchema, businessTables } from '../../../engine/core-modules/tenant/business-tables';", mod), ['business-schema-bind']);
  assert.deepEqual(rules("import { snapshotBusinessSchema as s } from '../tenant/business-tables'; restoreBusinessSchema(m, x);", mod), ['business-schema-bind', 'business-schema-bind']);
  assert.deepEqual(rules("import * as bt from '../tenant/business-tables';", mod), ['business-schema-bind']);
  assert.deepEqual(rules("import { businessTables, boundBusinessSchema, peekBusinessSchema } from '../tenant/business-tables';", mod), []);
  // Re-review LOW: re-export, require() and import() cannot hide the name.
  assert.deepEqual(rules("export { bindBusinessSchema as attach } from '../tenant/business-tables';", mod), ['business-schema-bind']);
  assert.deepEqual(rules("const { bindBusinessSchema: b } = require('../tenant/business-tables');", mod), ['business-schema-bind']);
  assert.deepEqual(rules("const bt = await import('../tenant/business-tables'); bt['bindBusinessSchema'](m, 'core', null);", mod), ['business-schema-bind']);
  const binder = 'packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts';
  assert.ok(check.BUSINESS_SCHEMA_BINDERS.includes(binder));
  assert.deepEqual(rules("import { bindBusinessSchema } from './business-tables'; bindBusinessSchema(m, 'core', null);", binder), []);
});

test('excludes are matched on the repo-relative path, not the absolute one (review #7)', () => {
  assert.equal(check.isExcluded('packages/rab-server/src/modules/x/x.service.spec.ts'), true);
  assert.equal(check.isExcluded('packages/rab-server/src/__tests__/integration/a.ts'), true);
  assert.equal(check.isExcluded('packages/rab-server/src/database/typeorm/workspace-schema/provision-workspace-schema.ts'), true);
  assert.equal(check.isExcluded('packages/rab-server/src/modules/x/services/x.service.ts'), false);
});

test('compareToBase: the committed baseline may only shrink against the base branch (review #2)', () => {
  const base = { 'a.ts': { unqualified: 2 }, 'b.ts': { 'core-qualified': 1 } };
  assert.deepEqual(check.compareToBase(base, base).grown, []);
  assert.deepEqual(check.compareToBase(base, { 'a.ts': { unqualified: 1 } }).grown, []); // a decrease and a removed entry pass
  const plusOne = check.compareToBase(base, { 'a.ts': { unqualified: 3 }, 'b.ts': { 'core-qualified': 1 } }).grown;
  assert.deepEqual(plusOne.map((g) => `${g.file}:${g.rule}:${g.base}->${g.head}`), ['a.ts:unqualified:2->3']);
  const newFile = check.compareToBase(base, { ...base, 'c.ts': { unqualified: 1 } }).grown;
  assert.deepEqual(newFile.map((g) => [g.file, g.newKey]), [['c.ts', true]]);
  const newRule = check.compareToBase(base, { ...base, 'a.ts': { unqualified: 2, 'other-qualified': 1 } }).grown;
  assert.deepEqual(newRule.map((g) => [g.file, g.rule, g.newKey]), [['a.ts', 'other-qualified', true]]);
  assert.throws(() => check.readBaselineAt('--output=x'), /not a plain git ref/);
});

test('flags core.<table>, any other qualifier, a QueryBuilder string table and a non-binder search_path switch', () => {
  assert.deepEqual(rules("m.query('SELECT 1 FROM core.shift');"), ['core-qualified']);
  assert.deepEqual(rules('m.query(`SELECT 1 FROM "core"."venue"`);'), ['core-qualified']);
  assert.deepEqual(rules('m.query(`SELECT 1 FROM ${schema}.shift`);'), ['other-qualified']);
  assert.deepEqual(rules('m.query(`SELECT 1 FROM "${schema}"."attendance"`);'), ['other-qualified']);
  assert.deepEqual(rules("m.query('SELECT 1 FROM public.job_role');"), ['other-qualified']);
  assert.deepEqual(rules("qb.select('x').from('shift', 's');"), ['qb-string-table']);
  assert.deepEqual(rules("qb.leftJoin('core.venue', 'v', 'v.id = s.venue_id');"), ['qb-string-table']);
  assert.deepEqual(rules("m.query(`SELECT set_config('search_path', $1, true)`, [s]);"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('SET LOCAL search_path TO core');"), ['search-path-switch']);
  // Re-review LOW: the parameterised form (the setting name is not a literal), and 'search_path' as a query parameter.
  assert.deepEqual(rules("m.query('SELECT set_config($1, $2, true)', [name, s]);"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('SELECT 1', ['search_path', s]);"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('SELECT set_config($1,$2,true)', ['search_path', s]);"), ['search-path-switch', 'search-path-switch']);
  assert.deepEqual(rules("m.query(`SELECT set_config('rab.team_shift_id', $1, true)`, [id]);"), []); // a literal, non-search_path name
  // Re-check Low: spelling variants and comments.
  assert.deepEqual(rules(`m.query(\`SELECT "set_config"('search_path', $1, true)\`, [s]);`), ['search-path-switch']);
  assert.deepEqual(rules("m.query(`SELECT pg_catalog.set_config ( 'search_path', $1, true)`, [s]);"), ['search-path-switch']);
  assert.deepEqual(rules(`m.query(\`SELECT set_config('"search_path"', $1, true)\`, [s]);`), ['search-path-switch']);
  assert.deepEqual(rules("m.query(`SELECT set_config(/* hidden */ 'search_path', $1, true)`, [s]);"), ['search-path-switch']);
  assert.deepEqual(rules("m.query(`SELECT 1;\n-- note\nSET \"search_path\" TO core`);"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('RESET search_path');"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('RESET ALL');"), ['search-path-switch']);
  assert.deepEqual(rules("m.query('DISCARD ALL');"), ['search-path-switch']);
  assert.deepEqual(rules("m.query(`SELECT 1 -- set_config('search_path', 'x', true)\n`);"), []); // only inside a SQL comment
  assert.deepEqual(rules("m.query('RESET ROLE');"), []);
  // Part D: versioned workspace upgrade commands name the schema themselves (other-qualified only, version dirs only);
  // the fingerprint measurement script may pin search_path.
  const cmd = 'packages/rab-server/src/engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select.ts';
  const ddl = 'export const sql = (schemaName) => `CREATE POLICY p ON ${schemaName}.staff_profile FOR SELECT USING (true)`;';
  assert.deepEqual(rules(ddl, cmd), []);
  assert.deepEqual(rules("m.query('SELECT 1 FROM shift');", cmd), ['unqualified']); // other rules still apply there
  assert.deepEqual(rules(ddl, 'packages/rab-server/src/engine/core-modules/upgrade/upgrade-commands/registry.ts'), ['other-qualified']);
  assert.deepEqual(rules(ddl), ['other-qualified']); // module code
  assert.deepEqual(rules("c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);", 'packages/rab-server/src/database/typeorm/scripts/generate-workspace-fingerprints.ts'), []);
  const c3 = 'packages/rab-server/src/engine/core-modules/upgrade/upgrade-commands/0-7/hws-cutover.ts';
  assert.deepEqual(rules("q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);", c3), []);
  assert.deepEqual(rules("q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);", 'packages/rab-server/src/engine/core-modules/upgrade/upgrade-commands/0-7/other.ts'), ['search-path-switch']);
  assert.deepEqual(rules("q('SELECT 1 FROM core.shift');", c3), ['core-qualified']); // only the search_path pin is waived
  // #253: the semantic posture read pins its own read-only transaction and restores a caller's value.
  const posture = 'packages/rab-server/src/database/posture-drift/semantic-posture.ts';
  assert.deepEqual(rules("q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, public, pg_temp', true)`);", posture), []);
  assert.deepEqual(rules("q('SELECT 1 FROM core.shift');", posture), ['core-qualified']); // only the search_path pin is waived
});

test('the binders may switch search_path; DDL that pins a function\'s own search_path is not a switch', () => {
  const binder = 'packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts';
  assert.ok(check.SEARCH_PATH_BINDERS.includes(binder));
  assert.deepEqual(rules("m.query(`SELECT set_config('search_path', $1, true)`, [s]);", binder), []);
  assert.deepEqual(rules("const ddl = `CREATE FUNCTION core.f() RETURNS int LANGUAGE sql\n  SET search_path = pg_catalog, pg_temp\n  AS 'SELECT 1'`;"), []);
});

test('flags global entity access on a workspace entity, not on a core entity or a bound manager call', () => {
  assert.deepEqual(rules('const r = this.dataSource.getRepository(Shift);'), ['global-entity-access']);
  assert.deepEqual(rules('await this.dataSource.manager.findOne(Venue, { where: { id } });'), ['global-entity-access']);
  assert.deepEqual(rules('class S { constructor(@InjectRepository(StaffProfile) private readonly repo: Repository<StaffProfile>) {} }'), ['global-entity-access']);
  assert.deepEqual(rules('await manager.findOne(Shift, { where: { id } });'), []); // C2-1 (entity layer) covers the bound manager
  assert.deepEqual(rules('const r = this.dataSource.getRepository(User);'), []);
});

test('ignores comments, lower-case prose and look-alike names', () => {
  assert.deepEqual(rules('// SELECT * FROM shift\n/* UPDATE venue SET x */\nconst a = 1;'), []);
  assert.deepEqual(rules("const msg = 'the shift was not found';"), []);
  assert.deepEqual(rules("m.query('SELECT s.shift_id FROM core.shift_log s');"), []);
  assert.deepEqual(rules("m.query('SELECT 1 FROM shifts');"), []);
});

test('workspace entities are the @Entity classes on a workspace table without a schema option', () => {
  const files = [
    { abs: 'a.entity.ts', src: "@Entity({ name: 'shift' })\nexport class Shift {}" },
    { abs: 'b.entity.ts', src: "@Entity({ name: 'user', schema: 'core' })\nexport class User {}" },
    { abs: 'c.entity.ts', src: "@Entity({ name: 'venue', schema: 'core' })\nexport class LegacyVenue {}" },
    { abs: 'd.entity.ts', src: "@Entity('job_role')\nexport class JobRole {}" },
  ];
  assert.deepEqual([...check.workspaceEntities(files, TABLES)].sort(), ['JobRole', 'Shift']);
});

test('the ratchet: more sites than the baseline fails (new), fewer fails (stale), equal passes', () => {
  const base = { 'a.ts': { unqualified: 2 }, 'b.ts': { 'core-qualified': 1 } };
  assert.deepEqual(check.compare({ 'a.ts': { unqualified: 2 }, 'b.ts': { 'core-qualified': 1 } }, base), { grown: [], stale: [], unknownRules: [] });
  const grown = check.compare({ 'a.ts': { unqualified: 3 }, 'b.ts': { 'core-qualified': 1 } }, base);
  assert.equal(grown.grown.length, 1);
  assert.equal(grown.stale.length, 0);
  const newFile = check.compare({ ...base, 'c.ts': { unqualified: 1 } }, base);
  assert.deepEqual(newFile.grown.map((g) => g.file), ['c.ts']);
  const stale = check.compare({ 'a.ts': { unqualified: 1 } }, base);
  assert.deepEqual(stale.stale.map((s) => `${s.file}:${s.rule}:${s.current}`), ['a.ts:unqualified:1', 'b.ts:core-qualified:0']);
  const bad = check.compare({}, { 'a.ts': { 'made-up': 1 } });
  assert.equal(bad.unknownRules.length, 1);
});

test('the committed baseline matches the tree exactly (no new site, no stale entry)', () => {
  const baseline = check.readBaseline();
  assert.ok(baseline, 'tools/workspace-table-qualified.baseline.json exists');
  const { sites } = check.scan();
  const result = check.compare(check.countsOf(sites), baseline);
  assert.deepEqual(result, { grown: [], stale: [], unknownRules: [] });
});

test('C2-7: the committed baseline is empty ({}), and a non-empty baseline is reported even when its counts match', () => {
  assert.deepEqual(check.readBaseline(), {});
  assert.deepEqual(check.assertEmptyBaseline({}), []);
  assert.deepEqual(check.assertEmptyBaseline({ 'packages/rab-server/src/x.ts': { unqualified: 1 } }), ['packages/rab-server/src/x.ts']);
});

test('check-sql-injection: ${X.<table>} needs no review comment only for X = businessTables(…), unquoted (review #1)', () => {
  const imp = IMPORT.trimEnd();
  const sites = (lines, file = 'packages/rab-server/src/modules/x/services/x.service.ts') =>
    sqlLint.scanSource(file, lines.join('\n')).map((s) => (s.reviewed ? 'reviewed' : 'UNREVIEWED'));
  assert.deepEqual(sites([imp, 'const t = businessTables(m);', 'm.query(`SELECT 1 FROM ${t.venue} WHERE id = $1`);']), []);
  assert.deepEqual(sites([imp, 'function f(m) {', '  const tables = businessTables(m);', '  return m.query(`DELETE FROM ${tables.shift} WHERE id = $1`);', '}']), []);
  assert.deepEqual(sites([WORKER_IMPORT.trimEnd(), 'const t = businessTables(m);', 'm.query(`SELECT 1 FROM ${t.attendance} WHERE id = $1`);'], WORKER_FILE), []);
  assert.deepEqual(sites([imp, 'const t = body;', 'm.query(`SELECT 1 FROM ${t.venue} WHERE id = $1`);']), ['UNREVIEWED']);
  assert.deepEqual(sites([imp, 'm.query(`SELECT 1 FROM ${t.venue} WHERE id = $1`);']), ['UNREVIEWED']);
  assert.deepEqual(sites([imp, 'const t = businessTables(m);', "m.query(`SELECT 1 FROM x WHERE name = '${t.venue}'`);"]), ['UNREVIEWED']);
  assert.deepEqual(sites([imp, 'const t = businessTables(m);', 'm.query(`SELECT 1 FROM ${t.venue} WHERE x = ${other}`);']), ['UNREVIEWED']);
  assert.deepEqual(
    sites([imp, 'const t = businessTables(m);', '// sql-injection-reviewed: other is a code constant from the frozen list above', 'm.query(`SELECT 1 FROM ${t.venue} WHERE x = ${other}`);']),
    ['reviewed'],
  );
  // Re-review MEDIUM regressions: a fake/aliased/missing callee and a hoisted var are UNREVIEWED.
  const q = ['const t = businessTables(req.body);', 'm.query(`SELECT 1 FROM ${t.shift} WHERE id = $1`);'];
  assert.deepEqual(sites(['const businessTables = (x) => x;', ...q]), ['UNREVIEWED']);
  assert.deepEqual(sites(["import { evil as businessTables } from '../../../engine/core-modules/tenant/business-tables';", ...q]), ['UNREVIEWED']);
  assert.deepEqual(sites(q), ['UNREVIEWED']);
  assert.deepEqual(sites([imp, 'function f(m) {', '  const t = businessTables(m);', '  if (x) { var t = body; }', '  return m.query(`SELECT 1 FROM ${t.shift} WHERE id = $1`);', '}']), ['UNREVIEWED']);
});
