import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { provisionTypeScript } from './helpers/workspace-fixtures';

/**
 * Security review F4 (0b branch): RoleService.assertRelationsInScopeTx validates the venue / job-role ids of a member role's
 * record filter against the table the TENANT TRANSACTION routes to (search_path: the workspace schema with HWS on, core with it
 * off), never an explicit `core.` table. HWS is toggled per test on the one shared EnvironmentService (read per call), as
 * workspace-provisioning-owner-flow does. Every case on both modes:
 *  (a) an id of the caller's own workspace → the role is created (201);
 *  (b) an id of ANOTHER workspace (same organisation) → refused (400 INVALID_ROLE_DEFINITION), no probing;
 *  (c) HWS on only: an id that exists only in the legacy core copy (with the caller's workspace id) → refused: the routed
 *      workspace table does not have it.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

describeIfDb('member role record filters: relation ids are checked in the routed workspace table (F4)', () => {
  const { adminUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let hwsOn = false;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 6)}`;
  const venue = async (token: string) => {
    const res = await http().post('/rest/v1/venues').set(bearer(token)).send({ name: uniq('F4 venue'), type: 'hotel' });
    if (res.status !== 201) throw new Error(`venue create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const jobRole = async (token: string) => {
    const res = await http().post('/rest/v1/job-roles').set(bearer(token)).send({ name: uniq('F4 role'), defaultRatePence: 1300 });
    if (res.status !== 201) throw new Error(`job role create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const role = (token: string, venueIds: string[], jobRoleIds: string[]) =>
    http()
      .post('/rest/v1/roles')
      .set(bearer(token))
      .send({
        name: uniq('F4'),
        assignableToMembers: true,
        readAllObjects: false,
        objects: [
          ...(venueIds.length ? [{ object: 'venue', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'name', operator: 'in', value: venueIds }] } }] : []),
          ...(jobRoleIds.length ? [{ object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'jobRole', operator: 'in', value: jobRoleIds }] } }] : []),
        ],
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const environment = app.get(EnvironmentService);
    const realGet = environment.get.bind(environment) as (key: string) => unknown;
    jest.spyOn(environment, 'get').mockImplementation(((key: string) => (key === 'HWS_RUNTIME_ENABLED' ? hwsOn : realGet(key))) as never);
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'f4' });
    [managerA, managerB] = seeded.managers as [TestIdentity, TestIdentity];
    tokenA = await factory.login(managerA);
    tokenB = await factory.login(managerB);
  });

  afterAll(async () => {
    hwsOn = false;
    await app?.close();
    await owner?.destroy();
  });

  for (const mode of [false, true]) {
    it(`HWS ${mode ? 'on' : 'off'}: own-workspace ids accepted; another workspace's refused${mode ? '; a legacy core-only id refused' : ''}`, async () => {
      hwsOn = mode;
      if (mode) {
        // HWS on routes the caller's requests to its READY workspace schema. With HWS off (main) the fixtures never built one:
        // build it the Worker's way (TypeScript provisioner, idempotent: ALREADY_READY when C1's fixtures did).
        for (const m of [managerA, managerB]) {
          const ws = { id: m.workspaceId!, org: m.organisationId, owner: m.userId, schema: `workspace_${m.workspaceId!.replace(/-/g, '')}`, label: 'f4' };
          expect(['READY', 'ALREADY_READY']).toContain(await provisionTypeScript(adminUrl, ws));
          const [{ status }] = await owner.query(`SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1`, [m.workspaceId]);
          expect(status).toBe('READY');
        }
      }
      const [vA, vB, jA, jB] = [await venue(tokenA), await venue(tokenB), await jobRole(tokenA), await jobRole(tokenB)];
      // (a) the caller's own workspace
      expect((await role(tokenA, [vA], [])).status).toBe(201);
      expect((await role(tokenA, [], [jA])).status).toBe(201);
      // (b) another workspace of the same organisation: refused, the same answer as a missing id
      for (const res of [await role(tokenA, [vB], []), await role(tokenA, [], [jB])]) {
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_ROLE_DEFINITION');
      }
      if (mode) {
        // (c) a row only in the legacy core copy, carrying the caller's own workspace id: the routed table does not have it.
        const legacy = randomUUID();
        await owner.query(`INSERT INTO core.venue (id, organisation_id, workspace_id, name, type, created_by) VALUES ($1, $2, $3, $4, 'hotel', $5)`, [
          legacy,
          managerA.organisationId,
          managerA.workspaceId,
          uniq('F4 legacy-only'),
          managerA.userId,
        ]);
        const res = await role(tokenA, [legacy], []);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_ROLE_DEFINITION');
        await owner.query(`DELETE FROM core.venue WHERE id = $1`, [legacy]);
      }
    });
  }
});
