import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.3, item 2 — refresh reuse retention).
 * Proves, against real Postgres, exactly the scenario the finalization instruction specified:
 *
 *   "A 90-day mobile family exists. An earlier token in that family was rotated/revoked. More
 *    than 30 days pass. Cleanup runs. The security evidence still exists. Replay of that old
 *    token still triggers reuse detection and family revocation. Also test cleanup after the
 *    new retention boundary."
 *
 * `core.worker_cleanup_auth_tokens` (migration `RefreshReuseRetentionExtension1786677900000`) is
 * invoked directly via SQL — exactly how `rab-worker`'s token-cleanup job calls it in production —
 * rather than waiting 31+ real days. Real time cannot be fast-forwarded, so rows are backdated by
 * direct UPDATE (the same technique `session-auth-correctness.integration.spec.ts` already uses
 * for `expires_at`/`family_expires_at`), then the REAL cleanup function and the REAL
 * `RefreshTokenService.rotate()` reuse-detection path (exercised end-to-end through the actual
 * `/rest/v1/auth/refresh` HTTP endpoint, not a unit mock) run against that backdated state.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('refresh token reuse-detection evidence retention (P0 finalization §8.3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const refreshWith = (token: string) => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

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
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  let org: Organisation;
  let staff: TestIdentity;

  beforeAll(async () => {
    org = await factory.createOrganisation('p0-retention');
    const owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });

    // `core.worker_cleanup_auth_tokens` operates table-wide, not scoped to this org — the same way
    // rab-worker's real cleanup job runs it in production. On a long-lived local test database, earlier
    // suite runs can leave already-past-retention rows behind (e.g. from this file's own 92-day-old
    // fixtures). Drain those here so the "nothing eligible is deleted yet" assertion below reflects THIS
    // test's fixtures only, deterministically, rather than depending on whatever stale rows happen to be
    // lying around from previous runs.
    await adminDataSource.query(`SELECT * FROM core.worker_cleanup_auth_tokens($1)`, [100000]);
  });

  /** Runs the REAL worker cleanup function exactly as rab-worker's cleanup job calls it. */
  async function runCleanup(): Promise<{ refresh_tokens_deleted: number; password_reset_tokens_deleted: number }> {
    const [row] = await adminDataSource.query(`SELECT * FROM core.worker_cleanup_auth_tokens($1)`, [1000]);
    return row;
  }

  async function tokenRowExists(token: string): Promise<boolean> {
    const rows = await adminDataSource.query(`SELECT 1 FROM core.refresh_token WHERE token_hash = $1`, [hashOf(token)]);
    return rows.length > 0;
  }

  it('a revoked token in a still-live 90-day family survives cleanup past 30 days, and replaying it still reuse-detects and revokes the family', async () => {
    // staff defaults to the staff_app target → a 90-day family (session-policy.ts).
    const { refreshToken: original } = await factory.loginTokens(staff);

    // Rotate once: `original` becomes revoked/replaced, a new successor is live. This is the
    // "earlier token in the family was rotated" step.
    const rotated = await refreshWith(original).expect(200);
    const successor = rotated.body.refreshToken as string;
    expect(await tokenRowExists(original)).toBe(true);

    // "More than 30 days pass" — backdate `original`'s revoked_at/created_at past the OLD 30-day
    // window but comfortably inside the new 91-day one, and inside the family's real 90-day ceiling.
    await adminDataSource.query(`UPDATE core.refresh_token SET revoked_at = now() - interval '40 days', created_at = now() - interval '40 days' WHERE token_hash = $1`, [
      hashOf(original),
    ]);

    // "Cleanup runs."
    const result = await runCleanup();

    // "The security evidence still exists."
    expect(await tokenRowExists(original)).toBe(true);
    // The successor (still live, never revoked) must never be touched by cleanup either.
    expect(await tokenRowExists(successor)).toBe(true);
    // Nothing in this org should have been eligible for deletion yet — 40 days is well inside 91.
    expect(result.refresh_tokens_deleted).toBe(0);

    // "Replay of that old token still triggers reuse detection and family revocation."
    const replay = await refreshWith(original);
    expect(replay.status).toBe(401);
    expect(replay.body.message).toMatch(/reuse/i);

    // Family revocation side effect: the legitimately-issued successor must now be dead too.
    const successorAfterReuse = await refreshWith(successor);
    expect(successorAfterReuse.status).toBe(401);
  });

  it('cleanup DOES eventually delete a revoked token once it passes the new 91-day retention boundary — retention is not forever', async () => {
    const { refreshToken: original } = await factory.loginTokens(staff);
    const rotated = await refreshWith(original).expect(200);
    const successor = rotated.body.refreshToken as string;

    // Past the new 91-day boundary.
    await adminDataSource.query(`UPDATE core.refresh_token SET revoked_at = now() - interval '92 days', created_at = now() - interval '92 days' WHERE token_hash = $1`, [
      hashOf(original),
    ]);

    const result = await runCleanup();

    expect(await tokenRowExists(original)).toBe(false);
    expect(result.refresh_tokens_deleted).toBeGreaterThanOrEqual(1);
    // The still-live successor must survive even though its sibling row was just deleted.
    expect(await tokenRowExists(successor)).toBe(true);
    const successorStillWorks = await refreshWith(successor);
    expect(successorStillWorks.status).toBe(200);
  });

  it('an EXPIRED (never revoked) token is retained past 30 days and deleted only once its own 91-day boundary passes', async () => {
    const { refreshToken } = await factory.loginTokens(staff);

    // Simulate a dead-but-never-revoked row (e.g. simply timed out) 40 days old — must survive.
    await adminDataSource.query(`UPDATE core.refresh_token SET expires_at = now() - interval '40 days', created_at = now() - interval '40 days' WHERE token_hash = $1`, [
      hashOf(refreshToken),
    ]);
    await runCleanup();
    expect(await tokenRowExists(refreshToken)).toBe(true);

    // Past the boundary — now eligible.
    await adminDataSource.query(`UPDATE core.refresh_token SET expires_at = now() - interval '92 days' WHERE token_hash = $1`, [hashOf(refreshToken)]);
    const result = await runCleanup();
    expect(await tokenRowExists(refreshToken)).toBe(false);
    expect(result.refresh_tokens_deleted).toBeGreaterThanOrEqual(1);
  });
});
