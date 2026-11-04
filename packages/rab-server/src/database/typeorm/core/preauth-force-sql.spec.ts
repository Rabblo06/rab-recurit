import {
  PLATFORM_ADMIN_GUARD_DOWN_SQL,
  PLATFORM_ADMIN_GUARD_UP_SQL,
  PLATFORM_ADMIN_GUARDED_POLICIES,
  PlatformAdminPolicyRow,
  platformAdminPolicyProblems,
} from './preauth-force-sql';

/** M-T1 platform_admin recursion guard: the start / end checks the migration fails closed on (DB-free). */
describe('preauth-force-sql: platform_admin recursion guard checks', () => {
  const G = `CASE WHEN (CURRENT_USER = 'rab_secure_owner'::name) THEN false ELSE`;
  const original: PlatformAdminPolicyRow[] = [
    { name: 'platform_admin_select', to_public: true, qual: '((user_id = core.current_uid()) OR core.is_active_platform_admin())', chk: '' },
    { name: 'platform_admin_update', to_public: true, qual: 'core.is_active_platform_admin()', chk: 'core.is_active_platform_admin()' },
    { name: 'platform_admin_write', to_public: true, qual: '', chk: 'core.is_active_platform_admin()' },
  ];
  const guarded: PlatformAdminPolicyRow[] = original.map((r) => ({
    ...r,
    qual: r.qual ? `${G} ${r.qual} END` : '',
    chk: r.chk ? `${G} ${r.chk} END` : '',
  }));

  it('accepts the original policies as the start state and the guarded ones as the end state', () => {
    expect(platformAdminPolicyProblems(original, 'start')).toEqual([]);
    expect(platformAdminPolicyProblems(guarded, 'end')).toEqual([]);
  });

  it('refuses a start state that is already guarded, missing a policy, or no longer TO PUBLIC', () => {
    expect(platformAdminPolicyProblems(guarded, 'start').join('\n')).toMatch(/already carries the rab_secure_owner guard/);
    expect(platformAdminPolicyProblems(original.slice(1), 'start')).toEqual(['core.platform_admin policy platform_admin_select is missing']);
    expect(platformAdminPolicyProblems([{ ...original[0]!, to_public: false }, ...original.slice(1)], 'start').join('\n')).toMatch(/no longer applies TO PUBLIC/);
  });

  it('refuses an end state where any expression (USING or WITH CHECK) is unguarded', () => {
    const halfUpdate = guarded.map((r) => (r.name === 'platform_admin_update' ? { ...r, chk: original[1]!.chk } : r));
    expect(platformAdminPolicyProblems(halfUpdate, 'end')).toEqual([expect.stringMatching(/^platform_admin_update is not guarded/)]);
    expect(platformAdminPolicyProblems(original, 'end')).toHaveLength(3);
  });

  it('up guards exactly the three policies and down restores exactly their previous expressions', () => {
    expect([...PLATFORM_ADMIN_GUARDED_POLICIES].sort()).toEqual(['platform_admin_select', 'platform_admin_update', 'platform_admin_write']);
    const up = PLATFORM_ADMIN_GUARD_UP_SQL.join('\n');
    expect(up.match(/CASE WHEN CURRENT_USER = 'rab_secure_owner'::name THEN false ELSE/g)).toHaveLength(4); // select, write, update x2
    expect(PLATFORM_ADMIN_GUARD_DOWN_SQL.join('\n')).not.toMatch(/rab_secure_owner/);
  });
});
