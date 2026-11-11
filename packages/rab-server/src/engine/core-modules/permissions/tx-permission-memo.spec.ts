import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { SecurityVersionService } from '../auth/services/security-version.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { PermissionsService } from './permissions.service';
import { forgetTxPermissions, hasTxPermissionMemo } from './tx-permission-memo';

/**
 * Phase X C5 — the transaction-local effective-permission set (unit level; the PostgreSQL behaviour is proven in
 * c5-tx-permission-set.integration.spec.ts).
 */
type Bound = { org: string; workspace: string };

function primary(): DataSource {
  return { subscribers: [] as unknown[] } as unknown as DataSource;
}

function txManager(ds: DataSource, keys: string[], bound: Bound, opts: { active?: boolean; released?: boolean } = {}) {
  const runner = { isTransactionActive: opts.active ?? true, isReleased: opts.released ?? false, connection: ds, manager: undefined } as unknown as QueryRunner;
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(undefined),
    getCount: jest.fn().mockResolvedValue(1),
  };
  const manager = {
    queryRunner: runner,
    connection: ds,
    query: jest.fn(async () => [{ keys, bound_org: bound.org, bound_workspace: bound.workspace }]),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    increment: jest.fn().mockResolvedValue(undefined),
  };
  return { manager: manager as unknown as EntityManager & { query: jest.Mock; createQueryBuilder: jest.Mock; increment: jest.Mock }, runner };
}

function service(ds: DataSource | undefined): PermissionsService {
  const svc = new PermissionsService({} as TenantContextService);
  Object.assign(svc, { primaryDataSource: ds });
  return svc;
}

const ctx = { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: '' };
const BOUND: Bound = { org: 'org-1', workspace: 'ws-1' };

