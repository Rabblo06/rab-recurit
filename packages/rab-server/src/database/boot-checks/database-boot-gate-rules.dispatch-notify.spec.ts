import { MARKER_PRESENT_SQL, MARKER_READ_SQL, Query } from '../deployment-identity/deployment-identity';
import {
  assertDispatchNotifyGate,
  BOOT_FACTS_SQL,
  DatabaseBootGateError,
  DISPATCH_CLAIM_FUNCTIONS,
  DISPATCH_NOTIFY_SESSION_SQL,
  DISPATCH_NOTIFY_STORED_SQL,
  DUE_WORK_FUNCTIONS,
  evaluateBootGates,
  EvaluateBootGatesInput,
  expectedDispatchNotify,
  FORCE_RLS_SPOT_CHECK_TABLES,
  FORCE_RLS_SQL,
  RLS_DISABLED_TENANT_TABLES_SQL,
  ROUTINE_GRANTS_SQL,
  WORKER_LOGIN_SHAPE_SQL,
} from './database-boot-gate-rules';

/**
 * Phase D wave 3 (owner-approved): `crewflow.dispatch_notify` may only ever come from the process's own startup option
 * (`-c crewflow.dispatch_notify=on`, event mode, API/Worker writable sessions — pg-config.ts dispatchNotifyFor). Gate
 * "dispatch-notify":
 *  - refuses when the database holds a PERSISTENT setting of it: any pg_db_role_setting row for this database or all
 *    databases (setdatabase = 0), for all roles (setrole = 0) or the connecting role or any role it is a member of;
 *  - asserts the gate session's own value: absent (NULL) for a poll-mode process (and every CLI / provisioner), 'on' for an
 *    event-mode API / Worker. Anything else refuses.
 * Unit tests over stubbed rows; the real-catalog counterpart is
 * src/database/boot-checks/dispatch-notify-boot-gate.integration.spec.ts.
 */

interface Db {
  who: string;
  stored: Array<Record<string, unknown>>;
  session: unknown;
  seen: string[];
}

function db(over: Partial<Db> = {}): Db {
  return { who: 'crewflow_app', stored: [], session: null, seen: [], ...over };
}

