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
  WORKER_LOGIN_SHAPE_SQL,
  WORKER_ROLES_BY_CLAIM_MODE,
  workerClaimModeFrom,
} from './database-boot-gate-rules';

/**
 * Phase D (D1/D2/D5) identity separation — unit tests over mocked catalog facts (interface contract):
 *  - API = crewflow_app only; a crewflow_worker login (or a member of it) on the API refuses to boot.
 *  - Worker jobs child = crewflow_app or crewflow_worker in per_scope mode, crewflow_worker only in global mode.
 *  - provisioner = crewflow; CLI never crewflow_worker.
 *  - crewflow_worker keeps the owner-role rule and must have the reviewed shape (member of crewflow_app WITH INHERIT TRUE,
 *    SET FALSE only; no CREATEROLE/CREATEDB/REPLICATION; owns nothing).
 *  - gate 8: a Worker that cannot EXECUTE the due-work functions refuses (D5 cutover / mixed-version rollout); global mode
 *    needs the dispatch-claim functions; any non-Worker process that can EXECUTE a dispatch-claim function refuses.
 * The real-database counterpart (needs the crewflow_worker role, which does not exist yet) is
 * src/__tests__/integration/worker-identity-boot-gates.integration.spec.ts — written, NOT run.
 */

const DUE_GRANTED = DUE_WORK_FUNCTIONS.map((name) => ({ name, can_execute: true }));
const DUE_DENIED = DUE_WORK_FUNCTIONS.map((name) => ({ name, can_execute: false }));
const DISPATCH_GRANTED = DISPATCH_CLAIM_FUNCTIONS.map((name) => ({ name, can_execute: true }));
const DISPATCH_DENIED = DISPATCH_CLAIM_FUNCTIONS.map((name) => ({ name, can_execute: false }));

const GOOD_WORKER_SHAPE = { createrole: false, createdb: false, replication: false, inherit: true, app_inherit: true, app_set: false, other_memberships: null, owned_objects: 0 };

interface Db {
  facts: Record<string, unknown>;
  shape?: Record<string, unknown>;
  grants: Array<Record<string, unknown>>;
  seen: string[];
}

function db(who: string, over: { facts?: Record<string, unknown>; shape?: Record<string, unknown>; grants?: Array<Record<string, unknown>> } = {}): Db {
  return {
    facts: {
      who,
      login: who,
      super: false,
      bypassrls: false,
      login_privileged: false,
      owner_roles: null,
      worker_member: who === 'crewflow_worker',
      server_version_num: 160015,
      database: 'crewflow',
      extensions: 'btree_gist,citext,pg_trgm,pgcrypto,unaccent',
      ssl: false,
      ...over.facts,
    },
    shape: over.shape ?? GOOD_WORKER_SHAPE,
    grants: over.grants ?? DUE_GRANTED,
    seen: [],
  };
}

