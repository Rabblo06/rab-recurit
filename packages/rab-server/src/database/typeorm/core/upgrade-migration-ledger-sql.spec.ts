import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { lockKeyParts } from '../scripts/migrate/migration-lock';
import {
  LOCK_CLASSID,
  LOCK_OBJID,
  UPGRADE_LEDGER_EXPECTED_STATE,
  UPGRADE_LEDGER_UP_SQL,
  UPGRADE_SCOPE_SETTING,
} from './upgrade-migration-ledger-sql';
import { UPGRADE_SCOPE_SETTING as SERVICE_SCOPE_SETTING } from '../../../engine/core-modules/upgrade/upgrade-migration.service';

const SRC = join(__dirname, '..', '..', '..');
const all = UPGRADE_LEDGER_UP_SQL.join('\n');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === 'node_modules' || name === 'dist' ? [] : files(p)) : /\.ts$/.test(name) ? [p] : [];
  });
}

describe('upgrade logbook SQL (OWNER-DB-ULTIMATE Part B, UpgradeMigrationLedger1786721470000)', () => {
  it('the INSERT policy checks exactly the migration lock key of migration-lock.ts', () => {
    const parts = lockKeyParts();
    expect(String(LOCK_CLASSID)).toBe(parts.classid);
    expect(String(LOCK_OBJID)).toBe(parts.objid);
    expect(all).toContain(`l.classid = ${parts.classid}::oid AND l.objid = ${parts.objid}::oid AND l.objsubid = 1`);
    expect(all).toContain('l.pid = pg_catalog.pg_backend_pid()');
  });

  it('creates no function (B2: no SECURITY DEFINER), FORCE RLS in the same migration, append-only grants', () => {
    expect(all).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(all).not.toMatch(/SECURITY DEFINER/i);
    expect(UPGRADE_LEDGER_UP_SQL).toContain('ALTER TABLE core.upgrade_migration ENABLE ROW LEVEL SECURITY');
    expect(UPGRADE_LEDGER_UP_SQL).toContain('ALTER TABLE core.upgrade_migration FORCE ROW LEVEL SECURITY');
    // DELETE for the owner only (the FK cascade runs as the owner and checks it); never UPDATE / TRUNCATE.
    expect(UPGRADE_LEDGER_UP_SQL).toContain('GRANT SELECT, INSERT, DELETE ON TABLE core.upgrade_migration TO rab_secure_owner');
    expect(UPGRADE_LEDGER_UP_SQL.filter((q) => /^GRANT /.test(q))).toEqual(['GRANT SELECT, INSERT, DELETE ON TABLE core.upgrade_migration TO rab_secure_owner']);
    expect(all).not.toMatch(/GRANT[^;]*(UPDATE|TRUNCATE)/i);
    expect(all).not.toMatch(/FOR (UPDATE|DELETE)/i);
    expect(UPGRADE_LEDGER_EXPECTED_STATE.table_acl).toBe('rab_secure_owner:DELETE:false,rab_secure_owner:INSERT:false,rab_secure_owner:SELECT:false');
    expect(UPGRADE_LEDGER_EXPECTED_STATE.functions).toBe(0);
  });

  it("has Twenty's columns and indexes, status completed | failed only, the workspace FK cascade", () => {
    expect(UPGRADE_LEDGER_EXPECTED_STATE.columns.split(',').map((c) => c.split(':')[0])).toEqual([
      'id', 'name', 'status', 'attempt', 'executed_by_version', 'error_message', 'is_initial', 'workspace_id', 'created_at', 'forced',
    ]);
    expect(all).toContain("CHECK (status IN ('completed', 'failed'))");
    expect(all).toContain('REFERENCES core.manager_workspace (id) ON DELETE CASCADE');
    expect(all).toContain('ON core.upgrade_migration (name, attempt) WHERE workspace_id IS NULL');
    expect(all).toContain('ON core.upgrade_migration (name, attempt, workspace_id) WHERE workspace_id IS NOT NULL');
  });

  it('every function and table it names is schema-qualified', () => {
    for (const m of all.matchAll(/\b([a-z_]+)\(/g)) {
      const at = m.index ?? 0;
      const before = all.slice(Math.max(0, at - 12), at);
      const allowed = ['IN', 'CHECK', 'USING', 'EXISTS', 'KEY', 'TABLE', 'INDEX', 'CONSTRAINT'];
      if (/(pg_catalog|core)\.$/.test(before) || allowed.some((k) => before.trimEnd().toUpperCase().endsWith(k))) continue;
      if (['upgrade_migration', 'manager_workspace'].includes(m[1]!)) continue; // `core.x (` column lists
      throw new Error(`unqualified call ${m[1]}( in the logbook SQL`);
    }
  });

  it('the scope setting is one constant, and only the upgrade code, this migration and workspace creation name it', () => {
    expect(SERVICE_SCOPE_SETTING).toBe(UPGRADE_SCOPE_SETTING);
    const allowed = [
      'database/typeorm/core/upgrade-migration-ledger-sql.ts',
      'database/typeorm/core/upgrade-migration-ledger-sql.spec.ts',
      'database/typeorm/core/migrations/1786721470000-UpgradeMigrationLedger.ts',
      // Security review L2(b): every tenant binding CLEARS the scope (never sets it), like rab.admin_scope.
      'engine/core-modules/tenant/tenant-context.service.ts',
    ];
    const offenders = files(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes(UPGRADE_SCOPE_SETTING))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((f) => !allowed.includes(f) && !f.startsWith('engine/core-modules/upgrade/'))
      // Tests may name it (they exercise the policies); production code outside the list may not.
      .filter((f) => !f.startsWith('__tests__/') && !f.endsWith('.spec.ts'));
    expect(offenders).toEqual([]);
  });
});