function fakeQuery(d: Db): Query {
  return async (sql: string, params?: unknown[]) => {
    d.seen.push(sql);
    if (sql === BOOT_FACTS_SQL) {
      return [
        {
          who: d.who,
          login: d.who,
          super: false,
          bypassrls: false,
          login_privileged: false,
          owner_roles: null,
          worker_member: d.who === 'crewflow_worker',
          server_version_num: 160004,
          database: 'crewflow',
          extensions: 'btree_gist,citext,pg_trgm,pgcrypto,unaccent',
          ssl: false,
        },
      ];
    }
    if (sql === WORKER_LOGIN_SHAPE_SQL) return [{ createrole: false, createdb: false, replication: false, inherit: true, app_inherit: true, app_set: false, other_memberships: null, owned_objects: 0 }];
    if (sql === DISPATCH_NOTIFY_STORED_SQL) return d.stored;
    if (sql === DISPATCH_NOTIFY_SESSION_SQL) return [{ dispatch_notify: d.session }];
    if (sql === MARKER_PRESENT_SQL) return [{ present: false, database: 'crewflow' }];
    if (sql === MARKER_READ_SQL) return [];
    if (sql === FORCE_RLS_SQL) return FORCE_RLS_SPOT_CHECK_TABLES.map((relname) => ({ relname, enabled: true, forced: true }));
    if (sql === RLS_DISABLED_TENANT_TABLES_SQL) return [];
    if (sql === ROUTINE_GRANTS_SQL) {
      // A crewflow_worker login holds the due-work and dispatch-claim grants (global mode passes gate 8); others due-work only.
      const granted = d.who === 'crewflow_worker' ? [...DUE_WORK_FUNCTIONS, ...DISPATCH_CLAIM_FUNCTIONS] : DUE_WORK_FUNCTIONS;
      return granted.filter((n) => ((params?.[0] as string[]) ?? []).includes(n)).map((name) => ({ name, can_execute: true }));
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

const EVENT = { NODE_ENV: 'development', WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event' };

describe('dispatch-notify gate: the expected session value is the connection factory rule', () => {
  it('on only for an event-mode API / Worker; absent for poll/unset and for every CLI / provisioner', () => {
    expect(expectedDispatchNotify('api', { WORKER_DISPATCH_MODE: 'event' })).toBe(true);
    expect(expectedDispatchNotify('worker', { WORKER_DISPATCH_MODE: 'event' })).toBe(true);
    for (const env of [{}, { WORKER_DISPATCH_MODE: '' }, { WORKER_DISPATCH_MODE: 'poll' }]) {
      expect(expectedDispatchNotify('api', env)).toBe(false);
      expect(expectedDispatchNotify('worker', env)).toBe(false);
    }
    expect(expectedDispatchNotify('cli', { WORKER_DISPATCH_MODE: 'event' })).toBe(false);
    expect(expectedDispatchNotify('provisioner', { WORKER_DISPATCH_MODE: 'event' })).toBe(false);
  });

  it('a malformed WORKER_DISPATCH_MODE refuses at gate config (fail closed, never guessed)', () => {
    for (const bad of ['Event', 'listen', 'on']) {
      expect(() => expectedDispatchNotify('api', { WORKER_DISPATCH_MODE: bad })).toThrow(DatabaseBootGateError);
    }
  });
});

describe('dispatch-notify gate: pure decision', () => {
  it('no stored setting + the expected session value passes (poll: absent, event: on)', () => {
    expect(assertDispatchNotifyGate([], { dispatch_notify: null }, { expectOn: false, label: 'api process' })).toBe('absent');
    expect(assertDispatchNotifyGate([], undefined, { expectOn: false, label: 'api process' })).toBe('absent');
    expect(assertDispatchNotifyGate([], { dispatch_notify: 'on' }, { expectOn: true, label: 'api process' })).toBe('on');
  });

  it.each([
    [{ role_name: 'crewflow_app', database_name: 'rab' }, /role crewflow_app in database rab/],
    [{ role_name: 'crewflow_app', database_name: null }, /role crewflow_app in every database/],
    [{ role_name: null, database_name: 'rab' }, /every role in database rab/],
  ])('a stored setting %p refuses, naming its scope and how to remove it', (row, scope) => {
    for (const expectOn of [false, true]) {
      let error: unknown;
      try {
        assertDispatchNotifyGate([row], { dispatch_notify: expectOn ? 'on' : null }, { expectOn, label: 'worker process' });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DatabaseBootGateError);
      expect((error as DatabaseBootGateError).gate).toBe('dispatch-notify');
      expect((error as Error).message).toMatch(/persistent setting of crewflow\.dispatch_notify/);
      expect((error as Error).message).toMatch(scope);
      expect((error as Error).message).toMatch(/RESET crewflow\.dispatch_notify/);
    }
  });

  it('several stored rows are all listed', () => {
    expect(() =>
      assertDispatchNotifyGate(
        [
          { role_name: null, database_name: 'rab' },
          { role_name: 'crewflow_app', database_name: 'rab' },
        ],
        { dispatch_notify: null },
        { expectOn: false, label: 'api process' },
      ),
    ).toThrow(/every role in database rab.*role crewflow_app in database rab/);
  });

  it.each([
    [false, 'on', /poll mode.*sees crewflow\.dispatch_notify='on'/],
    [false, 'off', /sees crewflow\.dispatch_notify='off'/],
    [false, '', /sees crewflow\.dispatch_notify=''/],
    [true, null, /event mode .*sees crewflow\.dispatch_notify absent/],
    [true, 'off', /event mode .*'off'/],
    [true, 'ON', /'ON'/],
  ])('expectOn=%p with session value %p refuses', (expectOn, value, pattern) => {
    expect(() => assertDispatchNotifyGate([], { dispatch_notify: value }, { expectOn, label: 'api process' })).toThrow(pattern);
  });
});

describe('dispatch-notify gate inside evaluateBootGates', () => {
  it('runs the two read-only statements after the role gate, on every process kind', async () => {
    for (const processName of ['api', 'worker', 'cli', 'provisioner'] as const) {
      const d = db({ who: processName === 'provisioner' ? 'crewflow' : 'crewflow_app' });
      const report = await evaluateBootGates(input(d, { processName, cliCommand: processName === 'cli' ? 'ping' : undefined }));
      expect(d.seen).toContain(DISPATCH_NOTIFY_STORED_SQL);
      expect(d.seen).toContain(DISPATCH_NOTIFY_SESSION_SQL);
      expect(d.seen.indexOf(DISPATCH_NOTIFY_STORED_SQL)).toBeGreaterThan(d.seen.indexOf(BOOT_FACTS_SQL));
      expect(report.dispatchNotify).toBe('absent');
    }
  });

  it('a wrong role is still reported as a role refusal (the gate runs after gate 1)', async () => {
    await refusedAt(evaluateBootGates(input(db({ who: 'crewflow', stored: [{ role_name: 'crewflow', database_name: 'rab' }] }))), 'role', /expected crewflow_app/);
  });

  it('poll-mode API with a stored per-role setting refuses at gate dispatch-notify', async () => {
    await refusedAt(
      evaluateBootGates(input(db({ stored: [{ role_name: 'crewflow_app', database_name: 'crewflow' }] }))),
      'dispatch-notify',
      /role crewflow_app in database crewflow/,
    );
  });

  it('event-mode Worker (crewflow_worker) with its own startup option passes; a database-wide stored row refuses even then', async () => {
    const ok = await evaluateBootGates(input(db({ who: 'crewflow_worker', session: 'on' }), { processName: 'worker', env: EVENT }));
    expect(ok.dispatchNotify).toBe('on');
    await refusedAt(
      evaluateBootGates(input(db({ who: 'crewflow_worker', session: 'on', stored: [{ role_name: null, database_name: 'crewflow' }] }), { processName: 'worker', env: EVENT })),
      'dispatch-notify',
      /every role in database crewflow/,
    );
  });

  it('event-mode API whose session lacks the option refuses; a stored member-role setting refuses', async () => {
    await refusedAt(evaluateBootGates(input(db({ session: null }), { env: EVENT })), 'dispatch-notify', /event mode/);
    await refusedAt(
      evaluateBootGates(input(db({ session: 'on', stored: [{ role_name: 'some_parent_role', database_name: null }] }), { env: EVENT })),
      'dispatch-notify',
      /role some_parent_role in every database/,
    );
  });

  it('the CLI and the provisioner refuse a session that carries the setting, even with WORKER_DISPATCH_MODE=event', async () => {
    await refusedAt(evaluateBootGates(input(db({ session: 'on' }), { processName: 'cli', cliCommand: 'ping', env: EVENT })), 'dispatch-notify', /poll mode|must not carry/);
    await refusedAt(evaluateBootGates(input(db({ who: 'crewflow', session: 'on' }), { processName: 'provisioner', env: EVENT })), 'dispatch-notify', /must not carry/);
  });
});

describe('dispatch-notify gate SQL (read-only, catalog-only)', () => {
  it('stored-setting query: pg_db_role_setting, this database or all, all roles or a role the CONNECTING role is a member of, name case-insensitive', () => {
    const sql = DISPATCH_NOTIFY_STORED_SQL;
    expect(sql).toMatch(/^\s*SELECT\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|SET\s+ROLE|CREATE|DROP|GRANT)\b/i);
    expect(sql).toMatch(/pg_catalog\.pg_db_role_setting/);
    expect(sql).toMatch(/s\.setdatabase = 0/);
    expect(sql).toMatch(/pg_catalog\.current_database\(\)/);
    expect(sql).toMatch(/s\.setrole = 0/);
    expect(sql).toMatch(/pg_catalog\.pg_has_role\(current_user, s\.setrole, 'MEMBER'\)/);
    expect(sql).toMatch(/pg_catalog\.lower\(pg_catalog\.split_part\(c\.cfg, '=', 1\)\) = 'crewflow\.dispatch_notify'/);
  });

  it('session query: current_setting(..., true) (missing_ok: NULL when absent, never an error)', () => {
    expect(DISPATCH_NOTIFY_SESSION_SQL).toMatch(/pg_catalog\.current_setting\('crewflow\.dispatch_notify', true\) AS dispatch_notify/);
  });
});
