import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditAction } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { EmailChangeService } from '../../modules/identity/services/email-change.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 review L-1 follow-up: every ManagerService method that accepts the Venue Manager route's flag
 * (`venue_manager.create`) pins the target, in the action's own transaction, to a `type: venue` profile of the caller's own
 * workspace: `update`, `setActive`, `resetPassword`, `changePendingEmail`, `changeEmail`, `getTimeline`, `listNotes`,
 * `addNote`, `listEmails`. Anything else is 404, nothing changes, and a read returns no data.
 *
 * The caller is a CEO that CAN see the Internal Manager target under RLS and holds `venue_manager.create` through a real
 * per-user grant override (plus `user.reset_password`), with a workspace: without the pin every refused call below would
 * succeed. Every call goes to the SERVICE directly (no PermissionGuard, no VenueManagerService gate), as a job, CLI
 * command or another service would. Step-up-gated methods use a real signed-in session, so only the pin can refuse.
 * Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Venue Manager route flag pins the target in every ManagerService method that accepts it (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let managers: ManagerService;

  let orgA: string;
  let ceoA: TestIdentity; // CEO with a workspace; venue_manager.create granted per test
  let mgrA: TestIdentity; // Internal Manager with its own workspace (owner of otherVmA)
  let internalA: TestIdentity; // ACTIVE Internal Manager: the target the Venue Manager flag must never reach
  let ownVmA: TestIdentity; // ACTIVE Venue Manager in ceoA's own workspace (positive control)
  let otherVmA: TestIdentity; // ACTIVE Venue Manager in mgrA's workspace (another workspace)
  let pendingInternalA: TestIdentity; // INVITED Internal Manager (pending-email / direct change-email target)
  let pendingOwnVmA: TestIdentity; // INVITED Venue Manager in ceoA's own workspace (positive control)
  let mgrB: TestIdentity; // a second Internal Manager with its own workspace (staff.edit caller, out of scope for mgrA's staff)
  let staffOfA: TestIdentity; // ACTIVE staff member created by mgrA in mgrA's workspace
  let emailChange: EmailChangeService;

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' });

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  /** Runs `fn` while `flag` is GRANTED to `identity` by a per-user override (removed afterwards, whatever happens). */
  async function withGranted<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = $3 RETURNING user_id`,
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

  /** Everything the pinned methods could write in the organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(): Promise<Record<string, unknown>> {
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT count(*) FROM core.password_reset_token WHERE organisation_id = $1)::int AS reset_tokens,
         (SELECT count(*) FROM core.refresh_token WHERE organisation_id = $1 AND revoked_at IS NOT NULL)::int AS revoked_refresh_tokens,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1)::int AS invites,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1 AND revoked_at IS NULL)::int AS live_invites,
         (SELECT count(*) FROM core.email_change_request WHERE organisation_id = $1)::int AS email_change_requests,
         (SELECT count(*) FROM ${businessTable(ceoA.workspaceId!, 'user_note')} WHERE organisation_id = $1)::int AS notes,
         (SELECT json_agg(json_build_object('id', id, 'email', email, 'first', first_name, 'last', last_name, 'phone', phone, 'status', status,
                                            'mustReset', must_reset_password, 'securityVersion', security_version) ORDER BY id)
            FROM core."user" WHERE organisation_id = $1) AS users,
         (SELECT json_agg(json_build_object('id', id, 'jobTitle', job_title, 'archived', archived_at) ORDER BY id)
            FROM core.manager_profile WHERE organisation_id = $1) AS profiles`,
      [orgA],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  async function expectNotFoundAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  }

  /** A read refused by the pin: 404, nothing returned, nothing written. */
  async function expectNotFoundNoDataAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    let returned: unknown = undefined;
    let error: unknown = undefined;
    try {
      returned = await call();
    } catch (e) {
      error = e;
    }
    expect(returned).toBeUndefined();
    expect(error).toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  }

  const setInvited = (identity: TestIdentity) => admin.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [identity.userId, UserStatus.INVITED]);
  const newEmail = (label: string) => `vmpin-${label}-${randomUUID()}@example.test`;

  async function auditActions(targetUserId: string, actions: string[]): Promise<string[]> {
    const rows = (await admin.query(
      `SELECT action FROM core.audit_log WHERE organisation_id = $1 AND target_user_id = $2 AND actor_user_id = $3 AND action = ANY($4) ORDER BY created_at, id`,
      [orgA, targetUserId, ceoA.userId, actions],
    )) as Array<{ action: string }>;
    return rows.map((r) => r.action);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    managers = moduleRef.get(ManagerService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmpin-a' });
    orgA = seeded.organisation.id;
    mgrA = seeded.managers[0]!;
    ceoA = await factory.createCeo(seeded.organisation);
    internalA = await factory.createInternalManager(seeded.organisation, { label: 'vmpin-a-internal' });
    ownVmA = await factory.createVenueManager(seeded.organisation, { owner: ceoA, label: 'vmpin-a-own-vm' });
    otherVmA = await factory.createVenueManager(seeded.organisation, { owner: mgrA, label: 'vmpin-a-other-vm' });
    pendingInternalA = await factory.createInternalManager(seeded.organisation, { label: 'vmpin-a-pending-internal', workspace: false });
    await setInvited(pendingInternalA);
    pendingOwnVmA = await factory.createVenueManager(seeded.organisation, { owner: ceoA, label: 'vmpin-a-pending-own-vm' });
    await setInvited(pendingOwnVmA);
    // Data the reads would return without the pin: a note on the Internal Manager (and its manager.note_added audit row),
    // written through the /managers flag.
    await managers.addNote(ctxOf(ceoA), internalA.profileId!, { body: 'Internal Manager note' } as never);
    emailChange = moduleRef.get(EmailChangeService);
    mgrB = await factory.createInternalManager(seeded.organisation, { permissions: 'production', label: 'vmpin-a-mgr-b' });
    staffOfA = await factory.createStaff(seeded.organisation, { owner: mgrA, label: 'vmpin-a-staff' });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('precondition: the caller CAN see the Internal Manager under RLS (the /managers route reads it), so only the pin can refuse below', async () => {
    expect(ceoA.workspaceId).toBeTruthy();
    expect((await managers.get(ctxOf(ceoA), internalA.profileId!)).id).toBe(internalA.profileId);
    expect((await managers.get(ctxOf(ceoA), pendingInternalA.profileId!)).id).toBe(pendingInternalA.profileId);
    expect((await managers.listNotes(ctxOf(ceoA), internalA.profileId!)).map((n) => n.body)).toContain('Internal Manager note');
    await expect(managers.getTimeline(ctxOf(ceoA), internalA.profileId!)).resolves.toEqual(expect.any(Array));
  });

  it('update with venue_manager.create on an Internal Manager → 404, nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      await expectNotFoundAndInert(() =>
        managers.update(ctxOf(ceoA), internalA.profileId!, { firstName: 'Pinned', jobTitle: 'Not a Venue Manager' } as never, PermissionFlag.VENUE_MANAGER_CREATE),
      );
    });
  });

  it('setActive with venue_manager.create on an Internal Manager → 404 (suspend and reactivate), nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.setActive(signedIn, internalA.profileId!, false, PermissionFlag.VENUE_MANAGER_CREATE));
      await expectNotFoundAndInert(() => managers.setActive(signedIn, internalA.profileId!, true, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('resetPassword with venue_manager.create on an Internal Manager → 404, no reset token, email, session revocation or audit row', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.resetPassword(signedIn, internalA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('the pin also refuses a CEO profile and another workspace\'s Venue Manager → 404, nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      for (const id of [ceoA.profileId!, otherVmA.profileId!]) {
        await expectNotFoundAndInert(() => managers.update(signedIn, id, { firstName: 'Pinned' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.setActive(signedIn, id, false, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.resetPassword(signedIn, id, PermissionFlag.VENUE_MANAGER_CREATE));
      }
    });
  });

  it('changePendingEmail with venue_manager.create on a pending Internal Manager → 404: no email change, invite or outbox row', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.changePendingEmail(signedIn, pendingInternalA.profileId!, { email: newEmail('cpe') }, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('changeEmail with venue_manager.create on an Internal Manager → 404, both the direct (invited) and the verified (active) path', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.changeEmail(signedIn, pendingInternalA.profileId!, { email: newEmail('ce-direct') } as never, PermissionFlag.VENUE_MANAGER_CREATE));
      await expectNotFoundAndInert(() =>
        managers.changeEmail(signedIn, internalA.profileId!, { email: newEmail('ce-verified'), currentPassword: ceoA.password } as never, PermissionFlag.VENUE_MANAGER_CREATE),
      );
    });
  });

  it('getTimeline with venue_manager.create on an Internal Manager → 404, no data returned', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      expectNotFoundNoDataAndInert(() => managers.getTimeline(ctxOf(ceoA), internalA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)),
    );
  });

  it('listNotes with venue_manager.create on an Internal Manager → 404, no data returned', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      expectNotFoundNoDataAndInert(() => managers.listNotes(ctxOf(ceoA), internalA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)),
    );
  });

  it('listEmails with venue_manager.create on an Internal Manager → 404, no data returned', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      expectNotFoundNoDataAndInert(() => managers.listEmails(ctxOf(ceoA), internalA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)),
    );
  });

  it('addNote with venue_manager.create on an Internal Manager → 404, no note and no audit row', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      await expectNotFoundAndInert(() => managers.addNote(ctxOf(ceoA), internalA.profileId!, { body: 'Should not land' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('positive control: with venue_manager.create the same caller corrects and changes a pending own-workspace Venue Manager email', async () => {
    const corrected = newEmail('own-cpe');
    const changed = newEmail('own-ce');
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      const sent = await managers.changePendingEmail(signedIn, pendingOwnVmA.profileId!, { email: corrected }, PermissionFlag.VENUE_MANAGER_CREATE);
      expect(sent.sendNumber).toBe(1);
      expect(await managers.changeEmail(signedIn, pendingOwnVmA.profileId!, { email: changed } as never, PermissionFlag.VENUE_MANAGER_CREATE)).toEqual({ email: changed });
    });
    const [user] = (await admin.query(`SELECT email FROM core."user" WHERE id = $1`, [pendingOwnVmA.userId])) as Array<{ email: string }>;
    expect(user!.email).toBe(changed);
  });

  it('positive control: with venue_manager.create the same caller adds a note to, and reads the timeline, notes and emails of, an own-workspace Venue Manager', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const ctx = ctxOf(ceoA);
      const note = await managers.addNote(ctx, ownVmA.profileId!, { body: 'Own Venue Manager note' } as never, PermissionFlag.VENUE_MANAGER_CREATE);
      expect(note.body).toBe('Own Venue Manager note');
      expect((await managers.listNotes(ctx, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)).map((n) => n.id)).toContain(note.id);
      await expect(managers.getTimeline(ctx, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)).resolves.toEqual(expect.any(Array));
      await expect(managers.listEmails(ctx, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE)).resolves.toEqual(expect.any(Array));
    });
  });

  it('positive control: the same caller with venue_manager.create updates, suspends, reactivates and resets a Venue Manager of its own workspace', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      const updated = await managers.update(signedIn, ownVmA.profileId!, { jobTitle: 'Floor lead' } as never, PermissionFlag.VENUE_MANAGER_CREATE);
      expect(updated.id).toBe(ownVmA.profileId);
      await managers.setActive(signedIn, ownVmA.profileId!, false, PermissionFlag.VENUE_MANAGER_CREATE);
      await managers.setActive(signedIn, ownVmA.profileId!, true, PermissionFlag.VENUE_MANAGER_CREATE);
      await managers.resetPassword(signedIn, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE);
    });
    const [profile] = (await admin.query(`SELECT job_title FROM core.manager_profile WHERE id = $1`, [ownVmA.profileId])) as Array<{ job_title: string | null }>;
    expect(profile!.job_title).toBe('Floor lead');
    const [user] = (await admin.query(`SELECT status, must_reset_password FROM core."user" WHERE id = $1`, [ownVmA.userId])) as Array<{ status: string; must_reset_password: boolean }>;
    expect(user).toEqual({ status: UserStatus.ACTIVE, must_reset_password: true });
    expect(await auditActions(ownVmA.userId, [AuditAction.ACCOUNT_SUSPENDED, AuditAction.ACCOUNT_REACTIVATED, AuditAction.ADMIN_PASSWORD_RESET])).toEqual([
      AuditAction.ACCOUNT_SUSPENDED,
      AuditAction.ACCOUNT_REACTIVATED,
      AuditAction.ADMIN_PASSWORD_RESET,
    ]);
  });

  it('the other six methods also refuse a CEO profile and another workspace\'s Venue Manager → 404 (reads return nothing), nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      for (const id of [ceoA.profileId!, otherVmA.profileId!]) {
        await expectNotFoundAndInert(() => managers.changePendingEmail(signedIn, id, { email: newEmail('cpe-out') }, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.changeEmail(signedIn, id, { email: newEmail('ce-out'), currentPassword: ceoA.password } as never, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.addNote(signedIn, id, { body: 'Out of scope' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundNoDataAndInert(() => managers.getTimeline(signedIn, id, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundNoDataAndInert(() => managers.listNotes(signedIn, id, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundNoDataAndInert(() => managers.listEmails(signedIn, id, PermissionFlag.VENUE_MANAGER_CREATE));
      }
    });
  });

  it('a context with no workspace gets 404 with the Venue Manager flag, even for the caller\'s own Venue Manager, nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const noWorkspace: AuthContext = { ...ctxOf(ceoA), workspaceId: null };
      await expectNotFoundAndInert(() => managers.update(noWorkspace, ownVmA.profileId!, { jobTitle: 'No workspace' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
      await expectNotFoundAndInert(() => managers.addNote(noWorkspace, ownVmA.profileId!, { body: 'No workspace' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
      await expectNotFoundNoDataAndInert(() => managers.getTimeline(noWorkspace, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE));
      const signedIn = { ...(await factory.signedInContext(ceoA)), workspaceId: null };
      await expectNotFoundAndInert(() =>
        emailChange.request(signedIn, { targetUserId: ownVmA.userId, newEmail: newEmail('req-nows'), currentPassword: ceoA.password, targetScope: 'venue_manager' }),
      );
    });
  });

  it('EmailChangeService.request with the Venue Manager scope on an Internal Manager or a CEO → 404: no request, email or audit row', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      for (const target of [internalA, ceoA]) {
        await expectNotFoundAndInert(() =>
          emailChange.request(signedIn, { targetUserId: target.userId, newEmail: newEmail('req-vm'), currentPassword: ceoA.password, targetScope: 'venue_manager' }),
        );
      }
      // The other workspace's Venue Manager is out of scope too.
      await expectNotFoundAndInert(() =>
        emailChange.request(signedIn, { targetUserId: otherVmA.userId, newEmail: newEmail('req-vm-other'), currentPassword: ceoA.password, targetScope: 'venue_manager' }),
      );
    });
  });

  it('EmailChangeService.request with the staff scope on a staff member another Manager created → 404, nothing changes', async () => {
    await withGranted(mgrB, PermissionFlag.STAFF_EDIT, async () => {
      const signedIn = await factory.signedInContext(mgrB);
      await expectNotFoundAndInert(() =>
        emailChange.request(signedIn, { targetUserId: staffOfA.userId, newEmail: newEmail('req-staff'), currentPassword: mgrB.password, targetScope: 'staff' }),
      );
    });
  });

  it('EmailChangeService.request fails closed on an unknown scope → 403 before anything is read', async () => {
    const signedIn = await factory.signedInContext(ceoA);
    const before = await snapshot();
    await expect(
      emailChange.request(signedIn, { targetUserId: ownVmA.userId, newEmail: newEmail('req-bogus'), currentPassword: ceoA.password, targetScope: 'anyone' as never }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await snapshot()).toEqual(before);
  });

  it('positive controls for the verified email change: an active own-workspace Venue Manager (changeEmail, Venue Manager flag) and the creator\'s own staff member (staff scope)', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      const result = await managers.changeEmail(signedIn, ownVmA.profileId!, { email: newEmail('own-verified'), currentPassword: ceoA.password } as never, PermissionFlag.VENUE_MANAGER_CREATE);
      expect(result).toMatchObject({ status: 'pending_verification', email: ownVmA.email });
    });
    await withGranted(mgrA, PermissionFlag.STAFF_EDIT, async () => {
      const signedIn = await factory.signedInContext(mgrA);
      const result = await emailChange.request(signedIn, { targetUserId: staffOfA.userId, newEmail: newEmail('own-staff'), currentPassword: mgrA.password, targetScope: 'staff' });
      expect(result).toMatchObject({ status: 'pending_verification', email: staffOfA.email });
    });
    const open = (await admin.query(
      `SELECT user_id FROM core.email_change_request WHERE organisation_id = $1 AND user_id = ANY($2) AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [orgA, [ownVmA.userId, staffOfA.userId]],
    )) as Array<{ user_id: string }>;
    expect(open.map((r) => r.user_id).sort()).toEqual([ownVmA.userId, staffOfA.userId].sort());
  });

  it('the /managers flag is unchanged: the CEO (manager.manage) still updates the Internal Manager', async () => {
    const updated = await managers.update(ctxOf(ceoA), internalA.profileId!, { jobTitle: 'Ops lead' } as never);
    expect(updated.id).toBe(internalA.profileId);
  });
});
