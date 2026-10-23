import { AttendanceMoneyChecks1786719810000 } from '../core/migrations/1786719810000-AttendanceMoneyChecks';
import { WORKSPACE_TEMPLATE_STEPS } from './provision-workspace-schema';
import { attendanceMoneyChecksSql } from './v1/attendance-money-checks';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from './v1/expected-fingerprints';
import { provisionWorkspaceFunctionSql } from './v1/provision-workspace-function';
import { provisionWorkspaceFunctionV2Sql } from './v1/provision-workspace-function-v2';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { composeServerPathTemplateV1AttendanceMoney } from './v1/server-path-template-attendance-money';
import { composeServerPathTemplateV1PayrollRestrict } from './v1/server-path-template-payroll-restrict';
import { errorClassOf, WorkspaceMigrationRefused, WorkspaceSchemaMigrator } from './workspace-schema-migrator';
import {
  composeModulesForSentinel,
  LATEST_WORKSPACE_MODULE_VERSION,
  moduleChecksum,
  modulesThrough,
  WORKSPACE_SCHEMA_MODULES,
} from './workspace-schema-modules';

/**
 * Wave 2 lane S2 (B3) drift guards. Pure unit tests, no database.
 *
 * FROZEN_CHECKSUMS pins every module's SQL: editing a frozen v1/*.ts file (instead of adding a module) changes a checksum
 * here AND makes the migrator refuse every schema that recorded the old one (CHECKSUM_MISMATCH). Append a row for a new
 * module; never change an existing row.
 */
const FROZEN_CHECKSUMS: ReadonlyArray<readonly [string, string]> = [
  ['v1.001-template', '2ae16ae26869f76f6d4d484688ffc7c57bb44a860dd89ca29b85f202b36566a2'],
  ['v1.002-shift-team-policy', '339d2cafdb446855e0b487b42b446d24afffdc4950bef92cde7380921cde48e9'],
  ['v1.003-venue-manager-staff-assignment', '965db87d9753837716a3375904fc72130dc748262fd59b407b7986654dfb6b7f'],
  ['v1.004-shift-review-signoff', 'd6234078b378bc91d4937dfb277bd830dc21b5b012c6059eef6daa6b6d239cf5'],
  ['v1.005-shift-review-worker-scan', '8921695a4308e18e8a38432f97a74d1fe55b10ba7a274a44cee1c033bed14f2f'],
  ['v1.006-attendance-review', '216ae24382dca25e1cf126d558dcf131ee1a8d8f4faf9dfaa051aeb789e7fc6b'],
  ['v1.007-venue-photo', 'f01afb041335abb5afaac96e87561fc2e4450ce193fff9ba389afb7956425f71'],
  ['v1.008-payroll-record', '7934b7b5b7755851aa1a6728d66141adb26a0811204e7d344f86cbe28b5ca474'],
  ['v1.009-pay-statement', '50f80603d84ca4a19844866eb2a215b520e7f33dce59c8524c8ec7e918c4378d'],
  ['v1.010-approved-shift-statement', '53eadfb0a25298e8e479db9e065e6ce9ea2dbc864b9a3c329f5a7221d614fdee'],
  ['v1.011-payroll-runs', '1d6c679ebe143c7de785152cfa6dbe919849e0478a56817e2777d1108d6cf546'],
  ['v1.012-offer-kind', 'eef661aeadc36308237723803b54904d944a21ef3fa62a0691ea58a3f74fc2e3'],
  ['v1.013-attendance-check-in', '92050bc8d53a51ef78d3c5b01733443cab691d830fb9ddecfe6f7c152ed1236a'],
  ['v1.014-payroll-evidence-restrict', '9454844b554bae582bcacfc5d1b12d176cebdb78aa79eac1d667cf6560367c1f'],
  ['v1.015-attendance-money-checks', 'ebaa9a29420c311e80e79601367f2866becb87eaf21fb508956225f9cbb01534'],
];

