/**
 * Phase B P8 (owner decision C: ProvisioningHealth1786721220000 approved for the counts-only health definer ONLY) — the
 * ordinary Worker (runtime role crewflow_app, no privileged connection) runs the daily stuck-workspace alert. The runtime
 * drift check drafted alongside it is DEFERRED (HWS prerequisite, parked in docs/later/hws-prerequisites/) and is not
 * built or registered. Runs on the harness-built database; FAILS LOUDLY — never skips — when the migration is missing
 * (the cycle throws "… is missing (migration ProvisioningHealth1786721220000 not applied)").
 * Rows are seeded through the real API and adjusted only through the superuser connection.
 */
import 'reflect-metadata';
// Explicit: the Worker's app tsconfig compiles src/__tests__ (only *.spec.ts / *.test.ts are excluded), without jest globals.
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { runWorkspaceProvisioningHealthCycle } from '../../queues/rab-maintenance/workspace-provisioning-health.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

jest.setTimeout(180_000);

describe('Worker: workspace provisioning health (counts-only definer, runtime role)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    runtime = moduleRef.get(DataSource);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const [{ current_user: who }] = await runtime.query('SELECT current_user');
    expect(who).toBe('crewflow_app');
  });

  afterAll(async () => {
    await admin?.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`).catch(() => undefined);
    await admin?.destroy();
    await app?.close();
  });

  const createWorkspace = async (deferred: boolean): Promise<string> => {
    const org = await factory.createOrganisation('p8w');
    const manager = await factory.createInternalManager(org, { permissions: 'production', workspace: false });
    const token = await factory.login(manager);
    const sub = `p8w-${randomUUID().slice(0, 8)}`;
    if (deferred) await admin.query(`REVOKE EXECUTE ON FUNCTION core.provision_workspace(uuid) FROM crewflow_app`);
    try {
      const res = await request(app.getHttpServer()).post('/rest/v1/manager-workspaces').set('Authorization', `Bearer ${token}`).send({ name: sub, subdomain: sub });
      expect(res.status).toBe(201);
      return res.body.id as string;
    } finally {
      if (deferred) await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`);
    }
  };

  it('stuck-workspace alert: counts only, warn line + Sentry warning when either count > 0, on the runtime connection', async () => {
    const stale = await createWorkspace(true);
    await admin.query(`UPDATE core.manager_workspace SET created_at = now() - interval '30 minutes' WHERE id = $1`, [stale]);
    const warn = jest.fn();
    const captureMessage = jest.fn();
    const result = await runWorkspaceProvisioningHealthCycle(runtime, { warn, captureMessage });
    expect(result.creatingOver10Min).toBeGreaterThanOrEqual(1);
    expect(result.alerted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ level: 'warning', extra: { creating_over_10_min: result.creatingOver10Min, failed: result.failed } }));
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain(stale);
  });

  it('a FAILED workspace is counted, a fresh CREATING one is not; the runtime role alone sees no workspace row', async () => {
    const before = await runWorkspaceProvisioningHealthCycle(runtime, { warn: () => undefined, captureMessage: null });
    const failed = await createWorkspace(true);
    await admin.query(`UPDATE core.manager_workspace SET schema_status = 'FAILED' WHERE id = $1`, [failed]);
    await createWorkspace(true); // fresh CREATING: never counted
    const after = await runWorkspaceProvisioningHealthCycle(runtime, { warn: () => undefined, captureMessage: null });
    expect(after.failed - before.failed).toBe(1);
    expect(after.creatingOver10Min - before.creatingOver10Min).toBe(0);
    const [{ n }] = await runtime.query(`SELECT count(*)::int AS n FROM core.manager_workspace`);
    expect(n).toBe(0);
  });
});
