import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { resolveInviteAutoDeleteEnabled, runAccountInviteCleanupCycle } from '../../queues/rab-maintenance/account-invite-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * D-1 (Twenty Mode M0, HIGH; docs/TWENTY_MODE_M0_DECISION_2026-11-04.md §6.1): WORKER_INVITE_AUTO_DELETE_ENABLED=false
 * (the default) must change NOTHING, whatever database login the Worker runs as.
 *
 * Before the fix the OFF path ran the pre-Phase-D direct SQL (expire UPDATE + DELETE FROM core."user") and relied on the
 * runtime login being crewflow_app, which sees no row of the NOT-FORCE core."user" / core.account_invite without tenant
 * context. On an OWNER-MEMBER login — a member of rab_secure_owner (the owner of both tables, so RLS does not apply) and of
 * crewflow, exactly Twenty Mode's crewflow_owner (M0 §3.1) — the same OFF cycle expired invites and deleted accounts in
 * every organisation. The superuser is the extreme form of the same thing.
 *
 * Proven here on real PostgreSQL, with two organisations and every invite state (awaiting, expired, cancelled, past the
 * grace period, with a live session, with a business reference):
 *  1. OFF as an owner-member login: zero changes (failed before the fix: invites expired, accounts deleted).
 *  2. OFF as the superuser: zero changes (failed before the fix).
 *  3. OFF as crewflow_app: zero changes (passed before the fix only because RLS hid every row).
 *  4. Worker restart: a fresh connection + the startup flag resolution (unset ⇒ OFF), ticked again: zero changes.
 *  5. Permission checks: OFF needs no privilege at all (a CONNECT-only login completes with zero statements); the same
 *     login with ON is refused by PostgreSQL and changes nothing; the owner-member login really COULD execute the cleanup
 *     definers and read every tenant's invited users (so 1 is a real test, not a no-op by lack of privilege).
 *  6. ON as the owner-member login (non-production only): the business conditions still decide — eligible accounts are
 *     expired / deleted, while awaiting, cancelled, session-holding and business-referenced accounts are kept.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

type Fixture = Record<'awaiting' | 'expired' | 'cancelled' | 'graceOver' | 'withSession' | 'withBusinessRef', string>;

