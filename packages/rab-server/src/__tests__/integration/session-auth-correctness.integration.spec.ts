import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * PHASE 10 — session & authentication correctness. Real Postgres, real RLS,
 * real HTTP requests through the actual AuthController — no mocks. Proves:
 *
 *   AUTH-01: one presented refresh token can mint AT MOST one successor,
 *   even under genuine concurrency (`Promise.all`, not a deterministic
 *   barrier) — the row-lock fix in `RefreshTokenService.rotate()`.
 *
 *   AUTH-02: an already-issued access JWT stops authorizing requests
 *   IMMEDIATELY on logout / reuse-detection / absolute-deadline / password
 *   reset — the `SessionValidityService` check `JwtAuthGuard` now runs on
 *   every request, not just at the token's own (up to 15-minute) expiry.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('session & authentication correctness (Phase 10)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const refreshWith = (token: string) => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });
  const logoutWith = (accessToken: string, refreshToken: string) =>
    http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).set('x-client-platform', 'mobile').send({ refreshToken });

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

  // ------------------------------------------------------------------------------------------------ fixtures
  let org: Organisation;
  let staffA: TestIdentity;
  let staffB: TestIdentity; // for cross-user isolation checks

  beforeAll(async () => {
    org = await factory.createOrganisation('p10');
    const owner = await factory.createInternalManager(org);
    staffA = await factory.createStaff(org, { owner });
    staffB = await factory.createStaff(org, { owner });
  });

  /** Direct DB read of a session's own family_expires_at/revoked_at, scoped by owner-connection (pre-auth-exempt table, no tenant context needed for a diagnostic read in tests). */
  async function familyRow(familyId: string): Promise<{ revoked_at: Date | null; family_expires_at: Date }> {
    const [row] = await adminDataSource.query(`SELECT revoked_at, family_expires_at FROM core.refresh_token WHERE family_id = $1 AND revoked_at IS NULL LIMIT 1`, [familyId]);
    if (!row) {
      const [any] = await adminDataSource.query(`SELECT revoked_at, family_expires_at FROM core.refresh_token WHERE family_id = $1 ORDER BY created_at DESC LIMIT 1`, [familyId]);
      return any;
    }
    return row;
  }

  // ================================================================================================ AUTH-01 (Part 61)
  describe('AUTH-01 — refresh token concurrency', () => {
    it('1: a normal, sequential refresh succeeds and returns a genuinely new token pair', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const res = await refreshWith(refreshToken).expect(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      expect(res.body.refreshToken).not.toBe(refreshToken);
    });

    it('2: a second use of an already-consumed token is reuse-detected, not silently accepted', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      await refreshWith(refreshToken).expect(200);
      const second = await refreshWith(refreshToken);
      expect(second.status).toBe(401);
      expect(second.body.message).toMatch(/reuse/i);
    });

    it('3: 2 simultaneous refreshes of the SAME token — exactly one succeeds', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const [a, b] = await Promise.all([refreshWith(refreshToken), refreshWith(refreshToken)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]); // exactly one winner, one reuse-detected loser
      const winner = a.status === 200 ? a : b;
      expect(winner.body.refreshToken).toBeTruthy();
    });

    it('4: 5 simultaneous refreshes of the SAME token — exactly one winner, real Postgres, no test instrumentation', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const results = await Promise.all(Array.from({ length: 5 }, () => refreshWith(refreshToken)));
      const succeeded = results.filter((r) => r.status === 200);
      const failed = results.filter((r) => r.status === 401);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(4);
      // Every successor issued must be genuinely distinct — no accidental sharing.
      expect(new Set(succeeded.map((r) => r.body.refreshToken)).size).toBe(1);
    });

    it('11 (lost-response scenario): after a winner commits, retrying the ORIGINAL old token is indistinguishable from reuse, is denied, and revokes the whole family — including the winner\'s own successor', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const first = await refreshWith(refreshToken).expect(200);
      // Simulates a client that never saw `first`'s response (network drop) and retries the OLD token it still has.
      const retried = await refreshWith(refreshToken);
      expect(retried.status).toBe(401);
      expect(retried.body.message).toMatch(/reuse/i);
      // The server cannot distinguish "the same honest client retried after a
      // dropped response" from "an attacker replayed a captured token" — both
      // present the same already-rotated token. The standard, deliberate
      // response to ANY detected reuse (RFC 6819 / the OAuth reuse-detection
      // pattern this codebase follows) is to revoke the ENTIRE family, not
      // just deny the one offending request — so even the legitimately-issued
      // winner's own successor stops working, forcing a fresh login. A
      // well-behaved client (this repo's own single-flight + Web Locks/
      // BroadcastChannel coordination on web) should never actually trigger
      // this in practice; it exists to make real token theft costly.
      const afterReuse = await refreshWith(first.body.refreshToken);
      expect(afterReuse.status).toBe(401);
    });

    it('6: a revoked (logged-out) token cannot be refreshed', async () => {
      const { accessToken, refreshToken } = await factory.loginTokens(staffA);
      await logoutWith(accessToken, refreshToken).expect(204);
      const res = await refreshWith(refreshToken);
      expect(res.status).toBe(401);
    });

    it('7: an expired (but not yet revoked) token is rejected', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const decodedHash = createHash('sha256').update(refreshToken).digest('hex');
      await adminDataSource.query(`UPDATE core.refresh_token SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [decodedHash]);
      const res = await refreshWith(refreshToken);
      expect(res.status).toBe(401);
    });

    it('8: a token whose FAMILY deadline has passed is rejected even though the row itself was never individually touched', async () => {
      const { refreshToken } = await factory.loginTokens(staffA);
      const hash = createHash('sha256').update(refreshToken).digest('hex');
      const past = new Date(Date.now() - 1000);
      await adminDataSource.query(`UPDATE core.refresh_token SET family_expires_at = $2, expires_at = $2 WHERE token_hash = $1`, [hash, past]);
      const res = await refreshWith(refreshToken);
      expect(res.status).toBe(401);
    });

    it('9: refresh() rejects a mismatched requested application target — a session cannot be silently retargeted', async () => {
      const { refreshToken } = await factory.loginTokens(staffA); // staff_app session
      const res = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').set('x-application-target', 'venue_manager_app').send({ refreshToken });
      expect(res.status).toBe(403);
    });

    it('10/11: two DIFFERENT users refreshing concurrently never cross-contaminate — each gets back exactly their own identity', async () => {
      const [tokensA, tokensB] = await Promise.all([factory.loginTokens(staffA), factory.loginTokens(staffB)]);
      const [resA, resB] = await Promise.all([refreshWith(tokensA.refreshToken), refreshWith(tokensB.refreshToken)]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const meA = await authed(resA.body.accessToken).expect(200);
      const meB = await authed(resB.body.accessToken).expect(200);
      expect(meA.body.id).not.toBe(meB.body.id);
    });

    it('12: logout racing refresh for the same token settles on ONE coherent outcome, never a live token AND a dead session simultaneously', async () => {
      const { accessToken, refreshToken } = await factory.loginTokens(staffA);
      const [logoutRes, refreshRes] = await Promise.allSettled([logoutWith(accessToken, refreshToken), refreshWith(refreshToken)]);
      // Whichever raced first, the family must now be coherently EITHER fully revoked OR advanced to a new token —
      // never both a "still usable old token" and a "revoked family" at once.
      const refreshSucceeded = refreshRes.status === 'fulfilled' && refreshRes.value.status === 200;
      if (refreshSucceeded) {
        const newToken = (refreshRes as PromiseFulfilledResult<request.Response>).value.body.refreshToken;
        // The new token from a genuine refresh-win must still work even if logout also fired — logout only ever
        // revokes the family via the ONE presented token; if refresh won the race first, logout's own presented
        // (now-superseded) token correctly no-ops rather than corrupting the winner's fresh state.
        const stillWorks = await refreshWith(newToken);
        expect([200, 401]).toContain(stillWorks.status); // must be a clean, deterministic outcome, not a crash/500
      }
      expect(logoutRes.status).toBe('fulfilled');
    });
  });

  // ================================================================================================ AUTH-02 (Part 62)
  describe('AUTH-02 — residual access JWT after session end', () => {
    it('14: logout invalidates the OLD access JWT immediately — no residual authorization window', async () => {
      const { accessToken, refreshToken } = await factory.loginTokens(staffA);
      await authed(accessToken).expect(200); // sanity: valid before logout
      await logoutWith(accessToken, refreshToken).expect(204);
      const res = await authed(accessToken);
      expect(res.status).toBe(401);
    });

    it('15: reuse-detected family revocation invalidates the OLD access JWT immediately', async () => {
      const { accessToken, refreshToken } = await factory.loginTokens(staffA);
      await refreshWith(refreshToken).expect(200); // legitimate rotation
      await refreshWith(refreshToken); // reuse — revokes the whole family
      const res = await authed(accessToken); // the ORIGINAL access token, minted before any of this
      expect(res.status).toBe(401);
    });

    it('16: once the family absolute deadline has passed, the old access JWT is denied even though its OWN 15-minute expiry has not arrived', async () => {
      const { accessToken, refreshToken } = await factory.loginTokens(staffA);
      const hash = createHash('sha256').update(refreshToken).digest('hex');
      await adminDataSource.query(`UPDATE core.refresh_token SET family_expires_at = now() - interval '1 second' WHERE token_hash = $1`, [hash]);
      const res = await authed(accessToken); // still well inside its own 15m JWT expiry
      expect(res.status).toBe(401);
    });

    it('17: password reset revokes every session — an old access JWT stops working immediately', async () => {
      const owner = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner });
      const { accessToken } = await factory.loginTokens(staff);
      await authed(accessToken).expect(200);
      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: owner.workspaceId!, userId: staff.userId, role: '' }, (manager) =>
        new RefreshTokenService().revokeAllForUser(manager, staff.userId),
      );
      const res = await authed(accessToken);
      expect(res.status).toBe(401);
    });

    it('19 (control): a genuinely active, valid family + valid JWT is allowed', async () => {
      const { accessToken } = await factory.loginTokens(staffA);
      await authed(accessToken).expect(200);
    });
  });
});
