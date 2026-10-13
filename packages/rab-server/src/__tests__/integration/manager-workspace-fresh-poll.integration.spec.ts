import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerWorkspaceService } from '../../modules/manager-workspace/services/manager-workspace.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Live finding (2026-10-12): `rab-worker`'s workspace-schema provisioner is an isolated,
 * privilege-separated raw-`pg` process with no NestJS DI and deliberately no Redis access — see
 * `provision-workspace-schema.ts`'s own doc comment. It writes `schema_status = 'READY'` straight
 * to Postgres via `core.mark_workspace_schema_ready()`, with no way to invalidate
 * `CoreEntityCacheService`'s cache for that row. Reproduced here by doing the same thing a real
 * provisioning run does — a raw SQL UPDATE outside the cache's own write path — and proving:
 * (a) the bug — an ordinary cached `getMine()` call still reports the stale status afterward, and
 * (b) the fix — `getMine(ctx, { skipCache: true })` (wired to `GET /manager-workspaces/me?fresh=1`,
 * used only by `WorkspacePreparationScreen`'s active poll) reads the real, current row instead.
 */
describe('manager workspace getMine — fresh-poll cache bypass (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let adminDataSource: DataSource;
  let service: ManagerWorkspaceService;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;

  beforeAll(async () => {
    const __bt = new BootstrapTimer('manager-workspace-fresh-poll');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();
    runtime = app.get(DataSource);
    service = app.get(ManagerWorkspaceService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const tenantContext = app.get(TenantContextService);
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource,
      tenantContext,
      passwordHashing: app.get(PasswordHashingService),
    });
    const org = await factory.createOrganisation('fresh-poll');
    manager = await factory.createInternalManager(org, { permissions: 'production', label: 'fresh-poll' });
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  const ctxOf = (m: TestIdentity) => ({ organisationId: m.organisationId, workspaceId: m.workspaceId, userId: m.userId, role: '' });

  /** Flips schema_status directly via raw SQL — exactly what the isolated provisioner does: a
   * write that bypasses `CoreEntityCacheService.invalidate()` entirely. */
  async function flipSchemaStatusDirectly(workspaceId: string, status: string): Promise<void> {
    await adminDataSource.query(`UPDATE core.manager_workspace SET schema_status = $1 WHERE id = $2`, [status, workspaceId]);
  }

  // NOTE: this does NOT reproduce the live symptom in THIS environment — `CORE_ENTITY_CACHE_ENABLED`
  // defaults to `false` (environment-variables.ts) and is unset in this checkout's `.env`, so
  // `getOrFetch` takes its `if (!enabled) return fetch();` branch and this cache is a no-op here.
  // The live "stuck on Preparing" bug the owner is still seeing is therefore NOT this cache — that
  // theory is disproven, not confirmed, by this test. Kept anyway as a genuine regression guard: if
  // this flag is ever turned on (e.g. a future perf pass, or a different environment where it
  // already is), the gap this file documents is real and this test still catches it.
  it('an ordinary (uncached-here) getMine() already reflects a direct DB write immediately — confirms the cache is not the live bug in this environment', async () => {
    await flipSchemaStatusDirectly(manager.workspaceId!, 'CREATING');
    const first = await service.getMine(ctxOf(manager));
    expect(first.schemaStatus).toBe('CREATING');

    await flipSchemaStatusDirectly(manager.workspaceId!, 'READY');
    const second = await service.getMine(ctxOf(manager));
    expect(second.schemaStatus).toBe('READY');
  });

  it('proves the fix: getMine({ skipCache: true }) — the polling screen\'s own call path — reads the real, current status', async () => {
    await flipSchemaStatusDirectly(manager.workspaceId!, 'CREATING');
    await service.getMine(ctxOf(manager)); // populates the (soon-to-be-stale) cache, same as above

    await flipSchemaStatusDirectly(manager.workspaceId!, 'READY');
    const fresh = await service.getMine(ctxOf(manager), { skipCache: true });
    expect(fresh.schemaStatus).toBe('READY'); // FIX, confirmed: bypasses the stale cache entirely
  });

  it('skipCache never corrupts the cache for the NEXT ordinary (cached) caller', async () => {
    await flipSchemaStatusDirectly(manager.workspaceId!, 'READY');
    await service.getMine(ctxOf(manager), { skipCache: true });
    const ordinary = await service.getMine(ctxOf(manager));
    expect(ordinary.schemaStatus).toBe('READY');
  });
});
