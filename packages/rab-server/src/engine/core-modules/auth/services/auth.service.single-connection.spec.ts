import { BadRequestException } from '@nestjs/common';
import { PasswordResetTokenPurpose } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { Organisation, User } from '../../../../modules/identity/entities';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { AuthService } from './auth.service';
import { OrganisationAuthProvidersService } from './organisation-auth-providers.service';

/**
 * Load-test §4.3 (HIGH, availability): `RefreshTokenService.rotate()` and `AuthService.resetPassword()` asked questions
 * (is this user a platform admin? may this organisation use passwords?) through helpers that open their OWN transaction on
 * a SECOND pool connection while the caller's transaction still held its connection. ~pool-size concurrent refreshes then
 * each held one connection and waited for another: the pool deadlocked until its connection timeout and the whole API
 * (every tenant) answered 500.
 *
 * The rule tested here: while a request holds a connection in a transaction it never asks the pool for another. The fake
 * `runInTenantContext`/`dataSource.query` below behave like a pool with exactly one connection for this caller: any checkout
 * while a transaction is open throws. The services under test are the REAL `RefreshTokenService`, `PlatformAdminService`
 * and `OrganisationAuthProvidersService` (only their I/O is faked), so this pins the production call paths, not mocks of
 * them. The real-database version (a deliberately small pool, more concurrent refreshes than connections) is
 * src/__tests__/integration/refresh-pool-deadlock.integration.spec.ts.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';
const STRONG_PASSWORD = 'Vq8#Lr2!Xz7@Pm4$';

class SecondConnectionError extends Error {
  constructor(what: string) {
    super(
      `${what} asked the pool for a second connection while this request's transaction still holds one (load-test §4.3)`,
    );
  }
}

function qbChain(rows: unknown[]) {
  const qb: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'select', 'update', 'set'])
    qb[m] = () => qb;
  qb.getRawMany = async () => rows;
  qb.execute = async () => ({ affected: 1 });
  return qb;
}

function harness(
  opts: {
    roles?: string[];
    orgPasswordEnabled?: boolean;
    platformAdmin?: boolean;
    orgSuspended?: boolean;
  } = {},
) {
  const roles = opts.roles ?? ['staff'];
  let inTransaction = false;
  let transactions = 0;

  const manager = {
    query: jest.fn(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('is_active_platform_admin'))
        return [{ is_active_platform_admin: opts.platformAdmin ?? false }];
      if (sql.includes('core."user"')) return [{ '?column?': 1 }];
      if (sql.includes('application_target FROM core.refresh_token'))
        return [{ application_target: 'staff_app' }];
      if (sql.includes('user_role')) return roles.map((key) => ({ key }));
      if (sql.includes('FROM core.user_session'))
        return [{ revoked_at: null, idle_expired: false }];
      if (sql.includes('FROM core.organisation'))
        return [
          { suspended_at: opts.orgSuspended ? new Date().toISOString() : null },
        ];
      return [];
    }),
    findOne: jest.fn(async () => ({
      id: 'rt-1',
      familyId: 'fam-1',
      userId: USER,
      organisationId: ORG,
      applicationTarget: 'staff_app',
      revokedAt: null,
      replacedBy: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      familyExpiresAt: new Date(Date.now() + 3_600_000),
    })),
    findOneOrFail: jest.fn(async (entity: unknown) => {
      if (entity === User)
        return {
          id: USER,
          organisationId: ORG,
          email: 'person@example.test',
          firstName: 'Pat',
        };
      if (entity === Organisation) {
        const enabled = opts.orgPasswordEnabled ?? true;
        return {
          id: ORG,
          name: 'Acme',
          passwordAuthEnabled: enabled,
          googleAuthEnabled: !enabled,
          microsoftAuthEnabled: false,
        };
      }
      throw new Error('unexpected findOneOrFail');
    }),
    findOneByOrFail: jest.fn(async () => ({ id: ORG, name: 'Acme' })),
    insert: jest.fn(async () => ({ identifiers: [{ id: 'rt-2' }] })),
    update: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => qbChain(roles.map((key) => ({ key })))),
  } as unknown as EntityManager;

  const tenantContext = {
    runInTenantContext: jest.fn(
      async <T>(
        _ctx: unknown,
        fn: (m: EntityManager) => Promise<T>,
      ): Promise<T> => {
        if (inTransaction)
          throw new SecondConnectionError('runInTenantContext');
        inTransaction = true;
        transactions++;
        try {
          return await fn(manager);
        } finally {
          inTransaction = false;
        }
      },
    ),
  };
  const dataSource = {
    query: jest.fn(async (sql: string): Promise<unknown[]> => {
      if (inTransaction) throw new SecondConnectionError('dataSource.query');
      if (
        sql.includes('auth_find_refresh_token_org') ||
        sql.includes('auth_find_password_reset_token_org')
      )
        return [{ organisationId: ORG, userId: USER }];
      return [];
    }),
  };
  const env = {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_PASSWORD_ENABLED' || key === 'AUTH_GOOGLE_ENABLED')
        return true;
      if (key === 'AUTH_MICROSOFT_ENABLED') return false;
      if (key === 'APP_URL') return 'https://app.example.test';
      return undefined;
    }),
  };

  const platformAdmin = new PlatformAdminService(
    tenantContext as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const isPlatformAdmin = jest.spyOn(platformAdmin, 'isPlatformAdmin');
  const isPlatformAdminTx = jest.spyOn(platformAdmin, 'isPlatformAdminTx');
  const providers = new OrganisationAuthProvidersService(
    dataSource as never,
    tenantContext as never,
    env as never,
    undefined as never,
    undefined as never,
    undefined as never,
    platformAdmin,
    undefined as never,
  );
  const getEffective = jest.spyOn(providers, 'getEffective');
  const refreshTokens = new RefreshTokenService(platformAdmin);
  const resetTokens = {
    hashToken: jest.fn(() => 'reset-token-hash'),
    consume: jest.fn(async () => ({
      userId: USER,
      purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD as string,
      applicationTarget: 'staff_app',
    })),
  };
  const auth = new AuthService(
    dataSource as never,
    tenantContext as never,
    { hash: jest.fn(async () => 'argon2id-hash') } as never,
    { sign: jest.fn(() => 'access-jwt') } as never,
    refreshTokens,
    resetTokens as never,
    {
      enqueue: jest.fn(async () => ({ id: 'outbox-1' })),
      publishAfterCommit: jest.fn(),
    } as never,
    { publish: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    env as never,
    platformAdmin,
    { resolveForUser: jest.fn(async () => 'workspace-1') } as never,
    undefined as never,
    undefined as never,
    providers,
    { bumpUser: jest.fn(async () => undefined) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return {
    auth,
    manager,
    isPlatformAdmin,
    isPlatformAdminTx,
    getEffective,
    transactions: () => transactions,
  };
}

describe('auth flows never ask the pool for a second connection while holding one (load-test §4.3 pool deadlock)', () => {
  describe('AuthService.refresh → RefreshTokenService.rotate', () => {
    it('rotates with every lookup on the open transaction: sequential transactions only, never a nested one', async () => {
      const h = harness();
      await expect(
        h.auth.refresh('presented-refresh-token', {
          userAgent: 'jest',
          ip: '127.0.0.1',
        } as never),
      ).resolves.toMatchObject({
        accessToken: 'access-jwt',
      });
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
      // rotate()'s suspension check: the token owner, on rotate's own manager.
      expect(h.isPlatformAdminTx).toHaveBeenCalledWith(h.manager, {
        userId: USER,
      });
      expect(h.transactions()).toBe(3); // pre-check, rotation, access-token roles: one after another
    });

    it('denial unchanged: a non-admin whose organisation is suspended is still refused at refresh', async () => {
      const h = harness({ orgSuspended: true });
      await expect(
        h.auth.refresh('presented-refresh-token', {} as never),
      ).rejects.toThrow('This organisation has been suspended');
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
    });

    it('exemption unchanged: a platform admin in a suspended organisation still refreshes', async () => {
      const h = harness({ orgSuspended: true, platformAdmin: true });
      await expect(
        h.auth.refresh('presented-refresh-token', {} as never),
      ).resolves.toMatchObject({ accessToken: 'access-jwt' });
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
    });
  });

  describe('AuthService.resetPassword', () => {
    it('reads the platform-admin answer and the organisation flags on its own transaction (one transaction in total)', async () => {
      const h = harness();
      await expect(
        h.auth.resetPassword({
          token: 'reset-token',
          newPassword: STRONG_PASSWORD,
        }),
      ).resolves.toMatchObject({ applicationTarget: 'staff_app' });
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
      expect(h.getEffective).not.toHaveBeenCalled();
      expect(h.isPlatformAdminTx).toHaveBeenCalledWith(h.manager, {
        userId: USER,
      });
      expect(h.transactions()).toBe(1);
    });

    it('CF-06 denial unchanged: organisation password sign-in off, a manager-tier identity is refused (no password set)', async () => {
      const h = harness({ orgPasswordEnabled: false, roles: ['manager'] });
      await expect(
        h.auth.resetPassword({
          token: 'reset-token',
          newPassword: STRONG_PASSWORD,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(h.manager.update).not.toHaveBeenCalled();
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
    });

    it('CF-06 exemption unchanged: organisation password sign-in off, a staff-only identity may still recover', async () => {
      const h = harness({ orgPasswordEnabled: false, roles: ['staff'] });
      await expect(
        h.auth.resetPassword({
          token: 'reset-token',
          newPassword: STRONG_PASSWORD,
        }),
      ).resolves.toMatchObject({ applicationTarget: 'staff_app' });
      expect(h.manager.update).toHaveBeenCalledWith(User, USER, {
        passwordHash: 'argon2id-hash',
        mustResetPassword: false,
      });
    });

    it('a platform admin is never given the mobile-workforce exemption (decided on the same transaction)', async () => {
      const h = harness({
        orgPasswordEnabled: false,
        roles: ['staff'],
        platformAdmin: true,
      });
      await expect(
        h.auth.resetPassword({
          token: 'reset-token',
          newPassword: STRONG_PASSWORD,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(h.isPlatformAdmin).not.toHaveBeenCalled();
    });
  });
});
