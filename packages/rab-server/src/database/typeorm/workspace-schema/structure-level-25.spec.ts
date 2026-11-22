import { composeServerPathTemplateLevel24, PROVISION_PREDECESSOR_SQL } from './structure-level-24';
import { composeServerPathTemplateLevel25, LEVEL_25_WORKSPACES_SQL } from './structure-level-25';
import { ATTENDANCE_TENANT_HASH } from './attendance-staff-scope-sql';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  ATTENDANCE_STAFF_SCOPE,
  attendanceCorrectionScopeSql,
  attendanceStaffScopeSql,
  workspaceAttendanceScopeSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';

/** M4 §11 (DRAFT SQL): structure level 25 = the workspace copies of #305's two policies, statically. */
describe('M4 §11: attendance + correction scope in workspace schemas (structure level 25)', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';

  it('the command is exactly the two ALTER POLICY statements of the core migration, for its own schema', () => {
    expect(workspaceAttendanceScopeSql(W)).toBe(`${attendanceStaffScopeSql(W)};\n${attendanceCorrectionScopeSql(W)}`);
    expect(workspaceAttendanceScopeSql(W).split(W).join('core')).toBe(`${attendanceStaffScopeSql('core')};\n${attendanceCorrectionScopeSql('core')}`);
    expect(workspaceAttendanceScopeSql(W)).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|RENAME)\b/i);
    expect([...workspaceAttendanceScopeSql(W).matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
  });

  it('the level-25 template is the level-24 template plus exactly the command statements', () => {
    const t24 = composeServerPathTemplateLevel24();
    const t25 = composeServerPathTemplateLevel25();
    expect(t25.startsWith(t24)).toBe(true);
    expect(t25.slice(t24.length)).toBe(`;\n${workspaceAttendanceScopeSql(SERVER_PATH_SENTINEL_SCHEMA)}`);
  });

  it('release 0.7.0 registers it as level 25, additive, with its provision literal mapped to 25', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-7']).toContain(ATTENDANCE_STAFF_SCOPE);
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(25);
    expect(declaredProvisionLiterals()['db:provision_workspace@WorkspaceAttendanceStaffScope1786722120000']).toBe(25);
    expect(ATTENDANCE_STAFF_SCOPE).toMatchObject({ name: 'AttendanceStaffScope', timestamp: 1786722120000 });
    expect(ATTENDANCE_STAFF_SCOPE.structure?.mayDrop).toBeUndefined();
    expect(ATTENDANCE_STAFF_SCOPE.precheck).toBeUndefined();
  });

  it('the down() guard reads the catalog only and compares with the tenant-only hash on both policies', () => {
    for (const sql of [LEVEL_25_WORKSPACES_SQL, PROVISION_PREDECESSOR_SQL]) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    }
    expect(LEVEL_25_WORKSPACES_SQL).toContain(`IS DISTINCT FROM '${ATTENDANCE_TENANT_HASH}'`);
    expect(LEVEL_25_WORKSPACES_SQL).toContain("c.relname = 'attendance_correction' AND p.polname = 'attendance_correction_tenant'");
  });
});