describe('workspace schema modules (B3 single source of truth)', () => {
  it('versions are contiguous 1..N, ids unique and well-formed, and every checksum is frozen', () => {
    expect(WORKSPACE_SCHEMA_MODULES.map((m) => m.version)).toEqual(WORKSPACE_SCHEMA_MODULES.map((_, i) => i + 1));
    expect(new Set(WORKSPACE_SCHEMA_MODULES.map((m) => m.id)).size).toBe(WORKSPACE_SCHEMA_MODULES.length);
    for (const m of WORKSPACE_SCHEMA_MODULES) expect(m.id).toMatch(/^v[0-9]+\.[0-9]{3}-[a-z0-9-]{1,48}$/);
    expect(WORKSPACE_SCHEMA_MODULES.map((m) => [m.id, moduleChecksum(m)])).toEqual(FROZEN_CHECKSUMS);
    expect(LATEST_WORKSPACE_MODULE_VERSION).toBe(FROZEN_CHECKSUMS.length);
  });

  it('modules 1..14 compose exactly the frozen 1786719700000 server-path template; 1..15 the 1786719810000 one', () => {
    expect(composeModulesForSentinel(14)).toBe(composeServerPathTemplateV1PayrollRestrict());
    expect(composeModulesForSentinel(15)).toBe(composeServerPathTemplateV1AttendanceMoney());
  });

  it('the TypeScript provisioner applies exactly the module list (the two provisioning paths cannot drift)', () => {
    const composed = WORKSPACE_TEMPLATE_STEPS.map((step) => step(SERVER_PATH_SENTINEL_SCHEMA)).join(';\n');
    expect(composed).toBe(composeModulesForSentinel(LATEST_WORKSPACE_MODULE_VERSION));
  });

  it('an unknown target version is refused (fail closed)', () => {
    expect(() => modulesThrough(0)).toThrow('unknown workspace module version');
    expect(() => modulesThrough(LATEST_WORKSPACE_MODULE_VERSION + 1)).toThrow('unknown workspace module version');
    expect(() => modulesThrough(1.5)).toThrow('unknown workspace module version');
  });

  it('module 15 only adds the two attendance CHECKs (NOT VALID, then VALIDATE), nothing else', () => {
    const sql = attendanceMoneyChecksSql('workspace_0123456789abcdef0123456789abcdef');
    expect(sql.split(';\n')).toEqual([
      'ALTER TABLE workspace_0123456789abcdef0123456789abcdef.attendance ADD CONSTRAINT attendance_earned_pence_non_negative CHECK (earned_pence >= 0) NOT VALID',
      'ALTER TABLE workspace_0123456789abcdef0123456789abcdef.attendance ADD CONSTRAINT attendance_worked_minutes_non_negative CHECK (worked_minutes >= 0) NOT VALID',
      'ALTER TABLE workspace_0123456789abcdef0123456789abcdef.attendance VALIDATE CONSTRAINT attendance_earned_pence_non_negative',
      'ALTER TABLE workspace_0123456789abcdef0123456789abcdef.attendance VALIDATE CONSTRAINT attendance_worked_minutes_non_negative',
    ]);
  });
});

