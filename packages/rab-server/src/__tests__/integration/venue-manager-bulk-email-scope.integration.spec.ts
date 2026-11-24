import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { VenueManagerService } from '../../modules/manager/services/venue-manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Owner decision 1 (2026-11-21, #248 review L-2): `ManagerService.bulkEmail` called with the Venue Manager route's flag
 * (`venue_manager.create`) emails ONLY Venue Managers of the caller's own workspace. Every other id (an Internal Manager,
 * the CEO, another workspace's Venue Manager, an unknown id) is skipped: never emailed, only counted. The batch is not
 * refused, and the response is two counts, never ids, so it says nothing about which ids exist.
 *
 * The caller is a CEO that CAN see the Internal Manager under RLS (the `/managers` flag emails it: positive control) and
 * holds `venue_manager.create` through a real per-user grant override, with a workspace. Every call goes to the SERVICE
 * directly (no PermissionGuard, no VenueManagerService pre-filter), as a job, CLI command or another service would.
 * Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Venue Manager bulk email skips out-of-scope recipients (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let managers: ManagerService;
  let venueManagers: VenueManagerService;

  let orgA: string;
  let ceoA: TestIdentity; // CEO with a workspace; venue_manager.create granted per test
  let mgrA: TestIdentity; // Internal Manager with its own workspace (owner of otherVmA)
  let internalA: TestIdentity; // Internal Manager: never reachable with the Venue Manager flag
  let ownVmA: TestIdentity; // Venue Manager in ceoA's own workspace (the only one in reach)
  let ownVm2A: TestIdentity; // a second own-workspace Venue Manager
  let otherVmA: TestIdentity; // Venue Manager in mgrA's workspace (another workspace)
  let orgBVm: TestIdentity; // a Venue Manager of ANOTHER organisation

  const ctxOf = (identity: TestIdentity, overrides: Partial<AuthContext> = {}): AuthContext => ({
    organisationId: identity.organisationId,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    role: 'manager',
    ...overrides,
  });

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

  /** Outbox rows a send with `subject` wrote, in ANY organisation, read as the fixture superuser (not narrowed by RLS). */
  async function outboxFor(subject: string): Promise<Array<{ target: string; recipient: string; org: string }>> {
    return (await admin.query(
      `SELECT target_user_id AS target, recipient_email AS recipient, organisation_id AS org
         FROM core.email_outbox WHERE rendered_subject = $1 ORDER BY recipient_email`,
      [subject],
    )) as Array<{ target: string; recipient: string; org: string }>;
  }

  /** The email.sent audit rows a send with `subject` wrote (the subject is in the metadata). */
  async function auditFor(subject: string): Promise<Array<{ target: string | null; metadata: Record<string, unknown> }>> {
    return (await admin.query(
      `SELECT target_user_id AS target, metadata FROM core.audit_log
        WHERE organisation_id = $1 AND actor_user_id = $2 AND action = 'email.sent' AND metadata->>'subject' = $3`,
      [orgA, ceoA.userId, subject],
    )) as Array<{ target: string | null; metadata: Record<string, unknown> }>;
  }

  const subjectOf = (label: string) => `vm-bulk-${label}-${randomUUID()}`;

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
    venueManagers = moduleRef.get(VenueManagerService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmbulk-a' });
    orgA = seeded.organisation.id;
    mgrA = seeded.managers[0]!;
    ceoA = await factory.createCeo(seeded.organisation);
    internalA = await factory.createInternalManager(seeded.organisation, { label: 'vmbulk-a-internal' });
    ownVmA = await factory.createVenueManager(seeded.organisation, { owner: ceoA, label: 'vmbulk-a-own-vm' });
    ownVm2A = await factory.createVenueManager(seeded.organisation, { owner: ceoA, label: 'vmbulk-a-own-vm2' });
    otherVmA = await factory.createVenueManager(seeded.organisation, { owner: mgrA, label: 'vmbulk-a-other-vm' });

    const seededB = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmbulk-b' });
    orgBVm = await factory.createVenueManager(seededB.organisation, { owner: seededB.managers[0]!, label: 'vmbulk-b-vm' });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('positive control: with the /managers flag the same caller CAN email the Internal Manager (it is visible under RLS)', async () => {
    const subject = subjectOf('managers-flag');
    const result = await managers.bulkEmail(ctxOf(ceoA), { userIds: [internalA.profileId!], subject, message: 'hello' });
    expect(result).toEqual({ queued: 1, skipped: 0 });
    expect((await outboxFor(subject)).map((r) => r.target)).toEqual([internalA.userId]);
  });

  it('with venue_manager.create: only own-workspace Venue Managers are emailed; the Internal Manager, the CEO, another workspace\'s and another organisation\'s Venue Manager and an unknown id are skipped and counted', async () => {
    const subject = subjectOf('mixed');
    const userIds = [ownVmA.profileId!, internalA.profileId!, ceoA.profileId!, otherVmA.profileId!, orgBVm.profileId!, randomUUID(), ownVm2A.profileId!];
    const result = await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      managers.bulkEmail(ctxOf(ceoA), { userIds, subject, message: 'hello' }, PermissionFlag.VENUE_MANAGER_CREATE),
    );
    // Exactly two counts: no ids, no per-recipient status, nothing that tells an existing id from an unknown one.
    expect(result).toEqual({ queued: 2, skipped: 5 });
    expect(Object.keys(result).sort()).toEqual(['queued', 'skipped']);
    const sent = await outboxFor(subject);
    expect(sent.map((r) => r.target).sort()).toEqual([ownVmA.userId, ownVm2A.userId].sort());
    expect(sent.map((r) => r.recipient).sort()).toEqual([ownVmA.email, ownVm2A.email].sort());
    expect(sent.every((r) => r.org === orgA)).toBe(true);
    for (const outOfScope of [internalA, ceoA, otherVmA, orgBVm]) {
      expect(sent.some((r) => r.target === outOfScope.userId || r.recipient === outOfScope.email)).toBe(false);
    }
    // One audit row: counts only, no out-of-scope identity.
    const audit = await auditFor(subject);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ bulkEmail: true, recipientCount: 2, skipped: 5 });
    const auditText = JSON.stringify(audit);
    for (const outOfScope of [internalA, otherVmA, orgBVm]) {
      expect(auditText).not.toContain(outOfScope.userId);
      expect(auditText).not.toContain(outOfScope.profileId!);
      expect(auditText).not.toContain(outOfScope.email);
    }
  });

  it('with venue_manager.create and only out-of-scope ids: nothing is emailed, every id is skipped, no error', async () => {
    const subject = subjectOf('all-out');
    const userIds = [internalA.profileId!, otherVmA.profileId!, orgBVm.profileId!, randomUUID()];
    const result = await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      managers.bulkEmail(ctxOf(ceoA), { userIds, subject, message: 'hello' }, PermissionFlag.VENUE_MANAGER_CREATE),
    );
    expect(result).toEqual({ queued: 0, skipped: 4 });
    expect(await outboxFor(subject)).toEqual([]);
  });

  it('an existing out-of-scope id and an unknown id give the same answer (no existence oracle)', async () => {
    const run = (id: string) =>
      withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
        managers.bulkEmail(ctxOf(ceoA), { userIds: [id], subject: subjectOf('oracle'), message: 'hello' }, PermissionFlag.VENUE_MANAGER_CREATE),
      );
    const existing = await run(internalA.profileId!);
    const unknown = await run(randomUUID());
    expect(existing).toEqual(unknown);
    expect(existing).toEqual({ queued: 0, skipped: 1 });
  });

  it('with venue_manager.create and no workspace in the context: even the caller\'s own Venue Manager is skipped, nothing is emailed', async () => {
    const subject = subjectOf('no-workspace');
    const result = await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () =>
      managers.bulkEmail(ctxOf(ceoA, { workspaceId: null }), { userIds: [ownVmA.profileId!, internalA.profileId!], subject, message: 'hello' }, PermissionFlag.VENUE_MANAGER_CREATE),
    );
    expect(result).toEqual({ queued: 0, skipped: 2 });
    expect(await outboxFor(subject)).toEqual([]);
  });

  it('VenueManagerService.bulkEmail (the web route\'s service) gives the same counts: no double counting after the second filter', async () => {
    const subject = subjectOf('route');
    const userIds = [ownVmA.profileId!, internalA.profileId!, otherVmA.profileId!, randomUUID()];
    const result = await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, () => venueManagers.bulkEmail(ctxOf(ceoA), { userIds, subject, message: 'hello' }));
    expect(result).toEqual({ queued: 1, skipped: 3 });
    expect((await outboxFor(subject)).map((r) => r.target)).toEqual([ownVmA.userId]);
  });
});
