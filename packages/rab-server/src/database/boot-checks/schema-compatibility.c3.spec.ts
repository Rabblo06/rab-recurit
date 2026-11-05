import { LATEST_WORKSPACE_MODULE_VERSION } from '../typeorm/workspace-schema/workspace-schema-modules';
import { PROVISION_FUNCTION_SOURCE_SQL, ProvisionFunctionState } from '../typeorm/workspace-schema/provision-function-versions';
import { upgradeIncompleteFor } from './database-boot-gates';
import {
  assessSchemaCompatibility,
  checkSchemaCompatibility,
  compareLedger,
  CompatibilityProcess,
  firstPendingMigration,
  isInOrderPendingTail,
  SchemaCompatibilityFacts,
  UPGRADE_INCOMPLETE_VAR,
} from './schema-compatibility';

/**
 * C3 (owner decision 2026-11-05, "EXACTLY LIKE TWENTY"): after a failed, non-first-install upgrade under the continue
 * policy, api-prestart sets CREWFLOW_UPGRADE_INCOMPLETE=<migration>. For the API only, and only when the FIRST pending
 * migration is exactly that one, gate 7 downgrades `pending` and `provision-function-behind` to warnings. Every other case
 * keeps today's verdict; unset changes nothing. The Worker starts too (owner decision changed 2026-11-05): it decides from
 * the database alone, on an in-order pending tail of its chain.
 */
const CODE = ['Alpha1786000000000', 'Beta1786000000100', 'Gamma1786000000200'];
const INTERLEAVED = 'OtherBranch1786000000150';
const BEHIND_FN: ProvisionFunctionState = { state: 'known', literal: 'db:provision_workspace@older', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION - 1 };
const UNKNOWN_FN: ProvisionFunctionState = { state: 'unknown', literal: 'db:provision_workspace@NotInTheMap' } as ProvisionFunctionState;

function assess(process: CompatibilityProcess, facts: Partial<SchemaCompatibilityFacts>, upgradeIncomplete?: string, production = true) {
  return assessSchemaCompatibility(process, { expected: CODE, applied: CODE, ...facts }, { production, upgradeIncomplete });
}
const refused = (a: ReturnType<typeof assess>) => a.refusals.map((r) => r.finding).sort();

describe('C3: CREWFLOW_UPGRADE_INCOMPLETE relaxes gate 7 for the API, only for the named failed migration', () => {
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
    expect(a.warnings.join('\n')).toMatch(/below this code's workspace module .* UPGRADE INCOMPLETE \(C3\): first not applied Beta1786000000100/);
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

  it.each(['cli', 'provisioner', 'migrate-check', 'migrate-apply'] as const)('%s: unchanged by C3 (variable or in-order tail)', (process) => {
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
    // The CLI is unchanged: pending refuses even with the variable set.
    await expect(checkSchemaCompatibility(query, { ...opts, process: 'cli', label: 'CLI', upgradeIncomplete: 'Beta1786000000100' })).rejects.toMatchObject({ gate: 'pending-migrations' });
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

describe('C3, Worker ("starts too, like Twenty"): an in-order pending tail of its chain is a loud warning, decided from the database alone', () => {
  it('in-order tail: pending and function-behind are warnings naming the first pending migration; the flag drives the semantic skip', () => {
    const a = assess('worker', { applied: CODE.slice(0, 1), provisionFunction: BEHIND_FN });
    expect(a.refusals).toEqual([]);
    expect(a.upgradeIncomplete).toBe('Beta1786000000100');
    expect(a.warnings.join(String.fromCharCode(10))).toMatch(/running on a partly-upgraded schema: Beta1786000000100 and 1 more not applied/);
    expect(a.warnings.join(String.fromCharCode(10))).toMatch(/UPGRADE INCOMPLETE \(C3\): first not applied Beta1786000000100/);
    // A tail of one, and the whole chain on an empty ledger, are tails too.
    expect(refused(assess('worker', { applied: CODE.slice(0, 2) }))).toEqual([]);
    // The API's variable is irrelevant to the Worker (another container).
    expect(assess('worker', { applied: CODE.slice(0, 1) }, 'Gamma1786000000200').upgradeIncomplete).toBe('Beta1786000000100');
  });

  it('nothing pending: no warning, no flag (a behind function still refuses)', () => {
    const a = assess('worker', {});
    expect({ refusals: a.refusals, warnings: a.warnings, flag: a.upgradeIncomplete }).toEqual({ refusals: [], warnings: [], flag: null });
    expect(refused(assess('worker', { provisionFunction: BEHIND_FN }))).toEqual(['provision-function-behind']);
  });

  it('not a tail (a gap: a later migration applied before an earlier one): pending refuses', () => {
    const gap = assess('worker', { applied: [CODE[0]!, CODE[2]!] });
    expect(refused(gap)).toEqual(['pending']);
    expect(gap.upgradeIncomplete).toBeNull();
  });

  it('interleaved, unknown / foreign, ahead or retired names: no relaxation; the existing refusals stand', () => {
    expect(refused(assess('worker', { applied: [CODE[0]!, INTERLEAVED] }))).toEqual(['ledger-interleaved', 'pending']);
    // Foreign chain: nothing of this code applied, only other names.
    expect(refused(assess('worker', { applied: ['Foreign1785000000000'] }))).toEqual(['ledger-interleaved', 'pending']);
    // A newer (ahead) name next to a pending tail: the ahead rule is unchanged (warning), but pending is not relaxed.
    const ahead = assess('worker', { applied: [CODE[0]!, 'Future1786000000999'] });
    expect(refused(ahead)).toEqual(['pending']);
    // A retired name in the ledger: not relaxed.
    const retired = assessSchemaCompatibility('worker', { expected: CODE, applied: [CODE[0]!, 'Retired1785000000000'] }, { production: true, retired: ['Retired1785000000000'] });
    expect(retired.refusals.map((r) => r.finding)).toEqual(['pending']);
  });

  it('unknown provision function in production still refuses on an in-order tail', () => {
    expect(refused(assess('worker', { applied: CODE.slice(0, 1), provisionFunction: UNKNOWN_FN }))).toEqual(['provision-function-unknown']);
  });

  it('isInOrderPendingTail: exact rule', () => {
    const l = (applied: string[], retired: string[] = []) => compareLedger(CODE, applied, retired);
    expect(isInOrderPendingTail(CODE, l(CODE.slice(0, 1)))).toBe(true);
    expect(isInOrderPendingTail(CODE, l([]))).toBe(true);
    expect(isInOrderPendingTail(CODE, l(CODE))).toBe(false); // nothing pending
    expect(isInOrderPendingTail(CODE, l([CODE[0]!, CODE[2]!]))).toBe(false); // gap
    expect(isInOrderPendingTail(CODE, l([CODE[0]!, INTERLEAVED]))).toBe(false);
  });

  it('the API rule is unchanged: without the named variable an in-order tail still refuses for the API', () => {
    expect(refused(assess('api', { applied: CODE.slice(0, 1) }))).toEqual(['pending']);
  });
});
