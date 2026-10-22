import './helpers/redis-unavailable-env';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';

import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerWorkspaceService } from '../../modules/manager-workspace/services/manager-workspace.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Server-path provisioning does not depend on Redis for correctness (brief §10/§13 "no Redis"). This file boots the API
 * with REDIS_URL pointing at a closed local port AND the Redis-backed core entity cache switched ON, so every Redis call
 * on the path (cache epoch invalidation after READY) really fails. PostgreSQL stays authoritative: the workspace is
 * created and provisioned to READY, exactly once, and the request does not hang.
 *
 * The environment is set by the first import (helpers/redis-unavailable-env), before AppModule is loaded.
 */
// Needs core.provision_workspace (migration 1786719500000), which every database migrated from the chain now has.
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('server-path workspace provisioning with Redis unavailable (integration)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let admin: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
  });

  afterAll(async () => {
    await admin?.destroy();
    await app?.close().catch(() => undefined);
  });

  it('creates and provisions to READY exactly once with Redis down (cache ON), within a bounded time', async () => {
    // The booted app really runs with Redis unreachable and the Redis-backed cache on.
    expect(app.get(EnvironmentService).get('REDIS_URL')).toBe('redis://127.0.0.1:1');
    expect(app.get(EnvironmentService).get('CORE_ENTITY_CACHE_ENABLED')).toBe(true);
    const dataSource = app.get(DataSource);
    const factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource: admin,
      tenantContext: app.get(TenantContextService),
      passwordHashing: app.get(PasswordHashingService),
    });
    const org = await factory.createOrganisation('spp-noredis');
    const m = await factory.createInternalManager(org, { permissions: 'production', label: 'spp-noredis', workspace: false });
    const sub = `spp-nr-${randomUUID().slice(0, 8)}`;
    const service = app.get(ManagerWorkspaceService);

    const t0 = Date.now();
    const created = await service.create({ organisationId: org.id, workspaceId: null, userId: m.userId, role: '' }, { name: 'No Redis', subdomain: sub });
    const elapsed = Date.now() - t0;

    expect(created.schemaStatus).toBe('READY');
    expect(elapsed).toBeLessThan(30_000);
    const [ws] = await admin.query(
      `SELECT mw.schema_status, r.status AS registry FROM core.manager_workspace mw JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = $1`,
      [created.id],
    );
    expect(ws).toEqual({ schema_status: 'READY', registry: 'READY' });
    const audit = await admin.query(`SELECT action, count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 GROUP BY action ORDER BY action`, [created.id]);
    expect(audit).toEqual([
      { action: 'manager_workspace.created', n: 1 },
      { action: 'manager_workspace.provisioned', n: 1 },
    ]);
    // Replaying the same request with Redis still down is idempotent.
    const replay = await service.create({ organisationId: org.id, workspaceId: null, userId: m.userId, role: '' }, { name: 'No Redis', subdomain: sub });
    expect(replay).toMatchObject({ id: created.id, schemaStatus: 'READY' });
  });
});
