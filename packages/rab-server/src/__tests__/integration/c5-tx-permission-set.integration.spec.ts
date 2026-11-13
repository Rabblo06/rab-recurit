import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { hasTxPermissionMemo } from '../../engine/core-modules/permissions/tx-permission-memo';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RequestCompletePayload, subscribeToRequestMetrics } from '../../engine/observability/request-context';
import { Permission, UserPermissionOverride } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';

/**
 * Phase X C5 (S0-C-caches.md §C5, XP-04): the layer-2 service checks of ONE transaction share a transaction-local
 * effective-permission set (one query per identity instead of two per flag). Real PostgreSQL (FORCE RLS, owner login),
 * real HTTP. Proves: the same answers as the per-flag lookup for all 46 flags; never across transactions; keyed by
 * identity and tenant binding; cleared by in-transaction authority writes (ORM, raw SQL + version bump, a rolled-back
 * savepoint); and the query count before/after on a real endpoint.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ALL_FLAGS = Object.values(PermissionFlag) as PermissionFlagType[];

describeIfDb('C5 transaction-local effective-permission set (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let permissions: PermissionsService;
  let versions: SecurityVersionService;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let organisationId: string;

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' });
  const inTx = <T>(identity: TestIdentity, fn: (m: EntityManager) => Promise<T>) => tenantContext.runInTenantContext(ctxOf(identity), fn);
  const uncached = (m: EntityManager, ctx: AuthContext, flag: PermissionFlagType) =>
    (permissions as unknown as { userHasPermissionUncachedTx: (m: EntityManager, c: AuthContext, f: PermissionFlagType) => Promise<boolean> }).userHasPermissionUncachedTx(m, ctx, flag);
  const fills = () => jest.spyOn(permissions as unknown as { loadEffectivePermissionsTx: () => Promise<unknown> }, 'loadEffectivePermissionsTx');
  const permissionId = async (m: EntityManager, key: string) => (await m.findOneByOrFail(Permission, { key })).id;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    permissions = moduleRef.get(PermissionsService);
    versions = moduleRef.get(SecurityVersionService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c5' });
    manager = seeded.managers[0]!;
    organisationId = seeded.organisation.id;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'c5-staff' });
    await owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = $3`,
      [staff.userId, organisationId, PermissionFlag.PAYROLL_VIEW],
    );
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('answers exactly like the per-flag lookup for all 46 flags, with ONE fill per identity per transaction', async () => {
    expect(ALL_FLAGS).toHaveLength(46);
    for (const identity of [manager, staff]) {
      const spy = fills();
      try {
        await inTx(identity, async (m) => {
          const ctx = ctxOf(identity);
          for (const flag of ALL_FLAGS) expect([flag, await permissions.userHasPermissionTx(m, ctx, flag)]).toEqual([flag, await uncached(m, ctx, flag)]);
          expect(hasTxPermissionMemo(m.queryRunner)).toBe(true);
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('is never shared across transactions: each transaction fills its own set', async () => {
    const spy = fills();
    try {
      for (let i = 0; i < 3; i++) await inTx(manager, (m) => permissions.userHasPermissionTx(m, ctxOf(manager), PermissionFlag.STAFF_VIEW));
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('an ORM override write inside the transaction is seen by the next check (memo cleared)', async () => {
    await inTx(manager, async (m) => {
      const ctx = ctxOf(manager);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
      await m.insert(UserPermissionOverride, { userId: manager.userId, permissionId: await permissionId(m, PermissionFlag.STAFF_VIEW), organisationId, effect: 'revoke' } as never);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(false);
      await m.delete(UserPermissionOverride, { userId: manager.userId });
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
    });
  });

  it('a raw-SQL authority write plus its in-transaction version bump is seen by the next check', async () => {
    await inTx(manager, async (m) => {
      const ctx = ctxOf(manager);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
      await m.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`,
        [manager.userId, organisationId, PermissionFlag.STAFF_VIEW],
      );
      await versions.bumpUser(m, manager.userId); // what every service writer of an authority table does
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(false);
      await m.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [manager.userId]);
      await versions.bumpUser(m, manager.userId);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
    });
  });

  it('a write undone by a RAW-SQL savepoint rollback (manager.query, no TypeORM event) does not survive in the memo', async () => {
    await inTx(manager, async (m) => {
      const ctx = ctxOf(manager);
      const original = await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW);
      expect(original).toBe(true);
      await m.query('SAVEPOINT c5_raw');
      await m.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`,
        [manager.userId, organisationId, PermissionFlag.STAFF_VIEW],
      );
      await versions.bumpUser(m, manager.userId); // the writer's in-transaction bump (clears the memo)
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(false); // now denied, memoised
      expect(hasTxPermissionMemo(m.queryRunner)).toBe(true);
      await m.query('ROLLBACK TO SAVEPOINT c5_raw');
      expect(hasTxPermissionMemo(m.queryRunner)).toBe(false);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(original); // the ORIGINAL answer
      expect(await uncached(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(original);
    });
  });

  it('a write undone by a savepoint rollback does not survive in the memo', async () => {
    await inTx(manager, async (m) => {
      const ctx = ctxOf(manager);
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
      await expect(
        m.transaction(async (inner) => {
          await inner.insert(UserPermissionOverride, { userId: manager.userId, permissionId: await permissionId(inner, PermissionFlag.STAFF_VIEW), organisationId, effect: 'revoke' } as never);
          expect(await permissions.userHasPermissionTx(inner, ctx, PermissionFlag.STAFF_VIEW)).toBe(false);
          throw new Error('roll back the savepoint');
        }),
      ).rejects.toThrow('roll back the savepoint');
      expect(await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW)).toBe(true);
    });
  });

  it('keyed by identity: two users in one transaction get their own sets', async () => {
    await inTx(manager, async (m) => {
      expect(await permissions.userHasPermissionTx(m, ctxOf(manager), PermissionFlag.STAFF_CREATE)).toBe(await uncached(m, ctxOf(manager), PermissionFlag.STAFF_CREATE));
      expect(await permissions.userHasPermissionTx(m, ctxOf(staff), PermissionFlag.STAFF_CREATE)).toBe(await uncached(m, ctxOf(staff), PermissionFlag.STAFF_CREATE));
      expect(await permissions.userHasPermissionTx(m, ctxOf(staff), PermissionFlag.PAYROLL_VIEW)).toBe(true); // the override grant
    });
  });

  it('a transaction rebound to another workspace answers for its binding but memoises nothing', async () => {
    const spy = fills();
    try {
      await inTx(manager, async (m) => {
        await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, ['00000000-0000-0000-0000-000000000001']);
        const ctx = ctxOf(manager);
        await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW);
        await permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW);
        expect(hasTxPermissionMemo(m.queryRunner)).toBe(false);
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('query count on a real endpoint: /dashboard/summary (5 layer-2 flags in one transaction)', async () => {
    const token = await factory.login(manager);
    await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set({ Authorization: `Bearer ${token}` }); // warm
    const seen: RequestCompletePayload[] = [];
    const stop = subscribeToRequestMetrics((p) => {
      if (p.route === '/rest/v1/dashboard/summary') seen.push(p);
    });
    const spy = fills();
    try {
      const res = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      // eslint-disable-next-line no-console
      console.log(`C5 /dashboard/summary metrics: sql=${seen[0]?.sqlCount} transactions=${seen[0]?.transactionCount} permissionFills=${spy.mock.calls.length}`);
      expect(seen).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1); // 5 flags, one statement (previously up to 10)
    } finally {
      stop();
      spy.mockRestore();
    }
  });
});
