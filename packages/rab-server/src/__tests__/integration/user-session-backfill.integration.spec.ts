import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { UserSessionBackfillService } from '../../engine/core-modules/auth/token/backfill/user-session-backfill.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { SessionValidityService } from '../../engine/core-modules/auth/services/session-validity.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * P1B — `UserSessionBackfillService`, proven against the real local database. Simulates
 * "pre-P1B" refresh-token families (inserted directly, bypassing `RefreshTokenService.issue()`,
 * so no `user_session` row exists for them — exactly what every family logged in before this
 * phase shipped looks like) and backfills them.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('UserSessionBackfillService (P1B)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let staffA: TestIdentity;
  let backfill: UserSessionBackfillService;
  let ownerDataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    org = await factory.createOrganisation('p1b-backfill');
    managerA = await factory.createInternalManager(org);
    staffA = await factory.createStaff(org, { owner: managerA });

    // Owner DataSource dedicated to this suite — never the pooled app DataSource — matching the
    // CLI command's own convention (DATABASE_URL_UNPOOLED).
    ownerDataSource = createAdminDataSource();
    await ownerDataSource.initialize();
    backfill = new UserSessionBackfillService();
    backfill.ownerDataSource = ownerDataSource;
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
    await ownerDataSource.destroy();
  });

  function hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Inserts a raw refresh_token row directly — bypassing RefreshTokenService.issue() entirely, so no user_session row is created. Simulates a real pre-P1B login. */
  async function insertLegacyToken(params: {
    familyId: string;
    userId: string;
    organisationId: string;
    applicationTarget?: string;
    createdAt: Date;
    expiresAt: Date;
    familyExpiresAt: Date;
    revokedAt?: Date | null;
    deviceId?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await adminDataSource.query(
      `INSERT INTO core.refresh_token
         (id, organisation_id, user_id, token_hash, application_target, family_id, device_id, user_agent, ip,
          expires_at, revoked_at, created_at, family_expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
      [
        params.organisationId,
        params.userId,
        hash(randomBytes(16).toString('hex')),
        params.applicationTarget ?? 'manager_web',
        params.familyId,
        params.deviceId ?? null,
        params.userAgent ?? null,
        params.expiresAt,
        params.revokedAt ?? null,
        params.createdAt,
        params.familyExpiresAt,
      ],
    );
  }

  async function userSessionRowAsOwner(userId: string, id: string): Promise<Record<string, unknown> | undefined> {
    return ownerDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, userId]);
      const [row] = await manager.query(`SELECT * FROM core.user_session WHERE id = $1`, [id]);
      return row;
    });
  }

  /**
   * P1C: this suite runs against the same real, long-lived shared local dev database every other
   * phase this session has used — now past 1900 accumulated historical refresh_token families
   * (confirmed directly, not assumed). `findCandidates` orders by `family_id` (a random UUID), so
   * a fixed `batchSize: 1000` is no longer guaranteed to include a just-inserted family at all —
   * test 8 already discovered and worked around this exact growth for its own assertion; sizing
   * EVERY other test's own batch to the current total (+10 margin) makes the whole file robust to
   * the database's continued growth, not just that one test.
   */
  async function sufficientBatchSize(): Promise<number> {
    return (await backfill.verify()).totalFamilies + 10;
  }

  it('1: a LIVE legacy family backfills to an ACTIVE (not revoked) user_session', async () => {
    const familyId = randomUUID();
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await insertLegacyToken({
      familyId,
      userId: managerA.userId,
      organisationId: org.id,
      applicationTarget: 'manager_web',
      createdAt: now,
      expiresAt: familyExpiresAt,
      familyExpiresAt,
      deviceId: 'legacy-device-1',
      userAgent: 'legacy-ua',
    });

    const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('inserted');

    const session = await userSessionRowAsOwner(managerA.userId, familyId);
    expect(session).toBeDefined();
    expect(session!.revoked_at).toBeNull();
    expect(session!.device_id).toBe('legacy-device-1');
    expect(new Date(session!.absolute_expires_at as string).getTime()).toBe(familyExpiresAt.getTime());
  });

  it('2: a family with an explicit revocation backfills to a REVOKED session, reason=backfill_revoked, using the latest revoked_at', async () => {
    const familyId = randomUUID();
    const now = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // created 10 days ago
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // already past (expired AND revoked)
    const revokedAt = new Date(now.getTime() + 60 * 60 * 1000); // revoked 1h after creation
    await insertLegacyToken({
      familyId,
      userId: staffA.userId,
      organisationId: org.id,
      applicationTarget: 'staff_app',
      createdAt: now,
      expiresAt: familyExpiresAt,
      familyExpiresAt,
      revokedAt,
    });

    const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('inserted');

    const session = await userSessionRowAsOwner(staffA.userId, familyId);
    expect(session!.revoked_at).not.toBeNull();
    expect(session!.revoked_reason).toBe('backfill_revoked');
    expect(new Date(session!.revoked_at as string).getTime()).toBe(revokedAt.getTime());
    // Never extends the deadline: absolute_expires_at is still the family's own (already past) deadline.
    expect(new Date(session!.absolute_expires_at as string).getTime()).toBe(familyExpiresAt.getTime());
  });

  it('3: a family that simply timed out (never explicitly revoked) backfills to REVOKED, reason=backfill_expired, at exactly its own deadline', async () => {
    const familyId = randomUUID();
    const now = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // long past, never revoked
    await insertLegacyToken({
      familyId,
      userId: managerA.userId,
      organisationId: org.id,
      applicationTarget: 'manager_web',
      createdAt: now,
      expiresAt: familyExpiresAt,
      familyExpiresAt,
    });

    const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('inserted');

    const session = await userSessionRowAsOwner(managerA.userId, familyId);
    expect(session!.revoked_at).not.toBeNull();
    expect(session!.revoked_reason).toBe('backfill_expired');
    expect(new Date(session!.revoked_at as string).getTime()).toBe(familyExpiresAt.getTime());
  });

  it('4: a family with conflicting user_id across its own rows fails closed — never written', async () => {
    const familyId = randomUUID();
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await insertLegacyToken({ familyId, userId: managerA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });
    await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

    const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('skipped-inconsistent');
    expect(result.failedClosed).toBeGreaterThanOrEqual(1);

    // Never written — ownerDataSource under EITHER identity sees nothing for this id.
    const asManager = await userSessionRowAsOwner(managerA.userId, familyId);
    const asStaff = await userSessionRowAsOwner(staffA.userId, familyId);
    expect(asManager).toBeUndefined();
    expect(asStaff).toBeUndefined();
  });

  it('5: a family with conflicting family_expires_at across its own rows also fails closed', async () => {
    const familyId = randomUUID();
    const now = new Date();
    const deadlineA = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const deadlineB = new Date(now.getTime() + 48 * 60 * 60 * 1000); // disagrees
    await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, createdAt: now, expiresAt: deadlineA, familyExpiresAt: deadlineA });
    await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, createdAt: now, expiresAt: deadlineB, familyExpiresAt: deadlineB });

    const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('skipped-inconsistent');
  });

  it('6: dry-run performs zero writes', async () => {
    const familyId = randomUUID();
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await insertLegacyToken({ familyId, userId: managerA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

    const result = await backfill.run({ dryRun: true, batchSize: await sufficientBatchSize() });
    const outcome = result.families.find((f) => f.familyId === familyId);
    expect(outcome?.outcome).toBe('dry-run-would-insert');

    const session = await userSessionRowAsOwner(managerA.userId, familyId);
    expect(session).toBeUndefined();
  });

  it('7: idempotency — re-running after a successful backfill reports already-present, never duplicates', async () => {
    const familyId = randomUUID();
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, applicationTarget: 'staff_app', createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

    const first = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    expect(first.families.find((f) => f.familyId === familyId)?.outcome).toBe('inserted');

    const second = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
    expect(second.families.find((f) => f.familyId === familyId)?.outcome).toBe('already-present');

    const rows = await ownerDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, staffA.userId]);
      return manager.query(`SELECT count(*)::int AS n FROM core.user_session WHERE id = $1`, [familyId]);
    });
    expect(rows[0].n).toBe(1); // never duplicated
  });

  it('8: verify() is internally consistent and correctly counts a FRESH, fully-consistent family as backfilled', async () => {
    // This suite runs against the real, long-lived shared local dev database, which — across many
    // earlier, unrelated test phases in this same session — has accumulated genuinely malformed
    // historical rows (e.g. `family_expires_at` deliberately backdated before `created_at` to
    // simulate "already expired" in other suites' own fixtures). verify()'s `missing` count
    // correctly includes those — they are REFUSED by design (item 4/5 above), not silently
    // backfilled — so asserting a global `missing === 0` across the WHOLE database's history
    // would be both false and the wrong thing to assert. What's actually being proven here:
    // verify()'s own fields agree with each other, and a BRAND NEW, fully-consistent family added
    // right now is correctly counted as backfilled by the very next run()+verify() pass.
    const before = await backfill.verify();
    expect(before.pass).toBe(before.missing === 0);
    expect(before.totalFamilies).toBeGreaterThan(0);
    expect(before.backfilled + before.missing).toBe(before.totalFamilies);

    const familyId = randomUUID();
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await insertLegacyToken({ familyId, userId: managerA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

    // Ordered by family_id (a random UUID) — with this shared database's large accumulated
    // history, a fixed 1000-row batch is not guaranteed to include a just-inserted family at all.
    // A batch sized to the full current total guarantees it does, for this specific assertion.
    await backfill.run({ dryRun: false, batchSize: before.totalFamilies + 10 });
    const after = await backfill.verify();
    // >= rather than strict equality: this is the real, shared local dev database, which may have
    // other live local activity (e.g. a running rab-server/worker container) minting its own
    // ordinary sessions concurrently — the one claim that matters is that THIS family specifically
    // is now backfilled, checked directly below, not a brittle exact global delta.
    expect(after.totalFamilies).toBeGreaterThanOrEqual(before.totalFamilies + 1);
    expect(after.backfilled).toBeGreaterThanOrEqual(before.backfilled + 1);

    const session = await userSessionRowAsOwner(managerA.userId, familyId);
    expect(session).toBeDefined();
    expect(session!.revoked_at).toBeNull();
  });

  it('9: run() without an owner DataSource set throws UserSessionBackfillError', async () => {
    const orphan = new UserSessionBackfillService();
    await expect(orphan.run({ dryRun: true, batchSize: 10 })).rejects.toThrow(/owner.*DataSource/i);
    await expect(orphan.verify()).rejects.toThrow(/owner.*DataSource/i);
  });

  // ================================================================================================ P1B.1 ENFORCEMENT CUTOVER (item 2)
  describe('P1B.1 — UserSession enforcement cutover (USER_SESSION_ENFORCEMENT_CUTOVER)', () => {
    /** Same technique as hws-backfill.integration.spec.ts's own `hwsOnEnvironment` stub — the real
     * `SessionValidityService` class, constructed directly with a stub `EnvironmentService` (ConfigService
     * caches validated env at module init, so toggling `process.env` after boot wouldn't reach the
     * already-running app's own instance anyway), never a mock of the service itself. */
    function stubEnv(cutover: boolean): EnvironmentService {
      return { get: (key: string) => (key === 'USER_SESSION_ENFORCEMENT_CUTOVER' ? cutover : undefined) } as unknown as EnvironmentService;
    }

    async function assertActiveAs(cutover: boolean, familyId: string, userId: string): Promise<void> {
      const sessionValidity = new SessionValidityService(stubEnv(cutover));
      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId, role: '' }, (manager) =>
        sessionValidity.assertActive(manager, { userId, organisationId: org.id, sid: familyId }),
      );
    }

    it('PRE-CUTOVER (default): a live legacy family with NO matching user_session row is still accepted', async () => {
      const familyId = randomUUID();
      const now = new Date();
      const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await insertLegacyToken({ familyId, userId: managerA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

      const session = await userSessionRowAsOwner(managerA.userId, familyId);
      expect(session).toBeUndefined(); // confirms this really is a "missing row" case, not an already-backfilled one

      await expect(assertActiveAs(false, familyId, managerA.userId)).resolves.toBeUndefined();
    });

    it('POST-CUTOVER: the exact same missing-row family is now denied', async () => {
      const familyId = randomUUID();
      const now = new Date();
      const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, applicationTarget: 'staff_app', createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

      const session = await userSessionRowAsOwner(staffA.userId, familyId);
      expect(session).toBeUndefined();

      await expect(assertActiveAs(true, familyId, staffA.userId)).rejects.toThrow('Please sign in again.');
    });

    it('POST-CUTOVER: a revoked user_session is denied (same as pre-cutover — revocation always denies, regardless of mode)', async () => {
      const familyId = randomUUID();
      const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const familyExpiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // still live by refresh_token's own deadline
      const revokedAt = new Date();
      await insertLegacyToken({ familyId, userId: managerA.userId, organisationId: org.id, createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt, revokedAt: null });
      // Backfill it to an ACTIVE row first (the family itself is still "live" by refresh_token's
      // own deadline — see insertLegacyToken's revokedAt:null above — so it backfills active),
      // then explicitly revoke the user_session row directly, simulating ProfileService
      // .revokeSession/logout/reuse-detection's own real effect.
      await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
      await ownerDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, managerA.userId]);
        await manager.query(
          `UPDATE core.user_session SET revoked_at = $2, revoked_reason = 'test_revoked', security_version = security_version + 1 WHERE id = $1 AND revoked_at IS NULL`,
          [familyId, revokedAt],
        );
      });

      await expect(assertActiveAs(false, familyId, managerA.userId)).rejects.toThrow('Please sign in again.');
      await expect(assertActiveAs(true, familyId, managerA.userId)).rejects.toThrow('Please sign in again.');
    });

    it('backfill completed → strict (post-cutover) mode can then be enabled safely for that family', async () => {
      const familyId = randomUUID();
      const now = new Date();
      const familyExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await insertLegacyToken({ familyId, userId: staffA.userId, organisationId: org.id, applicationTarget: 'staff_app', createdAt: now, expiresAt: familyExpiresAt, familyExpiresAt });

      // Before backfill: post-cutover would deny this family (proven by the test above) — this is
      // exactly why the brief requires backfill to be VERIFIED complete before flipping the flag.
      const result = await backfill.run({ dryRun: false, batchSize: await sufficientBatchSize() });
      expect(result.families.find((f) => f.familyId === familyId)?.outcome).toBe('inserted');

      // After backfill, the SAME family is now accepted under BOTH modes.
      await expect(assertActiveAs(false, familyId, staffA.userId)).resolves.toBeUndefined();
      await expect(assertActiveAs(true, familyId, staffA.userId)).resolves.toBeUndefined();
    });
  });
});
