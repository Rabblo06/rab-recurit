import { coreReferences, orphanCountSql } from './workspace-core-orphans';
import { composeServerPathTemplateLevel22, VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL } from './structure-level-22';
import { composeServerPathTemplateLevel21, VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL } from './structure-level-21';
import { workspaceCoreFkRemovalSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';

/** Part D 0a (DRAFT SQL): the dropped references, the orphan probe and the level-22 SQL, statically. */
describe('Part D 0a: workspace → core references (static)', () => {
  it('the dropped references are the 72 constraints: 31 core."user", 21 core.organisation, 20 core.manager_workspace, over the 21 tables', () => {
    const refs = coreReferences();
    expect(refs).toHaveLength(72);
    expect(refs.filter((r) => r.target === 'core."user"')).toHaveLength(31);
    expect(refs.filter((r) => r.target === 'core.organisation')).toHaveLength(21);
    expect(refs.filter((r) => r.target === 'core.manager_workspace')).toHaveLength(20);
    expect(new Set(refs.map((r) => r.table)).size).toBe(21);
    expect(refs.filter((r) => r.target === 'core.organisation').every((r) => r.column === 'organisation_id')).toBe(true);
  });

  it('the orphan probe: one UNION ALL branch per reference, a user must be of the row\'s organisation, the schema name is validated', () => {
    const s = 'workspace_0123456789abcdef0123456789abcdef';
    const sql = orphanCountSql(s);
    expect(sql.split('UNION ALL')).toHaveLength(72);
    expect(sql).toContain(`FROM ${s}.staff_profile t WHERE t.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core."user" c WHERE c.id = t.user_id AND c.organisation_id = t.organisation_id)`);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    expect(() => orphanCountSql('core')).toThrow('invalid workspace schema name');
    expect(() => orphanCountSql('workspace_x; DROP TABLE y')).toThrow('invalid workspace schema name');
  });

  it('the command drops exactly the 72 constraints, each guarded, and nothing else', () => {
    const sql = workspaceCoreFkRemovalSql('workspace_00000000000000000000000000000000');
    expect(sql.match(/DROP CONSTRAINT IF EXISTS \w+/g)).toHaveLength(72);
    expect(sql.split(';\n')).toHaveLength(21);
    expect(sql).not.toMatch(/\b(CREATE|GRANT|REVOKE|POLICY|DROP TABLE|DROP INDEX|TRIGGER|CASCADE)\b/);
  });

  it('level-22 verify differs from level 21 ONLY in the foreign-key count line; the template appends the drops to level 21', () => {
    const a = VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL.split('\n');
    const b = VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL.split('\n');
    expect(b).toHaveLength(a.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    expect(diff).toHaveLength(1);
    expect(diff[0]![1]).toContain(`<> ALL (CASE WHEN coalesce(v_mv, 0) = 0 THEN ARRAY[128, 56] WHEN v_mv >= 22 THEN ARRAY[56] ELSE ARRAY[128] END) THEN RETURN 'foreign key count'`);
    expect(composeServerPathTemplateLevel22().startsWith(composeServerPathTemplateLevel21() + ';\n')).toBe(true);
  });
});
