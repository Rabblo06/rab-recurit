import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B, item 4 — session UUID non-reuse proof).
 *
 * The server session ID (the JWT's `sid` claim, which IS the refresh token family id —
 * `AuthService.login()` mints it via `randomUUID()` and `RefreshTokenService.issue()` never
 * generates its own when one is passed through) must be a globally unique value that is NEVER
 * reassigned after the session it names is revoked — no numeric sequence, no reusable slot. This
 * suite proves that behaviourally against the real login/logout HTTP endpoints and the real
 * database, not by inspecting the `randomUUID()` call site alone: it logs in, captures `sid`, logs
 * out (revoking that session), logs in again, and asserts the new `sid` was never seen before —
 * repeated enough times, across both a same-identity cycle and an A→C identity transition, that a
 * hypothetical small reusable slot pool (e.g. "the next free id out of N") would be caught.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decodes a JWT's payload WITHOUT verifying the signature — identity bookkeeping only, never an authorization decision (mirrors rab-front's jwt.ts decodeAccessToken, re-implemented here since this is a server-side test with no dependency on the front-end package). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

describeIfDb('session UUID non-reuse (P0 finalization §16B item 4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
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

  let org: Organisation;
  let managerA: TestIdentity;
  let managerC: TestIdentity;

  beforeAll(async () => {
    org = await factory.createOrganisation('p0-sid-nonreuse');
    managerA = await factory.createInternalManager(org);
    managerC = await factory.createInternalManager(org);
  });

  async function loginAndGetSid(identity: Pick<TestIdentity, 'kind' | 'email' | 'password'>): Promise<{ sid: string; accessToken: string; refreshToken: string }> {
    const { accessToken, refreshToken } = await factory.loginTokens(identity);
    const payload = decodeJwtPayload(accessToken);
    const sid = payload.sid as string;
    expect(sid).toMatch(UUID_RE);
    return { sid, accessToken, refreshToken };
  }

  it('exact required scenario: login A → sid A, logout A, login C → sid C, sid C != sid A', async () => {
    const a = await loginAndGetSid(managerA);
    await logoutWith(a.accessToken, a.refreshToken).expect(204);
    const c = await loginAndGetSid(managerC);
    expect(c.sid).not.toBe(a.sid);
  });

  it('repeats the login→revoke→login cycle 25 times for the SAME identity — every sid is globally distinct, never recycled from the revoked set', async () => {
    const seenSids = new Set<string>();
    const revokedSids = new Set<string>();

    for (let i = 0; i < 25; i++) {
      const { sid, accessToken, refreshToken } = await loginAndGetSid(managerA);

      // Non-reuse against EVERY previously issued sid, not just the immediately preceding one —
      // catches a hypothetical small reusable slot pool, not only a naive "same as last time" bug.
      expect(seenSids.has(sid)).toBe(false);
      expect(revokedSids.has(sid)).toBe(false);
      seenSids.add(sid);

      await logoutWith(accessToken, refreshToken).expect(204);
      revokedSids.add(sid);

      // Database-level confirmation: the row this sid names is now revoked, and no OTHER row
      // (past or future) shares its family_id — the id names exactly one session, permanently.
      const rows = await adminDataSource.query(`SELECT revoked_at FROM core.refresh_token WHERE family_id = $1`, [sid]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { revoked_at: Date | null }) => r.revoked_at !== null)).toBe(true);
    }

    expect(seenSids.size).toBe(25); // 25 logins, 25 structurally-distinct ids — no collision, no slot reuse
  });

  it('an A→C identity transition never produces a sid collision even under back-to-back rapid succession', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const a = await loginAndGetSid(managerA);
      await logoutWith(a.accessToken, a.refreshToken).expect(204);
      expect(seen.has(a.sid)).toBe(false);
      seen.add(a.sid);

      const c = await loginAndGetSid(managerC);
      await logoutWith(c.accessToken, c.refreshToken).expect(204);
      expect(seen.has(c.sid)).toBe(false);
      seen.add(c.sid);

      expect(a.sid).not.toBe(c.sid);
    }
    expect(seen.size).toBe(20);
  });
});
