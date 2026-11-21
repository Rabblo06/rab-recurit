import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeServerPathTemplateLevel24, PROVISION_PREDECESSOR_SQL } from './structure-level-24';
import {
  ATTENDANCE_TENANT_HASH,
  composeServerPathTemplateLevel25,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_REVIEWED_DRIFT,
  CORE_ATTENDANCE_SCOPE_DEPARSED,
  CORE_ATTENDANCE_SCOPE_HASH,
  LEVEL_25_WORKSPACES_SQL,
} from './structure-level-25';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  ATTENDANCE_STAFF_SCOPE,
  attendanceScopePredicate,
  attendanceStaffScopeSql,
  attendanceTenantOnlySql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

/** M4 §11 LOW (DRAFT SQL): structure level 25, statically. The behaviour is in ws-attendance-staff-scope.integration.spec.ts. */
describe('M4 §11: attendance_tenant gains a staff-own-or-manager predicate (structure level 25)', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';
  const md5 = (s: string) => createHash('md5').update(s.replace(/\s+/g, ' ')).digest('hex');

  it('the statement is one ALTER POLICY ... USING ... WITH CHECK on its own schema, the same predicate on both sides; nothing created, dropped or granted', () => {
    const sql = attendanceStaffScopeSql(W);
    expect(sql.startsWith(`ALTER POLICY attendance_tenant ON "${W}".attendance USING (\n`)).toBe(true);
    expect(sql).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TO PUBLIC|FOR ALL|RENAME|RESTRICTIVE)\b/i);
    expect(sql).not.toContain(';');
    const predicate = attendanceScopePredicate(W);
    expect(sql.split(predicate)).toHaveLength(3);
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
    expect(p).toContain("s.id = attendance.shift_id");
    expect(p).toContain("mp.user_id = core.current_uid() AND mp.type = 'venue'");
    expect(p.match(/\bOR EXISTS\b/g)).toHaveLength(3);
    // No role GUC, no client value, no permissive fallback.
    expect(p).not.toMatch(/rab\.role|rab\.admin_scope|true\)\s*$|OR TRUE/i);
    expect(attendanceTenantOnlySql('core')).toBe(
      'ALTER POLICY attendance_tenant ON "core".attendance USING (\n    organisation_id = core.current_org() AND workspace_id = core.current_workspace()\n  ) WITH CHECK (\n    organisation_id = core.current_org() AND workspace_id = core.current_workspace()\n  )',
    );
  });

  it('the level-25 template is the level-24 template plus exactly the command statement, nothing else', () => {
    const t24 = composeServerPathTemplateLevel24();
    const t25 = composeServerPathTemplateLevel25();
    expect(t25.startsWith(t24)).toBe(true);
    expect(t25.slice(t24.length)).toBe(`;\n${attendanceStaffScopeSql(SERVER_PATH_SENTINEL_SCHEMA)}`);
  });

  it('release 0.7.0 registers it as level 25 (after #243 = 24), with its provision literal mapped to 25', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-7']![WORKSPACE_UPGRADE_COMMANDS['0-7']!.length - 1]).toBe(ATTENDANCE_STAFF_SCOPE);
    expect(codeWorkspaceStructureLevel()).toBe(25);
    expect(declaredProvisionLiterals()['db:provision_workspace@AttendanceStaffScopeRls1786722100000']).toBe(25);
    expect(ATTENDANCE_STAFF_SCOPE.structure?.mayDrop).toBeUndefined();
    expect(ATTENDANCE_STAFF_SCOPE.precheck).toBeUndefined();
    expect(ATTENDANCE_STAFF_SCOPE.run).toBeUndefined();
  });

  it('the hashes are those of the semantic-golden formula; the goldens (16/17/18) pin the level-25 predicate on both expressions', () => {
    expect(md5('((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))')).toBe(ATTENDANCE_TENANT_HASH);
    expect(md5(CORE_ATTENDANCE_SCOPE_DEPARSED)).toBe(CORE_ATTENDANCE_SCOPE_HASH);
    const golden = readFileSync(join(__dirname, '..', 'core', 'security-posture.golden.txt'), 'utf8');
    const ws = golden.split('\n').find((l) => l.startsWith('ws|policy|attendance|attendance_tenant|'))!;
    const using = ws.split('|using=')[1]!.split('|check=')[0]!;
    expect(ws.split('|check=')[1]).toBe(using);
    expect(using.split('workspace_*').join('core')).toBe(CORE_ATTENDANCE_SCOPE_DEPARSED);
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(g.filter((l) => l.startsWith('policy|attendance|attendance_tenant|'))).toEqual([
        `policy|attendance|attendance_tenant|PERMISSIVE|public|*|using=${CORE_ATTENDANCE_SCOPE_HASH}|check=${CORE_ATTENDANCE_SCOPE_HASH}`,
      ]);
    }
    expect(LEVEL_25_WORKSPACES_SQL).toContain(`IS DISTINCT FROM '${ATTENDANCE_TENANT_HASH}'`);
    expect(CORE_ATTENDANCE_REVIEWED_DRIFT).toHaveLength(2);
    expect(CORE_ATTENDANCE_REVIEWED_DRIFT[1]).toBe(
      `+ policy|attendance|attendance_tenant|*|permissive=true|roles=public|using=${CORE_ATTENDANCE_SCOPE_DEPARSED}|check=${CORE_ATTENDANCE_SCOPE_DEPARSED}`,
    );
  });

  it('the migration guards read the catalog only', () => {
    for (const sql of [CORE_ATTENDANCE_POLICY_SQL, LEVEL_25_WORKSPACES_SQL, PROVISION_PREDECESSOR_SQL]) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    }
  });
});
