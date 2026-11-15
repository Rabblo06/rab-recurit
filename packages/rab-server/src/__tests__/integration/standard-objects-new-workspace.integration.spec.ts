import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { WORKSPACE_TABLES } from '../../database/typeorm/workspace-schema/workspace-tables';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { lastStepOfVersion } from '../../engine/core-modules/upgrade/upgrade-sequence';
import { readAppVersion } from '../../engine/core-modules/upgrade/upgrade-version';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { metadataCatalogDifferences } from './helpers/standard-metadata-equivalence';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Metadata engine M1 / E2: a NEW workspace gets the standard-object sync. A workspace created on this code starts at the
 * release's last upgrade step (Part B / D `is_initial` row = 0.6.0_SyncStandardObjects_…), so it never runs the workspace
 * command; ManagerWorkspaceService.createFor writes its standard metadata in the creation transaction instead. Real HTTP, real
 * auth, the configured runtime login; the result is compared with the provisioned schema in pg_catalog, and a rolled-back
 * create leaves no metadata behind.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('M1 / E2: a new workspace gets its standard objects (integration)', () => {
  jest.setTimeout(180_000);
  let app: INestApplication;
  let adminDs: DataSource;
  let admin: Client;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    adminDs = createAdminDataSource();
    await adminDs.initialize();
    admin = new Client({ connectionString: integrationTestDatabase().adminUrl });
    await admin.connect();
    factory = new TestIdentityFactory({
      app,
      dataSource: app.get(DataSource),
      adminDataSource: adminDs,
      tenantContext: app.get(TenantContextService),
      passwordHashing: app.get(PasswordHashingService),
    });
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await adminDs?.destroy();
    await app?.close();
  });

  it('POST /manager-workspaces → standard metadata present, matching the provisioned tables, and is_initial = the sync step', async () => {
    const org = await factory.createOrganisation(`m1s-${randomUUID().slice(0, 6)}`);
    const manager = await factory.createInternalManager(org, { permissions: 'production', label: `m1s-${randomUUID().slice(0, 6)}`, workspace: false });
    const token = await factory.login(manager);
    const sub = `m1s-${randomUUID().slice(0, 8)}`;
    const created = await request(app.getHttpServer()).post('/rest/v1/manager-workspaces').set({ Authorization: `Bearer ${token}` }).send({ name: `M1S ${sub}`, subdomain: sub });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const [ws] = (await admin.query(`SELECT id::text, organisation_id::text AS org, schema_status FROM core.manager_workspace WHERE id = $1`, [id])).rows;
    expect(ws.schema_status).toBe('READY');

    const counts = (await admin.query(
      `SELECT (SELECT count(*) FROM core.object_metadata WHERE workspace_id = $1)::int AS objects,
              (SELECT count(*) FROM core.field_metadata WHERE workspace_id = $1)::int AS fields,
              (SELECT count(*) FROM core.object_metadata WHERE workspace_id = $1 AND is_system AND NOT allows_custom_fields
                  AND physical_table = ANY($2::text[]))::int AS system_locked`,
      [id, ['attendance', 'attendance_correction', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document']],
    )).rows[0];
    expect(counts).toEqual({ objects: 25, fields: 344, system_locked: 7 });
    expect(await metadataCatalogDifferences(admin, { id, org: ws.org, schema: `workspace_${id.replace(/-/g, '')}` }, WORKSPACE_TABLES)).toEqual([]);

    const initial = (await admin.query(`SELECT name, status FROM core.upgrade_migration WHERE workspace_id = $1 AND is_initial`, [id])).rows;
    expect(initial).toEqual([{ name: lastStepOfVersion(readAppVersion()), status: 'completed' }]);
    expect(initial[0].name).toMatch(/^0\.6\.0_SyncStandardObjects_\d{13}$/);
  });

  it('the runtime login with no tenant context bound sees no metadata rows (FORCE RLS, fail closed)', async () => {
    const runtime = app.get(DataSource);
    const rows = await runtime.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', '', true), set_config('rab.workspace_id', '', true)`);
      return m.query(`SELECT (SELECT count(*) FROM core.object_metadata)::int AS o, (SELECT count(*) FROM core.field_metadata)::int AS f`);
    });
    expect(rows).toEqual([{ o: 0, f: 0 }]);
  });
});
