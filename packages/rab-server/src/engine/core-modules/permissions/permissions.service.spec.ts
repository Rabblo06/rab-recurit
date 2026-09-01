import { EntityManager } from 'typeorm';

import { TenantContextService } from '../tenant/tenant-context.service';
import { PermissionsService } from './permissions.service';

function fakeManager(overrideEffect: 'grant' | 'revoke' | undefined, roleGrantCount: number): EntityManager {
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(overrideEffect ? { effect: overrideEffect } : undefined),
    getCount: jest.fn().mockResolvedValue(roleGrantCount),
  };
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as EntityManager;
}

function buildService(overrideEffect: 'grant' | 'revoke' | undefined, roleGrantCount: number) {
  const manager = fakeManager(overrideEffect, roleGrantCount);
  const tenantContext = {
    runInTenantContext: jest.fn((_ctx, fn) => fn(manager)),
  } as unknown as TenantContextService;
  return new PermissionsService(tenantContext);
}

const ctx = { organisationId: 'org-1', workspaceId: null, userId: 'user-1', role: 'manager' };

describe('PermissionsService', () => {
  it('allows when a role grants the permission and there is no override', async () => {
    const service = buildService(undefined, 1);
    await expect(service.userHasPermission(ctx, 'payroll.approve')).resolves.toBe(true);
  });

  it('denies when no role grants the permission and there is no override', async () => {
    const service = buildService(undefined, 0);
    await expect(service.userHasPermission(ctx, 'payroll.approve')).resolves.toBe(false);
  });

  it('a "grant" override allows even with no role-based grant', async () => {
    const service = buildService('grant', 0);
    await expect(service.userHasPermission(ctx, 'payroll.approve')).resolves.toBe(true);
  });

  it('a "revoke" override denies even when a role would otherwise grant it', async () => {
    const service = buildService('revoke', 1);
    await expect(service.userHasPermission(ctx, 'payroll.approve')).resolves.toBe(false);
  });

  it('resolves inside the caller\'s tenant context', async () => {
    const manager = fakeManager(undefined, 1);
    const tenantContext = {
      runInTenantContext: jest.fn((boundCtx, fn) => fn(manager)),
    } as unknown as TenantContextService;
    const service = new PermissionsService(tenantContext);

    await service.userHasPermission(ctx, 'payroll.approve');

    expect(tenantContext.runInTenantContext).toHaveBeenCalledWith(ctx, expect.any(Function));
  });
});
