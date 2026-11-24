import { composeServerPathTemplateLevel22 } from './structure-level-22';
import { composeServerPathTemplateLevel23, LEVEL_23_WORKSPACES_SQL } from './structure-level-23';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE,
  staffProfileWorkspaceRequiredValidateSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';

/** C3 Q3 (DRAFT SQL): structure level 23, statically. */
describe('C3 Q3: staff_profile_workspace_required VALIDATE (structure level 23)', () => {
  it('the frozen template still creates the constraint NOT VALID (what level 23 validates)', () => {
    const t22 = composeServerPathTemplateLevel22();
    expect(t22.match(/ADD CONSTRAINT "staff_profile_workspace_required" CHECK \(\(workspace_id IS NOT NULL\)\) NOT VALID;/g)).toHaveLength(1);
  });

  it('the level-23 template is the level-22 template plus exactly the command statement, nothing else', () => {
    const t22 = composeServerPathTemplateLevel22();
    const t23 = composeServerPathTemplateLevel23();
    expect(t23.startsWith(t22)).toBe(true);
    expect(t23.slice(t22.length)).toBe(`;\n${staffProfileWorkspaceRequiredValidateSql(SERVER_PATH_SENTINEL_SCHEMA)}`);
  });

  it('the command is one ALTER TABLE … VALIDATE CONSTRAINT on its own schema: no DDL that creates, drops or grants anything', () => {
    const sql = STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.sql!('workspace_0123456789abcdef0123456789abcdef');
    expect(sql).toBe('ALTER TABLE workspace_0123456789abcdef0123456789abcdef.staff_profile VALIDATE CONSTRAINT staff_profile_workspace_required');
    expect(sql).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|POLICY|TRIGGER|INSERT|UPDATE|DELETE|core\.)\b/i);
    expect(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.precheck).toBeUndefined();
    expect(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.run).toBeUndefined();
  });

  it('release 0.7.0 registers it as level 23 (after 0b = 21 and 0a = 22), with its provision literal mapped to 23', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-7']).toContain(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE);
    expect(codeWorkspaceStructureLevel()).toBe(23);
    expect(declaredProvisionLiterals()['db:provision_workspace@WorkspaceStaffProfileWorkspaceRequiredValidated1786721595000']).toBe(23);
  });

  it('the down() guard reads the catalog only (workspace schemas whose constraint is already VALID)', () => {
    expect(LEVEL_23_WORKSPACES_SQL).toMatch(/^SELECT pg_catalog\.count\(\*\)::int AS n\s+FROM pg_catalog\.pg_constraint k/);
    expect(LEVEL_23_WORKSPACES_SQL).toContain("k.conname = 'staff_profile_workspace_required' AND k.convalidated");
    expect(LEVEL_23_WORKSPACES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });
});
