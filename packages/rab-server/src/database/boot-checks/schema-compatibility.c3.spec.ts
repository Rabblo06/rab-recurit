import { LATEST_WORKSPACE_MODULE_VERSION } from '../typeorm/workspace-schema/workspace-schema-modules';
import { PROVISION_FUNCTION_SOURCE_SQL, ProvisionFunctionState } from '../typeorm/workspace-schema/provision-function-versions';
import { upgradeIncompleteFor } from './database-boot-gates';
import {
  assessSchemaCompatibility,
  checkSchemaCompatibility,
  CompatibilityProcess,
  firstPendingMigration,
  SchemaCompatibilityFacts,
  UPGRADE_INCOMPLETE_VAR,
} from './schema-compatibility';

/**
 * C3 (owner decision 2026-11-05, "EXACTLY LIKE TWENTY"): after a failed, non-first-install upgrade under the continue
 * policy, api-prestart sets CREWFLOW_UPGRADE_INCOMPLETE=<migration>. For the API only, and only when the FIRST pending
 * migration is exactly that one, gate 7 downgrades `pending` and `provision-function-behind` to warnings. Every other case
 * keeps today's verdict; unset changes nothing. The Worker waits (owner decision).
 */
const CODE = ['Alpha1786000000000', 'Beta1786000000100', 'Gamma1786000000200'];
const INTERLEAVED = 'OtherBranch1786000000150';
const BEHIND_FN: ProvisionFunctionState = { state: 'known', literal: 'db:provision_workspace@older', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION - 1 };
const UNKNOWN_FN: ProvisionFunctionState = { state: 'unknown', literal: 'db:provision_workspace@NotInTheMap' } as ProvisionFunctionState;

function assess(process: CompatibilityProcess, facts: Partial<SchemaCompatibilityFacts>, upgradeIncomplete?: string, production = true) {
  return assessSchemaCompatibility(process, { expected: CODE, applied: CODE, ...facts }, { production, upgradeIncomplete });
}
const refused = (a: ReturnType<typeof assess>) => a.refusals.map((r) => r.finding).sort();

describe('C3: CREWFLOW_UPGRADE_INCOMPLETE relaxes gate 7 for the API only, and only for the named failed migration', () => {
  it('unset: every case refuses exactly as before (pending, function behind, interleaved, unknown function)', () => {
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }))).toEqual(['pending']);
    expect(refused(assess('api', { provisionFunction: BEHIND_FN }))).toEqual(['provision-function-behind']);
    expect(refused(assess('api', { applied: [...CODE, INTERLEAVED] }))).toEqual(['ledger-interleaved']);
    expect(refused(assess('api', { provisionFunction: UNKNOWN_FN }))).toEqual(['provision-function-unknown']);
    expect(assess('api', { applied: CODE.slice(0, 1) }).upgradeIncomplete).toBeNull();
    // blank / whitespace is "unset"
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }, '   '))).toEqual(['pending']);
  });

  it('API, first pending == named: pending and function-behind become warnings naming the failed migration', () => {
    const a = assess('api', { applied: CODE.slice(0, 1), provisionFunction: BEHIND_FN }, 'Beta1786000000100');
    expect(a.refusals).toEqual([]);
    expect(a.upgradeIncomplete).toBe('Beta1786000000100');
    expect(a.warnings.join('\n')).toMatch(/UPGRADE INCOMPLETE \(owner decision C3, 2026-11-05\): the upgrade failed at Beta1786000000100; 2 migration\(s\) are not applied/);
    expect(a.warnings.join('\n')).toMatch(/below this code's workspace module .* UPGRADE INCOMPLETE \(C3\): Beta1786000000100 failed/);
  });

  it('API, named is not the FIRST pending migration (or is not pending at all): refuses as before', () => {
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }, 'Gamma1786000000200'))).toEqual(['pending']);
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }, 'Alpha1786000000000'))).toEqual(['pending']);
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }, 'SomethingElse1786000000999'))).toEqual(['pending']);
    // Nothing pending: no relaxation flag, and a behind function still refuses.
    const none = assess('api', { provisionFunction: BEHIND_FN }, 'Beta1786000000100');
    expect(none.upgradeIncomplete).toBeNull();
    expect(refused(none)).toEqual(['provision-function-behind']);
  });

  it('API, relaxed: an interleaved ledger name and an unknown provision function in production still refuse', () => {
    expect(refused(assess('api', { applied: [CODE[0]!, INTERLEAVED] }, 'Beta1786000000100'))).toEqual(['ledger-interleaved']);
    expect(refused(assess('api', { applied: CODE.slice(0, 1), provisionFunction: UNKNOWN_FN }, 'Beta1786000000100'))).toEqual(['provision-function-unknown']);
  });

  it.each(['worker', 'cli', 'provisioner', 'migrate-check', 'migrate-apply'] as const)('%s: the variable changes nothing (the Worker waits)', (process) => {
    const facts = { applied: CODE.slice(0, 1), provisionFunction: BEHIND_FN };
    const without = assess(process, facts);
    const withVar = assess(process, facts, 'Beta1786000000100');
    expect({ refusals: refused(withVar), warnings: withVar.warnings, flag: withVar.upgradeIncomplete }).toEqual({
      refusals: refused(without),
      warnings: without.warnings,
      flag: null,
    });
  });

  it('the first pending migration is chosen in chain order (timestamp, then name), not list order', () => {
    expect(firstPendingMigration(['Gamma1786000000200', 'Beta1786000000100'])).toBe('Beta1786000000100');
    expect(firstPendingMigration([])).toBeUndefined();
  });

  it('checkSchemaCompatibility: relaxed, the read goes on to the function and resolves with warnings; unset, it refuses first', async () => {
    const seen: string[] = [];
    const query = async (sql: string): Promise<unknown[]> => {
      seen.push(sql);
      if (sql === 'SELECT name FROM core.migrations') return CODE.slice(0, 1).map((name) => ({ name }));
      if (sql === PROVISION_FUNCTION_SOURCE_SQL) return [{ prosrc: `... 'db:provision_workspace@WorkspaceGrantParityGuards1786721430000' ...` }];
      throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
    };
    const opts = { process: 'api' as const, production: true, expected: CODE, label: 'api process' };
    await expect(checkSchemaCompatibility(query, opts)).rejects.toMatchObject({ gate: 'pending-migrations' });
    const a = await checkSchemaCompatibility(query, { ...opts, upgradeIncomplete: 'Beta1786000000100' });
    expect(a.upgradeIncomplete).toBe('Beta1786000000100');
    expect(a.refusals).toEqual([]);
    expect(seen).toContain(PROVISION_FUNCTION_SOURCE_SQL);
    await expect(checkSchemaCompatibility(query, { ...opts, process: 'worker', upgradeIncomplete: 'Beta1786000000100' })).rejects.toMatchObject({ gate: 'pending-migrations' });
  });

  it('upgradeIncompleteFor: read for the API only; the Worker, CLI and provisioner never see it', () => {
    const env = { [UPGRADE_INCOMPLETE_VAR]: ' Beta1786000000100 ' } as NodeJS.ProcessEnv;
    expect(UPGRADE_INCOMPLETE_VAR).toBe('CREWFLOW_UPGRADE_INCOMPLETE');
    expect(upgradeIncompleteFor('api', env)).toBe('Beta1786000000100');
    for (const p of ['worker', 'cli', 'provisioner']) expect(upgradeIncompleteFor(p, env)).toBeUndefined();
    expect(upgradeIncompleteFor('api', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(upgradeIncompleteFor('api', { [UPGRADE_INCOMPLETE_VAR]: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
