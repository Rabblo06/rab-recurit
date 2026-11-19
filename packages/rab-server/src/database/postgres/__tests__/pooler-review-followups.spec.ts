import { Client } from 'pg';

import { boundEndpointTarget } from '../../boot-checks/database-boot-gates';
import { dbSetupTargetProblem, DB_SETUP_INPUT_MESSAGES, OwnerCredentialError, selectDbSetupInput } from '../../owner-login/owner-credential';
import { assertPooledHopTls, resolveRuntimeDatabase, RuntimeDbError } from '../../typeorm/core/runtime-database-guard';
import { createPgClient, pgClientConfig, pgPoolConfig } from '../create-pg-pool';
import { resolvePgEnvironment, ResolvedPgEnvironment } from '../pg-config';
import { parsePgUrl } from '../pg-url-policy';
import { TransactionScopedClient } from '../transaction-scoped-client';

// Security review of PR #258 at 58ab6ac9 (APPROVE WITH NITS): unit coverage of the follow-ups. The PgBouncer cases are in
// transaction-pooler.integration.spec.ts, the catalog check of the RLS GUC list in rls-guc-names.integration.spec.ts.
const PW = 'Pw-s3cret-9f-0123456789abcdefghijklmnop';
const PROD_URL = `postgresql://crewflow_owner:${PW}@db.example.com:5432/rab?sslmode=verify-full`;
const POOLER = `postgresql://crewflow_owner:${PW}@pool.example.com:6432/rab?sslmode=verify-full`;
const PROD = { NODE_ENV: 'production', PG_DATABASE_URL: PROD_URL };

describe('L-1: production always serves the API / Worker runtime pool with the transaction-scoped client', () => {
  it.each(['api', 'worker'] as const)('%s, production, NO session URL: runtime scoped; primary and lock stay plain direct sessions', (role) => {
    const r = resolvePgEnvironment(PROD, { processRole: role });
    expect(r.pooled?.transactionScoped).toBe(true);
    expect(r.pooled?.target.host).toBe('db.example.com');
    expect(r.primary.transactionScoped).toBeUndefined();
    expect(r.lock).toBe(r.primary);
    const runtime = pgPoolConfig(r, { endpoint: 'runtime', purpose: 'runtime' });
    expect(runtime.Client).toBe(TransactionScopedClient);
    expect(runtime).not.toHaveProperty('options');
    expect(pgClientConfig(r, { endpoint: 'primary', purpose: 'probe' }).options).toBe('-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000');
    expect(createPgClient(r, { endpoint: 'lock', purpose: 'probe' })).not.toBeInstanceOf(TransactionScopedClient);
  });

  it('outside production without a session URL the runtime pool stays plain (checkout RESET ROLE); other processes are never scoped', () => {
    expect(resolvePgEnvironment({ PG_DATABASE_URL: PROD_URL }, { processRole: 'api' }).pooled).toBeNull();
    for (const role of ['migrate', 'cli', 'provisioner'] as const) expect(resolvePgEnvironment(PROD, { processRole: role }).pooled).toBeNull();
  });

  it('production event dispatch: the NOTIFY switch moves into the per-transaction preamble of the always-scoped pool', () => {
    const r = resolvePgEnvironment({ ...PROD, WORKER_DISPATCH_MODE: 'event' }, { processRole: 'worker' });
    expect(pgPoolConfig(r, { endpoint: 'runtime', purpose: 'runtime' }).crewflowTransactionScope).toMatchObject({ dispatchNotify: true });
    // The plain session connections keep the startup option (boot gate 1c reads it there).
    expect(pgClientConfig(r, { endpoint: 'primary', purpose: 'probe' }).options).toContain('-c crewflow.dispatch_notify=on');
  });
});

describe('I-4: a session-role option never rides on a transaction-scoped endpoint', () => {
  it('the factory refuses it at config time', () => {
    const r = resolvePgEnvironment(PROD, { processRole: 'api' });
    const target = parsePgUrl(`postgres://crewflow_owner:${PW}@localhost:5432/rab?options=-c%20role%3Dcrewflow`, 'PG_DATABASE_URL', { allowSessionRole: true });
    const forged: ResolvedPgEnvironment = { ...r, pooled: { ...r.pooled!, target, ssl: false } };
    expect(() => createPgClient(forged, { endpoint: 'runtime', purpose: 'runtime' })).toThrow(/session role option/);
  });
});

describe('M-1: the TLS gate for the pooled hop', () => {
  it('production refuses a non-TLS backend (pg_stat_ssl false or no row); outside production, or with TLS, it passes', () => {
    expect(() => assertPooledHopTls(false, true)).toThrow(RuntimeDbError);
    expect(() => assertPooledHopTls(null, true)).toThrow(/pooler->PostgreSQL hop/);
    expect(() => assertPooledHopTls(true, true)).not.toThrow();
    expect(() => assertPooledHopTls(false, false)).not.toThrow();
  });
});

