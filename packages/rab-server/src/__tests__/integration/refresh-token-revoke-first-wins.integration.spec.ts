import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * XP-09 Q6 (owner decision 2026-11-13): `revokeFamily` and `revokeAllForUser` stamp `core.refresh_token.revoked_at` only
 * where it is still NULL — the FIRST revocation wins and is never overwritten. Before, every call rewrote `revoked_at` on
 * every row of the family/user, including rows already revoked by rotation or by an earlier revoke. That
 * (a) erased when a token actually stopped being valid (the evidence a reuse investigation reads) and
 * (b) restarted the 181-day retention clock of `core.worker_cleanup_auth_tokens` on every later revoke, so an attacker
 *     who keeps replaying an old token (each replay → reuse detection → revokeFamily) could keep dead rows alive forever.
 *
 * Abuse case: revoke, then revoke again later → `revoked_at` unchanged, for both methods, through the real service on the
 * runtime login (RLS bound by TenantContextService) and through the real reuse-detection HTTP path.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('refresh token revocation: first revocation wins (XP-09 Q6)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let refreshTokens: RefreshTokenService;
  let factory: TestIdentityFactory;
  let staff: TestIdentity;

  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
  const refreshWith = (token: string) =>
    request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    refreshTokens = moduleRef.get(RefreshTokenService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const org = await factory.createOrganisation('q6-first-wins');
    const owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  /** Read through the admin (fixture) connection: the assertions must not depend on the code under test's own RLS view. */
  async function rowOf(token: string): Promise<{ id: string; family_id: string; revoked_at: Date | null }> {
    const [row] = await adminDataSource.query<Array<{ id: string; family_id: string; revoked_at: Date | null }>>(
      `SELECT id, family_id, revoked_at FROM core.refresh_token WHERE token_hash = $1`,
      [hashOf(token)],
    );
    if (!row) throw new Error('fixture token row missing');
    return row;
  }

  /**
   * Backdates one token's revoked_at and returns the stored value, read back with a SELECT: TypeORM's `query()` returns
   * `[rows, affectedCount]` for an UPDATE … RETURNING on postgres, so destructuring its result would yield `undefined`
   * (and a first-wins assertion against `undefined` would test nothing).
   */
  async function setRevokedAt(token: string, sql: string): Promise<Date> {
    // sql-injection-reviewed: `sql` is one of this file's literal interval expressions, never input
    await adminDataSource.query(`UPDATE core.refresh_token SET revoked_at = ${sql} WHERE token_hash = $1`, [hashOf(token)]);
    const { revoked_at } = await rowOf(token);
    if (!(revoked_at instanceof Date)) throw new Error('fixture: revoked_at was not set');
    return revoked_at;
  }

  const ctx = () => ({ organisationId: staff.organisationId, workspaceId: null, userId: staff.userId, role: '' });
  const revokeFamily = (familyId: string, reason: string) => tenantContext.runInTenantContext(ctx(), (m) => refreshTokens.revokeFamily(m, familyId, reason));
  const revokeAllForUser = (reason: string) => tenantContext.runInTenantContext(ctx(), (m) => refreshTokens.revokeAllForUser(m, staff.userId, reason));

  it('revokeFamily: revoke, then revoke again later → every revoked_at is unchanged; a rotated predecessor keeps its rotation time', async () => {
    const { refreshToken: original } = await factory.loginTokens(staff);
    const successor = (await refreshWith(original).expect(200)).body.refreshToken as string;
    // The rotation happened "long ago": the predecessor's revocation time is evidence, not something a later revoke may move.
    const rotatedAt = await setRevokedAt(original, `now() - interval '100 days'`);
    const familyId = (await rowOf(original)).family_id;
    expect((await rowOf(successor)).revoked_at).toBeNull();

    await revokeFamily(familyId, 'logout');
    const firstRevocation = (await rowOf(successor)).revoked_at;
    expect(firstRevocation).not.toBeNull();
    expect((await rowOf(original)).revoked_at).toEqual(rotatedAt);

    // "Later": make the first revocation visibly old, then revoke the same family again.
    const backdated = await setRevokedAt(successor, `now() - interval '3 days'`);
    await revokeFamily(familyId, 'superseded');
    expect((await rowOf(successor)).revoked_at).toEqual(backdated);
    expect((await rowOf(original)).revoked_at).toEqual(rotatedAt);
  });

  it('revokeAllForUser: a second call (another password change) never rewrites an existing revocation; it still revokes rows that were live', async () => {
    const { refreshToken: a } = await factory.loginTokens(staff);
    const { refreshToken: b } = await factory.loginTokens(staff);
    expect((await rowOf(a)).family_id).not.toBe((await rowOf(b)).family_id);
    const aRevoked = await setRevokedAt(a, `now() - interval '10 days'`);

    await revokeAllForUser('password_changed');
    expect((await rowOf(a)).revoked_at).toEqual(aRevoked);
    expect((await rowOf(b)).revoked_at).not.toBeNull();
    const bRevoked = await setRevokedAt(b, `now() - interval '2 days'`);

    // A new live session, then a second revoke-all later: only the live one is stamped.
    const { refreshToken: c } = await factory.loginTokens(staff);
    await revokeAllForUser('password_reset');
    expect((await rowOf(a)).revoked_at).toEqual(aRevoked);
    expect((await rowOf(b)).revoked_at).toEqual(bRevoked);
    expect((await rowOf(c)).revoked_at).not.toBeNull();
  });

  it('abuse case: replaying an old rotated token (reuse detection → revokeFamily) cannot move its revocation time and so cannot extend its retention', async () => {
    const { refreshToken: original } = await factory.loginTokens(staff);
    const successor = (await refreshWith(original).expect(200)).body.refreshToken as string;
    const rotatedAt = await setRevokedAt(original, `now() - interval '170 days'`);

    for (let replay = 0; replay < 2; replay += 1) {
      const res = await refreshWith(original);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/reuse/i);
      expect((await rowOf(original)).revoked_at).toEqual(rotatedAt);
    }
    // The family is still revoked by the reuse detection (the successor is dead), only the old row's time is preserved.
    expect((await rowOf(successor)).revoked_at).not.toBeNull();
    expect((await refreshWith(successor)).status).toBe(401);
  });
});
