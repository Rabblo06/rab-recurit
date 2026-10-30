/**
 * Phase B ops container: the VERIFIED elevated session on a real disposable PostgreSQL 16 database. Opt-in: needs
 * OPS_TEST_MIGRATOR_URL = the migration identity (crewflow_migrator, created on the DISPOSABLE cluster by
 * scripts/setup/migrator-role.ts) on the same database as TEST_DATABASE_URL (crewflow_app). Skipped otherwise.
 *
 * Proves, live: the positive shape (migration identity → SET LOCAL ROLE rab_secure_owner, READ ONLY, narrowed — no crewflow
 * privileges — and the cross-tenant owner read the containment/user-session scans rely on), and the refusals: wrong
 * session_user, missing SET membership (PG16 `SET FALSE`), an unnarrowed / wrongly narrowed / read-write session, a
 * statement name outside the plan, a write transaction on a read-only plan, and an app session that is not crewflow_app.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import {
  assertOpsActingFacts,
  ElevatedOpsSession,
  ElevatedOpsSessionError,
  ElevatedTransactionRecord,
  OPS_SESSION_FACTS_SQL,
  parseOpsSessionFacts,
  verifyOpsAppSession,
} from '../../command/ops/elevated-ops-session';
import { OPS_ELEVATED_PLANS, OpsStatementName } from '../../command/ops/ops-statements';
import { createPgDataSource, resolvePgEnvironment, ResolvedPgEnvironment, setPgProcessRole } from '../../database/postgres';

const MIGRATOR_URL = process.env.OPS_TEST_MIGRATOR_URL?.trim();
const RUN = Boolean(process.env.DATABASE_URL) && Boolean(MIGRATOR_URL);
jest.setTimeout(60_000);

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

(RUN ? describe : describe.skip)('ops container: verified elevated session (disposable database)', () => {
  const appUrl = process.env.TEST_DATABASE_URL!;
  const adminUrl = process.env.TEST_DATABASE_URL_UNPOOLED!;
  const noSetRole = `ops_test_noset_${randomBytes(4).toString('hex')}`;
  const noSetPassword = randomBytes(18).toString('hex');
  let admin: Client;
  const opened: Array<{ destroy(): Promise<void> }> = [];

  function opsEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
    return { CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: appUrl, PG_DATABASE_URL: MIGRATOR_URL, DB_TARGET: 'test', ...overrides };
  }

  async function appSession(resolved: ResolvedPgEnvironment, env: Record<string, string | undefined>) {
    const ds = createPgDataSource(resolved, { purpose: 'runtime', max: 1 }, { name: `ops-app-${randomBytes(4).toString('hex')}`, entities: [] });
    await ds.initialize();
    opened.push({ destroy: () => ds.destroy() });
    return { ds, proof: await verifyOpsAppSession(ds, resolved, env, 'test') };
  }

  async function open(env: Record<string, string | undefined>, plan = OPS_ELEVATED_PLANS.containment, records: ElevatedTransactionRecord[] = []) {
    const resolved = resolvePgEnvironment(env, { processRole: 'ops' });
    const { proof } = await appSession(resolved, env);
    const session = await ElevatedOpsSession.open({ plan, resolved, env, app: proof, onVerified: (r) => records.push(r) });
    opened.push(session);
    return session;
  }

  beforeAll(async () => {
    setPgProcessRole('ops');
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    // A login with the migration identity's memberships, but rab_secure_owner WITHOUT the SET option (PG16).
    await admin.query(`CREATE ROLE ${noSetRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${noSetPassword}'`);
    await admin.query(`GRANT rab_secure_owner TO ${noSetRole} WITH INHERIT TRUE, SET FALSE`);
    await admin.query(`GRANT crewflow TO ${noSetRole} WITH INHERIT TRUE, SET TRUE`);
    await admin.query(`GRANT CONNECT ON DATABASE "${new URL(appUrl).pathname.slice(1)}" TO ${noSetRole}`).catch(() => undefined);
  });

  afterAll(async () => {
    for (const s of opened.reverse()) await s.destroy().catch(() => undefined);
    await admin.query(`DROP OWNED BY ${noSetRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${noSetRole}`).catch(() => undefined);
    await admin.end();
    setPgProcessRole('api');
  });

  it('positive: migration identity narrowed to rab_secure_owner, READ ONLY, sees every tenant (owner of a NOT-FORCE table)', async () => {
    const records: ElevatedTransactionRecord[] = [];
    const session = await open(opsEnv(), OPS_ELEVATED_PLANS.containment, records);
    const orgs = await session.transaction('read-only', (run) => run('containment.test-pattern-organisations', ['.*']));
    const [{ n }] = (await admin.query(`SELECT count(*)::int AS n FROM core.organisation`)).rows;
    expect(orgs.length).toBe(n); // every organisation, no tenant context bound
    expect(records).toEqual([expect.objectContaining({ access: 'read-only', login: 'crewflow_migrator', acting: 'rab_secure_owner' })]);
    // The restricted runtime login with no tenant context sees zero rows of the same table (fail closed).
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      expect((await app.query(`SELECT count(*)::int AS n FROM core.organisation`)).rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('live facts: after SET LOCAL ROLE rab_secure_owner the session holds no crewflow privilege; unnarrowed / wrong role / read-write refuse', async () => {
    const raw = new Client({ connectionString: MIGRATOR_URL });
    await raw.connect();
    const expect_ = { expectedLogin: 'crewflow_migrator', expectedDatabase: new URL(appUrl).pathname.slice(1), role: 'rab_secure_owner' as const, readOnly: true };
    const facts = async () => parseOpsSessionFacts((await raw.query(OPS_SESSION_FACTS_SQL, ['rab_secure_owner'])).rows[0]);
    try {
      await raw.query('BEGIN READ ONLY');
      const before = await facts();
      expect(before).toMatchObject({ login: 'crewflow_migrator', acting: 'crewflow_migrator', canSetRole: true, actingHasCrewflow: true, loginExempt: false });
      expect(() => assertOpsActingFacts(before, expect_)).toThrow(/unnarrowed or wrong role/);
      await raw.query('SET LOCAL ROLE crewflow');
      const asCrewflow = await facts();
      expect(() => assertOpsActingFacts(asCrewflow, expect_)).toThrow(/current_user is "crewflow"/);
      await raw.query('ROLLBACK');

      await raw.query('BEGIN READ ONLY');
      await raw.query('SET LOCAL ROLE rab_secure_owner');
      const narrowed = await facts();
      expect(narrowed).toMatchObject({ acting: 'rab_secure_owner', actingHasCrewflow: false, actingExempt: false, readOnly: true });
      expect(() => assertOpsActingFacts(narrowed, expect_)).not.toThrow();
      // READ ONLY is a real boundary: a write is refused by PostgreSQL itself.
      await expect(raw.query(`UPDATE core.organisation SET name = name WHERE false`)).rejects.toThrow(/read-only transaction/);
      await raw.query('ROLLBACK');

      await raw.query('BEGIN');
      await raw.query('SET LOCAL ROLE rab_secure_owner');
      const readWrite = await facts();
      expect(readWrite.readOnly).toBe(false);
      expect(() => assertOpsActingFacts(readWrite, expect_)).toThrow(/requires READ ONLY/);
      await raw.query('ROLLBACK');
      // LOCAL: the role is gone after the transaction.
      expect((await raw.query('SELECT current_user::text AS u')).rows[0].u).toBe('crewflow_migrator');
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }
  });

  it('refuses a statement name outside the plan, and a READ WRITE transaction on a read-only plan', async () => {
    const session = await open(opsEnv());
    await expect(session.transaction('read-only', (run) => run('user-session-backfill.candidates' as OpsStatementName, [1]))).rejects.toThrow(
      /not on the frozen read-only list of plan containment-read/,
    );
    await expect(session.transaction('read-write', async () => 1)).rejects.toThrow(/allows no read-write elevated transaction/);
  });

  it('refuses the wrong session_user (the crewflow owner login as PG_DATABASE_URL)', async () => {
    const crewflowUrl = process.env.TEST_DATABASE_CREWFLOW_URL;
    if (!crewflowUrl) return;
    const session = await open(opsEnv({ PG_DATABASE_URL: crewflowUrl }));
    await expect(session.transaction('read-only', (run) => run('containment.test-pattern-organisations', ['.*']))).rejects.toThrow(
      /must be the migration identity, not "crewflow"/,
    );
  });

  it('refuses a login whose rab_secure_owner membership lacks the SET option', async () => {
    const session = await open(opsEnv({ PG_DATABASE_URL: withUser(MIGRATOR_URL!, noSetRole, noSetPassword) }));
    await expect(session.transaction('read-only', (run) => run('containment.test-pattern-organisations', ['.*']))).rejects.toThrow(
      /may not SET ROLE rab_secure_owner \(PG16 membership without SET\)/,
    );
  });

  it('refuses an app session that is not crewflow_app', async () => {
    const env = opsEnv({ PG_OPS_APP_DATABASE_URL: process.env.TEST_DATABASE_CREWFLOW_URL ?? MIGRATOR_URL! });
    const resolved = resolvePgEnvironment(env, { processRole: 'ops' });
    await expect(appSession(resolved, env)).rejects.toThrow(/must be the restricted runtime login crewflow_app/);
  });

  it('the apply plan: READ WRITE elevated transaction is verified as read-write and still narrowed', async () => {
    const records: ElevatedTransactionRecord[] = [];
    const session = await open(opsEnv(), OPS_ELEVATED_PLANS['user-session-apply'], records);
    // Bind a non-existent identity and roll back by throwing: proves the write path opens, verifies and runs only plan names.
    await expect(
      session.transaction('read-write', async (run) => {
        await run('user-session-backfill.bind-family', ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']);
        await expect(run('containment.target-users', [[]])).rejects.toThrow(ElevatedOpsSessionError);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(records[0]).toMatchObject({ access: 'read-write', acting: 'rab_secure_owner' });
  });
});