describeIfDb('D-1: account-invite cleanup with auto-delete OFF changes nothing, on any login (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let runtimeApp: DataSource; // crewflow_app — the separated-mode runtime login
  let admin: DataSource; // the test cluster superuser (fixtures only, and case 2)
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  const fixtures: Array<{ owner: TestIdentity; ids: Fixture }> = [];
  const opened: DataSource[] = [];

  const suffix = randomBytes(4).toString('hex');
  const ownerMemberRole = `d1_owner_member_${suffix}`;
  const ownerMemberPassword = randomBytes(18).toString('hex');
  const noAccessRole = `d1_no_access_${suffix}`;
  const noAccessPassword = randomBytes(18).toString('hex');

  async function openAs(role: string, password: string): Promise<DataSource> {
    const ds = new DataSource({
      type: 'postgres',
      url: withUser(process.env.TEST_DATABASE_URL!, role, password),
      entities: [],
      synchronize: false,
      extra: { max: 2, application_name: `d1-${role}` },
    });
    await ds.initialize();
    opened.push(ds);
    return ds;
  }

  async function seedInvite(
    organisationId: string,
    opts: { status: 'invited' | 'invite_expired'; expires: string; cleanup: string | null; revoked?: boolean },
  ): Promise<string> {
    const [{ id }] = await admin.query<[{ id: string }]>(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'D1', 'Candidate', $3) RETURNING id`,
      [organisationId, `d1-${randomUUID()}@example.test`, opts.status],
    );
    await admin.query(
      `INSERT INTO core.account_invite (organisation_id, user_id, send_number, token_hash, expires_at, cleanup_at, revoked_at)
       VALUES ($1, $2, 3, $3, now() + $4::interval, now() + $5::interval, ${opts.revoked ? 'now()' : 'NULL'})`,
      [organisationId, id, randomUUID(), opts.expires, opts.cleanup],
    );
    return id;
  }

  async function seedOrganisation(label: string): Promise<{ owner: TestIdentity; ids: Fixture }> {
    const owner = await factory.createInternalManager(await factory.createOrganisation(label), { label: `${label}-owner` });
    const org = owner.organisationId;
    const ids: Fixture = {
      awaiting: await seedInvite(org, { status: 'invited', expires: '1 day', cleanup: '8 days' }),
      expired: await seedInvite(org, { status: 'invited', expires: '-1 minute', cleanup: '7 days' }),
      cancelled: await seedInvite(org, { status: 'invited', expires: '-1 minute', cleanup: '7 days', revoked: true }),
      graceOver: await seedInvite(org, { status: 'invite_expired', expires: '-8 days', cleanup: '-1 minute' }),
      withSession: await seedInvite(org, { status: 'invite_expired', expires: '-8 days', cleanup: '-1 minute' }),
      withBusinessRef: await seedInvite(org, { status: 'invite_expired', expires: '-8 days', cleanup: '-1 minute' }),
    };
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, family_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '30 days')`,
      [org, ids.withSession, randomBytes(32).toString('hex'), randomUUID()],
    );
    await tenantContext.runInTenantContext({ organisationId: org, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, (m) =>
      m.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'D1 Venue', $3)`, [org, owner.workspaceId, ids.withBusinessRef]),
    );
    return { owner, ids };
  }

  const allIds = () => fixtures.flatMap((f) => Object.values(f.ids));

  /** Everything the cleanup could change, read by the superuser: per-fixture rows, plus cross-tenant totals. */
  async function snapshot(): Promise<unknown> {
    const ids = allIds();
    const users = await admin.query(`SELECT id, status FROM core."user" WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    const invites = await admin.query(
      `SELECT user_id, send_number, expires_at, cleanup_at, revoked_at, accepted_at FROM core.account_invite WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
      [ids],
    );
    const sessions = await admin.query(`SELECT user_id, revoked_at FROM core.refresh_token WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`, [ids]);
    const venues = await admin.query(`SELECT created_by FROM core.venue WHERE created_by = ANY($1::uuid[]) ORDER BY created_by`, [ids]);
    const fixtureAudit = await admin.query(
      `SELECT count(*)::int AS n FROM core.audit_log WHERE target_user_id = ANY($1::uuid[]) OR metadata->>'deletedUserId' = ANY($1::text[])`,
      [ids],
    );
    // Cross-tenant: other suites' debris in this shared database must not move either.
    const usersByStatus = await admin.query(`SELECT status, count(*)::int AS n FROM core."user" GROUP BY status ORDER BY status`);
    const [totals] = await admin.query(
      `SELECT (SELECT count(*)::int FROM core."user") AS users,
              (SELECT count(*)::int FROM core.account_invite) AS invites,
              (SELECT count(*)::int FROM core.audit_log WHERE action LIKE 'user.invite%') AS invite_audits`,
    );
    return { users, invites, sessions, venues, fixtureAudit, usersByStatus, totals };
  }

  const ZERO = { expired: 0, deleted: 0, retained: 0 };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtimeApp = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = createTestIdentityFactory({ app, dataSource: runtimeApp, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });

    const database = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
    // Twenty Mode's crewflow_owner shape (M0 §3.1): INHERIT + SET on rab_secure_owner and crewflow, nothing else.
    await admin.query(`CREATE ROLE ${ownerMemberRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${ownerMemberPassword}'`);
    await admin.query(`GRANT rab_secure_owner TO ${ownerMemberRole} WITH INHERIT TRUE, SET TRUE`);
    await admin.query(`GRANT crewflow TO ${ownerMemberRole} WITH INHERIT TRUE, SET TRUE`);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${ownerMemberRole}`);
    // A login that can connect and nothing else.
    await admin.query(`CREATE ROLE ${noAccessRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${noAccessPassword}'`);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${noAccessRole}`);

    fixtures.push(await seedOrganisation('d1a'), await seedOrganisation('d1b'));
  });

  afterAll(async () => {
    for (const ds of opened) if (ds.isInitialized) await ds.destroy().catch(() => undefined);
    if (admin?.isInitialized) {
      for (const role of [ownerMemberRole, noAccessRole]) {
        await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      await admin.destroy();
    }
    await app?.close();
  });

  // M-class (owner-login architecture, M-T1 1786721400000): core."user" and core.account_invite are FORCE now, so an
  // owner-member login no longer reads every tenant DIRECTLY (a control that now holds, asserted below). What still reaches
  // every tenant is the cleanup definers, which run as rab_secure_owner: that is what keeps the OFF tests non-vacuous.
  it('5a. the owner-member login can execute the cleanup definers, which reach every tenant (so the OFF tests below are not vacuous)', async () => {
    const ownerMember = await openAs(ownerMemberRole, ownerMemberPassword);
    const [{ who, usable }] = await ownerMember.query<[{ who: string; usable: boolean }]>(
      `SELECT current_user AS who, bool_and(has_function_privilege(f, 'EXECUTE')) AS usable
         FROM unnest(ARRAY['core.worker_expire_account_invites(integer)',
                           'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)',
                           'core.worker_delete_expired_invited_user(uuid)']::regprocedure[]) AS f`,
    );
    expect(who).toBe(ownerMemberRole);
    expect(usable).toBe(true);
    // M-T1 control (holds on normal paths): with no tenant context the owner-member login sees NONE of them directly.
    const direct = await ownerMember.query(`SELECT 1 FROM core."user" WHERE id = ANY($1::uuid[])`, [allIds()]);
    expect(direct).toHaveLength(0);
    // Non-vacuity: as rab_secure_owner (the definers' owner and security context) both organisations' invited users are
    // visible, so a cleanup cycle that called the definers WOULD reach every tenant. Read in a rolled-back transaction.
    const runner = ownerMember.createQueryRunner();
    await runner.connect();
    let visible: Array<{ organisation_id: string }> = [];
    try {
      await runner.query('BEGIN');
      await runner.query(`SELECT set_config('role', 'rab_secure_owner', true)`);
      visible = await runner.query(`SELECT DISTINCT organisation_id FROM core."user" WHERE id = ANY($1::uuid[])`, [allIds()]);
    } finally {
      await runner.query('ROLLBACK').catch(() => undefined);
      await runner.release();
    }
    expect(visible.map((r) => r.organisation_id).sort()).toEqual(fixtures.map((f) => f.owner.organisationId).sort());
    // The runtime login (crewflow_owner since the owner-login architecture, BC-02) with no tenant context sees none of them.
    const appVisible = await runtimeApp.query(`SELECT 1 FROM core."user" WHERE id = ANY($1::uuid[])`, [allIds()]);
    expect(appVisible).toHaveLength(0);
  });

  it('1. OFF as an owner-member login (Twenty Mode crewflow_owner shape): zero changes across both organisations', async () => {
    const ownerMember = await openAs(ownerMemberRole, ownerMemberPassword);
    const before = await snapshot();
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await runAccountInviteCleanupCycle(ownerMember, { autoDeleteEnabled: false })).toEqual(ZERO);
    }
    expect(await runAccountInviteCleanupCycle(ownerMember)).toEqual(ZERO); // no option = OFF
    expect(await snapshot()).toEqual(before);
  });

  it('2. OFF as the superuser: zero changes', async () => {
    const before = await snapshot();
    expect(await runAccountInviteCleanupCycle(admin, { autoDeleteEnabled: false })).toEqual(ZERO);
    expect(await runAccountInviteCleanupCycle(admin)).toEqual(ZERO);
    expect(await snapshot()).toEqual(before);
  });

  // BC-02 (owner-login architecture): the runtime login is crewflow_owner now (crewflow_app is a schema role); OFF still
  // changes nothing on it.
  it('3. OFF as the runtime login (crewflow_owner): zero changes', async () => {
    const [{ who }] = await runtimeApp.query<[{ who: string }]>('SELECT current_user AS who');
    expect(who).toBe('crewflow_owner');
    const before = await snapshot();
    expect(await runAccountInviteCleanupCycle(runtimeApp, { autoDeleteEnabled: false })).toEqual(ZERO);
    expect(await runAccountInviteCleanupCycle(runtimeApp)).toEqual(ZERO);
    expect(await snapshot()).toEqual(before);
  });

  it('4. Worker restart: a new connection and the startup flag resolution (unset ⇒ OFF) still change nothing', async () => {
    const before = await snapshot();
    for (let restart = 0; restart < 2; restart += 1) {
      const ds = await openAs(ownerMemberRole, ownerMemberPassword);
      const autoDeleteEnabled = resolveInviteAutoDeleteEnabled({ get: (key: string) => (key === 'NODE_ENV' ? 'production' : undefined) });
      expect(autoDeleteEnabled).toBe(false);
      expect(await runAccountInviteCleanupCycle(ds, { autoDeleteEnabled })).toEqual(ZERO);
      await ds.destroy();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('5b. OFF needs no privilege at all; the same CONNECT-only login with ON is refused by PostgreSQL and changes nothing', async () => {
    const noAccess = await openAs(noAccessRole, noAccessPassword);
    const before = await snapshot();
    expect(await runAccountInviteCleanupCycle(noAccess, { autoDeleteEnabled: false })).toEqual(ZERO);
    await expect(runAccountInviteCleanupCycle(noAccess, { autoDeleteEnabled: true })).rejects.toThrow(/permission denied/);
    expect(await snapshot()).toEqual(before);
  });

  it('6. ON as the owner-member login: the business conditions decide (eligible ones go; awaiting, cancelled, session and business-referenced accounts stay)', async () => {
    const ownerMember = await openAs(ownerMemberRole, ownerMemberPassword);
    const status = async (id: string) => (await admin.query<Array<{ status: string }>>(`SELECT status FROM core."user" WHERE id = $1`, [id]))[0]?.status ?? null;
    const skipReason = async (id: string) =>
      (await admin.query<Array<{ reason: string }>>(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'user.invite_cleanup_skipped' AND target_user_id = $1 LIMIT 1`, [id]))[0]
        ?.reason ?? null;
    // Repeated ticks, as production runs it: other suites' debris in this shared database may sort first in the bounded pages.
    const done = async () => {
      for (const { ids } of fixtures) {
        if ((await status(ids.expired)) !== 'invite_expired') return false;
        if ((await status(ids.graceOver)) !== null) return false;
        if (!(await skipReason(ids.withSession)) || !(await skipReason(ids.withBusinessRef))) return false;
      }
      return true;
    };
    for (let tick = 0; tick < 20 && !(await done()); tick += 1) {
      await runAccountInviteCleanupCycle(ownerMember, { autoDeleteEnabled: true });
    }
    for (const { ids } of fixtures) {
      expect(await status(ids.expired)).toBe('invite_expired');
      expect(await status(ids.graceOver)).toBeNull();
      expect(await status(ids.awaiting)).toBe('invited');
      expect(await status(ids.cancelled)).toBe('invited');
      expect(await status(ids.withSession)).toBe('invite_expired');
      expect(await skipReason(ids.withSession)).toBe('had_session');
      expect(await status(ids.withBusinessRef)).toBe('invite_expired');
      expect(await skipReason(ids.withBusinessRef)).toBe('venue');
    }
  });
});
