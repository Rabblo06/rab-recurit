import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { SchemaResolverService } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { runRealtimeOutboxPublishCycle, RealtimePublishFn } from '../../queues/rab-realtime/publish-outbox.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentityFactory } from './helpers/test-identities';

/**
 * W6-E2E-07 regression (LOW, worker): with HWS routing on, a workspace that is listed by `core.worker_list_workspaces`
 * before its schema is READY (the window between the workspace row's commit and provisioning) made
 * `TenantContextService` throw `WorkspaceRoutingError('registry-missing')`, and the realtime-outbox publish cycle (and
 * every `discoverInWorkspaces` job, e.g. shift statements) failed for EVERY tenant until the next tick.
 *
 * Real Postgres, real `SchemaResolverService`, a real `TenantContextService` with `HWS_RUNTIME_ENABLED` on (the only
 * difference from the app's instance; the test DB's app config runs HWS off). The factory's workspaces have no registry
 * row, i.e. exactly the "just created, not provisioned yet" state.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

describeIfDb('W6-E2E-07 not-yet-routable workspaces are skipped, not fatal (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let appTenant: TenantContextService;
  let hwsTenant: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    appTenant = app.get(TenantContextService);
    const env = app.get(EnvironmentService);
    const hwsEnv = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : env.get(key as never)) } as unknown as EnvironmentService;
    hwsTenant = new TenantContextService(dataSource, app.get(SchemaResolverService), hwsEnv);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext: appTenant, passwordHashing: app.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('precondition: the HWS tenant context really refuses the unprovisioned workspace', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'w6e07pre' });
    await expect(
      hwsTenant.runInTenantContext({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, userId: '', role: '', actorType: 'worker' }, async () => 1),
    ).rejects.toMatchObject({ name: 'WorkspaceRoutingError', code: 'registry-missing' });
  });

  it('realtime outbox: a not-yet-READY workspace scope ahead of a deliverable event no longer fails the cycle', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'w6e07rt' });
    const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: 'w6e07rt-staff' });
    // An organisation-wide event (workspace_id NULL) — deliverable without any workspace routing.
    const eventId = await appTenant.runInTenantContext({ organisationId: manager.organisationId, workspaceId: null, userId: manager.userId, role: '' }, async (m) => {
      const rows = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
         VALUES ($1, NULL, $2, $3, 'offer.sent', 'offer', $4, '{}'::jsonb, 10, 1) RETURNING id`,
        [manager.organisationId, staff.userId, `w6e07:${randomUUID()}`, randomUUID()],
      );
      return rows[0]!.id;
    });
    const calls: string[] = [];
    const publish: RealtimePublishFn = async (channel) => {
      calls.push(channel);
      return 1;
    };

    // Head of line: the unprovisioned workspace's scope comes FIRST, as storageScopes can yield it.
    const result = await runRealtimeOutboxPublishCycle(dataSource, hwsTenant, publish, 'inttest', {
      scopes: [
        { organisationId: manager.organisationId, workspaceId: manager.workspaceId },
        { organisationId: manager.organisationId, workspaceId: null },
      ],
    });

    expect(result.skippedNotReady).toBe(1);
    expect(result.published).toBe(1);
    expect(calls).toHaveLength(1);
    const [row] = await adminDataSource.query(`SELECT status FROM core.realtime_event WHERE id = $1`, [eventId]);
    expect(row.status).toBe('completed');
  });

  it('discoverInWorkspaces: an unprovisioned workspace is skipped and the walk completes', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'w6e07disc' });
    let scanned = 0;
    const found = await discoverInWorkspaces(
      dataSource,
      hwsTenant,
      async () => {
        scanned += 1;
        return [1];
      },
      manager.organisationId,
    );
    expect(found).toEqual([]);
    expect(scanned).toBe(0); // never routed into, never scanned
  });
});
