'use strict';
// node --test tools/check-index-migrations.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('./check-index-migrations.cjs');

const ts = check.loadTypeScript();
const rules = (src) => check.analyseMigration(ts, 'm.ts', src).map((f) => f.rule);

const migration = (body, { transactionFalse = false } = {}) => `import { MigrationInterface, QueryRunner } from 'typeorm';
export class M1786730000000 implements MigrationInterface {
  name = 'M1786730000000';
  ${transactionFalse ? 'transaction = false;' : ''}
  public async up(queryRunner: QueryRunner): Promise<void> {
${body}
  }
  public async down(): Promise<void> {}
}
`;

test('the repository typescript loads (without it the check refuses to pass)', () => {
  assert.ok(ts);
});

test('a plain CREATE INDEX on an existing table fails', () => {
  assert.deepEqual(rules(migration("    await queryRunner.query('CREATE INDEX shift_venue_idx ON core.shift (venue_id)');")), ['concurrently']);
});

test('CREATE INDEX CONCURRENTLY in a transaction = false migration passes; without transaction = false it fails', () => {
  const sql = "    await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS shift_venue_idx ON core.shift (venue_id)');";
  assert.deepEqual(rules(migration(sql, { transactionFalse: true })), []);
  assert.deepEqual(rules(migration(sql)), ['concurrently']);
});

test("the repository's `${cc}` switch counts as concurrent, with transaction = false", () => {
  const sql = [
    "    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';",
    '    await queryRunner.query(`CREATE INDEX ${cc}IF NOT EXISTS shift_venue_idx ON core.shift (venue_id)`);',
  ].join('\n');
  assert.deepEqual(rules(migration(sql, { transactionFalse: true })), []);
  assert.deepEqual(rules(migration(sql)), ['concurrently']);
});

test('an interpolated name and definition are treated as an existing table (fail closed); the name is left to the catalogue', () => {
  const sql = '    await queryRunner.query(`CREATE INDEX ${cc}IF NOT EXISTS ${index.name} ${index.definition}`);';
  assert.deepEqual(rules(migration(sql, { transactionFalse: true })), []);
  assert.deepEqual(rules(migration('    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ${index.name} ${index.definition}`);')), ['concurrently']);
});

test('an index on a table the same migration creates needs no CONCURRENTLY', () => {
  const sql = [
    "    await queryRunner.query('CREATE TABLE core.staff_document (id uuid PRIMARY KEY, organisation_id uuid NOT NULL)');",
    "    await queryRunner.query('CREATE INDEX staff_document_org_idx ON core.staff_document (organisation_id)');",
  ].join('\n');
  assert.deepEqual(rules(migration(sql)), []);
});

test('a reviewed exemption needs a reason of 20+ characters on the line above', () => {
  const ok = "    // index-migration-reviewed: core.permission is global reference data of under 100 rows\n    await queryRunner.query('CREATE INDEX permission_key_idx ON core.permission (key)');";
  assert.deepEqual(rules(migration(ok)), []);
  const short = "    // index-migration-reviewed: tiny\n    await queryRunner.query('CREATE INDEX permission_key_idx ON core.permission (key)');";
  assert.deepEqual(rules(migration(short)), ['concurrently']);
});

test('names: unnamed, unconventional suffix and over 63 bytes all fail; comments mentioning CREATE INDEX do not count', () => {
  const body = [
    '    // CREATE INDEX nothing ON core.shift (x) is only a comment',
    "    await queryRunner.query('CREATE TABLE core.t (id uuid, a uuid, b uuid)');",
    "    await queryRunner.query('CREATE INDEX ON core.t (a)');",
    "    await queryRunner.query('CREATE UNIQUE INDEX t_one_live_per_a ON core.t (a)');",
    `    await queryRunner.query('CREATE INDEX ${'x'.repeat(61)}_idx ON core.t (b)');`,
  ].join('\n');
  assert.deepEqual(rules(migration(body)), ['name', 'name', 'name']);
});

test('the frozen migrations stay frozen: the check passes on this tree', () => {
  assert.equal(check.main([]), 0);
  assert.ok(check.migrationFiles().length > 200);
  assert.ok(check.BASELINE_TIMESTAMP >= 1786721570000);
});
