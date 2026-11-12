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

describe('PermissionsService.displayHints (SC-05, GET /auth/capabilities)', () => {
  const flags = ['staff.view', 'payroll.approve', 'offer.send'] as const;
  const snapshot = (over: Partial<{ userId: string; organisationId: string; workspaceId: string | null }> = {}) => ({
    userId: 'user-1',
    organisationId: 'org-1',
    workspaceId: null,
    accountStatus: 'active' as never,
    mustResetPassword: false,
    roles: ['manager'],
    isPlatformAdmin: false,
    maintenanceModeEnabled: false,
    organisationSuspended: false,
    effectivePermissions: new Set(['staff.view', 'offer.send']),
    ...over,
  });
  function build(liveKeys: string[]) {
    const manager = { query: jest.fn().mockResolvedValue(liveKeys.map((key) => ({ key }))) } as unknown as EntityManager;
    const tenantContext = { runInTenantContext: jest.fn((_ctx, fn) => fn(manager)) } as unknown as TenantContextService;
    return { service: new PermissionsService(tenantContext), tenantContext, manager };
  }

  it('answers from the request snapshot of this identity: zero transactions, zero queries', async () => {
    const { service, tenantContext, manager } = build(['payroll.approve']);
    const hints = await service.displayHints({ ...ctx, security: snapshot() }, flags);
    expect(hints).toEqual({ 'staff.view': true, 'payroll.approve': false, 'offer.send': true });
    expect(Object.keys(hints)).toEqual([...flags]);
    expect(tenantContext.runInTenantContext).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('Admin Inspect never uses the ADMIN snapshot: the target set is resolved in ONE transaction with ONE query', async () => {
    const { service, tenantContext, manager } = build(['payroll.approve']);
    const inspected = { ...ctx, inspectedBy: 'admin-1', security: snapshot({ userId: 'admin-1' }) };
    const hints = await service.displayHints(inspected, flags);
    expect(hints).toEqual({ 'staff.view': false, 'payroll.approve': true, 'offer.send': false });
    expect(tenantContext.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(tenantContext.runInTenantContext).toHaveBeenCalledWith(inspected, expect.any(Function));
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect((manager.query as jest.Mock).mock.calls[0][1]).toEqual(['user-1']);
  });

  it.each([
    ['another user', { userId: 'someone-else' }],
    ['another organisation', { organisationId: 'org-2' }],
    ['another workspace', { workspaceId: 'ws-2' }],
  ])('a snapshot of %s is never used (falls back to a live read of this identity)', async (_label, over) => {
    const { service, tenantContext } = build([]);
    const hints = await service.displayHints({ ...ctx, security: snapshot(over) }, flags);
    expect(hints).toEqual({ 'staff.view': false, 'payroll.approve': false, 'offer.send': false });
    expect(tenantContext.runInTenantContext).toHaveBeenCalledTimes(1);
  });

  it('no snapshot at all: one live transaction (fail closed to a live read, never a default allow)', async () => {
    const { service, tenantContext } = build(['staff.view']);
    await expect(service.displayHints(ctx, flags)).resolves.toEqual({ 'staff.view': true, 'payroll.approve': false, 'offer.send': false });
    expect(tenantContext.runInTenantContext).toHaveBeenCalledTimes(1);
  });

  it('a failing live read propagates (the endpoint errors; it never answers true)', async () => {
    const tenantContext = { runInTenantContext: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as TenantContextService;
    await expect(new PermissionsService(tenantContext).displayHints(ctx, flags)).rejects.toThrow('db down');
  });
});
