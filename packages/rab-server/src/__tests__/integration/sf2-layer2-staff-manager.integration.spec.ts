import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { VenueManagerService } from '../../modules/manager/services/venue-manager.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 (docs/plans/untangle/server-modules.md M3), part 1: the layer-2 (service) re-check of the route's own flag on the
 * StaffService, ManagerService and VenueManagerService methods that relied on the route guard alone.
 *
 * Every call goes to the SERVICE directly, never through HTTP, so no PermissionGuard is in the path: exactly how a job,
 * CLI command, AI tool or another service reaches it. The actor lacking the flag is the SAME identity with a real per-user
 * `revoke` override for that one flag (`core.user_permission_override`, which `PermissionsService.userHasPermissionTx`
 * honours): same workspace, same records, only the flag differs, so a refusal can only come from the new check. Each
 * refusal must be a ForbiddenException AND leave the organisation's rows exactly as they were (audit log, outbox, invites,
 * files, accounts, staff profiles, venue links). Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-2 layer-2 re-checks: staff, manager, venue manager (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let staff: StaffService;
  let managers: ManagerService;
  let venueManagers: VenueManagerService;
  let onboarding: OrganisationOnboardingService;
  let orgId: string;
  let a: TestIdentity; // owning Internal Manager, production permission set (no manager.manage)
  let ceo: TestIdentity; // CEO of the same organisation (holds manager.manage)
  let otherManager: TestIdentity; // an Internal Manager the CEO manages
  let pendingManager: TestIdentity; // a never-activated Internal Manager
  let staffMember: TestIdentity; // active staff in a's workspace
  let pendingStaff: TestIdentity; // invited staff in a's workspace
  let vm: TestIdentity; // Venue Manager in a's workspace, linked to venueId
  let platformAdmin: TestIdentity; // platform admin of ANOTHER organisation
  let venueId: string;

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' });

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  /** Runs `fn` while `flag` is revoked for `identity` by a per-user override; the override is removed afterwards, whatever happens. */
  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
      [identity.userId, identity.organisationId, flag],
    )) as unknown[];
    if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
    await bumpSecurityVersion(identity);
    try {
      return await fn();
    } finally {
      await admin.query(
        `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
        [identity.userId, flag],
      );
      await bumpSecurityVersion(identity);
    }
  }

  /** Everything a refused call could have written in this organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(): Promise<Record<string, unknown>> {
    const ws = a.workspaceId!;
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT count(*) FROM core.stored_file WHERE organisation_id = $1)::int AS files,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1)::int AS invites,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1 AND revoked_at IS NULL)::int AS live_invites,
         (SELECT json_agg(json_build_object('id', id, 'email', email, 'first', first_name, 'status', status, 'avatar', avatar_file_id, 'deleted', deleted_at) ORDER BY id)
            FROM core."user" WHERE organisation_id = $1) AS users,
         (SELECT json_agg(json_build_object('id', id, 'employment', employment_status) ORDER BY id)
            FROM ${businessTable(ws, 'staff_profile')} WHERE organisation_id = $1) AS staff,
         (SELECT json_agg(json_build_object('manager', manager_profile_id, 'venue', venue_id) ORDER BY manager_profile_id, venue_id)
            FROM ${businessTable(ws, 'manager_venue')} WHERE organisation_id = $1) AS links`,
      [orgId],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  /** The call is refused with 403 and nothing in the organisation changed. */
  async function expectRefusedAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(await snapshot()).toEqual(before);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    const tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    staff = moduleRef.get(StaffService);
    managers = moduleRef.get(ManagerService);
    venueManagers = moduleRef.get(VenueManagerService);
    onboarding = moduleRef.get(OrganisationOnboardingService);
    const venues = moduleRef.get(VenueService);

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'sf2a' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    otherManager = seeded.managers[1]!;
    ceo = await factory.createCeo(seeded.organisation);
    pendingManager = await factory.createInternalManager(seeded.organisation, { label: 'sf2a-pending' });
    await admin.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [pendingManager.userId, UserStatus.INVITED]);
    staffMember = await factory.createStaff(seeded.organisation, { owner: a, label: 'sf2a-staff' });
    pendingStaff = await factory.createStaff(seeded.organisation, { owner: a, label: 'sf2a-pending-staff', status: UserStatus.INVITED });
    venueId = (await venues.create(ctxOf(a), { name: `SF2 Venue ${randomUUID().slice(0, 8)}`, type: 'hotel' } as never)).id;
    vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'sf2a-vm' });
    const otherOrg = await factory.createOrganisationWithManagers(1, { firstIsPlatformAdmin: true, label: 'sf2a-padmin' });
    platformAdmin = otherOrg.managers[0]!;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── StaffService

  describe('StaffService', () => {
    it('reads without staff.view → 403 for an own record AND an unknown id (no existence oracle), nothing written', async () => {
      const ctxA = ctxOf(a);
      await withRevoked(a, PermissionFlag.STAFF_VIEW, async () => {
        await expectRefusedAndInert(() => staff.list(ctxA));
        for (const id of [staffMember.profileId!, randomUUID()]) {
          await expectRefusedAndInert(() => staff.get(ctxA, id));
          await expectRefusedAndInert(() => staff.getTimeline(ctxA, id));
          await expectRefusedAndInert(() => staff.listNotes(ctxA, id));
          await expectRefusedAndInert(() => staff.listEmails(ctxA, id));
        }
        // The Venue Manager directory reads: refused before the scope check (an Internal Manager is otherwise a 404 there).
        await expectRefusedAndInert(() => staff.venueDirectory(ctxA));
        await expectRefusedAndInert(() => staff.venueTeamMember(ctxA, staffMember.profileId!));
        await expectRefusedAndInert(() => staff.setVenueTeamTags(ctxA, staffMember.profileId!, { favourite: true }));
      });
    });

    it('with staff.view the same reads still work (behaviour unchanged)', async () => {
      const ctxA = ctxOf(a);
      expect((await staff.get(ctxA, staffMember.profileId!)).id).toBe(staffMember.profileId);
      expect((await staff.list(ctxA)).data.map((s) => s.id)).toContain(staffMember.profileId);
      await expect(staff.listNotes(ctxA, staffMember.profileId!)).resolves.toEqual(expect.any(Array));
    });

    it('create without staff.create → 403, no account, invite, outbox or audit row', async () => {
      await withRevoked(a, PermissionFlag.STAFF_CREATE, () =>
        expectRefusedAndInert(() => staff.create(ctxOf(a), { email: `sf2-new-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Staff' } as never)),
      );
    });

    it('edits without staff.edit → 403: update, avatar upload / removal and change-email leave every row as it was', async () => {
      await withRevoked(a, PermissionFlag.STAFF_EDIT, async () => {
        const ctxA = ctxOf(a);
        await expectRefusedAndInert(() => staff.update(ctxA, staffMember.profileId!, { firstName: 'Changed' } as never));
        await expectRefusedAndInert(() => staff.uploadAvatar(ctxA, staffMember.profileId!, Buffer.from('not-an-image')));
        await expectRefusedAndInert(() => staff.removeAvatar(ctxA, staffMember.profileId!));
        const signedIn = await factory.signedInContext(a); // change-email is step-up gated: a real grant, so only the flag refuses
        await expectRefusedAndInert(() => staff.changeEmail(signedIn, pendingStaff.profileId!, { email: `sf2-moved-${randomUUID()}@example.test` } as never));
      });
    });

    it('deactivate / reactivate without staff.deactivate → 403, employment and account status unchanged, no notice', async () => {
      await withRevoked(a, PermissionFlag.STAFF_DEACTIVATE, async () => {
        const signedIn = await factory.signedInContext(a);
        await expectRefusedAndInert(() => staff.deactivate(signedIn, staffMember.profileId!));
        await expectRefusedAndInert(() => staff.reactivate(signedIn, staffMember.profileId!));
      });
    });

    it('account actions without user.reset_password → 403: reset, resend, pending-email and cancel write nothing', async () => {
      await withRevoked(a, PermissionFlag.USER_RESET_PASSWORD, async () => {
        const signedIn = await factory.signedInContext(a);
        await expectRefusedAndInert(() => staff.resetPassword(signedIn, staffMember.profileId!));
        await expectRefusedAndInert(() => staff.resendInvite(signedIn, pendingStaff.profileId!));
        await expectRefusedAndInert(() => staff.changePendingEmail(signedIn, pendingStaff.profileId!, { email: `sf2-pending-${randomUUID()}@example.test` }));
        await expectRefusedAndInert(() => staff.cancelInvite(signedIn, pendingStaff.profileId!));
      });
    });
  });

  // ─────────────────────────────────────────────── ManagerService (/managers: manager.manage)

  describe('ManagerService', () => {
    it('reads without manager.manage → 403 for a real and an unknown id, nothing written', async () => {
      const ctxCeo = ctxOf(ceo);
      await withRevoked(ceo, PermissionFlag.MANAGER_MANAGE, async () => {
        await expectRefusedAndInert(() => managers.list(ctxCeo));
        for (const id of [otherManager.profileId!, randomUUID()]) {
          await expectRefusedAndInert(() => managers.get(ctxCeo, id));
          await expectRefusedAndInert(() => managers.getTimeline(ctxCeo, id));
          await expectRefusedAndInert(() => managers.listNotes(ctxCeo, id));
          await expectRefusedAndInert(() => managers.listEmails(ctxCeo, id));
        }
      });
    });

    it('with manager.manage the CEO still reads a manager (behaviour unchanged)', async () => {
      expect((await managers.get(ctxOf(ceo), otherManager.profileId!)).id).toBe(otherManager.profileId);
    });

    it('writes without manager.manage → 403: create, update, venue assign / unassign leave every row as it was', async () => {
      const ctxCeo = ctxOf(ceo);
      await withRevoked(ceo, PermissionFlag.MANAGER_MANAGE, async () => {
        await expectRefusedAndInert(() => managers.create(ctxCeo, { email: `sf2-mgr-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Manager', type: 'internal' } as never));
        await expectRefusedAndInert(() => managers.update(ctxCeo, otherManager.profileId!, { firstName: 'Changed' } as never));
        await expectRefusedAndInert(() => managers.assignVenue(ctxCeo, vm.profileId!, venueId));
        await expectRefusedAndInert(() => managers.unassignVenue(ctxCeo, vm.profileId!, venueId)); // the seeded link stays
      });
    });

    it('step-up-gated writes without manager.manage → 403: suspend, reset, pending-email, change-email write nothing', async () => {
      await withRevoked(ceo, PermissionFlag.MANAGER_MANAGE, async () => {
        const signedIn = await factory.signedInContext(ceo);
        await expectRefusedAndInert(() => managers.setActive(signedIn, otherManager.profileId!, false));
        await expectRefusedAndInert(() => managers.resetPassword(signedIn, otherManager.profileId!));
        await expectRefusedAndInert(() => managers.changePendingEmail(signedIn, pendingManager.profileId!, { email: `sf2-pm-${randomUUID()}@example.test` }));
        await expectRefusedAndInert(() => managers.changeEmail(signedIn, pendingManager.profileId!, { email: `sf2-pm2-${randomUUID()}@example.test` } as never));
      });
    });

    it('reset and pending-email also need the route\'s user.reset_password (manager.manage alone is not enough)', async () => {
      await withRevoked(ceo, PermissionFlag.USER_RESET_PASSWORD, async () => {
        const signedIn = await factory.signedInContext(ceo);
        await expectRefusedAndInert(() => managers.resetPassword(signedIn, otherManager.profileId!));
        await expectRefusedAndInert(() => managers.changePendingEmail(signedIn, pendingManager.profileId!, { email: `sf2-pm3-${randomUUID()}@example.test` }));
      });
    });

    it('a direct call made under the wrong route flag is refused: an Internal Manager (venue_manager.create, no manager.manage) cannot use the /managers default', async () => {
      await expectRefusedAndInert(() => managers.update(ctxOf(a), vm.profileId!, { firstName: 'Changed' } as never));
      await expectRefusedAndInert(() => managers.listNotes(ctxOf(a), vm.profileId!));
    });

    it('fails closed on any flag other than the two route flags (e.g. through an `as never` cast)', async () => {
      await expectRefusedAndInert(() => managers.update(ctxOf(ceo), otherManager.profileId!, { firstName: 'Changed' } as never, PermissionFlag.STAFF_VIEW as never));
    });

    it('platform-admin Admin Panel read still works: getOrganisation returns the CEO through getWithin (no role in the target organisation)', async () => {
      const summary = await onboarding.getOrganisation({ userId: platformAdmin.userId }, orgId);
      expect(summary.ceo?.email).toBe(ceo.email);
    });
  });

  // ─────────────────────────────────────────────── VenueManagerService (/venue-managers: venue_manager.create)

  describe('VenueManagerService and the Venue Manager delete path', () => {
    it('createInOwnWorkspace without venue_manager.create → 403, no account', async () => {
      await withRevoked(a, PermissionFlag.VENUE_MANAGER_CREATE, () =>
        expectRefusedAndInert(() => venueManagers.createInOwnWorkspace(ctxOf(a), { email: `sf2-vm-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Vm' } as never)),
      );
    });

    it('ManagerService.deleteVenueManagerUser re-checks venue_manager.create itself (no implicit call-order rule) → 403, the Venue Manager stays', async () => {
      await withRevoked(a, PermissionFlag.VENUE_MANAGER_CREATE, () =>
        expectRefusedAndInert(() => managers.deleteVenueManagerUser(ctxOf(a), vm.profileId!, a.password)),
      );
    });

    it('resend / cancel invite through the Venue Manager route need user.reset_password → 403, nothing written', async () => {
      await withRevoked(a, PermissionFlag.USER_RESET_PASSWORD, async () => {
        await expectRefusedAndInert(() => venueManagers.resendInvite(ctxOf(a), vm.profileId!));
        await expectRefusedAndInert(() => venueManagers.cancelInvite(ctxOf(a), vm.profileId!));
      });
    });

    it('the Venue Manager route passes its own flag to the shared methods: the workspace owner still reads and edits their Venue Manager', async () => {
      await expect(venueManagers.listNotes(ctxOf(a), vm.profileId!)).resolves.toEqual(expect.any(Array));
      const updated = await venueManagers.update(ctxOf(a), vm.profileId!, { jobTitle: 'Floor lead' } as never);
      expect(updated.id).toBe(vm.profileId);
    });
  });

  // ─────────────────────────────────────────────── HTTP path unchanged

  it('HTTP behaviour is unchanged: the route guard answers 403 first, 200 with the flag', async () => {
    const http = () => request(app.getHttpServer());
    const tokenA = await factory.login(a);
    await withRevoked(a, PermissionFlag.STAFF_VIEW, async () => {
      expect((await http().get(`/rest/v1/staff/${staffMember.profileId}`).set('Authorization', `Bearer ${tokenA}`)).status).toBe(403);
    });
    expect((await http().get(`/rest/v1/staff/${staffMember.profileId}`).set('Authorization', `Bearer ${tokenA}`)).status).toBe(200);
    const tokenCeo = await factory.login(ceo);
    expect((await http().get(`/rest/v1/managers/${otherManager.profileId}`).set('Authorization', `Bearer ${tokenCeo}`)).status).toBe(200);
    expect((await http().get('/rest/v1/managers').set('Authorization', `Bearer ${tokenA}`)).status).toBe(403);
  });
});
