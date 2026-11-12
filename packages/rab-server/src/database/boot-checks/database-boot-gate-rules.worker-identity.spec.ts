import { healthyOwnerLoginPosture, ownerLoginPostureAnswer } from '../../__tests__/helpers/owner-login-posture-fake';
import { MARKER_PRESENT_SQL, MARKER_READ_SQL, Query } from '../deployment-identity/deployment-identity';
import {
  BOOT_FACTS_SQL,
  DISPATCH_NOTIFY_SESSION_SQL,
  DISPATCH_NOTIFY_STORED_SQL,
  DatabaseBootGateError,
  DISPATCH_CLAIM_FUNCTIONS,
  DUE_WORK_FUNCTIONS,
  evaluateBootGates,
  EvaluateBootGatesInput,
  expectedRolesFor,
  FORCE_RLS_SPOT_CHECK_TABLES,
  FORCE_RLS_SQL,
  RLS_DISABLED_TENANT_TABLES_SQL,
  ROUTINE_GRANTS_SQL,
  routineGrantState,
  workerClaimModeFrom,
} from './database-boot-gate-rules';

/**
 * Phase D identities under the owner-login architecture (owner's final decision 2026-11-04) — unit tests over mocked
 * catalog facts. What changed, each a catalogue entry (owner-login-behaviour-catalogue.ts):
 *  - every process (API, Worker in either claim mode, CLI, provisioner) connects as crewflow_owner; crewflow_worker and
 *    crewflow_app are schema roles and connecting as them is refused (BC-02);
 *  - the crewflow_worker LOGIN-shape gate (old gate 1b) is gone with it; the role's SCHEMA shape (zero members, member of
 *    crewflow_app only) is enforced by the inventory, the 1786721300000 preflight, invariant 8 and check-rls-coverage;
 *  - gate 8: the API CAN execute the Worker-only dispatch-claim functions with one login. It no longer refuses: it is
 *    RECORDED as a boot warning (BC-08, DBA-01 lost, accepted by the owner 2026-11-05), asserted below so it can never go silent.
 * Unchanged: WORKER_CLAIM_MODE is read fail closed; a Worker that cannot run the due-work functions refuses; global mode
 * needs every dispatch-claim function; a pending migration is reported before the grants gate.
 */

const DUE_GRANTED = DUE_WORK_FUNCTIONS.map((name) => ({ name, can_execute: true }));
const DUE_DENIED = DUE_WORK_FUNCTIONS.map((name) => ({ name, can_execute: false }));
const DISPATCH_GRANTED = DISPATCH_CLAIM_FUNCTIONS.map((name) => ({ name, can_execute: true }));

interface Db {
  facts: Record<string, unknown>;
  grants: Array<Record<string, unknown>>;
  seen: string[];
}

function db(who: string, over: { facts?: Record<string, unknown>; grants?: Array<Record<string, unknown>> } = {}): Db {
  return {
    facts: {
      who,
      login: who,
      super: false,
      bypassrls: false,
      login_privileged: false,
      login_repl_createdb: false,
      owner_roles: 'crewflow,rab_owner,rab_secure_owner',
      worker_member: false,
      server_version_num: 160015,
      database: 'crewflow',
      extensions: 'btree_gist,citext,pg_trgm,pgcrypto,unaccent',
      ssl: false,
      ...over.facts,
    },
    // The owner login can run everything it owns: the due-work AND the dispatch-claim functions (via rab_secure_owner).
    grants: over.grants ?? [...DUE_GRANTED, ...DISPATCH_GRANTED],
    seen: [],
  };
}

