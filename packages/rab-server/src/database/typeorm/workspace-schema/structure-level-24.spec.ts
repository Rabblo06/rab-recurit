import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeServerPathTemplateLevel23 } from './structure-level-23';
import {
  composeServerPathTemplateLevel24,
  CORE_SHIFT_TEAM_POLICY_SQL,
  CORE_SHIFT_TEAM_USING_HASH_EQUALITY,
  CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP,
  LEVEL_24_WORKSPACES_SQL,
} from './structure-level-24';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { shiftTeamPolicy } from './v1/shift-team-policy';
import {
  SHIFT_TEAM_ROLE_EQUALITY,
  SHIFT_TEAM_ROLE_MEMBERSHIP,
  STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE,
  shiftTeamSelectMultiRoleSql,
  shiftTeamSelectSingleRoleSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

/** #205 (DRAFT SQL): structure level 24, statically. The behaviour is in ws-shift-team-multi-role.integration.spec.ts. */
describe('#205: staff_profile_shift_team_select tests staff role membership (structure level 24)', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';
  const body = (createOrAlter: string) => createOrAlter.slice(createOrAlter.indexOf(' USING (') + ' USING ('.length);

  it('the ALTER POLICY is the frozen 1786718100000 predicate with ONLY the role test changed (same text after USING otherwise)', () => {
    const frozen = body(shiftTeamPolicy(W).replace(' FOR SELECT USING (', ' USING ('));
    expect(frozen.split(SHIFT_TEAM_ROLE_EQUALITY)).toHaveLength(2);
    expect(body(shiftTeamSelectSingleRoleSql(W))).toBe(frozen);
    expect(body(shiftTeamSelectMultiRoleSql(W))).toBe(frozen.replace(SHIFT_TEAM_ROLE_EQUALITY, SHIFT_TEAM_ROLE_MEMBERSHIP));
    expect(SHIFT_TEAM_ROLE_MEMBERSHIP).toBe("'staff' = ANY (pg_catalog.string_to_array(current_setting('rab.role', true), ','))");
  });

  it('the statement is one ALTER POLICY ... USING on its own schema: no FOR / TO / WITH CHECK change, nothing created, dropped or granted', () => {
    const sql = shiftTeamSelectMultiRoleSql(W);
    expect(sql.startsWith(`ALTER POLICY staff_profile_shift_team_select ON "${W}".staff_profile USING (\n`)).toBe(true);
    expect(sql).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|WITH CHECK|TO PUBLIC|FOR SELECT|RENAME)\b/i);
    expect(sql).not.toContain(';');
    expect([...sql.matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
    expect(() => shiftTeamSelectMultiRoleSql('public')).toThrow('Invalid workspace schema');
    expect(() => shiftTeamSelectMultiRoleSql('workspace_x"; DROP')).toThrow('Invalid workspace schema');
    expect(shiftTeamSelectMultiRoleSql('core')).toBe(sql.split(W).join('core'));
  });

  it('the level-24 template is the level-23 template plus exactly the command statement, nothing else', () => {
    const t23 = composeServerPathTemplateLevel23();
    const t24 = composeServerPathTemplateLevel24();
    expect(t24.startsWith(t23)).toBe(true);
    expect(t24.slice(t23.length)).toBe(`;\n${shiftTeamSelectMultiRoleSql(SERVER_PATH_SENTINEL_SCHEMA)}`);
  });

  it('release 0.7.0 registers it as level 24 (after #177 = 23), with its provision literal mapped to 24', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-7']![WORKSPACE_UPGRADE_COMMANDS['0-7']!.length - 1]).toBe(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE);
    expect(codeWorkspaceStructureLevel()).toBe(24);
    expect(declaredProvisionLiterals()['db:provision_workspace@StaffShiftTeamMultiRole1786721600000']).toBe(24);
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure?.mayDrop).toBeUndefined();
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.precheck).toBeUndefined();
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.run).toBeUndefined();
  });

  it('the core policy hashes are those of the semantic-golden formula; the goldens (16/17/18) pin the membership predicate', () => {
    // The deparsed 1786718100000 expression, as the PG16 security-posture golden's workspace template records it.
    const golden = readFileSync(join(__dirname, '..', 'core', 'security-posture.golden.txt'), 'utf8');
    const ws = golden.split('\n').find((l) => l.startsWith('ws|policy|staff_profile|staff_profile_shift_team_select|'))!;
    const deparsed = ws.split('|using=')[1]!.split('|check=')[0]!;
    const md5 = (s: string) => createHash('md5').update(s.replace(/\s+/g, ' ')).digest('hex');
    expect(deparsed).toContain("('staff'::text = ANY (string_to_array(current_setting('rab.role'::text, true), ','::text)))");
    expect(md5(deparsed.split('workspace_*').join('core'))).toBe(CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP);
    expect(
      md5(
        deparsed
          .split('workspace_*')
          .join('core')
          .replace("('staff'::text = ANY (string_to_array(current_setting('rab.role'::text, true), ','::text)))", "(current_setting('rab.role'::text, true) = 'staff'::text)"),
      ),
    ).toBe(CORE_SHIFT_TEAM_USING_HASH_EQUALITY);
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(g.filter((l) => l.startsWith('policy|staff_profile|staff_profile_shift_team_select|'))).toEqual([
        `policy|staff_profile|staff_profile_shift_team_select|PERMISSIVE|public|r|using=${CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP}|check=-`,
      ]);
    }
  });

  it('the migration guards read the catalog only', () => {
    for (const sql of [CORE_SHIFT_TEAM_POLICY_SQL, LEVEL_24_WORKSPACES_SQL]) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    }
  });
});