function fakeQuery(d: Db): Query {
  return async (sql: string, params?: unknown[]) => {
    d.seen.push(sql);
    if (sql === BOOT_FACTS_SQL) return [d.facts];
    // Phase D wave 3 gate 1c (covered in database-boot-gate-rules.dispatch-notify.spec.ts): nothing stored, poll-mode session.
    if (sql === DISPATCH_NOTIFY_STORED_SQL) return [];
    if (sql === DISPATCH_NOTIFY_SESSION_SQL) return [{ dispatch_notify: null }];
    if (sql === WORKER_LOGIN_SHAPE_SQL) return d.shape ? [d.shape] : [];
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

describe('Phase D boot identity: expected roles are code constants per process', () => {
  it('API crewflow_app; Worker per_scope crewflow_app|crewflow_worker; Worker global crewflow_worker; provisioner crewflow; CLI never crewflow_worker', () => {
    expect(expectedRolesFor('api')).toEqual(['crewflow_app']);
    expect(expectedRolesFor('worker')).toEqual(['crewflow_app', 'crewflow_worker']);
    expect(expectedRolesFor('worker', undefined, 'per_scope')).toEqual(['crewflow_app', 'crewflow_worker']);
    expect(expectedRolesFor('worker', undefined, 'global')).toEqual(['crewflow_worker']);
    expect(expectedRolesFor('provisioner', undefined, 'global')).toEqual(['crewflow']);
    for (const cmd of [undefined, 'bootstrap-admin', 'seed', 'storage:reconcile', 'ping']) expect(expectedRolesFor('cli', cmd)).not.toContain('crewflow_worker');
    expect(WORKER_ROLES_BY_CLAIM_MODE).toEqual({ per_scope: ['crewflow_app', 'crewflow_worker'], global: ['crewflow_worker'] });
  });

  it('reads WORKER_CLAIM_MODE fail closed (unset/empty = per_scope; anything else but the two values refuses)', () => {
    expect(workerClaimModeFrom({})).toBe('per_scope');
    expect(workerClaimModeFrom({ WORKER_CLAIM_MODE: '' })).toBe('per_scope');
    expect(workerClaimModeFrom({ WORKER_CLAIM_MODE: 'global' })).toBe('global');
    for (const bad of ['Global', 'global ', 'crewflow_worker', 'true']) expect(() => workerClaimModeFrom({ WORKER_CLAIM_MODE: bad })).toThrow(DatabaseBootGateError);
  });
});

describe('Phase D boot identity: role gate', () => {
  it('the API refuses a crewflow_worker login with a clear message', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_worker'))), 'role', /api process connects as "crewflow_worker", the Worker-only login .*expected crewflow_app/);
  });

  it('every CLI command and the provisioner refuse crewflow_worker too', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_worker'), { processName: 'cli', cliCommand: 'bootstrap-admin' })), 'role', /Worker-only login/);
    await refusedAt(evaluateBootGates(input(db('crewflow_worker'), { processName: 'provisioner' })), 'role', /Worker-only login.*expected crewflow/);
  });

  it('the API refuses a login that is a member of crewflow_worker (would inherit the claim grants)', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_app', { facts: { worker_member: true } }))), 'role', /member of crewflow_worker/);
  });

  it('per_scope Worker: crewflow_app (old runtime mode) and crewflow_worker both start', async () => {
    await expect(evaluateBootGates(input(db('crewflow_app'), worker()))).resolves.toMatchObject({ role: 'crewflow_app', claimMode: 'per_scope' });
    await expect(evaluateBootGates(input(db('crewflow_worker'), worker('per_scope')))).resolves.toMatchObject({ role: 'crewflow_worker', claimMode: 'per_scope' });
  });

  it('global Worker: crewflow_app refuses with an actionable message; crewflow_worker starts', async () => {
    await refusedAt(
      evaluateBootGates(input(db('crewflow_app', { grants: [...DUE_GRANTED, ...DISPATCH_DENIED] }), worker('global'))),
      'role',
      /WORKER_CLAIM_MODE=global requires "crewflow_worker".*PG_DATABASE_URL.*WORKER_CLAIM_MODE=per_scope/,
    );
    await expect(evaluateBootGates(input(db('crewflow_worker', { grants: [...DUE_GRANTED, ...DISPATCH_GRANTED] }), worker('global')))).resolves.toMatchObject({
      role: 'crewflow_worker',
      claimMode: 'global',
      grants: { dueWork: 'granted', dispatchClaims: 'granted' },
    });
  });

  it('an invalid WORKER_CLAIM_MODE refuses the Worker before any query', async () => {
    const d = db('crewflow_app');
    await refusedAt(evaluateBootGates(input(d, worker('GLOBAL'))), 'config', /WORKER_CLAIM_MODE must be exactly per_scope or global/);
    expect(d.seen).toEqual([]);
  });

  it('the owner-role rule still holds for crewflow_worker (any membership in crewflow / rab_owner / rab_secure_owner), and SET ROLE / SUPERUSER / BYPASSRLS refuse', async () => {
    for (const owner of ['crewflow', 'rab_owner', 'rab_secure_owner']) {
      await refusedAt(evaluateBootGates(input(db('crewflow_worker', { facts: { owner_roles: owner } }), worker())), 'role', new RegExp(`member of ${owner}`));
    }
    await refusedAt(evaluateBootGates(input(db('crewflow_worker', { facts: { login: 'someone_else' } }), worker())), 'role', /SET ROLE is not accepted/);
    await refusedAt(evaluateBootGates(input(db('crewflow_worker', { facts: { bypassrls: true } }), worker())), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(evaluateBootGates(input(db('crewflow_worker', { facts: { super: true } }), worker('global'))), 'role', /SUPERUSER or BYPASSRLS/);
  });

  it('the owner-role SQL uses pg_has_role MEMBER for both current_user and session_user (PG16: ignores INHERIT/SET grant options)', () => {
    expect(BOOT_FACTS_SQL).toMatch(/pg_has_role\(current_user, o\.oid, 'MEMBER'\) OR pg_catalog\.pg_has_role\(session_user, o\.oid, 'MEMBER'\)/);
    expect(BOOT_FACTS_SQL).toMatch(/pg_has_role\(current_user, w\.oid, 'MEMBER'\) OR pg_catalog\.pg_has_role\(session_user, w\.oid, 'MEMBER'\)/);
    expect(BOOT_FACTS_SQL).not.toMatch(/'USAGE'|'SET'\)/);
    // Several grantors may each hold a grant row for the same pair in PG16: the effective option is any row's.
    expect(WORKER_LOGIN_SHAPE_SQL).toMatch(/bool_or\(m\.inherit_option\)/);
    expect(WORKER_LOGIN_SHAPE_SQL).toMatch(/bool_or\(m\.set_option\)/);
  });
});

