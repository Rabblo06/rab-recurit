import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { runTokenCleanupCycle } from '../../queues/rab-maintenance/token-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Twenty-style worker runtime cutover (see HYPER-WORKSPACE-PHASE3-FOUNDATION.md). The worker runs as rab_app. These tests check the
 * runtime identity, the narrow discovery and cleanup functions, the worker actor marker's workspace isolation, fail-closed contexts,
 * and that no transaction leaks worker context to the next user of a pooled connection.
 *
 * The runtime DataSource is the application's own (rab_app). The owner DataSource is used only to seed fixtures, never to exercise
 * the code under test.
 */
describe('worker runtime cutover (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let tenantContext: TenantContextService;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let orgA: Organisation;
  let orgB: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let staffA: TestIdentity;
  let staffB: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource,
      tenantContext,
      passwordHashing: app.get(PasswordHashingService),
    });

    orgA = await factory.createOrganisation('cutover-a');
    managerA = await factory.createInternalManager(orgA, { permissions: 'production', label: 'cutover-a-mgr' });
    staffA = await factory.createStaff(orgA, { owner: managerA, label: 'cutover-staff-a' });

    orgB = await factory.createOrganisation('cutover-b');
    managerB = await factory.createInternalManager(orgB, { permissions: 'production', label: 'cutover-b-mgr' });
    staffB = await factory.createStaff(orgB, { owner: managerB, label: 'cutover-staff-b' });
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  const workerCtx = (organisationId: string, workspaceId: string | null) => ({
    organisationId,
    workspaceId,
    userId: '',
    role: '',
    actorType: 'worker' as const,
  });

  describe('runtime identity', () => {
    it('the runtime DataSource authenticates as crewflow_app, not superuser, not BYPASSRLS, not an owner of core', async () => {
      const [row] = await runtime.query<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>(
        `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
      );
      // P1C.2: single application credential — see docs/P1-MASTER-EXECUTION-STATUS.md's P1C.2 entry.
      expect(row.current_user).toBe('crewflow_app');
      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
    });
  });

  describe('workspace discovery (core.worker_list_workspaces)', () => {
    it('returns trusted routing pointers only: workspace, organisation, status, schema version', async () => {
      const rows = await runtime.query<Array<Record<string, unknown>>>(`SELECT * FROM core.worker_list_workspaces(NULL, 5)`);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(['organisation_id', 'schema_version', 'status', 'workspace_id']);
    });

    it('is bounded: the page size is clamped to 100 even when a larger limit is requested', async () => {
      const rows = await runtime.query(`SELECT * FROM core.worker_list_workspaces(NULL, 100000)`);
      expect(rows.length).toBeLessThanOrEqual(100);
    });

    it('is keyset-paginated: the next page starts strictly after the last workspace id', async () => {
      const first = await runtime.query<Array<{ workspace_id: string }>>(`SELECT * FROM core.worker_list_workspaces(NULL, 2)`);
      const next = await runtime.query<Array<{ workspace_id: string }>>(`SELECT * FROM core.worker_list_workspaces($1::uuid, 2)`, [
        first[first.length - 1]!.workspace_id,
      ]);
      for (const row of next) expect(row.workspace_id > first[first.length - 1]!.workspace_id).toBe(true);
    });

    it('rejects an arbitrary schema name: the function accepts only a uuid cursor and an integer limit', async () => {
      await expect(runtime.query(`SELECT * FROM core.worker_list_workspaces('pg_catalog', 1)`)).rejects.toThrow();
      await expect(runtime.query(`SELECT * FROM core.worker_list_workspaces('workspace_00000000000000000000000000000000', 1)`)).rejects.toThrow();
    });

    it('lists the workspaces this test created (trusted DB record, not a payload)', async () => {
      // The shared validation database holds ~2,000 workspaces, so these two sort past the first page. Walk the keyset cursor until both
      // are found or the list ends. Bounded: the loop stops after 100 pages.
      const wanted = new Set([`${orgA.id}:${managerA.workspaceId}`, `${orgB.id}:${managerB.workspaceId}`]);
      const seen = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < 100 && [...wanted].some((pair) => !seen.has(pair)); page++) {
        const rows: Array<{ workspace_id: string; organisation_id: string }> = await runtime.query(
          `SELECT * FROM core.worker_list_workspaces($1::uuid, 100)`,
          [after],
        );
        if (!rows.length) break;
        for (const r of rows) seen.add(`${r.organisation_id}:${r.workspace_id}`);
        after = rows[rows.length - 1]!.workspace_id;
      }
      for (const pair of wanted) expect(seen).toContain(pair);
    });
  });

  describe('worker actor marker: workspace isolation for Staff rows', () => {
    it('Workspace A worker context sees Workspace A Staff', async () => {
      const ids = await tenantContext.runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.staff_profile`),
      );
      expect(ids.map((r) => r.id)).toContain(staffA.profileId);
    });

    it('Workspace A worker context cannot read Workspace B Staff', async () => {
      const rows = await tenantContext.runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.staff_profile WHERE id = $1`, [staffB.profileId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('a worker context with the wrong organisation sees zero Staff rows', async () => {
      const rows = await tenantContext.runInTenantContext(workerCtx(orgB.id, managerA.workspaceId!), (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.staff_profile`),
      );
      expect(rows).toHaveLength(0);
    });

    it('a worker context with no workspace bound fails closed: zero Staff rows', async () => {
      const rows = await tenantContext.runInTenantContext(workerCtx(orgA.id, null), (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.staff_profile`),
      );
      expect(rows).toHaveLength(0);
    });

    it('a human context (no actor marker) sees no Staff row it is not entitled to — the worker path does not widen it', async () => {
      const rows = await tenantContext.runInTenantContext(
        { organisationId: orgA.id, workspaceId: managerA.workspaceId!, userId: '', role: '' },
        (m) => m.query<Array<{ id: string }>>(`SELECT id FROM core.staff_profile`),
      );
      expect(rows).toHaveLength(0);
    });

    it('the worker marker does not leak into the next transaction on a pooled connection', async () => {
      await tenantContext.runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), async () => {
        /* worker work */
      });
      const [{ actor }] = await runtime.query<Array<{ actor: string | null }>>(`SELECT current_setting('rab.actor_type', true) AS actor`);
      expect(actor ?? '').toBe('');
    });

    it('an exception inside a worker context rolls back and leaves no worker marker behind', async () => {
      await expect(
        tenantContext.runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const [{ actor }] = await runtime.query<Array<{ actor: string | null }>>(`SELECT current_setting('rab.actor_type', true) AS actor`);
      expect(actor ?? '').toBe('');
    });
  });

  describe('worker actor marker: SELECT only on staff_profile', () => {
    it('a worker context cannot INSERT a staff_profile row, even into its own workspace (no worker write policy exists)', async () => {
      await expect(
        tenantContext.runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), (m) =>
          m.query(
            `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status)
             VALUES ($1, $2, $3, $2, $4, 'active')`,
            [orgA.id, managerA.userId, `cutover-${randomUUID().slice(0, 8)}`, managerA.workspaceId],
          ),
        ),
      ).rejects.toThrow();
    });

    it('a worker context cannot UPDATE or DELETE a Workspace A staff_profile row (count 0 or denied)', async () => {
      const updated = await tenantContext
        .runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), (m) =>
          m.query(`UPDATE core.staff_profile SET staff_ref = staff_ref WHERE id = $1 RETURNING id`, [staffA.profileId]),
        )
        .catch(() => 'denied');
      const deleted = await tenantContext
        .runInTenantContext(workerCtx(orgA.id, managerA.workspaceId!), (m) =>
          m.query(`DELETE FROM core.staff_profile WHERE id = $1 RETURNING id`, [staffA.profileId]),
        )
        .catch(() => 'denied');
      expect(updated === 'denied' || (updated as unknown[][])[0]?.length === 0).toBe(true);
      expect(deleted === 'denied' || (deleted as unknown[][])[0]?.length === 0).toBe(true);
      // The row survived: read it back through Manager A's own human context (the owner cannot see FORCE-RLS rows without one).
      const stillThere = await tenantContext.runInTenantContext(
        { organisationId: orgA.id, workspaceId: managerA.workspaceId!, userId: managerA.userId, role: '' },
        (m) => m.query(`SELECT id FROM core.staff_profile WHERE id = $1`, [staffA.profileId]),
      );
      expect(stillThere).toHaveLength(1);
    });

    it('a context with no actor marker (every human request path) sees no worker-only rows: the marker defaults to empty', async () => {
      const [{ actor }] = await runtime.query<Array<{ actor: string | null }>>(
        `SELECT current_setting('rab.actor_type', true) AS actor`,
      );
      expect(actor ?? '').toBe('');
    });
  });

  describe('token cleanup (core.worker_cleanup_auth_tokens)', () => {
    it('deletes only eligible expired or revoked tokens older than 181 days (WebSessionRetention1786717100000), and keeps fresh and recent ones', async () => {
      // RefreshReuseRetentionExtension1786677900000 deliberately extended this window from 30 to 91 days
      // (one day beyond the longest ABSOLUTE_SESSION_TTL_MS, 90 days, so reuse-detection evidence always
      // outlives the longest live session family) — this fixture must clear 91 days, not 30, to actually be
      // eligible under the function's current, intentional retention policy.
      const old = new Date(Date.now() - 185 * 86_400_000);
      const recent = new Date(Date.now() - 2 * 86_400_000);
      const future = new Date(Date.now() + 86_400_000);
      const family = randomUUID();
      const insert = (label: string, expiresAt: Date, revokedAt: Date | null) =>
        adminDataSource.query(
          `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, revoked_at, family_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [orgA.id, managerA.userId, `cutover-${label}-${randomUUID()}`, family, expiresAt, revokedAt, future],
        ).then((rows: Array<{ id: string }>) => rows[0]!.id);

      const expiredOld = await insert('expired-old', old, null);
      const revokedOld = await insert('revoked-old', future, old);
      const expiredRecent = await insert('expired-recent', recent, null);
      const live = await insert('live', future, null);

      await runTokenCleanupCycle(runtime);

      const survivors = await adminDataSource.query<Array<{ id: string }>>(
        `SELECT id FROM core.refresh_token WHERE id = ANY($1::uuid[])`,
        [[expiredOld, revokedOld, expiredRecent, live]],
      );
      const alive = survivors.map((r) => r.id);
      expect(alive).not.toContain(expiredOld);
      expect(alive).not.toContain(revokedOld);
      expect(alive).toContain(expiredRecent);
      expect(alive).toContain(live);

      await adminDataSource.query(`DELETE FROM core.refresh_token WHERE id = ANY($1::uuid[])`, [[expiredRecent, live]]);
    });

    it('also removes Google/Microsoft sign-in attempts an hour past expiry (audit F8), keeping live ones', async () => {
      const insert = (expiresAt: string, createdAt: string) =>
        adminDataSource
          .query(
            `INSERT INTO core.oauth_transaction_state (provider, pkce_code_verifier, nonce, return_to_path, created_at, expires_at, provider_email)
             VALUES ('google', 'v', 'n', '/', now() - $2::interval, now() - $1::interval, 'someone@example.test') RETURNING id`,
            [expiresAt, createdAt],
          )
          .then((rows: Array<{ id: string }>) => rows[0]!.id);
      const stale = await insert('2 hours', '3 hours');
      const live = await insert('-5 minutes', '5 minutes');
      const result = await runTokenCleanupCycle(runtime);
      expect(result.oauthTransactionsDeleted).toBeGreaterThanOrEqual(1);
      const survivors = (await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.oauth_transaction_state WHERE id = ANY($1::uuid[])`, [[stale, live]])).map((r) => r.id);
      expect(survivors).toEqual([live]);
      await adminDataSource.query(`DELETE FROM core.oauth_transaction_state WHERE id = $1`, [live]);
    });
  });
});
