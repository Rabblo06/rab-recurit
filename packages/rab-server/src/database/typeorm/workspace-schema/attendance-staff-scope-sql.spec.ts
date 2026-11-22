import { createHash } from 'node:crypto';

import {
  ATTENDANCE_TENANT_DEPARSED,
  ATTENDANCE_TENANT_HASH,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_REVIEWED_DRIFT,
  CORE_ATTENDANCE_SCOPE_DEPARSED,
  CORE_ATTENDANCE_SCOPE_HASH,
  CORE_CORRECTION_SCOPE_DEPARSED,
  CORE_CORRECTION_SCOPE_HASH,
} from './attendance-staff-scope-sql';
import { attendanceCorrectionScopeSql, attendanceScopePredicate, attendanceStaffScopeSql, attendanceTenantOnlySql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** M4 §11 LOW (DRAFT SQL): the attendance staff-own-or-manager predicate, statically. Behaviour: attendance-staff-scope-rls.integration.spec.ts. */
describe('M4 §11: attendance_tenant gains a staff-own-or-manager predicate', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';
  const md5 = (s: string) => createHash('md5').update(s.replace(/\s+/g, ' ')).digest('hex');

  it('the statement is one ALTER POLICY ... USING ... WITH CHECK on its own schema, the same predicate on both sides; nothing created, dropped or granted', () => {
    const sql = attendanceStaffScopeSql(W);
    expect(sql.startsWith(`ALTER POLICY attendance_tenant ON "${W}".attendance USING (\n`)).toBe(true);
    expect(sql).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TO PUBLIC|FOR ALL|RENAME|RESTRICTIVE)\b/i);
    expect(sql).not.toContain(';');
    expect(sql.split(attendanceScopePredicate(W))).toHaveLength(3);
    expect([...sql.matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
    expect(() => attendanceStaffScopeSql('public')).toThrow('Invalid workspace schema');
    expect(() => attendanceStaffScopeSql('workspace_x"; DROP')).toThrow('Invalid workspace schema');
    expect(attendanceStaffScopeSql('core')).toBe(sql.split(W).join('core'));
  });

  it('the predicate keeps the tenant binding and adds exactly the four allowed callers (worker, staff own, workspace manager, venue manager of the shift)', () => {
    const p = attendanceScopePredicate(W);
    expect(p.startsWith('organisation_id = core.current_org() AND workspace_id = core.current_workspace()\n')).toBe(true);
    expect(p).toContain("current_setting('rab.actor_type', true) = 'worker'");
    expect(p).toContain('sp.id = attendance.staff_profile_id AND sp.user_id = core.current_uid()');
    expect(p).toContain("mp.workspace_id = core.current_workspace() AND mp.type <> 'venue'");
    expect(p).toContain('s.id = attendance.shift_id');
    expect(p).toContain("mp.user_id = core.current_uid() AND mp.type = 'venue'");
    expect(p.match(/\bOR EXISTS\b/g)).toHaveLength(3);
    expect(p).not.toMatch(/rab\.role|rab\.admin_scope|OR TRUE/i);
    expect(attendanceTenantOnlySql('core')).toBe(
      'ALTER POLICY attendance_tenant ON "core".attendance USING (\n    organisation_id = core.current_org() AND workspace_id = core.current_workspace()\n  ) WITH CHECK (\n    organisation_id = core.current_org() AND workspace_id = core.current_workspace()\n  )',
    );
  });

  it('the workspace copies are the 0.7.0 level-25 command AttendanceStaffScope only (structure-level-25.spec.ts)', () => {
    const attendanceCommands = Object.values(WORKSPACE_UPGRADE_COMMANDS).flat().filter((c) => /attendance/i.test(c.name)).map((c) => `${c.name}:${c.structure?.level}`);
    expect(attendanceCommands.filter((n) => n.startsWith('AttendanceStaffScope:'))).toEqual(['AttendanceStaffScope:25']);
  });

  it('the hashes are those of the semantic-golden formula; the goldens (16/17/18) pin the predicate on both expressions; the harness reviews exactly two lines', () => {
    expect(md5(ATTENDANCE_TENANT_DEPARSED)).toBe(ATTENDANCE_TENANT_HASH);
    expect(md5(CORE_ATTENDANCE_SCOPE_DEPARSED)).toBe(CORE_ATTENDANCE_SCOPE_HASH);
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(g.filter((l) => l.startsWith('policy|attendance|attendance_tenant|'))).toEqual([
        `policy|attendance|attendance_tenant|PERMISSIVE|public|*|using=${CORE_ATTENDANCE_SCOPE_HASH}|check=${CORE_ATTENDANCE_SCOPE_HASH}`,
      ]);
    }
    // The harness (scripts/migration-security-check.ts runs on import, so it is read as text here) maps the migration to these lines.
    const harness = readFileSync(join(__dirname, '..', 'scripts', 'migration-security-check.ts'), 'utf8');
    expect(harness).toContain("'1786722100000-AttendanceStaffScopeRls': CORE_ATTENDANCE_REVIEWED_DRIFT,");
    expect(CORE_ATTENDANCE_REVIEWED_DRIFT).toEqual([
      `- policy|attendance|attendance_tenant|*|permissive=true|roles=public|using=${ATTENDANCE_TENANT_DEPARSED}|check=${ATTENDANCE_TENANT_DEPARSED}`,
      `+ policy|attendance|attendance_tenant|*|permissive=true|roles=public|using=${CORE_ATTENDANCE_SCOPE_DEPARSED}|check=${CORE_ATTENDANCE_SCOPE_DEPARSED}`,
      `- policy|attendance_correction|attendance_correction_tenant|*|permissive=true|roles=public|using=${ATTENDANCE_TENANT_DEPARSED}|check=${ATTENDANCE_TENANT_DEPARSED}`,
      `+ policy|attendance_correction|attendance_correction_tenant|*|permissive=true|roles=public|using=${CORE_CORRECTION_SCOPE_DEPARSED}|check=${CORE_CORRECTION_SCOPE_DEPARSED}`,
    ]);
    expect(md5(CORE_CORRECTION_SCOPE_DEPARSED)).toBe(CORE_CORRECTION_SCOPE_HASH);
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(g.filter((l) => l.startsWith('policy|attendance_correction|attendance_correction_tenant|'))).toEqual([
        `policy|attendance_correction|attendance_correction_tenant|PERMISSIVE|public|*|using=${CORE_CORRECTION_SCOPE_HASH}|check=${CORE_CORRECTION_SCOPE_HASH}`,
      ]);
    }
    expect(attendanceCorrectionScopeSql('core')).toContain('EXISTS (SELECT 1 FROM "core".attendance a WHERE a.id = attendance_correction.attendance_id)');
  });

  it('the migration guard reads the catalog only', () => {
    expect(CORE_ATTENDANCE_POLICY_SQL).toMatch(/^SELECT /);
    expect(CORE_ATTENDANCE_POLICY_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });
});
