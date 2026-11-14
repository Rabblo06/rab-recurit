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

test('accepts exactly the primitive form ${t.<table>} / ${tables.<table>}', () => {
  assert.deepEqual(rules('const t = businessTables(m); m.query(`SELECT 1 FROM ${t.shift} s JOIN ${t.venue} v ON v.id = s.venue_id`);'), []);
  assert.deepEqual(rules('m.query(`UPDATE ${tables.shift_assignment} SET status = $1`);'), []);
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

test('check-sql-injection: the exact ${t.<table>} form needs no review comment; anything else still does', () => {
  for (const ok of ['t.shift', 'tables.payslip_document', 't.venue_manager_staff']) assert.equal(sqlLint.isBusinessTableRef(ok), true, ok);
  for (const no of ['t.shifts', 'x.shift', 't.user', 't[k]', 'schema', 't.shift.x', '`${t.shift}`', 'tables.workspace_schema_registry']) {
    assert.equal(sqlLint.isBusinessTableRef(no), false, no);
  }
});
