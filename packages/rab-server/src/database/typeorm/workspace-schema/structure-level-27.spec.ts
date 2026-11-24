import { VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL } from './structure-level-22';
import { composeServerPathTemplateLevel26 } from './structure-level-26';
import { composeServerPathTemplateLevel27, LEVEL_27_COUNTS, LEVEL_27_WORKSPACES_SQL, VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL } from './structure-level-27';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { WORKSPACE_STRUCTURE_LEVEL_TABLES, WORKSPACE_TABLES, WORKSPACE_TEMPLATE_TABLES } from './workspace-tables';
import {
  ATTENDANCE_BREAKS_RECEIPTS,
  attendanceBreaksReceiptsPolicies,
  attendanceBreaksReceiptsSql,
  workspaceAttendanceBreaksReceiptsSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../engine/core-modules/upgrade/workspace-structure-level';

/** M4 §13 PR 2 (DRAFT SQL): structure level 27, statically. Behaviour: (ws-)attendance-breaks-receipts.integration.spec.ts. */
describe('M4 §13 PR 2: attendance breaks and sync receipts (structure level 27)', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';

  it('the workspace copy has no foreign key to core, binds both tables to the schema\'s own workspace id, and names only its own schema', () => {
    const sql = workspaceAttendanceBreaksReceiptsSql(W);
    expect(sql).not.toMatch(/REFERENCES core\./);
    expect(sql).toContain(`pg_catalog.substr('${W}', 11)`);
    expect(sql).toContain("'attendance_break_workspace_bound'");
    expect(sql).toContain("'attendance_sync_receipt_workspace_bound'");
    expect([...sql.matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM|TRUNCATE "/);
    expect(() => workspaceAttendanceBreaksReceiptsSql('core')).toThrow('Invalid workspace schema');
    expect(() => attendanceBreaksReceiptsSql('public')).toThrow('Invalid workspace schema');
  });

  it('the core copy keeps its core keys and has no workspace bound CHECK', () => {
    const sql = attendanceBreaksReceiptsSql('core');
    expect(sql).toContain('REFERENCES core.organisation(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES core."user"(id)');
    expect(sql).not.toContain('_workspace_bound');
  });

  it('every evidence key is RESTRICT (A.7); insert-only receipts have no UPDATE / DELETE policy; breaks have no DELETE policy', () => {
    const sql = workspaceAttendanceBreaksReceiptsSql(W);
    expect(sql).toContain(`attendance_break_attendance_id_fkey   FOREIGN KEY (attendance_id) REFERENCES "${W}".attendance(id) ON DELETE RESTRICT`);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    const policies = attendanceBreaksReceiptsPolicies(W).map((p) => p.sql);
    expect(policies.filter((p) => p.includes('attendance_sync_receipt AS PERMISSIVE')).map((p) => /FOR (\w+)/.exec(p)![1])).toEqual(['SELECT', 'INSERT']);
    expect(policies.filter((p) => p.includes('attendance_break AS PERMISSIVE')).map((p) => /FOR (\w+)/.exec(p)![1])).toEqual(['SELECT', 'INSERT', 'UPDATE']);
    // The worker marker reads (SELECT) but never writes.
    for (const p of policies) expect(p.includes("'worker'")).toBe(/FOR SELECT/.test(p));
  });

  it('the level-27 template is the level-26 template plus exactly the command statements', () => {
    const t26 = composeServerPathTemplateLevel26();
    const t27 = composeServerPathTemplateLevel27();
    expect(t27.startsWith(t26)).toBe(true);
    expect(t27.slice(t26.length)).toBe(`;\n${workspaceAttendanceBreaksReceiptsSql(SERVER_PATH_SENTINEL_SCHEMA)}`);
    expect(t27).not.toMatch(/\$(template|provision)\$/);
  });

  it('release 0.7.0 registers it as level 27, last, additive, with its provision literal mapped to 27', () => {
    const list = WORKSPACE_UPGRADE_COMMANDS['0-7']!;
    expect(list[list.length - 1]).toBe(ATTENDANCE_BREAKS_RECEIPTS);
    expect(codeWorkspaceStructureLevel()).toBe(27);
    expect(declaredProvisionLiterals()['db:provision_workspace@WorkspaceAttendanceBreaksReceipts1786722150000']).toBe(27);
    expect(ATTENDANCE_BREAKS_RECEIPTS.structure?.mayDrop).toBeUndefined();
  });

  it('WORKSPACE_TABLES = the 21 template tables + the two level-27 tables; the template list is unchanged', () => {
    expect(WORKSPACE_TEMPLATE_TABLES).toHaveLength(21);
    expect([...WORKSPACE_TABLES]).toEqual([...WORKSPACE_TEMPLATE_TABLES, ...Object.keys(WORKSPACE_STRUCTURE_LEVEL_TABLES)]);
    expect(LEVEL_27_COUNTS.tables).toBe(WORKSPACE_TABLES.length);
  });

  it('the verify body differs from level 22 only in the counts it accepts; below 27 the old rules are kept verbatim', () => {
    for (const kept of [
      "IF v_idx NOT IN (90, 94, 100) THEN RETURN 'index count'; END IF;",
      "IF v_pol NOT IN (39, 41, 42) THEN RETURN 'policy count'; END IF;",
      "IF v_idx <> (CASE WHEN v_mv >= 17 THEN 100 WHEN v_mv = 16 THEN 94 ELSE 90 END) THEN RETURN 'index count'; END IF;",
      "IF v_pol <> (CASE WHEN v_mv >= 21 THEN 42 WHEN v_mv >= 18 THEN 41 ELSE 39 END) THEN RETURN 'policy count'; END IF;",
      "RETURN 'workspace CHECK value or NULL exclusion';",
      "RETURN 'user_note workspace_id NOT NULL';",
    ]) {
      expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL).toContain(kept);
      expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL).toContain(kept);
    }
    expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL).toContain('WHEN v_l27 THEN ARRAY[62] WHEN coalesce(v_mv, 0) = 0 THEN ARRAY[128, 56] WHEN v_mv >= 22 THEN ARRAY[56] ELSE ARRAY[128] END');
    expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL).toContain("IF v_idx <> 112 THEN RETURN 'index count'; END IF;");
    expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL).toContain("IF v_pol <> 47 THEN RETURN 'policy count'; END IF;");
    expect(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL).toContain('v_l27 := coalesce(v_mv, 0) >= 27 OR (coalesce(v_mv, 0) = 0 AND v_n = 23);');
  });

  it('the down() guard reads the catalog only', () => {
    expect(LEVEL_27_WORKSPACES_SQL).toMatch(/^SELECT /);
    expect(LEVEL_27_WORKSPACES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });
});
