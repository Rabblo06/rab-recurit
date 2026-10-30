import { RETIRED_MIGRATIONS } from '../typeorm/core/retired-migrations';
import {
  parseProvisionFunctionSource,
  PROVISION_FUNCTION_MODULE_VERSIONS,
  PROVISION_FUNCTION_SOURCE_SQL,
  ProvisionFunctionState,
} from '../typeorm/workspace-schema/provision-function-versions';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../typeorm/workspace-schema/workspace-schema-modules';
import {
  assertSchemaCompatible,
  assessSchemaCompatibility,
  checkSchemaCompatibility,
  compareLedger,
  CompatibilityFinding,
  CompatibilityProcess,
  migrationTimestamp,
  SchemaCompatibilityError,
  SchemaCompatibilityFacts,
} from './schema-compatibility';

/**
 * Phase B (proposal 03): the schema-version compatibility matrix, one row per case, per process type. Pure: the facts
 * (code migrations, ledger names, provision function state, READY workspace levels) are injected.
 */
const CODE = ['Alpha1786000000000', 'Beta1786000000100', 'Gamma1786000000200'];
const NEWER = ['Future1786000000300', 'Future1786000000400'];
const INTERLEAVED = 'OtherBranch1786000000150';
const PROCESSES: CompatibilityProcess[] = ['api', 'worker', 'cli', 'provisioner', 'migrate-check', 'migrate-apply'];

const CURRENT_FN: ProvisionFunctionState = {
  state: 'known',
  literal: 'db:provision_workspace@ProvisionWorkspaceGuards1786721210000',
  moduleVersion: LATEST_WORKSPACE_MODULE_VERSION,
};

type Outcome = 'refuse' | 'warn' | 'ok';

function outcome(process: CompatibilityProcess, facts: Partial<SchemaCompatibilityFacts>, production = false, retired: string[] = []): Outcome {
  const a = assessSchemaCompatibility(process, { expected: CODE, applied: CODE, ...facts }, { production, retired });
  if (a.refusals.length) return 'refuse';
  return a.warnings.length ? 'warn' : 'ok';
}

function findings(process: CompatibilityProcess, facts: Partial<SchemaCompatibilityFacts>, production = false): CompatibilityFinding[] {
  return assessSchemaCompatibility(process, { expected: CODE, applied: CODE, ...facts }, { production }).refusals.map((r) => r.finding);
}

describe('migrationTimestamp / compareLedger', () => {
  it('reads the 13-digit suffix; anything else is null', () => {
    expect(migrationTimestamp('VenueTeamOrgAdmin1786721090000')).toBe(1786721090000);
    expect(migrationTimestamp('NoTimestamp')).toBeNull();
    expect(migrationTimestamp('Short123')).toBeNull();
  });

  it('splits pending, newer and interleaved; a newer name next to an interleaved one is not a rollback', () => {
    expect(compareLedger(CODE, [CODE[0]!, CODE[1]!])).toMatchObject({ pending: [CODE[2]], unknownNewer: [], unknownInterleaved: [] });
    expect(compareLedger(CODE, [...CODE, ...NEWER].reverse())).toMatchObject({ pending: [], unknownNewer: NEWER, unknownInterleaved: [] });
    expect(compareLedger(CODE, [...CODE, INTERLEAVED])).toMatchObject({ unknownNewer: [], unknownInterleaved: [INTERLEAVED] });
    expect(compareLedger(CODE, [...CODE, NEWER[0]!, INTERLEAVED])).toMatchObject({ unknownNewer: [], unknownInterleaved: [INTERLEAVED, NEWER[0]] });
    // A name without a 13-digit timestamp cannot be proven newer: interleaved (fail closed).
    expect(compareLedger(CODE, [...CODE, 'HandWrittenFix'])).toMatchObject({ unknownInterleaved: ['HandWrittenFix'] });
  });

  it('a retired name is ignored, even when its timestamp is older than the code; RETIRED_MIGRATIONS ships empty', () => {
    expect(RETIRED_MIGRATIONS).toEqual([]);
    expect(Object.isFrozen(RETIRED_MIGRATIONS)).toBe(true);
    expect(compareLedger(CODE, [...CODE, INTERLEAVED], [INTERLEAVED])).toMatchObject({ unknownInterleaved: [], unknownNewer: [], retiredPresent: [INTERLEAVED] });
    // Retiring one name never excuses another.
    expect(compareLedger(CODE, [...CODE, INTERLEAVED, 'Other1786000000160'], [INTERLEAVED])).toMatchObject({ unknownInterleaved: ['Other1786000000160'] });
  });
});

