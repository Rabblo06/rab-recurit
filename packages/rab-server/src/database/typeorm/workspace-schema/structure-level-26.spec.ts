import { composeServerPathTemplateLevel25 } from './structure-level-25';
import { composeServerPathTemplateLevel26, LEVEL_26_WORKSPACES_SQL } from './structure-level-26';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  ATTENDANCE_CORRECTION_INSERT_ONLY,
  attendanceCorrectionInsertOnlySql,
  workspaceCorrectionInsertOnlySql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';

/** S11 + owner decision 46 (DRAFT SQL): structure level 26, statically. Behaviour: ws-attendance-correction-insert-only.integration.spec.ts. */
describe('S11: attendance_correction insert-only in workspace schemas (structure level 26)', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';

  it('the command is the REVOKE, the core triggers for its own schema and a guarded RESTRICT key change, in that order', () => {
    const sql = workspaceCorrectionInsertOnlySql(W);
    const parts = sql.split(';\n');
    expect(parts[0]).toBe(`REVOKE UPDATE, DELETE ON "${W}".attendance_correction FROM crewflow_app`);
    expect(sql).toContain(attendanceCorrectionInsertOnlySql(W));
    expect(sql).toContain(`ADD CONSTRAINT attendance_correction_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES "${W}".attendance(id) ON DELETE RESTRICT`);
    expect(sql).toContain("k.confdeltype = 'c'");
    expect(sql).not.toMatch(/\bGRANT\b|POLICY|CASCADE/);
    expect([...sql.matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
    expect(() => workspaceCorrectionInsertOnlySql('public')).toThrow('Invalid workspace schema');
  });

  it('the level-26 template is the level-25 template plus exactly the command statements', () => {
    const t25 = composeServerPathTemplateLevel25();
    const t26 = composeServerPathTemplateLevel26();
    expect(t26.startsWith(t25)).toBe(true);
    expect(t26.slice(t25.length)).toBe(`;\n${workspaceCorrectionInsertOnlySql(SERVER_PATH_SENTINEL_SCHEMA)}`);
  });

  it('release 0.7.0 registers it as level 26, last, with its drop declared and its provision literal mapped to 26', () => {
    const list = WORKSPACE_UPGRADE_COMMANDS['0-7']!;
    expect(list[list.length - 1]).toBe(ATTENDANCE_CORRECTION_INSERT_ONLY);
    expect(codeWorkspaceStructureLevel()).toBe(26);
    expect(declaredProvisionLiterals()['db:provision_workspace@WorkspaceAttendanceCorrectionInsertOnly1786722130000']).toBe(26);
    expect(ATTENDANCE_CORRECTION_INSERT_ONLY).toMatchObject({ name: 'AttendanceCorrectionInsertOnly', timestamp: 1786722130000 });
    expect(ATTENDANCE_CORRECTION_INSERT_ONLY.structure?.mayDrop).toBe(true);
  });

  it('the down() guard reads the catalog only', () => {
    expect(LEVEL_26_WORKSPACES_SQL).toMatch(/^SELECT /);
    expect(LEVEL_26_WORKSPACES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });
});