describe('core.provision_workspace v2 (ledger-aware)', () => {
  const modules = modulesThrough(15).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
  const expected = EXPECTED_WORKSPACE_FINGERPRINTS[15]!;
  const v2 = provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1AttendanceMoney(), 'CREATE OR REPLACE', modules, expected, 'db:test');
  const v1 = provisionWorkspaceFunctionSql(composeServerPathTemplateV1AttendanceMoney(), 'CREATE OR REPLACE');

  it('is the v1 body with only the two documented insertions', () => {
    const lines = (s: string) => s.split('\n');
    const added = lines(v2).filter((l) => !lines(v1).includes(l));
    const removed = lines(v1).filter((l) => !lines(v2).includes(l));
    expect(removed).toEqual([]);
    expect(added.join('\n')).toContain('INSERT INTO core.workspace_schema_migration');
    expect(added.join('\n')).toContain('v_started   timestamptz := pg_catalog.clock_timestamp();');
    expect(added.join('\n')).not.toMatch(/GRANT|REVOKE|OWNER|SECURITY|search_path/i);
  });

  it('embeds every module id, version and checksum, and refuses READY on a fingerprint mismatch', () => {
    for (const m of modules) {
      expect(v2).toContain(`'${m.id}'`);
      expect(v2).toContain(`'${m.checksum}'`);
    }
    expect(v2).toContain(`IF v_fp IS DISTINCT FROM '${expected}' THEN`);
    expect(v2).toContain("USING ERRCODE = 'CWV01'");
    expect(v2.indexOf('INSERT INTO core.workspace_schema_migration')).toBeLessThan(v2.indexOf("RETURN 'READY';"));
  });

  it('refuses malformed inputs instead of embedding them', () => {
    expect(() => provisionWorkspaceFunctionV2Sql('x', 'CREATE', modules, 'nothex', 'db:test')).toThrow();
    expect(() => provisionWorkspaceFunctionV2Sql('x', 'CREATE', modules, expected, "x'; DROP TABLE core.user; --")).toThrow();
    expect(() => provisionWorkspaceFunctionV2Sql('x', 'CREATE', [{ ...modules[0]!, version: 2 }], expected, 'db:test')).toThrow();
  });

  it('the AttendanceMoneyChecks migration re-creates the function with exactly this v2 body', async () => {
    const sql: string[] = [];
    const runner = {
      query: async (q: string) => {
        sql.push(q);
        if (q.includes("conrelid = 'core.attendance'::regclass")) return [];
        if (q.includes('FROM core.attendance WHERE earned_pence < 0')) return [{ n: 0 }];
        if (q.includes("'core.provision_workspace(uuid)'::regprocedure")) {
          return [{ definer: true, owner: 'crewflow', path_ok: true, executors: ['crewflow', 'crewflow_app'] }];
        }
        if (q.includes('current_user::text AS who')) return [{ who: 'postgres', superuser: true, crewflow: true }];
        return [];
      },
    };
    await new AttendanceMoneyChecks1786719810000().up(runner as never);
    const fn = sql.find((q) => q.includes('FUNCTION core.provision_workspace('));
    expect(fn).toBe(
      provisionWorkspaceFunctionV2Sql(
        composeServerPathTemplateV1AttendanceMoney(),
        'CREATE OR REPLACE',
        modules,
        expected,
        'db:provision_workspace@AttendanceMoneyChecks1786719810000',
      ),
    );
    expect(sql).toContain(attendanceMoneyChecksSql('core'));
  });
});

describe('WorkspaceSchemaMigrator identity and error hygiene', () => {
  it('refuses to run as the runtime role (and as any identity that cannot act as crewflow)', async () => {
    for (const who of [
      { who: 'crewflow_app', superuser: false, crewflow: false },
      { who: 'crewflow_app', superuser: false, crewflow: true },
      { who: 'someone', superuser: false, crewflow: false },
    ]) {
      const runner = { query: async () => [who] };
      await expect(new WorkspaceSchemaMigrator(runner).migrateAll()).rejects.toThrow('WorkspaceSchemaMigrator refuses to run as');
    }
  });

  it('records only safe error classes, never a driver message', () => {
    expect(errorClassOf(Object.assign(new Error('relation "workspace_x.secret" …'), { code: '42P01' }))).toBe('SQLSTATE_42P01');
    expect(errorClassOf(Object.assign(new Error('x'), { code: '55P03' }))).toBe('LOCK_TIMEOUT');
    expect(errorClassOf(new WorkspaceMigrationRefused('CHECKSUM_MISMATCH', 'v1.001-template'))).toBe('CHECKSUM_MISMATCH');
    expect(errorClassOf(new Error('no code at all'))).toBe('INTERNAL');
    expect(errorClassOf(Object.assign(new Error('x'), { code: "'; DROP" }))).toBe('INTERNAL');
  });
});