function fakeQuery(d: Db): Query {
  const posture = healthyOwnerLoginPosture();
  return async (sql: string, params?: unknown[]) => {
    d.seen.push(sql);
    if (sql === BOOT_FACTS_SQL) return [d.facts];
    const answer = ownerLoginPostureAnswer(sql, posture);
    if (answer) return answer;
    if (sql === DISPATCH_NOTIFY_STORED_SQL) return [];
    if (sql === DISPATCH_NOTIFY_SESSION_SQL) return [{ dispatch_notify: null }];
    if (sql === MARKER_PRESENT_SQL) return [{ present: false, database: 'crewflow' }];
    if (sql === MARKER_READ_SQL) return [];
    if (sql === FORCE_RLS_SQL) return FORCE_RLS_SPOT_CHECK_TABLES.map((relname) => ({ relname, enabled: true, forced: true }));
    if (sql === RLS_DISABLED_TENANT_TABLES_SQL) return [];
    if (sql === ROUTINE_GRANTS_SQL) {
      const wanted = (params?.[0] as string[]) ?? [];
      return d.grants.filter((g) => wanted.includes(String(g.name)));
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  };
}

function input(d: Db, over: Partial<EvaluateBootGatesInput> = {}): EvaluateBootGatesInput {
  return { processName: 'api', env: { NODE_ENV: 'development' }, query: fakeQuery(d), checkPendingMigrations: async () => undefined, connectionHost: 'devdb', ...over };
}

async function refusedAt(promise: Promise<unknown>, gate: string, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DatabaseBootGateError);
  expect((error as DatabaseBootGateError).gate).toBe(gate);
  expect((error as Error).message).toMatch(pattern);
}

const worker = (claimMode?: string): Partial<EvaluateBootGatesInput> => ({
  processName: 'worker',
  env: { NODE_ENV: 'development', ...(claimMode === undefined ? {} : { WORKER_CLAIM_MODE: claimMode }) },
});

describe('owner login: the expected login is one code constant for every process and claim mode', () => {
  it('API, Worker (per_scope and global), provisioner and every CLI command expect crewflow_owner only', () => {
    expect(expectedRolesFor('api')).toEqual(['crewflow_owner']);
    expect(expectedRolesFor('worker', undefined, 'per_scope')).toEqual(['crewflow_owner']);
    expect(expectedRolesFor('worker', undefined, 'global')).toEqual(['crewflow_owner']);
    expect(expectedRolesFor('provisioner', undefined, 'global')).toEqual(['crewflow_owner']);
    for (const cmd of [undefined, 'bootstrap-admin', 'seed', 'storage:reconcile', 'ping']) expect(expectedRolesFor('cli', cmd)).toEqual(['crewflow_owner']);
  });

  it('reads WORKER_CLAIM_MODE fail closed (unset/empty = per_scope; anything else but the two values refuses)', () => {
    expect(workerClaimModeFrom({})).toBe('per_scope');
    expect(workerClaimModeFrom({ WORKER_CLAIM_MODE: '' })).toBe('per_scope');
    expect(workerClaimModeFrom({ WORKER_CLAIM_MODE: 'global' })).toBe('global');
    for (const bad of ['Global', 'global ', 'crewflow_worker', 'true']) expect(() => workerClaimModeFrom({ WORKER_CLAIM_MODE: bad })).toThrow(DatabaseBootGateError);
  });
});

describe('owner login: role gate', () => {
  it('BC-02: every process refuses a crewflow_worker or crewflow_app login (schema roles now), whatever the claim mode', async () => {
    for (const over of [{}, worker(), worker('global'), { processName: 'cli' as const, cliCommand: 'bootstrap-admin' }, { processName: 'provisioner' as const }]) {
      await refusedAt(evaluateBootGates(input(db('crewflow_worker'), over)), 'role', /connects as "crewflow_worker", a schema role/);
      await refusedAt(evaluateBootGates(input(db('crewflow_app'), over)), 'role', /connects as "crewflow_app"; expected crewflow_owner/);
    }
  });

  it('the owner login refuses when it is a member of crewflow_worker (that role must have zero members)', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { facts: { worker_member: true } }), worker())), 'role', /member of crewflow_worker, which must have zero members/);
  });

  it('per_scope and global Workers start on the owner login', async () => {
    await expect(evaluateBootGates(input(db('crewflow_owner'), worker()))).resolves.toMatchObject({ role: 'crewflow_owner', claimMode: 'per_scope' });
    await expect(evaluateBootGates(input(db('crewflow_owner'), worker('global')))).resolves.toMatchObject({
      role: 'crewflow_owner',
      claimMode: 'global',
      grants: { dueWork: 'granted', dispatchClaims: 'granted' },
    });
  });

  it('an invalid WORKER_CLAIM_MODE refuses the Worker before any query', async () => {
    const d = db('crewflow_owner');
    await refusedAt(evaluateBootGates(input(d, worker('GLOBAL'))), 'config', /WORKER_CLAIM_MODE must be exactly per_scope or global/);
    expect(d.seen).toEqual([]);
  });

  it('SET ROLE / SUPERUSER / BYPASSRLS refuse for the Worker as for the API', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { facts: { login: 'someone_else' } }), worker())), 'role', /SET ROLE is not accepted/);
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { facts: { bypassrls: true } }), worker())), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { facts: { super: true } }), worker('global'))), 'role', /SUPERUSER or BYPASSRLS/);
  });

  it('the membership SQL uses pg_has_role MEMBER for both current_user and session_user (PG16: ignores INHERIT/SET grant options)', () => {
    expect(BOOT_FACTS_SQL).toMatch(/pg_has_role\(current_user, o\.oid, 'MEMBER'\) OR pg_catalog\.pg_has_role\(session_user, o\.oid, 'MEMBER'\)/);
    expect(BOOT_FACTS_SQL).toMatch(/pg_has_role\(current_user, w\.oid, 'MEMBER'\) OR pg_catalog\.pg_has_role\(session_user, w\.oid, 'MEMBER'\)/);
    expect(BOOT_FACTS_SQL).not.toMatch(/'USAGE'|'SET'\)/);
  });
});

