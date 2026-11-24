import { CORE_CORRECTION_APP_GRANTS_SQL, CORE_CORRECTION_GUARD_STATE_SQL, coreCorrectionGuardProblems } from './attendance-correction-insert-only-sql';
import {
  ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS,
  attendanceCorrectionInsertOnlyDownSql,
  attendanceCorrectionInsertOnlySql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../../engine/core-modules/upgrade/upgrade-commands/registry';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

/** S11 (DRAFT SQL): attendance_correction insert-only, statically. Behaviour: attendance-correction-insert-only.integration.spec.ts. */
describe('S11: attendance_correction insert-only guard triggers', () => {
  const W = 'workspace_0123456789abcdef0123456789abcdef';
  const ok = [
    { name: 'attendance_correction_insert_only_delete', enabled: 'O', tgtype: 10, fn: 'core.owner_login_grant_parity_guard()' },
    { name: 'attendance_correction_insert_only_truncate', enabled: 'O', tgtype: 34, fn: 'core.owner_login_grant_parity_guard()' },
    { name: 'attendance_correction_insert_only_update', enabled: 'O', tgtype: 18, fn: 'core.owner_login_grant_parity_guard()' },
  ];
  const grants = { can_update: true, can_delete: true, can_insert: true, can_select: true };

  it('one DO block creating three statement-level BEFORE triggers on its own schema, each only when missing; no grant, policy or drop', () => {
    const sql = attendanceCorrectionInsertOnlySql(W);
    expect(sql.startsWith('DO $correction_insert_only$\nBEGIN\n')).toBe(true);
    for (const g of ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS) {
      expect(sql).toContain(`t.tgname = '${g.name}') THEN\n    CREATE TRIGGER ${g.name} BEFORE ${g.event} ON "${W}".attendance_correction FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard();`);
    }
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE|DROP|POLICY|FOR EACH ROW|ALTER)\b/);
    expect([...sql.matchAll(/workspace_[0-9a-f]{32}/g)].every((m) => m[0] === W)).toBe(true);
    expect(() => attendanceCorrectionInsertOnlySql('public')).toThrow('Invalid workspace schema');
    expect(attendanceCorrectionInsertOnlySql('core')).toBe(sql.split(W).join('core'));
    // No name in the frozen PAY-1 parity pattern (counted by its own checks).
    for (const g of ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS) expect(g.name).not.toMatch(/^_.*_grant_parity_/);
    expect(attendanceCorrectionInsertOnlyDownSql('core')).toBe(
      ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map((g) => `DROP TRIGGER IF EXISTS ${g.name} ON "core".attendance_correction`).join(';\n'),
    );
  });

  it('the end-state check accepts exactly the three triggers with their tgtype and the guard function, and SELECT + INSERT kept', () => {
    expect(coreCorrectionGuardProblems(ok, grants)).toEqual([]);
    expect(coreCorrectionGuardProblems(ok.slice(1), grants)).toEqual(expect.arrayContaining([expect.stringContaining('attendance_correction_insert_only_delete missing')]));
    expect(coreCorrectionGuardProblems([{ ...ok[0]!, enabled: 'D' }, ok[1]!, ok[2]!], grants)).toHaveLength(1);
    expect(coreCorrectionGuardProblems([{ ...ok[0]!, tgtype: 11 }, ok[1]!, ok[2]!], grants)).toHaveLength(1);
    expect(coreCorrectionGuardProblems([ok[0]!, ok[1]!, { ...ok[2]!, fn: 'core.other()' }], grants)).toHaveLength(1);
    expect(coreCorrectionGuardProblems(ok, { ...grants, can_insert: false })).toHaveLength(1);
    expect(coreCorrectionGuardProblems(ok, undefined)).toHaveLength(1);
  });

  it('no workspace command is registered by this change; the goldens pin the three core triggers', () => {
    for (const commands of Object.values(WORKSPACE_UPGRADE_COMMANDS)) for (const c of commands) expect(c.name).not.toMatch(/correction/i);
    for (const g of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(g.filter((l) => l.startsWith('trigger|attendance_correction|attendance_correction_insert_only_'))).toEqual(
        // def= (posture #253): md5(tgtype | columns | WHEN | deferrable | initdeferred | args | transition tables) -- the same
        // statement-level shape as the payroll_run_line parity guards, so the same three hashes.
        (
          [
            ['delete', '4d5b1e343ae5e9db331a17d5115ca1e7'],
            ['truncate', '0be8c43eadd64a41d76c54566871a3ce'],
            ['update', '3e05e43d14a5b82dcc02749598e03d79'],
          ] as const
        ).map(([e, def]) => `trigger|attendance_correction|attendance_correction_insert_only_${e}|enabled=O|core.owner_login_grant_parity_guard()|def=${def}`),
      );
    }
  });

  it('the migration checks read the catalog only', () => {
    expect(CORE_CORRECTION_GUARD_STATE_SQL).toMatch(/^SELECT /);
    expect(CORE_CORRECTION_GUARD_STATE_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    // The privilege names appear only as has_table_privilege arguments.
    expect(CORE_CORRECTION_APP_GRANTS_SQL).toMatch(/^SELECT /);
    const stripped = CORE_CORRECTION_APP_GRANTS_SQL.replace(/pg_catalog\.has_table_privilege\('crewflow_app', 'core\.attendance_correction', '(UPDATE|DELETE|INSERT|SELECT)'\)/g, '');
    expect(stripped).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });
});