describe('C5 transaction-local permission set', () => {
  it('the first check fills the set in ONE query; later checks for the same identity are lookups', async () => {
    const ds = primary();
    const { manager } = txManager(ds, ['staff.view', 'offer.send'], BOUND);
    const svc = service(ds);
    expect(await svc.userHasPermissionTx(manager, ctx, 'staff.view')).toBe(true);
    expect(await svc.userHasPermissionTx(manager, ctx, 'offer.send')).toBe(true);
    expect(await svc.userHasPermissionTx(manager, ctx, 'payroll.approve')).toBe(false);
    expect(await svc.userHasPermissionTx(manager, ctx, 'staff.view')).toBe(true);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('keyed by identity: another user, workspace, organisation, actor type or inspected-by never reuses the set', async () => {
    const ds = primary();
    const { manager } = txManager(ds, ['staff.view'], BOUND);
    const svc = service(ds);
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    for (const other of [
      { ...ctx, userId: 'user-2' },
      { ...ctx, workspaceId: 'ws-2' },
      { ...ctx, organisationId: 'org-2' },
      { ...ctx, actorType: 'worker' as const },
      { ...ctx, inspectedBy: 'admin-1' },
    ]) await svc.userHasPermissionTx(manager, other, 'staff.view');
    expect(manager.query).toHaveBeenCalledTimes(6);
  });

  it('a transaction bound to ANOTHER tenant than the identity answers, but memoises nothing', async () => {
    const ds = primary();
    const { manager, runner } = txManager(ds, ['staff.view'], { org: 'org-1', workspace: 'ws-OTHER' });
    const svc = service(ds);
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(hasTxPermissionMemo(runner)).toBe(false);
  });

  it('never memoises outside an open transaction, on a released runner, on the replica, or without a known primary', async () => {
    const ds = primary();
    const cases = [
      { svc: service(ds), ...txManager(ds, ['staff.view'], BOUND, { active: false }) },
      { svc: service(ds), ...txManager(ds, ['staff.view'], BOUND, { released: true }) },
      { svc: service(ds), ...txManager(primary(), ['staff.view'], BOUND) }, // a different (replica) DataSource
      { svc: service(undefined), ...txManager(ds, ['staff.view'], BOUND) },
    ];
    for (const { svc, manager } of cases) {
      await svc.userHasPermissionTx(manager, ctx, 'staff.view');
      await svc.userHasPermissionTx(manager, ctx, 'staff.view');
      // The original two-query path each time: no fill statement at all.
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(4);
    }
  });

  it('forgetTxPermissions and every in-transaction security-version bump drop the memo', async () => {
    const ds = primary();
    const { manager } = txManager(ds, ['staff.view'], BOUND);
    const svc = service(ds);
    const versions = new SecurityVersionService();
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    forgetTxPermissions(manager);
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    expect(manager.query).toHaveBeenCalledTimes(2);
    for (const bump of [
      () => versions.bumpUser(manager, 'user-1'),
      () => versions.bumpRole(manager, 'role-1'),
      () => versions.bumpOrganisation(manager, 'org-1'),
      () => versions.bumpPlatformAdmin(manager, 'user-1'),
    ]) {
      await bump();
      await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    }
    expect(manager.query).toHaveBeenCalledTimes(6);
  });

  it('commit, any rollback (savepoints included) and ORM writes to the authority tables drop it; other writes do not', async () => {
    const ds = primary();
    const { manager, runner } = txManager(ds, ['staff.view'], BOUND);
    const svc = service(ds);
    const fill = () => svc.userHasPermissionTx(manager, ctx, 'staff.view');
    await fill();
    const subscriber = (ds.subscribers as unknown as Array<Record<string, (e: unknown) => void>>)[0]!;
    expect(subscriber).toBeDefined();

    subscriber.afterInsert!({ queryRunner: runner, metadata: { tableName: 'shift' } });
    expect(hasTxPermissionMemo(runner)).toBe(true);
    for (const table of ['user_role', 'role_permission', 'role', 'user_permission_override', 'permission']) {
      for (const event of ['afterInsert', 'afterUpdate', 'afterRemove']) {
        await fill();
        subscriber[event]!({ queryRunner: runner, metadata: { tableName: table } });
        expect(hasTxPermissionMemo(runner)).toBe(false);
      }
    }
    await fill();
    subscriber.afterRemove!({ queryRunner: runner }); // no metadata: treated as a possible authority write
    expect(hasTxPermissionMemo(runner)).toBe(false);
    await fill();
    subscriber.afterTransactionRollback!({ queryRunner: runner });
    expect(hasTxPermissionMemo(runner)).toBe(false);
    await fill();
    subscriber.afterTransactionCommit!({ queryRunner: runner });
    expect(hasTxPermissionMemo(runner)).toBe(false);
  });

  it('raw transaction control on the runner (ROLLBACK / RELEASE / COMMIT / ABORT / END, any case, success or failure) drops it', async () => {
    const ds = primary();
    const { manager, runner } = txManager(ds, ['staff.view'], BOUND);
    const svc = service(ds);
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    const subscriber = (ds.subscribers as unknown as Array<Record<string, (e: unknown) => void>>)[0]!;
    for (const sql of ['SAVEPOINT sp1', 'SELECT 1', 'INSERT INTO core.shift DEFAULT VALUES']) {
      subscriber.afterQuery!({ queryRunner: runner, query: sql, success: true });
      expect(hasTxPermissionMemo(runner)).toBe(true);
    }
    for (const sql of ['ROLLBACK TO SAVEPOINT sp1', '  rollback to savepoint sp1', 'RELEASE SAVEPOINT sp1', 'release sp1', 'COMMIT', 'ROLLBACK', 'ABORT', 'END']) {
      await svc.userHasPermissionTx(manager, ctx, 'staff.view');
      expect(hasTxPermissionMemo(runner)).toBe(true);
      subscriber.afterQuery!({ queryRunner: runner, query: sql, success: sql !== 'ABORT' });
      expect([sql, hasTxPermissionMemo(runner)]).toEqual([sql, false]);
    }
  });

  it('a filled set that ends with its transaction is never read again (runner no longer active)', async () => {
    const ds = primary();
    const { manager, runner } = txManager(ds, ['staff.view'], BOUND);
    const svc = service(ds);
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    (runner as unknown as { isTransactionActive: boolean }).isTransactionActive = false;
    await svc.userHasPermissionTx(manager, ctx, 'staff.view');
    expect(hasTxPermissionMemo(runner)).toBe(false);
  });
});
