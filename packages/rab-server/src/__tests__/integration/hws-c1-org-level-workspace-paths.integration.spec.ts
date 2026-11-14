import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Part C1 (HWS-AUDIT.md §0.1): the two org-level paths that read workspace tables from a workspace-less (or other-workspace)
 * context, with HWS on (the code default outside production):
 *   4.5  GET /rest/v1/managers/:id/venues — read in the TARGET manager's workspace; another workspace = 404.
 *   4.6  DELETE /rest/v1/managers/:id — the protected-history check covers EVERY schema the target can have rows in (each
 *        workspace schema of the organisation and the `core` copies); the hard delete is refused while history exists in
 *        any of them.
 * Real Postgres, RLS on, real HTTP routes, no mocks. Fixture rows are written through the tenant context (unqualified
 * tables, routed like the product's own writes) or, for the pre-cutover `core` copies, explicitly into `core.*`.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('HWS C1: org-level paths over workspace tables (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let hwsOn: boolean;

  // One organisation: a workspace-less CEO, two Internal Managers with their own workspaces (A, B), Venue Managers in B.
  let orgId: string;
  let ceo: TestIdentity;
  let mgrA: TestIdentity;
  let mgrB: TestIdentity;
  let vmB: TestIdentity;
  let venueB: string;
  let staleCoreVenue: string;
  let otherOrgMgr: TestIdentity;

  const MANAGER_PERMS = [PermissionFlag.MANAGER_MANAGE, PermissionFlag.STAFF_VIEW, PermissionFlag.STAFF_CREATE];

  /** A venue in `owner`'s workspace, written through the tenant context (its schema with HWS on, the core copy with it off). */
  async function venueInWorkspace(owner: TestIdentity, createdBy: string, name: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (m) => {
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO venue (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, name, createdBy, owner.workspaceId],
      );
      return row!.id;
    });
  }

  /** A row in the pre-cutover `core` copy only (the superuser fixture connection; never reachable through the app). */
  async function venueInCoreCopy(workspaceId: string, createdBy: string, name: string): Promise<string> {
    const [row] = await adminDataSource.query<Array<{ id: string }>>(
      `INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, name, createdBy, workspaceId],
    );
    return row!.id;
  }

  const userExists = async (userId: string) =>
    ((await adminDataSource.query(`SELECT 1 FROM core."user" WHERE id = $1`, [userId])) as unknown[]).length === 1;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    hwsOn = moduleRef.get(EnvironmentService).get('HWS_RUNTIME_ENABLED') === true;
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const org = await factory.createOrganisation('hws-c1');
    orgId = org.id;
    ceo = await factory.createInternalManager(org, { type: 'ceo', workspace: false, label: 'c1-ceo' });
    mgrA = await factory.createInternalManager(org, { permissions: MANAGER_PERMS, label: 'c1-a' });
    mgrB = await factory.createInternalManager(org, { permissions: MANAGER_PERMS, label: 'c1-b' });
    venueB = await venueInWorkspace(mgrB, mgrB.userId, 'C1 Venue B');
    vmB = await factory.createVenueManager(org, { owner: mgrB, venueIds: [venueB], label: 'c1-vm-b' });
    // A stale pre-cutover copy for vmB: a venue and its manager_venue link only in core.
    staleCoreVenue = await venueInCoreCopy(mgrB.workspaceId!, mgrB.userId, 'C1 stale core venue');
    await adminDataSource.query(
      `INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`,
      [orgId, vmB.profileId, staleCoreVenue, mgrB.workspaceId],
    );

    const other = await factory.createOrganisation('hws-c1-other');
    otherOrgMgr = await factory.createInternalManager(other, { permissions: MANAGER_PERMS, label: 'c1-x' });
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  describe('4.5 GET /rest/v1/managers/:id/venues reads the target manager’s own workspace', () => {
    const venuesOf = async (caller: TestIdentity, profileId: string) =>
      request(app.getHttpServer()).get(`/rest/v1/managers/${profileId}/venues`).set('Authorization', `Bearer ${await factory.login(caller)}`);

    it('a manager of the same workspace sees the Venue Manager’s venues', async () => {
      const res = await venuesOf(mgrB, vmB.profileId!);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((v) => v.id).sort();
      // HWS on: the workspace schema only (the stale core copy is never read). HWS off: the core copy is authoritative.
      expect(ids).toEqual(hwsOn ? [venueB] : [venueB, staleCoreVenue].sort());
    });

    it('ABUSE: a manager bound to ANOTHER workspace of the same organisation gets 404, not [] and not the rows', async () => {
      const res = await venuesOf(mgrA, vmB.profileId!);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(venueB);
    });

    it('a workspace-less CEO reads the target’s workspace (never the stale core copy with HWS on)', async () => {
      const res = await venuesOf(ceo, vmB.profileId!);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((v) => v.id).sort();
      expect(ids).toEqual(hwsOn ? [venueB] : [venueB, staleCoreVenue].sort());
    });

    it('ABUSE: a manager of another organisation gets 404', async () => {
      const res = await venuesOf(otherOrgMgr, vmB.profileId!);
      expect(res.status).toBe(404);
    });

    it('ABUSE: an unknown id is 404', async () => {
      const res = await venuesOf(ceo, randomUUID());
      expect(res.status).toBe(404);
    });
  });

  describe('4.6 DELETE /rest/v1/managers/:id refuses while protected history exists in ANY schema', () => {
    const deleteManager = async (caller: TestIdentity, profileId: string) =>
      request(app.getHttpServer())
        .delete(`/rest/v1/managers/${profileId}`)
        .set('Authorization', `Bearer ${await factory.login(caller)}`)
        .send({ currentPassword: caller.password });

    it('ABUSE: history only in ANOTHER workspace’s schema (not the caller’s) → 409 USER_HAS_PROTECTED_HISTORY, nothing deleted', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-ws' });
      await venueInWorkspace(mgrB, target.userId, 'C1 venue created by the target');

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(JSON.stringify(res.body)).not.toMatch(/foreign key|violates|venue_created_by/i);
      expect(await userExists(target.userId)).toBe(true);
    });

    it('ABUSE: history only in the pre-cutover core copy → 409, nothing deleted', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-core' });
      await venueInCoreCopy(mgrB.workspaceId!, target.userId, 'C1 core-copy venue created by the target');

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(await userExists(target.userId)).toBe(true);
    });

    it('ABUSE: a manager bound to another workspace cannot delete the target either (refused, nothing deleted)', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-a' });
      await venueInWorkspace(mgrB, target.userId, 'C1 venue (A caller)');

      const res = await deleteManager(mgrA, target.profileId!);
      // 409 when A can see the profile (organisation-wide manager.manage), 404 when RLS hides it: never a deletion.
      expect([404, 409]).toContain(res.status);
      if (res.status === 409) expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(await userExists(target.userId)).toBe(true);
    });

    it('ABUSE: a workspace of the organisation whose schema exists but is not READY cannot be verified → refused', async () => {
      const mgrC = await factory.createInternalManager({ id: orgId }, { permissions: MANAGER_PERMS, label: 'c1-c' });
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-unverifiable' });
      const [{ status: before }] = await adminDataSource.query<Array<{ status: string }>>(
        `SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [mgrC.workspaceId],
      );
      await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [mgrC.workspaceId]);
      try {
        const res = await deleteManager(ceo, target.profileId!);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
        expect(await userExists(target.userId)).toBe(true);
      } finally {
        await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = $2 WHERE workspace_id = $1`, [mgrC.workspaceId, before]);
      }
    });

    it('control: a Venue Manager with no history anywhere is deleted (204)', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-clean' });
      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userExists(target.userId)).toBe(false);
    });
  });
});