describe('compatibility matrix per process type', () => {
  const table = (rows: Record<CompatibilityProcess, Outcome>, facts: Partial<SchemaCompatibilityFacts>, production = false) => {
    for (const p of PROCESSES) expect([p, outcome(p, facts, production)]).toEqual([p, rows[p]]);
  };

  it('current schema: every process runs, no warning', () => {
    table({ api: 'ok', worker: 'ok', cli: 'ok', provisioner: 'ok', 'migrate-check': 'ok', 'migrate-apply': 'ok' }, { provisionFunction: CURRENT_FN, workspaces: [] });
  });

  it('(a) pending migrations: API, Worker, CLI and provisioner refuse; rab-migrate applies them (not a compatibility finding)', () => {
    table(
      { api: 'refuse', worker: 'refuse', cli: 'refuse', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'ok' },
      { applied: CODE.slice(0, 2) },
    );
    expect(findings('api', { applied: CODE.slice(0, 2) })).toEqual(['pending']);
  });

  it('(b1) pure image rollback (every unknown name newer): API/Worker/CLI/migrate-check warn; provisioner and migrate-apply refuse', () => {
    table(
      { api: 'warn', worker: 'warn', cli: 'warn', provisioner: 'refuse', 'migrate-check': 'warn', 'migrate-apply': 'refuse' },
      { applied: [...CODE, ...NEWER] },
    );
    const a = assessSchemaCompatibility('api', { expected: CODE, applied: [...CODE, ...NEWER] }, { production: true });
    expect(a.warnings.join()).toMatch(/AHEAD of this code by 2 migration\(s\): Future1786000000300, Future1786000000400/);
    expect(findings('provisioner', { applied: [...CODE, ...NEWER] })).toEqual(['ledger-ahead']);
  });

  it('(b2) interleaved unknown name (another branch / wrong database): every process refuses, production or not', () => {
    const all = { api: 'refuse', worker: 'refuse', cli: 'refuse', provisioner: 'refuse', 'migrate-check': 'refuse', 'migrate-apply': 'refuse' } as const;
    table(all, { applied: [...CODE, INTERLEAVED] });
    table(all, { applied: [...CODE, INTERLEAVED] }, true);
    table(all, { applied: [...CODE, ...NEWER, INTERLEAVED] });
    expect(findings('cli', { applied: [...CODE, INTERLEAVED] })).toEqual(['ledger-interleaved']);
  });

  it('(b2) the same name on RETIRED_MIGRATIONS is accepted everywhere', () => {
    for (const p of PROCESSES) expect(outcome(p, { applied: [...CODE, INTERLEAVED] }, false, [INTERLEAVED])).toBe('ok');
  });

  it('(d1) unknown provision function body: API/Worker refuse in production and warn elsewhere; provisioner and migrate-apply refuse; CLI and migrate-check do not check', () => {
    for (const fn of [{ state: 'unknown', literal: 'db:provision_workspace@Tampered1786000000999' }, { state: 'missing' }] as ProvisionFunctionState[]) {
      table({ api: 'warn', worker: 'warn', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { provisionFunction: fn });
      table({ api: 'refuse', worker: 'refuse', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { provisionFunction: fn }, true);
    }
    expect(findings('worker', { provisionFunction: { state: 'missing' } }, true)).toEqual(['provision-function-unknown']);
  });

  it('(d2) known body behind the code (or the pre-ledger body): API, Worker, provisioner and migrate-apply refuse', () => {
    for (const fn of [
      { state: 'known', literal: 'db:provision_workspace@ArchiveAndSearchSchema1786719920000', moduleVersion: 17 },
      { state: 'known', literal: 'db:provision_workspace@AttendanceMoneyChecks1786719810000', moduleVersion: 15 },
      { state: 'legacy' },
    ] as ProvisionFunctionState[]) {
      table({ api: 'refuse', worker: 'refuse', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { provisionFunction: fn });
    }
    expect(findings('api', { provisionFunction: { state: 'legacy' } })).toEqual(['provision-function-behind']);
  });

  it('(d3) known body ahead of the code (image rollback): API/Worker warn; provisioner and migrate-apply refuse', () => {
    const ahead: ProvisionFunctionState = { state: 'known', literal: 'db:provision_workspace@Next', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION + 1 };
    table({ api: 'warn', worker: 'warn', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { provisionFunction: ahead });
    table({ api: 'warn', worker: 'warn', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { provisionFunction: ahead }, true);
    // Same through the frozen map with an older code level (what a rolled-back image sees).
    const a = assessSchemaCompatibility('api', { expected: CODE, applied: CODE, provisionFunction: CURRENT_FN }, { production: true, latestModuleVersion: 17 });
    expect(a.refusals).toEqual([]);
    expect(a.warnings.join()).toMatch(/above this code's workspace module 17/);
  });

  it('(c1) a READY workspace below LATEST: rab-migrate apply refuses (post-check); the provisioner leaves it to the migrator', () => {
    const behind = [{ workspaceId: 'w-behind', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION - 1 }];
    table({ api: 'ok', worker: 'ok', cli: 'ok', provisioner: 'ok', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { workspaces: behind });
    expect(findings('migrate-apply', { workspaces: behind })).toEqual(['workspace-behind']);
  });

  it('(c2) a READY workspace above LATEST: the provisioner and migrate-apply refuse; the API/Worker check it per request instead', () => {
    const ahead = [{ workspaceId: 'w-ahead', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION + 1 }];
    table({ api: 'ok', worker: 'ok', cli: 'ok', provisioner: 'refuse', 'migrate-check': 'ok', 'migrate-apply': 'refuse' }, { workspaces: ahead });
    expect(findings('provisioner', { workspaces: ahead })).toEqual(['workspace-ahead']);
  });
});

describe('assertSchemaCompatible', () => {
  it('throws one SchemaCompatibilityError naming every refusal; pending refusals belong to gate pending-migrations', () => {
    const a = assessSchemaCompatibility('api', { expected: CODE, applied: [CODE[0]!, INTERLEAVED] }, { production: false });
    try {
      assertSchemaCompatible(a, 'api process');
      throw new Error('not refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaCompatibilityError);
      const e = error as SchemaCompatibilityError;
      expect(e.gate).toBe('pending-migrations');
      expect(e.findings).toEqual(['pending', 'ledger-interleaved']);
      expect(e.message).toMatch(/^Refusing to start the api process: 2 migration\(s\) are not applied: Beta1786000000100, Gamma1786000000200\./);
      expect(e.message).toMatch(/OtherBranch1786000000150/);
    }
    const b = assessSchemaCompatibility('provisioner', { expected: CODE, applied: [...CODE, ...NEWER] }, { production: false });
    expect(() => assertSchemaCompatible(b, 'provisioner process')).toThrow(expect.objectContaining({ gate: 'schema-compatibility', findings: ['ledger-ahead'] }));
  });

  it('returns the warnings when nothing refuses', () => {
    const a = assessSchemaCompatibility('worker', { expected: CODE, applied: [...CODE, ...NEWER] }, { production: true });
    expect(assertSchemaCompatible(a, 'worker process')).toHaveLength(1);
  });
});

describe('provision function body → module version (frozen map)', () => {
  const body = (literal: string) => `BEGIN ... 'APPLIED', v_started, pg_catalog.clock_timestamp(), NULL, '${literal}' ... END`;

  it('maps the four frozen literals; the newest equals LATEST_WORKSPACE_MODULE_VERSION', () => {
    expect(PROVISION_FUNCTION_MODULE_VERSIONS).toEqual({
      'db:provision_workspace@AttendanceMoneyChecks1786719810000': 15,
      'db:provision_workspace@ArchiveAndSearchSchema1786719920000': 17,
      'db:provision_workspace@VenueTeamOrgAdmin1786721090000': 18,
      'db:provision_workspace@ProvisionWorkspaceGuards1786721210000': 18,
    });
    expect(Math.max(...Object.values(PROVISION_FUNCTION_MODULE_VERSIONS))).toBe(LATEST_WORKSPACE_MODULE_VERSION);
    expect(Object.isFrozen(PROVISION_FUNCTION_MODULE_VERSIONS)).toBe(true);
  });

  it('parses missing / legacy / unknown / known, and two different literals as unknown', () => {
    expect(parseProvisionFunctionSource(null)).toEqual({ state: 'missing' });
    expect(parseProvisionFunctionSource('BEGIN RETURN 1; END')).toEqual({ state: 'legacy' });
    expect(parseProvisionFunctionSource(body('db:provision_workspace@Nope1786000000000'))).toEqual({ state: 'unknown', literal: 'db:provision_workspace@Nope1786000000000' });
    expect(parseProvisionFunctionSource(body('db:provision_workspace@VenueTeamOrgAdmin1786721090000'))).toEqual({
      state: 'known',
      literal: 'db:provision_workspace@VenueTeamOrgAdmin1786721090000',
      moduleVersion: 18,
    });
    const twice = body('db:provision_workspace@VenueTeamOrgAdmin1786721090000') + body('db:provision_workspace@ArchiveAndSearchSchema1786719920000');
    expect(parseProvisionFunctionSource(twice).state).toBe('unknown');
  });
});

describe('checkSchemaCompatibility (reads over an injected query)', () => {
  function fakeQuery(db: { ledger?: string[] | Error; prosrc?: string | null; workspaces?: Array<{ id: string; org: string; status: string; v: number }> }) {
    const seen: string[] = [];
    const query = async (sql: string, params?: unknown[]): Promise<unknown[]> => {
      seen.push(sql);
      if (sql === 'SELECT name FROM core.migrations') {
        if (db.ledger instanceof Error) throw db.ledger;
        return (db.ledger ?? CODE).map((name) => ({ name }));
      }
      if (sql === PROVISION_FUNCTION_SOURCE_SQL) return db.prosrc === undefined ? [] : [{ prosrc: db.prosrc }];
      if (sql.includes('core.worker_list_workspaces')) return (db.workspaces ?? []).map((w) => ({ workspace_id: w.id, organisation_id: w.org }));
      if (sql.includes('FROM core.workspace_schema_registry')) {
        const w = (db.workspaces ?? []).find((x) => x.id === params?.[0]);
        return w ? [{ status: w.status, module_version: w.v }] : [];
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes('set_config')) return [];
      throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
    };
    return { query, seen };
  }
  const guards = `... 'db:provision_workspace@ProvisionWorkspaceGuards1786721210000' ...`;

  it('an unreadable ledger and an empty migration list refuse (gate pending-migrations), never pass', async () => {
    const err = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(checkSchemaCompatibility(fakeQuery({ ledger: err }).query, { process: 'api', production: false, expected: CODE, label: 'api process' })).rejects.toMatchObject({
      gate: 'pending-migrations',
      message: expect.stringMatching(/ledger could not be read \(SQLSTATE 42501\)/),
    });
    await expect(checkSchemaCompatibility(fakeQuery({}).query, { process: 'api', production: false, expected: [], label: 'api process' })).rejects.toThrow(/no migrations are loaded/);
  });

  it('pending refuses before the function or the workspaces are read', async () => {
    const f = fakeQuery({ ledger: CODE.slice(0, 1), prosrc: guards });
    await expect(checkSchemaCompatibility(f.query, { process: 'provisioner', production: false, expected: CODE, label: 'provisioner process', workspaces: true })).rejects.toMatchObject({
      gate: 'pending-migrations',
    });
    expect(f.seen).toEqual(['SELECT name FROM core.migrations']);
  });

  it('API: reads the function (catalog only) and passes on the current body; CLI never reads it', async () => {
    const api = fakeQuery({ prosrc: guards });
    await expect(checkSchemaCompatibility(api.query, { process: 'api', production: true, expected: CODE, label: 'api process' })).resolves.toMatchObject({ warnings: [] });
    expect(api.seen).toContain(PROVISION_FUNCTION_SOURCE_SQL);
    const cli = fakeQuery({ prosrc: null });
    await expect(checkSchemaCompatibility(cli.query, { process: 'cli', production: true, expected: CODE, label: 'CLI' })).resolves.toBeDefined();
    expect(cli.seen).not.toContain(PROVISION_FUNCTION_SOURCE_SQL);
  });

  it('API in production refuses a missing function; outside production it is a warning', async () => {
    await expect(checkSchemaCompatibility(fakeQuery({ prosrc: undefined }).query, { process: 'api', production: true, expected: CODE, label: 'api process' })).rejects.toMatchObject({
      gate: 'schema-compatibility',
      findings: ['provision-function-unknown'],
    });
    const a = await checkSchemaCompatibility(fakeQuery({ prosrc: undefined }).query, { process: 'api', production: false, expected: CODE, label: 'api process' });
    expect(a.warnings.join()).toMatch(/does not exist/);
  });

  it('provisioner: scans READY workspaces (one org-bound transaction each) and refuses one above LATEST', async () => {
    const f = fakeQuery({
      prosrc: guards,
      workspaces: [
        { id: 'w1', org: 'o1', status: 'READY', v: LATEST_WORKSPACE_MODULE_VERSION },
        { id: 'w2', org: 'o2', status: 'CREATING', v: 0 },
        { id: 'w3', org: 'o3', status: 'READY', v: LATEST_WORKSPACE_MODULE_VERSION + 1 },
      ],
    });
    await expect(
      checkSchemaCompatibility(f.query, { process: 'provisioner', production: false, expected: CODE, label: 'provisioner process', workspaces: true }),
    ).rejects.toMatchObject({ gate: 'schema-compatibility', findings: ['workspace-ahead'], message: expect.stringMatching(/w3@19/) });
    expect(f.seen.filter((s) => s === 'BEGIN')).toHaveLength(3);
    expect(f.seen.filter((s) => s === 'COMMIT')).toHaveLength(3);
  });

  it('a retired name passes through the options', async () => {
    const f = fakeQuery({ ledger: [...CODE, INTERLEAVED], prosrc: guards });
    await expect(checkSchemaCompatibility(f.query, { process: 'api', production: true, expected: CODE, label: 'api process' })).rejects.toMatchObject({ findings: ['ledger-interleaved'] });
    await expect(
      checkSchemaCompatibility(f.query, { process: 'api', production: true, expected: CODE, label: 'api process', retired: [INTERLEAVED] }),
    ).resolves.toMatchObject({ retiredPresent: [INTERLEAVED], warnings: [] });
  });
});
