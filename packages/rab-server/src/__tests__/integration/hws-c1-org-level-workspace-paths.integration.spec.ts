import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { UserDeletionService } from '../../engine/core-modules/user-deletion/user-deletion.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessSchema } from './helpers/hws-fixtures';
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
  let managerService: ManagerService;
  let userDeletion: UserDeletionService;

  // One organisation: a workspace-less CEO, two Internal Managers with their own workspaces (A, B), Venue Managers in B.
  let orgId: string;
  let ceo: TestIdentity;
  let mgrA: TestIdentity;
  let mgrB: TestIdentity;
  let vmB: TestIdentity;
  let venueB: string;
  let staleCoreVenue: string;
  let otherOrgMgr: TestIdentity;

  const MANAGER_PERMS = [PermissionFlag.MANAGER_MANAGE, PermissionFlag.STAFF_VIEW, PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_DEACTIVATE];

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

  /** A staff profile for `userId` in `owner`'s workspace with a confirmed shift assignment (operational history). */
  async function staffHistoryInWorkspace(owner: TestIdentity, userId: string, venueId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (m) => {
      const [profile] = await m.query<Array<{ id: string }>>(
        `INSERT INTO staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, userId, `STF-${randomUUID().slice(0, 8)}`, owner.userId, owner.workspaceId],
      );
      await assignShift(m, owner, venueId, profile!.id);
      return profile!.id;
    });
  }

  /** A confirmed shift assignment for `staffProfileId` in `owner`'s workspace (through the caller's tenant transaction). */
  async function assignShift(m: EntityManager, owner: TestIdentity, venueId: string, staffProfileId: string): Promise<void> {
    const workspaceId = owner.workspaceId!;
    const jobRole = await m.save(JobRole, { organisationId: orgId, name: `C1 Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId });
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const shift = await m.save(Shift, {
      organisationId: orgId, venueId, jobRoleId: jobRole.id, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500,
      status: 'open', createdBy: owner.userId, workspaceId,
    });
    await m.save(ShiftAssignment, {
      organisationId: orgId, shiftId: shift.id, staffProfileId, status: 'confirmed', payRateSnapshotPence: 1500,
      assignedBy: owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId,
    });
  }

  /** The row as the superuser fixture connection sees it, wherever this mode keeps it (workspace schema with HWS on). */
  const staffProfileExists = async (workspaceId: string, profileId: string) =>
    ((await adminDataSource.query(`SELECT 1 FROM "${businessSchema(workspaceId)}".staff_profile WHERE id = $1`, [profileId])) as unknown[]).length === 1;

  const userExists = async (userId: string) =>
    ((await adminDataSource.query(`SELECT 1 FROM core."user" WHERE id = $1`, [userId])) as unknown[]).length === 1;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    managerService = moduleRef.get(ManagerService);
    userDeletion = moduleRef.get(UserDeletionService);
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

    it('ABUSE (layer 2, review L4): the SERVICE refuses a caller without manager.manage (403), no guard involved', async () => {
      // Another organisation, so its canonical "manager" role can carry a different permission set.
      const noPermOrg = await factory.createOrganisation('hws-c1-noperm');
      const noPerm = await factory.createInternalManager(noPermOrg, { permissions: [PermissionFlag.STAFF_VIEW], label: 'c1-noperm' });
      await expect(
        managerService.listVenues({ organisationId: noPermOrg.id, workspaceId: noPerm.workspaceId, userId: noPerm.userId, role: '' }, vmB.profileId!),
      ).rejects.toMatchObject({ status: 403 });
      // Control: the same direct call with manager.manage succeeds.
      const venues = await managerService.listVenues({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, vmB.profileId!);
      expect(venues.map((v) => v.id)).toContain(venueB);
    });
  });

  describe('StaffService.deleteUser with HWS routing (review L4)', () => {
    const deleteStaff = async (caller: TestIdentity, profileId: string) =>
      request(app.getHttpServer())
        .delete(`/rest/v1/staff/${profileId}`)
        .set('Authorization', `Bearer ${await factory.login(caller)}`)
        .send({ currentPassword: caller.password });

    it('the creator deletes a Staff member with no history (204); the profile is gone from the workspace schema', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-clean' });
      const res = await deleteStaff(mgrB, staff.profileId!);
      expect(res.status).toBe(204);
      expect(await userExists(staff.userId)).toBe(false);
      expect(await staffProfileExists(mgrB.workspaceId!, staff.profileId!)).toBe(false);
    });

    it('ABUSE: a Staff member with a shift assignment in the workspace schema → 409, nothing deleted', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-history' });
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, (m) =>
        assignShift(m, mgrB, venueB, staff.profileId!),
      );
      const res = await deleteStaff(mgrB, staff.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(await userExists(staff.userId)).toBe(true);
      expect(await staffProfileExists(mgrB.workspaceId!, staff.profileId!)).toBe(true);
    });

    it('ABUSE: a manager of ANOTHER workspace cannot delete B’s Staff (404: the profile is not in its scope)', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-other' });
      const res = await deleteStaff(mgrA, staff.profileId!);
      expect(res.status).toBe(404);
      expect(await userExists(staff.userId)).toBe(true);
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
      // A holds organisation-wide manager.manage, so it sees the profile; the history in B's schema is found → 409.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
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
        // Review L2: its own code (an operator problem), not the misleading USER_HAS_PROTECTED_HISTORY; no workspace id leaks.
        expect(res.body.code).toBe('USER_DELETION_UNVERIFIABLE');
        expect(JSON.stringify(res.body)).not.toContain(mgrC.workspaceId!);
        expect(await userExists(target.userId)).toBe(true);
      } finally {
        await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = $2 WHERE workspace_id = $1`, [mgrC.workspaceId, before]);
      }
    });

    it('ABUSE (review L1): the CEO cannot see a staff profile in workspace B; its shift assignment would cascade away → 409, profile and history stay', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-hidden-staff' });
      const hiddenProfile = await staffHistoryInWorkspace(mgrB, target.userId, venueB);

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(JSON.stringify(res.body)).not.toMatch(/foreign key|violates|shift_assignment/i);
      expect(await userExists(target.userId)).toBe(true);
      expect(await staffProfileExists(mgrB.workspaceId!, hiddenProfile)).toBe(true);
      const assignments = await adminDataSource.query(`SELECT 1 FROM "${businessSchema(mgrB.workspaceId!)}".shift_assignment WHERE staff_profile_id = $1`, [hiddenProfile]);
      expect(assignments).toHaveLength(1);
    });

    it('ABUSE (review L1): a note ABOUT the target (user_note.subject_user_id cascades) is protected history → 409', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-note' });
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, async (m) => {
        if (hwsOn) {
          await m.query(`INSERT INTO user_note (organisation_id, subject_user_id, author_user_id, body, workspace_id) VALUES ($1, $2, $3, 'C1 note', $4)`, [orgId, target.userId, mgrB.userId, mgrB.workspaceId]);
        } else {
          await m.query(`INSERT INTO user_note (organisation_id, subject_user_id, author_user_id, body) VALUES ($1, $2, $3, 'C1 note')`, [orgId, target.userId, mgrB.userId]);
        }
      });

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(await userExists(target.userId)).toBe(true);
    });

    it('assertCanDelete restores rab.workspace_id and search_path to their values on entry (review L4)', async () => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label: 'c1-del-gucs' });
      for (const caller of [ceo, mgrB]) {
        const ctx = { organisationId: orgId, workspaceId: caller.workspaceId, userId: caller.userId, role: '' };
        await tenantContext.runInTenantContext(ctx, async (m) => {
          const read = () => m.query<Array<{ ws: string | null; sp: string }>>(`SELECT current_setting('rab.workspace_id', true) AS ws, current_setting('search_path') AS sp`);
          const [before] = await read();
          await userDeletion.assertCanDelete(m, ctx, target.userId);
          const [after] = await read();
          expect(after).toEqual(before);
        });
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