describe('L-3: the boot gates check the deployment marker against the host they actually connect to', () => {
  it('primary is the session URL when set; runtime the pooler; lock the session URL', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL }, { processRole: 'api' });
    expect(boundEndpointTarget(r, 'primary')?.target.host).toBe('db.example.com');
    expect(boundEndpointTarget(r, 'runtime')?.target.host).toBe('pool.example.com');
    expect(boundEndpointTarget(r, 'lock')?.target.host).toBe('db.example.com');
    expect(boundEndpointTarget(r, 'elevated')).toBeNull();
    const plain = resolvePgEnvironment({ PG_DATABASE_URL: PROD_URL }, { processRole: 'api' });
    expect(boundEndpointTarget(plain, 'primary')).toBe(plain.primary);
  });
});

describe('I-7: a production PG_DATABASE_SESSION_URL never comes from a .env file', () => {
  it('the runtime guard refuses it, value-free', () => {
    const env = { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL };
    let message = '';
    try {
      resolveRuntimeDatabase({ processName: 'api', env, dotenvValues: { PG_DATABASE_SESSION_URL: PROD_URL } });
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeDbError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/present in a \.env file/);
    expect(message).not.toContain(PW);
  });
});

describe('L-2: db-setup / db-harden refuse PG_DATABASE_SESSION_URL until #259; one target rule with the compose lint', () => {
  const ADMIN = `postgresql://doadmin:${PW}@db.example.com:5432/rab?sslmode=verify-full`;
  const refusal = (env: Record<string, string>): string => {
    try {
      selectDbSetupInput(env);
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerCredentialError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('a valid pooler + session (+ admin naming the session database) is refused with the fixed not-yet message', () => {
    expect(refusal({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL })).toBe(DB_SETUP_INPUT_MESSAGES.sessionUrlNotYetSupported);
    expect(refusal({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL, PG_ADMIN_URL: ADMIN })).toBe(DB_SETUP_INPUT_MESSAGES.sessionUrlNotYetSupported);
    expect(DB_SETUP_INPUT_MESSAGES.sessionUrlNotYetSupported).not.toContain(PW);
  });

  it('the target rule runs first: admin vs the SESSION database, session vs PG_DATABASE_URL database name, session login', () => {
    expect(refusal({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL, PG_ADMIN_URL: ADMIN.replace('db.example.com', 'other.example.com') })).toBe(
      DB_SETUP_INPUT_MESSAGES.sessionTargetMismatch,
    );
    expect(refusal({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: PROD_URL.replace('/rab?', '/other?') })).toBe(DB_SETUP_INPUT_MESSAGES.sessionTargetMismatch);
    expect(refusal({ PG_DATABASE_URL: POOLER, PG_DATABASE_SESSION_URL: ADMIN })).toBe(DB_SETUP_INPUT_MESSAGES.sessionUrlNotOwner);
    // Without a session URL the rule is unchanged: the admin URL names PG_DATABASE_URL's database.
    expect(refusal({ PG_DATABASE_URL: PROD_URL, PG_ADMIN_URL: ADMIN.replace('db.example.com', 'other.example.com') })).toBe(DB_SETUP_INPUT_MESSAGES.targetMismatch);
    expect(() => selectDbSetupInput({ PG_DATABASE_URL: PROD_URL, PG_ADMIN_URL: ADMIN })).not.toThrow();
  });

  it('dbSetupTargetProblem is the pure form of the rule', () => {
    const t = (u: string) => parsePgUrl(u, 'X');
    expect(dbSetupTargetProblem(t(ADMIN), t(POOLER), t(PROD_URL))).toBeNull();
    expect(dbSetupTargetProblem(t(ADMIN), t(PROD_URL), null)).toBeNull();
    expect(dbSetupTargetProblem(t(ADMIN), t(POOLER), null)).toBe(DB_SETUP_INPUT_MESSAGES.targetMismatch);
  });
});

describe('I-5: the login health probe covers the pooled endpoint too', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('with PG_DATABASE_SESSION_URL the factory returns a combined probe (session + runtime); without, one plain client', async () => {
    const { createDatabaseLoginProbeClient } = await import('../../../engine/core-modules/health/database-login.health');
    process.env.PG_DATABASE_URL = `postgres://crewflow_owner:${PW}@localhost:6432/rab`;
    process.env.PG_DATABASE_SESSION_URL = `postgres://crewflow_owner:${PW}@localhost:5432/rab`;
    const combined = createDatabaseLoginProbeClient();
    expect(combined).not.toBeInstanceOf(Client);
    delete process.env.PG_DATABASE_SESSION_URL;
    expect(createDatabaseLoginProbeClient()).toBeInstanceOf(Client);
  });
});