describe('Phase D boot identity: crewflow_worker reviewed shape', () => {
  it.each([
    [{ app_inherit: null, app_set: null }, /is not a member of crewflow_app/],
    [{ app_inherit: false }, /WITH INHERIT FALSE/],
    [{ app_set: true }, /WITH SET TRUE/],
    [{ createrole: true }, /has CREATEROLE/],
    [{ createdb: true }, /has CREATEDB/],
    [{ replication: true }, /has REPLICATION/],
    [{ inherit: false }, /NOINHERIT/],
    [{ other_memberships: 'pg_read_all_data' }, /also a member of pg_read_all_data/],
    [{ owned_objects: 2 }, /owns 2 database object/],
  ])('refuses %p', async (shape, pattern) => {
    await refusedAt(evaluateBootGates(input(db('crewflow_worker', { shape: { ...GOOD_WORKER_SHAPE, ...shape } }), worker())), 'role', pattern);
  });

  it('the shape query runs only for crewflow_worker and only after the version gate', async () => {
    const app = db('crewflow_app');
    await evaluateBootGates(input(app, worker()));
    expect(app.seen).not.toContain(WORKER_LOGIN_SHAPE_SQL);
    const old = db('crewflow_worker', { facts: { server_version_num: 150004 } });
    await refusedAt(evaluateBootGates(input(old, worker())), 'version', /below the minimum/);
    expect(old.seen).not.toContain(WORKER_LOGIN_SHAPE_SQL);
  });
});

describe('Phase D boot identity: gate 8 routine grants (D5 cutover visibility)', () => {
  it('a Worker that cannot EXECUTE the due-work functions refuses (old Worker after the D5 cutover), naming the fix', async () => {
    await refusedAt(
      evaluateBootGates(input(db('crewflow_app', { grants: DUE_DENIED }), worker())),
      'grants',
      /cannot run the due-work functions \(no EXECUTE on core\.worker_claim_due_work.*WorkerDueWorkClaimsToWorkerRole1786721330000.*crewflow_worker/,
    );
    await refusedAt(evaluateBootGates(input(db('crewflow_app', { grants: DUE_GRANTED.slice(1) }), worker())), 'grants', /missing core\.worker_claim_due_work/);
  });

  it('after the cutover crewflow_worker starts (per_scope) and reports the state; before it, crewflow_app starts and reports granted', async () => {
    await expect(evaluateBootGates(input(db('crewflow_worker'), worker()))).resolves.toMatchObject({ grants: { dueWork: 'granted', dispatchClaims: 'absent' } });
    await expect(evaluateBootGates(input(db('crewflow_app'), worker()))).resolves.toMatchObject({ grants: { dueWork: 'granted', dispatchClaims: 'absent' } });
  });

  it('global mode needs EXECUTE on every dispatch-claim function (missing = migrations not applied; denied = wrong grants)', async () => {
    await refusedAt(evaluateBootGates(input(db('crewflow_worker'), worker('global'))), 'grants', /missing core\.worker_claim_email_dispatch.*apply the Phase D migrations/);
    await refusedAt(
      evaluateBootGates(input(db('crewflow_worker', { grants: [...DUE_GRANTED, ...DISPATCH_GRANTED.slice(0, 4), { name: 'worker_release_dispatch_claim', can_execute: false }] }), worker('global'))),
      'grants',
      /no EXECUTE on core\.worker_release_dispatch_claim/,
    );
  });

  it('the API (and CLI) refuses when its login can EXECUTE any dispatch-claim function; the due-work grant (E7, until the cutover) is only reported', async () => {
    await refusedAt(
      evaluateBootGates(input(db('crewflow_app', { grants: [...DUE_GRANTED, ...DISPATCH_DENIED.slice(1), { name: 'worker_claim_email_dispatch', can_execute: true }] }))),
      'grants',
      /api process login "crewflow_app" can EXECUTE core\.worker_claim_email_dispatch: the dispatch-claim functions are for crewflow_worker only/,
    );
    await refusedAt(
      evaluateBootGates(input(db('crewflow_app', { grants: DISPATCH_GRANTED }), { processName: 'cli', cliCommand: 'seed' })),
      'grants',
      /CLI command "seed" login "crewflow_app" can EXECUTE/,
    );
    await expect(evaluateBootGates(input(db('crewflow_app', { grants: [...DUE_GRANTED, ...DISPATCH_DENIED] })))).resolves.toMatchObject({
      grants: { dueWork: 'granted', dispatchClaims: 'not-granted' },
    });
    await expect(evaluateBootGates(input(db('crewflow_app', { grants: DUE_DENIED })))).resolves.toMatchObject({ grants: { dueWork: 'not-granted' } });
  });

  it('a pending-migration refusal is reported before the grants gate', async () => {
    await refusedAt(
      evaluateBootGates(input(db('crewflow_worker'), { ...worker('global'), checkPendingMigrations: async () => Promise.reject(new Error('1 migration(s) are not applied')) })),
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
