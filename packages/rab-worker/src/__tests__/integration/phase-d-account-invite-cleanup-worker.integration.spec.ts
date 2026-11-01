import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { runAccountInviteCleanupCycle } from '../../queues/rab-maintenance/account-invite-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase D F-1 (owner condition D8) — the account-invite cleanup cycle on the RUNTIME data source (never the admin one,
 * unlike `account-invite-cleanup.integration.spec.ts`, which is why that suite never saw the no-op).
 *
 * OPT-IN: needs migration 1786721340000 (AccountInviteCleanupDefiner; owner-approved 2026-11-01, applied on disposable
 * test databases only) and the operator-created `crewflow_worker` login. Skipped unless PHASE_D_SQL_APPROVED=true and
 * TEST_DATABASE_WORKER_URL (crewflow_worker on the test database) are set.
 *
 *  1. crewflow_worker runtime: an invited user whose 3rd invite expired becomes `invite_expired` (+ audit) — fails on
 *     today's code (0 rows visible), passes with the definer path.
 *  2. crewflow_worker runtime: an `invite_expired` user past its grace period with no history is deleted (+ audit).
 *  3. crewflow_worker runtime: one that created a shift in its workspace is RETAINED (`shift`), checked by the Worker
 *     under that workspace's tenant context.
 *  4. crewflow_app runtime (an old / per_scope Worker): the definers are not executable → today's path, still a no-op
 *     (documents why the cutover needs crewflow_worker; nothing is changed or deleted).
 *  5. Phase D wave 2 retention gate — WORKER_INVITE_AUTO_DELETE_ENABLED=false (the DEFAULT) on crewflow_worker WITH the
 *     definers present and executable: nothing is expired, nothing is deleted, no audit row is written (the pre-Phase-D
 *     path, which as the runtime login sees no row). Cases 1–3 run with the flag explicitly ON (non-production only).
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL && process.env.DATABASE_URL);
const describeIfApproved = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfApproved('Phase D F-1 account-invite cleanup on the runtime data source (integration — opt-in)', () => {
  let app: import('@nestjs/common').INestApplication;
  let runtimeApp: DataSource;
  let admin: DataSource;
  let worker: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let owner: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtimeApp = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = createTestIdentityFactory({ app, dataSource: runtimeApp, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    worker = new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 2, application_name: 'crewflow-worker-it' } });
    await worker.initialize();
    const [{ current_user: who }] = await worker.query<[{ current_user: string }]>('SELECT current_user');
    expect(who).toBe('crewflow_worker');
    owner = await factory.createInternalManager(await factory.createOrganisation('f1'), { label: 'f1-owner' });
  });

  afterAll(async () => {
    await worker?.destroy();
    await app?.close();
    await admin?.destroy();
  });

  /** An invited user with a 3rd (final) invite, seeded through the admin connection (fixtures only). */
  async function seedInvited(opts: { status: 'invited' | 'invite_expired'; expiresAgo: string; cleanupAgo: string | null }): Promise<string> {
    const [{ id }] = await admin.query<[{ id: string }]>(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'F1', 'Candidate', $3) RETURNING id`,
      [owner.organisationId, `f1-${randomUUID()}@example.test`, opts.status],
    );
    await admin.query(
      `INSERT INTO core.account_invite (organisation_id, user_id, send_number, token_hash, expires_at, cleanup_at)
       VALUES ($1, $2, 3, $3, now() - $4::interval, ${opts.cleanupAgo === null ? 'NULL' : 'now() - $5::interval'})`,
      opts.cleanupAgo === null ? [owner.organisationId, id, randomUUID(), opts.expiresAgo] : [owner.organisationId, id, randomUUID(), opts.expiresAgo, opts.cleanupAgo],
    );
    return id;
  }

  const status = async (id: string) => (await admin.query<Array<{ status: string }>>(`SELECT status FROM core."user" WHERE id = $1`, [id]))[0]?.status ?? null;
  const audited = async (action: string, target: string | null, deletedUserId?: string) =>
    (
      await admin.query(
        `SELECT 1 FROM core.audit_log WHERE action = $1 AND organisation_id = $2 AND (target_user_id = $3 OR metadata->>'deletedUserId' = $4) LIMIT 1`,
        [action, owner.organisationId, target, deletedUserId ?? null],
      )
    ).length > 0;

  /** Repeated ticks, as production runs it (other suites' debris may sort first in the bounded pages). */
  const ON = { autoDeleteEnabled: true } as const;
  const OFF = { autoDeleteEnabled: false } as const;
  async function tickUntil(dataSource: DataSource, done: () => Promise<boolean>, max = 20): Promise<void> {
    for (let i = 0; i < max && !(await done()); i += 1) await runAccountInviteCleanupCycle(dataSource, ON);
  }

  it('1. crewflow_worker: a final invite past expires_at moves the user to invite_expired, audited', async () => {
    const id = await seedInvited({ status: 'invited', expiresAgo: '1 minute', cleanupAgo: null });
    await tickUntil(worker, async () => (await status(id)) === 'invite_expired');
    expect(await status(id)).toBe('invite_expired');
    expect(await audited('user.invite_expired', id)).toBe(true);
  });

  it('2. crewflow_worker: past the grace period with no history → deleted through the definer, audited', async () => {
    const id = await seedInvited({ status: 'invite_expired', expiresAgo: '8 days', cleanupAgo: '1 minute' });
    await tickUntil(worker, async () => (await status(id)) === null);
    expect(await status(id)).toBeNull();
    expect(await audited('user.invite_cleaned_up', null, id)).toBe(true);
  });

  it('3. crewflow_worker: a shift created by the user in its workspace retains it (Worker-side check under tenant context)', async () => {
    const id = await seedInvited({ status: 'invite_expired', expiresAgo: '8 days', cleanupAgo: '1 minute' });
    await tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (m) => {
      const [{ id: venueId }] = await m.query<[{ id: string }]>(
        `INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'F1 Venue', $3) RETURNING id`,
        [owner.organisationId, owner.workspaceId, owner.userId],
      );
      const [{ id: jobRoleId }] = await m.query<[{ id: string }]>(
        `INSERT INTO core.job_role (organisation_id, workspace_id, name, default_rate_pence, created_by) VALUES ($1, $2, 'F1 Role', 1500, $3) RETURNING id`,
        [owner.organisationId, owner.workspaceId, owner.userId],
      );
      await m.query(
        `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 8 hours', 0, 1, 1500, 'draft', $5)`,
        [owner.organisationId, owner.workspaceId, venueId, jobRoleId, id],
      );
    });
    const skipped = async () =>
      (await admin.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'user.invite_cleanup_skipped' AND target_user_id = $1 LIMIT 1`, [id]))[0]?.reason;
    await tickUntil(worker, async () => Boolean(await skipped()));
    expect(await skipped()).toBe('shift');
    expect(await status(id)).toBe('invite_expired');
  });

  it('4. crewflow_app (old / per_scope Worker): the definers are not executable → today\'s path, which still sees nothing', async () => {
    const [{ usable }] = await runtimeApp.query<[{ usable: boolean }]>(
      `SELECT has_function_privilege('core.worker_expire_account_invites(integer)', 'EXECUTE') AS usable`,
    );
    expect(usable).toBe(false);
    const id = await seedInvited({ status: 'invited', expiresAgo: '1 minute', cleanupAgo: null });
    const result = await runAccountInviteCleanupCycle(runtimeApp, ON); // even with the flag ON: no EXECUTE → legacy path
    expect(result).toEqual({ expired: 0, deleted: 0, retained: 0 });
    expect(await status(id)).toBe('invited');
  });

  it('5. retention gate OFF (default) on crewflow_worker with the definers executable: no expiry, no deletion, no audit', async () => {
    const [{ usable }] = await worker.query<[{ usable: boolean }]>(
      `SELECT bool_and(has_function_privilege(f, 'EXECUTE')) AS usable
         FROM unnest(ARRAY['core.worker_expire_account_invites(integer)',
                           'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)',
                           'core.worker_delete_expired_invited_user(uuid)']::regprocedure[]) AS f`,
    );
    expect(usable).toBe(true); // the definers ARE there and executable — only the flag keeps them unused
    const toExpire = await seedInvited({ status: 'invited', expiresAgo: '1 minute', cleanupAgo: null });
    const toDelete = await seedInvited({ status: 'invite_expired', expiresAgo: '8 days', cleanupAgo: '1 minute' });
    const auditsBefore = await admin.query<[{ n: string }]>(
      `SELECT count(*)::text AS n FROM core.audit_log WHERE target_user_id = ANY($1::uuid[]) OR metadata->>'deletedUserId' = ANY($1::text[])`,
      [[toExpire, toDelete]],
    );
    for (let i = 0; i < 5; i += 1) {
      expect(await runAccountInviteCleanupCycle(worker, OFF)).toEqual({ expired: 0, deleted: 0, retained: 0 });
    }
    expect(await runAccountInviteCleanupCycle(worker)).toEqual({ expired: 0, deleted: 0, retained: 0 }); // no option = OFF
    expect(await status(toExpire)).toBe('invited');
    expect(await status(toDelete)).toBe('invite_expired'); // still there: no automatic account deletion
    const auditsAfter = await admin.query<[{ n: string }]>(
      `SELECT count(*)::text AS n FROM core.audit_log WHERE target_user_id = ANY($1::uuid[]) OR metadata->>'deletedUserId' = ANY($1::text[])`,
      [[toExpire, toDelete]],
    );
    expect(auditsAfter[0].n).toBe(auditsBefore[0].n);
  });
});
