import { WorkspaceSchemaMigrator } from './workspace-schema-migrator';

/**
 * Owner-login architecture (M-T2): in its OWN transactions the migrator acts as crewflow for that transaction only
 * (`SET LOCAL ROLE crewflow`), so the registry guard's allow-list admits the owner login exactly as it admits the separate
 * provisioner. Unchanged for crewflow and the bootstrap superuser (every existing caller); refused for a login that cannot.
 */
function runner(facts: { who: string; superuser?: boolean; can_set?: boolean }) {
  const statements: string[] = [];
  return {
    statements,
    db: {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('can_set')) return [{ who: facts.who, superuser: facts.superuser ?? false, can_set: facts.can_set ?? false }];
        return [];
      },
    },
  };
}
const act = (m: WorkspaceSchemaMigrator) => (m as unknown as { actAsCrewflowForThisTransaction(): Promise<void> }).actAsCrewflowForThisTransaction();

describe('WorkspaceSchemaMigrator — owner login acts as crewflow per transaction (M-T2)', () => {
  it('the owner login → SET LOCAL ROLE crewflow (transaction-scoped: it ends with COMMIT / ROLLBACK)', async () => {
    const r = runner({ who: 'crewflow_owner', can_set: true });
    await act(new WorkspaceSchemaMigrator(r.db));
    expect(r.statements.at(-1)).toBe('SET LOCAL ROLE crewflow');
    expect(r.statements.some((s) => s === 'SET ROLE crewflow')).toBe(false); // never session-level here
  });

  it('crewflow and the bootstrap superuser → unchanged (byte-for-byte the previous statement sequence)', async () => {
    for (const facts of [{ who: 'crewflow' }, { who: 'ci_bootstrap', superuser: true }]) {
      const r = runner(facts);
      await act(new WorkspaceSchemaMigrator(r.db));
      expect(r.statements.some((s) => s.includes('SET LOCAL ROLE'))).toBe(false);
    }
  });

  it('a login that cannot SET crewflow is refused (never writes the registry under the wrong identity)', async () => {
    await expect(act(new WorkspaceSchemaMigrator(runner({ who: 'someone', can_set: false }).db))).rejects.toThrow(/cannot SET it for the transaction/);
  });
});
