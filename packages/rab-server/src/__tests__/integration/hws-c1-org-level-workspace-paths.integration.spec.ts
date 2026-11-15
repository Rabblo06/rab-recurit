import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, Logger } from '@nestjs/common';
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
import { Client } from 'pg';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { checkWorkspaceCoreOrphans } from '../../database/typeorm/workspace-schema/workspace-core-orphans';
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
 *        workspace schema of the organisation and the `core` copies). Owner 0g: only a never-activated invite with no
 *        history in any of them is hard-deleted; any history (or a schema that cannot be checked) means a soft delete.
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

  /**
   * Part D 0a, security review F2, owner decision (b): a staff profile the caller cannot see, with history the caller CAN see,
   * makes an invite's hard delete unsafe (core copy: the foreign keys cascade and historyLost sees it; level-22 workspace
   * schema: the hidden history alone counts). Soft delete, the profile and its history stay, no orphan.
   */
  const expectHiddenProfileOutcome = async (userId: string) => {
    expect(await userSoftDeleted(userId)).toBe(true);
  };
  /** The daily orphan check's staff_profile.user_id findings for workspace B (counts only), as the Worker runs it. */
  const profileOrphansInB = async (): Promise<number> => {
    const c = new Client({ connectionString: resolveIntegrationTestDatabase(process.env).adminUrl });
    await c.connect();
    try {
      await c.query('SET ROLE crewflow');
      const r = await checkWorkspaceCoreOrphans(c, [mgrB.workspaceId!]);
      expect(r.errors).toEqual([]);
      return r.findings.filter((f) => f.table === 'staff_profile' && f.column === 'user_id').reduce((n, f) => n + f.rows, 0);
    } finally {
      await c.end();
    }
  };
  /**
   * Removes every staff-history row of workspace B before a case where the CEO must be able to hard-delete a clean invite:
   * earlier cases leave staff with history that the CEO cannot see, which (F2 (b)) makes any CEO hard delete there unsafe.
   */
  const purgeStaffHistoryInB = async () => {
    const q = `"${businessSchema(mgrB.workspaceId!)}"`;
    for (const table of ['payroll_record', 'attendance', 'job_offer', 'shift_request_staff', 'venue_manager_staff', 'shift_assignment']) {
      await adminDataSource.query(`DELETE FROM ${q}.${table} WHERE workspace_id = $1`, [mgrB.workspaceId]);
    }
    await adminDataSource.query(`UPDATE ${q}.replacement_request SET selected_staff_profile_id = NULL WHERE workspace_id = $1`, [mgrB.workspaceId]);
  };
  /** Removes a hidden profile and its history after an L1 case, so later hard-delete cases of this file start clean. */
  const dropHiddenProfile = async (profileId: string) => {
    const q = `"${businessSchema(mgrB.workspaceId!)}"`;
    for (const table of ['shift_request_staff', 'shift_assignment']) await adminDataSource.query(`DELETE FROM ${q}.${table} WHERE staff_profile_id = $1`, [profileId]);
    await adminDataSource.query(`DELETE FROM ${q}.staff_profile WHERE id = $1`, [profileId]);
  };
  const userSoftDeleted = async (userId: string) =>
    ((await adminDataSource.query(`SELECT 1 FROM core."user" WHERE id = $1 AND deleted_at IS NOT NULL`, [userId])) as unknown[]).length === 1;

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

    it('owner decision 0d: an ORGANISATION-WIDE manager.manage holder bound to ANOTHER workspace reads the target’s venues (its workspace)', async () => {
      // mgrA holds manager.manage through the organisation-level `manager` role (MANAGER_PERMS): organisation-wide scope.
      const res = await venuesOf(mgrA, vmB.profileId!);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((v) => v.id).sort();
      expect(ids).toEqual(hwsOn ? [venueB] : [venueB, staleCoreVenue].sort());
    });

    it('ABUSE (0d): manager.manage cannot come from a workspace-only role, and a manager WITHOUT it in another workspace is refused (403), never shown the venues', async () => {
      // The database refuses manager.manage on a custom workspace-member role, so every holder is organisation-wide; the
      // service's strict same-workspace branch for a workspace-only holder stays as defence in depth (unit-tested).
      const [role] = await adminDataSource.query<Array<{ id: string }>>(
        `INSERT INTO core.role (organisation_id, key, name, is_system, workspace_id) VALUES ($1, $2, 'C1 custom manage', false, $3) RETURNING id`,
        [orgId, `custom_c1b_${randomUUID().slice(0, 8)}`, mgrA.workspaceId],
      );
      await expect(
        adminDataSource.query(
          `INSERT INTO core.role_permission (role_id, permission_id, organisation_id) SELECT $1, id, $2 FROM core.permission WHERE key = $3`,
          [role!.id, orgId, PermissionFlag.MANAGER_MANAGE],
        ),
      ).rejects.toThrow(/cannot be granted to a workspace-member role/);
      // A Venue Manager of workspace A (its system role has no manager.manage) asking for workspace B's Venue Manager.
      const vmA = await factory.createVenueManager({ id: orgId }, { owner: mgrA, label: 'c1-vm-a-plain' });
      const ctxA = { organisationId: orgId, workspaceId: mgrA.workspaceId, userId: vmA.userId, role: '' };
      await expect(managerService.listVenues(ctxA, vmB.profileId!)).rejects.toMatchObject({ status: 403 });
    });

    it('owner decision 0d: a workspace-bound caller asking for an in-organisation profile with NO workspace gets 404; a workspace-less CEO gets []', async () => {
      const res = await venuesOf(mgrB, ceo.profileId!); // the CEO's own profile has no workspace
      expect(res.status).toBe(404);
      await expect(managerService.listVenues({ organisationId: orgId, workspaceId: null, userId: ceo.userId, role: '' }, ceo.profileId!)).resolves.toEqual([]);
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

  describe('StaffService.deleteUser with HWS routing (review L4; owner 0g)', () => {
    const deleteStaff = async (caller: TestIdentity, profileId: string) =>
      request(app.getHttpServer())
        .delete(`/rest/v1/staff/${profileId}`)
        .set('Authorization', `Bearer ${await factory.login(caller)}`)
        .send({ currentPassword: caller.password });

    it('a never-activated invite with no history is hard-deleted (204); the profile is gone from the workspace schema', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-clean', status: 'invited' });
      const res = await deleteStaff(mgrB, staff.profileId!);
      expect(res.status).toBe(204);
      expect(await userExists(staff.userId)).toBe(false);
      expect(await staffProfileExists(mgrB.workspaceId!, staff.profileId!)).toBe(false);
    });

    it('an ACTIVE Staff member (no history) is soft-deleted: 204, account row and profile kept', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-active' });
      const res = await deleteStaff(mgrB, staff.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(staff.userId)).toBe(true);
      expect(await staffProfileExists(mgrB.workspaceId!, staff.profileId!)).toBe(true);
    });

    it('ABUSE: an invite whose profile has a shift assignment in the workspace schema is NOT hard-deleted: soft, history intact', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-history', status: 'invited' });
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, (m) =>
        assignShift(m, mgrB, venueB, staff.profileId!),
      );
      const res = await deleteStaff(mgrB, staff.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(staff.userId)).toBe(true);
      expect(await staffProfileExists(mgrB.workspaceId!, staff.profileId!)).toBe(true);
      expect(await adminDataSource.query(`SELECT 1 FROM "${businessSchema(mgrB.workspaceId!)}".shift_assignment WHERE staff_profile_id = $1`, [staff.profileId])).toHaveLength(1);
    });

    it('ABUSE: a manager of ANOTHER workspace cannot delete B’s Staff (404: the profile is not in its scope)', async () => {
      const staff = await factory.createStaff({ id: orgId }, { owner: mgrB, label: 'c1-staff-other' });
      const res = await deleteStaff(mgrA, staff.profileId!);
      expect(res.status).toBe(404);
      expect(await userExists(staff.userId)).toBe(true);
      expect(await userSoftDeleted(staff.userId)).toBe(false);
    });
  });

  describe('4.6 DELETE /rest/v1/managers/:id: a never-activated invite is hard-deleted only when NO schema holds history (owner 0g)', () => {
    const deleteManager = async (caller: TestIdentity, profileId: string) =>
      request(app.getHttpServer())
        .delete(`/rest/v1/managers/${profileId}`)
        .set('Authorization', `Bearer ${await factory.login(caller)}`)
        .send({ currentPassword: caller.password });

    /** A Venue Manager of B that never activated (status invited, never signed in, no token or session). */
    const invitedVenueManager = async (label: string) => {
      const target = await factory.createVenueManager({ id: orgId }, { owner: mgrB, label });
      await adminDataSource.query(`UPDATE core."user" SET status = 'invited' WHERE id = $1`, [target.userId]);
      return target;
    };

    it('ABUSE: history only in ANOTHER workspace’s schema (not the caller’s) → soft delete (204), never a hard delete', async () => {
      const target = await invitedVenueManager('c1-del-ws');
      await venueInWorkspace(mgrB, target.userId, 'C1 venue created by the target');

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(target.userId)).toBe(true);
    });

    it('ABUSE: history only in the pre-cutover core copy → soft delete, the row stays', async () => {
      const target = await invitedVenueManager('c1-del-core');
      await venueInCoreCopy(mgrB.workspaceId!, target.userId, 'C1 core-copy venue created by the target');

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(target.userId)).toBe(true);
    });

    it('ABUSE: a manager bound to another workspace finds the history in B’s schema too → soft delete', async () => {
      const target = await invitedVenueManager('c1-del-a');
      await venueInWorkspace(mgrB, target.userId, 'C1 venue (A caller)');

      const res = await deleteManager(mgrA, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(target.userId)).toBe(true);
    });

    it('ABUSE: a workspace of the organisation whose schema exists but is not READY cannot be verified → soft delete, never blind', async () => {
      const mgrC = await factory.createInternalManager({ id: orgId }, { permissions: MANAGER_PERMS, label: 'c1-c' });
      const target = await invitedVenueManager('c1-del-unverifiable');
      const [{ status: before }] = await adminDataSource.query<Array<{ status: string }>>(
        `SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [mgrC.workspaceId],
      );
      await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [mgrC.workspaceId]);
      try {
        const res = await deleteManager(ceo, target.profileId!);
        expect(res.status).toBe(204);
        expect(JSON.stringify(res.body ?? {})).not.toContain(mgrC.workspaceId!);
        expect(await userSoftDeleted(target.userId)).toBe(true);
      } finally {
        await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = $2 WHERE workspace_id = $1`, [mgrC.workspaceId, before]);
      }
    });

    it('ABUSE (review L1): the CEO cannot see a staff profile in workspace B; its shift assignment would cascade away → soft delete, profile and history stay', async () => {
      const target = await invitedVenueManager('c1-del-hidden-staff');
      const hiddenProfile = await staffHistoryInWorkspace(mgrB, target.userId, venueB);

      const orphansBefore = await profileOrphansInB();
      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      await expectHiddenProfileOutcome(target.userId);
      expect(await staffProfileExists(mgrB.workspaceId!, hiddenProfile)).toBe(true);
      const assignments = await adminDataSource.query(`SELECT 1 FROM "${businessSchema(mgrB.workspaceId!)}".shift_assignment WHERE staff_profile_id = $1`, [hiddenProfile]);
      expect(assignments).toHaveLength(1);
      // F2 (b): soft delete, so no orphan appears (the daily orphan report stays as it was).
      expect(await profileOrphansInB()).toBe(orphansBefore);
      await dropHiddenProfile(hiddenProfile);
    });

    it('ABUSE (security review L1): a hidden staff profile whose ONLY history is a shift-request row (cascades with it) → soft delete, both stay', async () => {
      const target = await invitedVenueManager('c1-del-hidden-request');
      const hiddenProfile = await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, async (m) => {
        const [profile] = await m.query<Array<{ id: string }>>(
          `INSERT INTO staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [orgId, target.userId, `STF-${randomUUID().slice(0, 8)}`, mgrB.userId, mgrB.workspaceId],
        );
        const jobRole = await m.save(JobRole, { organisationId: orgId, name: `C1 L1 Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: mgrB.userId, workspaceId: mgrB.workspaceId! });
        const startsAt = new Date(Date.now() + 120 * 3600 * 1000);
        const shift = await m.save(Shift, {
          organisationId: orgId, venueId: venueB, jobRoleId: jobRole.id, startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3600 * 1000), breakMinutes: 0,
          requiredCount: 1, payRatePence: 1500, status: 'open', createdBy: mgrB.userId, workspaceId: mgrB.workspaceId!,
        });
        await m.query(`INSERT INTO shift_request_staff (organisation_id, workspace_id, shift_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [orgId, mgrB.workspaceId, shift.id, profile!.id]);
        return profile!.id;
      });

      const orphansBefore = await profileOrphansInB();
      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      await expectHiddenProfileOutcome(target.userId);
      expect(await staffProfileExists(mgrB.workspaceId!, hiddenProfile)).toBe(true);
      expect(await adminDataSource.query(`SELECT 1 FROM "${businessSchema(mgrB.workspaceId!)}".shift_request_staff WHERE staff_profile_id = $1`, [hiddenProfile])).toHaveLength(1);
      // F2 (b): soft delete, so no orphan appears (the daily orphan report stays as it was).
      expect(await profileOrphansInB()).toBe(orphansBefore);
      await dropHiddenProfile(hiddenProfile);
    });

    it('ABUSE (review L1): a note ABOUT the target (user_note.subject_user_id cascades) is history → soft delete, the note stays', async () => {
      const target = await invitedVenueManager('c1-del-note');
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, async (m) => {
        if (hwsOn) {
          await m.query(`INSERT INTO user_note (organisation_id, subject_user_id, author_user_id, body, workspace_id) VALUES ($1, $2, $3, 'C1 note', $4)`, [orgId, target.userId, mgrB.userId, mgrB.workspaceId]);
        } else {
          await m.query(`INSERT INTO user_note (organisation_id, subject_user_id, author_user_id, body) VALUES ($1, $2, $3, 'C1 note')`, [orgId, target.userId, mgrB.userId]);
        }
      });

      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userSoftDeleted(target.userId)).toBe(true);
      expect(await adminDataSource.query(`SELECT 1 FROM "${businessSchema(mgrB.workspaceId!)}".user_note WHERE subject_user_id = $1`, [target.userId])).toHaveLength(1);
    });

    it('ABUSE (re-review N4): a reference with no ON DELETE that no pre-delete check reads (shift.approved_by) → soft delete, and the constraint is logged by name', async () => {
      const target = await invitedVenueManager('c1-del-approved-by');
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: mgrB.workspaceId, userId: mgrB.userId, role: '' }, async (m) => {
        const jobRole = await m.save(JobRole, { organisationId: orgId, name: `C1 N4 Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: mgrB.userId, workspaceId: mgrB.workspaceId! });
        const startsAt = new Date(Date.now() + 96 * 3600 * 1000);
        await m.save(Shift, {
          organisationId: orgId, venueId: venueB, jobRoleId: jobRole.id, startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3600 * 1000), breakMinutes: 0,
          requiredCount: 1, payRatePence: 1500, status: 'open', createdBy: mgrB.userId, approvedBy: target.userId, workspaceId: mgrB.workspaceId!,
        });
      });
      const log = jest.spyOn(Logger.prototype, 'log');
      try {
        const res = await deleteManager(ceo, target.profileId!);
        expect(res.status).toBe(204);
        expect(JSON.stringify(res.body ?? {})).not.toMatch(/foreign key|violates|approved_by/i);
        expect(await userSoftDeleted(target.userId)).toBe(true);
        const lines = log.mock.calls.map((c) => String(c[0]));
        // Part D 0a: the application probe of the former no-ON-DELETE columns finds the reference before any data is touched (Q3),
        // HWS on (no shift_approved_by_fkey in the workspace schema) and off (core copy). The 23503 fallback classifier itself is
        // exercised by ws-core-fk-app-enforcement (a payslip still needing the profile → foreign_key:payslip_staff_id_fkey).
        expect(lines).toContainEqual(expect.stringMatching(/^user hard delete not safe \(history:shift\.approved_by\)/));
        expect(lines.join('\n')).not.toContain(target.userId); // identifiers of the schema only, never row data
      } finally {
        log.mockRestore();
      }
    });

    it('deleteUser restores rab.workspace_id and search_path to their values on entry, on the hard path and on the soft fallback (review L4)', async () => {
      await purgeStaffHistoryInB(); // F2 (b): the CEO cannot see B's staff; their history would make the hard delete unsafe
      for (const caller of [ceo, mgrB]) {
        for (const withHistory of [false, true]) {
          const target = await invitedVenueManager(`c1-del-gucs-${withHistory ? 'hist' : 'clean'}`);
          if (withHistory) await venueInWorkspace(mgrB, target.userId, 'C1 venue (gucs)');
          const ctx = { organisationId: orgId, workspaceId: caller.workspaceId, userId: caller.userId, role: '' };
          const outcome = await tenantContext.runInTenantContext(ctx, async (m) => {
            const read = () => m.query<Array<{ ws: string | null; sp: string }>>(`SELECT current_setting('rab.workspace_id', true) AS ws, current_setting('search_path') AS sp`);
            const [before] = await read();
            const result = await userDeletion.deleteUser(m, ctx, target.userId);
            const [after] = await read();
            expect(after).toEqual(before);
            return result;
          });
          expect(outcome).toBe(withHistory ? 'soft_deleted' : 'hard_deleted');
          expect(await userExists(target.userId)).toBe(withHistory);
        }
      }
    });

    it('control: a never-activated Venue Manager invite with no history anywhere is hard-deleted (204)', async () => {
      await purgeStaffHistoryInB(); // F2 (b): the CEO cannot see B's staff; their history would make the hard delete unsafe
      const target = await invitedVenueManager('c1-del-clean');
      const res = await deleteManager(ceo, target.profileId!);
      expect(res.status).toBe(204);
      expect(await userExists(target.userId)).toBe(false);
    });
  });
});