describe('owner login: gate 8 routine grants', () => {
  it('a Worker that cannot EXECUTE the due-work functions refuses, naming the fix', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { grants: DUE_DENIED }), worker())), 'grants', /cannot run the due-work functions \(no EXECUTE on core\.worker_claim_due_work/);
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { grants: DUE_GRANTED.slice(1) }), worker())), 'grants', /missing core\.worker_claim_due_work/);
  });

  it('global mode needs EXECUTE on every dispatch-claim function (missing = migrations not applied; denied = wrong grants)', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_owner', { grants: DUE_GRANTED }), worker('global'))), 'grants', /missing core\.worker_claim_email_dispatch.*apply the Phase D migrations/);
    await refusedAt(
      evaluateBootGates(
        input(db('crewflow_owner', { grants: [...DUE_GRANTED, ...DISPATCH_GRANTED.slice(0, 4), { name: 'worker_release_dispatch_claim', can_execute: false }] }), worker('global')),
      ),
      'grants',
      /no EXECUTE on core\.worker_release_dispatch_claim/,
    );
  });

  it('BC-08 (DBA-01 lost, accepted by the owner 2026-11-05): the API / CLI CAN execute the dispatch-claim functions, recorded as a warning on every boot, never silent', async () => {
    // Before: refused at gate `grants` ("the dispatch-claim functions are for crewflow_worker only").
    for (const over of [{}, { processName: 'cli' as const, cliCommand: 'seed' }]) {
      const report = await evaluateBootGates(input(db('crewflow_owner'), over));
      expect(report.grants).toEqual({ dueWork: 'granted', dispatchClaims: 'granted' });
      const bc08 = report.warnings.filter((w) => w.startsWith('BC-08'));
      expect(bc08).toHaveLength(1);
      expect(bc08[0]).toMatch(/accepted by the owner 2026-11-05.*core\.worker_claim_email_dispatch, .*core\.worker_release_dispatch_claim/);
    }
    // The Worker itself carries no BC-08 warning (it is the intended caller).
    const w = await evaluateBootGates(input(db('crewflow_owner'), worker('global')));
    expect(w.warnings.some((x) => x.startsWith('BC-08'))).toBe(false);
  });

  it('a pending-migration refusal is reported before the grants gate', async () => {
    await refusedAt(
      evaluateBootGates(input(db('crewflow_owner'), { ...worker('global'), checkPendingMigrations: async () => Promise.reject(new Error('1 migration(s) are not applied')) })),
      'pending-migrations',
      /not applied/,
    );
  });

  it('routineGrantState summarises overloads and partial grants', () => {
    expect(routineGrantState([], ['a'])).toMatchObject({ state: 'absent', missing: ['a'] });
    expect(routineGrantState([{ name: 'a', can_execute: true }, { name: 'a', can_execute: false }], ['a'])).toMatchObject({ state: 'partial', denied: ['a'] });
    expect(routineGrantState([{ name: 'a', can_execute: false }], ['a', 'b'])).toMatchObject({ state: 'not-granted', missing: ['b'] });
  });
});
