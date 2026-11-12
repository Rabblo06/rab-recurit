import { postMigrationPrivilegeProblems, PRIVILEGE_DRIFT_SNAPSHOT_SQL, privilegeDrift, privilegeDriftSnapshot } from './migration-privilege-drift';

/**
 * Agent 5 finding (MEDIUM, 2026-11-04): the drift snapshot never covered `crewflow_owner`, the one runtime login of the
 * owner-login architecture. Each section that names the runtime logins must name it too. (The live behaviour of the
 * snapshot is exercised by migration-security.integration.spec.ts on a disposable database.)
 */
describe('privilege drift snapshot covers the owner login', () => {
  const section = (prefix: string): string => {
    const start = PRIVILEGE_DRIFT_SNAPSHOT_SQL.indexOf(`SELECT '${prefix}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = PRIVILEGE_DRIFT_SNAPSHOT_SQL.indexOf('UNION ALL', start);
    return PRIVILEGE_DRIFT_SNAPSHOT_SQL.slice(start, next < 0 ? undefined : next);
  };

  it.each(['schema-create|', 'database|', 'role|', 'member|', 'role-config|', 'db-role-config|'])('%s names crewflow_owner', (prefix) => {
    expect(section(prefix)).toContain("'crewflow_owner'");
  });

  it('members OF crewflow_owner are snapshotted (a new member is a persistence path), and so is what it owns', () => {
    expect(section('member|')).toMatch(/m\.roleid\) IN \('crewflow_worker', 'crewflow_owner'\)/);
    expect(PRIVILEGE_DRIFT_SNAPSHOT_SQL).toMatch(/-owns\|[\s\S]*rolname IN \('crewflow_app', 'crewflow_worker', 'crewflow_owner'\)/);
  });

  it('a change to a crewflow_owner line is drift, reported by postMigrationPrivilegeProblems', async () => {
    const before = ['role|crewflow_owner|login=true|super=false|bypassrls=false|createrole=true|createdb=false|inherit=true|replication=false'];
    const after = ['role|crewflow_owner|login=true|super=false|bypassrls=true|createrole=true|createdb=false|inherit=true|replication=false'];
    expect(privilegeDrift(before, after)).toEqual([`- ${before[0]}`, `+ ${after[0]}`]);
    const query = async (sql: string) => (sql === PRIVILEGE_DRIFT_SNAPSHOT_SQL ? after.map((line) => ({ line })) : []);
    expect(await privilegeDriftSnapshot(query)).toEqual(after);
    // (The fake catalog has no tables, so the secure-owner invariants add their own lines; only the drift lines matter here.)
    const drift = (await postMigrationPrivilegeProblems(query, before)).filter((p) => p.startsWith('privilege-drift '));
    expect(drift).toEqual([`privilege-drift - ${before[0]}`, `privilege-drift + ${after[0]}`]);
  });
});
