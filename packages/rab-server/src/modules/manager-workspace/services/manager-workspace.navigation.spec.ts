import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { ManagerWorkspaceService } from './manager-workspace.service';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';

/**
 * Unit tests (no database) for Phase B P8 on the owner's own workspace endpoints:
 *  - `schemaRequired` (navigation info only) is derived server-side: HWS_RUNTIME_ENABLED on AND the session's own resolved
 *    workspace is this workspace; never true with HWS off or for a purely additive personal workspace;
 *  - getMine / create (every transaction) / completeOnboarding never route the tenant context to the caller's own
 *    not-yet-READY workspace (inv-p8 finding 4: the HWS-on resume 404);
 *  - layer 2 (service) refuses a suspended organisation or an inactive account before any row is written or any DDL runs.
 */
type Ctx = { organisationId: string | null; workspaceId: string | null; userId: string; role: string };

const WS_ID = 'ws-own';
const OWNER: Ctx = { organisationId: 'org-1', workspaceId: WS_ID, userId: 'user-1', role: 'manager' };

function workspaceRow(overrides: Partial<ManagerWorkspace> = {}): ManagerWorkspace {
  return {
    id: WS_ID,
    organisationId: 'org-1',
    ownerUserId: 'user-1',
    name: 'Acme',
    subdomain: 'acme',
    logoFileId: null,
    status: 'active',
    schemaStatus: 'CREATING',
    onboardingCompletedAt: new Date('2026-10-29T10:00:00Z'),
    createdAt: new Date('2026-10-29T09:00:00Z'),
    ...overrides,
  } as unknown as ManagerWorkspace;
}

function harness(opts: {
  hws: boolean;
  workspace?: ManagerWorkspace | null;
  gate?: { org_active: boolean | null; account_status: string | null };
  /** The caller's profile: an internal Manager (unbound until create binds it) or a Venue Manager bound elsewhere. */
  profile?: { type: 'internal' | 'venue'; workspaceId: string | null };
}) {
  const contexts: Ctx[] = [];
  let stored: ManagerWorkspace | null = opts.workspace === undefined ? workspaceRow() : opts.workspace;
  const profile = { id: 'profile-1', userId: 'user-1', ...(opts.profile ?? { type: 'internal' as const, workspaceId: null }) };
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ManagerWorkspace) return stored;
      if (entity === ManagerProfile) return { ...profile };
      return null;
    }),
    findOneByOrFail: jest.fn(async () => stored ?? workspaceRow()),
    update: jest.fn(async (entity: unknown, _where: unknown, values: Record<string, unknown>) => {
      if (entity === ManagerProfile && 'workspaceId' in values) profile.workspaceId = values.workspaceId as string;
    }),
    create: jest.fn((_e: unknown, v: Record<string, unknown>) => ({ id: WS_ID, ...v })),
    save: jest.fn(async (row: ManagerWorkspace) => {
      stored = row;
      return row;
    }),
    query: jest.fn(async (sql: string) => (sql.includes('org_active') ? [opts.gate ?? { org_active: true, account_status: 'active' }] : [])),
  };
  const tenantContext = {
    runInTenantContext: jest.fn(async (ctx: Ctx, fn: (m: unknown) => Promise<unknown>) => {
      contexts.push(ctx);
      return fn(manager);
    }),
  };
  const entityCache = { invalidate: jest.fn(async () => undefined), getManagerWorkspaceByOwner: jest.fn(async () => null) };
  const provisioning = { provisionOwnWorkspace: jest.fn(async () => 'READY' as const) };
  const environment = { get: jest.fn((key: string) => (key === 'HWS_RUNTIME_ENABLED' ? opts.hws : undefined)) };
  const service = new ManagerWorkspaceService(
    tenantContext as never,
    { assignOwnWorkspace: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    { checkAvailability: jest.fn(async () => ({ available: true, normalized: 'acme', reserved: false })) } as never,
    {} as never,
    entityCache as never,
    provisioning as never,
    undefined,
    environment as never,
  );
  return { service, manager, contexts, provisioning, entityCache };
}

describe('ManagerWorkspaceResponse.schemaRequired (server-derived navigation info)', () => {
  it.each([
    ['HWS on, the session routes through this workspace', true, WS_ID, true],
    ['HWS off (legacy core routing): never required', false, WS_ID, false],
    ['HWS on, but the session routes through ANOTHER workspace (inert personal workspace of a Venue Manager / CEO)', true, 'ws-elsewhere', false],
    ['HWS on, no resolved workspace (membership not resolved / suspended)', true, null, false],
  ])('%s', async (_label, hws, sessionWorkspace, expected) => {
    const { service } = harness({ hws });
    const res = await service.getMine({ ...OWNER, workspaceId: sessionWorkspace });
    expect(res.schemaRequired).toBe(expected);
  });

  it('is computed per request, never served from the entity cache (session-dependent)', async () => {
    const { service, entityCache } = harness({ hws: true });
    entityCache.getManagerWorkspaceByOwner.mockResolvedValueOnce({
      id: WS_ID, name: 'Acme', subdomain: 'acme', logoFileId: null, status: 'active', schemaStatus: 'CREATING',
      onboardingCompletedAt: null, createdAt: '2026-10-29T09:00:00Z',
    } as never);
    expect((await service.getMine(OWNER)).schemaRequired).toBe(true);
    expect((await service.getMine({ ...OWNER, workspaceId: null })).schemaRequired).toBe(false);
  });

  it('create(): true when this very request bound the workspace as the caller\'s operational home (ctx predates it)', async () => {
    const { service } = harness({ hws: true, workspace: null, profile: { type: 'internal', workspaceId: null } });
    const res = await service.create({ ...OWNER, workspaceId: null }, { name: 'Acme', subdomain: 'acme' });
    expect(res.schemaRequired).toBe(true);
  });

  it('create(): false for a purely additive personal workspace (profile bound elsewhere)', async () => {
    const { service } = harness({ hws: true, workspace: null, profile: { type: 'venue', workspaceId: 'ws-elsewhere' } });
    const res = await service.create({ ...OWNER, workspaceId: 'ws-elsewhere' }, { name: 'Acme', subdomain: 'acme' });
    expect(res.schemaRequired).toBe(false);
  });
});

describe('core-only tenant context for the owner\'s own workspace lifecycle (HWS-on resume fix)', () => {
  it('getMine never routes to the session workspace', async () => {
    const { service, contexts } = harness({ hws: true });
    await service.getMine(OWNER);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({ ...OWNER, workspaceId: null });
  });

  it('create (resume / retry replay of the same body) runs every transaction core-only and passes the real ctx to provisioning', async () => {
    const { service, contexts, provisioning } = harness({ hws: true });
    const res = await service.create(OWNER, { name: 'Acme', subdomain: 'acme' });
    expect(res.id).toBe(WS_ID);
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    for (const ctx of contexts) expect(ctx.workspaceId).toBeNull();
    // The provisioning service nulls the workspace itself (provisionOwnWorkspace's own core-only rule).
    expect(provisioning.provisionOwnWorkspace).toHaveBeenCalledWith(OWNER, WS_ID);
  });

  it('completeOnboarding runs core-only', async () => {
    const { service, contexts } = harness({ hws: true });
    await service.completeOnboarding(OWNER);
    expect(contexts.every((c) => c.workspaceId === null)).toBe(true);
  });
});

describe('layer 2: suspended organisation / inactive account (inv-security F3)', () => {
  it.each([
    ['organisation suspended', { org_active: false, account_status: 'active' }, 'ORGANISATION_SUSPENDED'],
    ['organisation row not visible (fail closed)', { org_active: null, account_status: 'active' }, 'ORGANISATION_SUSPENDED'],
    ['account suspended', { org_active: true, account_status: 'suspended' }, 'ACCOUNT_NOT_ACTIVE'],
    ['account deactivated', { org_active: true, account_status: 'deactivated' }, 'ACCOUNT_NOT_ACTIVE'],
    ['account invited (never activated)', { org_active: true, account_status: 'invited' }, 'ACCOUNT_NOT_ACTIVE'],
  ])('create() refuses (%s) before writing anything or provisioning', async (_label, gate, code) => {
    const { service, manager, provisioning } = harness({ hws: false, workspace: null, gate });
    const error = await service.create({ ...OWNER, workspaceId: null }, { name: 'Acme', subdomain: 'acme' }).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code });
    expect(manager.save).not.toHaveBeenCalled();
    expect(provisioning.provisionOwnWorkspace).not.toHaveBeenCalled();
  });
});

describe('WorkspaceProvisioningService.provisionOwnWorkspace (called directly, no guard)', () => {
  function provisioningHarness(opts: { workspace: ManagerWorkspace | null; gate?: { org_active: boolean | null; account_status: string | null }; fnError?: unknown }) {
    const sql: string[] = [];
    const manager = {
      findOne: jest.fn(async () => opts.workspace),
      query: jest.fn(async (q: string) => {
        sql.push(q);
        if (q.includes('org_active')) return [opts.gate ?? { org_active: true, account_status: 'active' }];
        if (q.includes('core.provision_workspace')) {
          if (opts.fnError) throw opts.fnError;
          return [{ outcome: 'READY' }];
        }
        return [];
      }),
    };
    const tenantContext = { runInTenantContext: jest.fn(async (_ctx: Ctx, fn: (m: unknown) => Promise<unknown>) => fn(manager)) };
    const service = new WorkspaceProvisioningService(
      tenantContext as never,
      { record: jest.fn(async () => undefined) } as never,
      { invalidate: jest.fn(async () => undefined) } as never,
    );
    return { service, sql, tenantContext };
  }

  it('a foreign / unknown workspace is 404 before any suspension read (no existence disclosure)', async () => {
    const { service, sql } = provisioningHarness({ workspace: null, gate: { org_active: false, account_status: 'suspended' } });
    await expect(service.provisionOwnWorkspace(OWNER, 'someone-elses')).rejects.toBeInstanceOf(NotFoundException);
    expect(sql.some((q) => q.includes('core.provision_workspace'))).toBe(false);
  });

  it('suspended organisation: 403 and core.provision_workspace is never called', async () => {
    const { service, sql } = provisioningHarness({ workspace: workspaceRow(), gate: { org_active: false, account_status: 'active' } });
    await expect(service.provisionOwnWorkspace(OWNER, WS_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sql.some((q) => q.includes('core.provision_workspace'))).toBe(false);
  });

  it('inactive account: 403 and core.provision_workspace is never called', async () => {
    const { service, sql } = provisioningHarness({ workspace: workspaceRow(), gate: { org_active: true, account_status: 'deactivated' } });
    await expect(service.provisionOwnWorkspace(OWNER, WS_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sql.some((q) => q.includes('core.provision_workspace'))).toBe(false);
  });

  it.each([
    ['CWP01', 'ORGANISATION_SUSPENDED'],
    ['CWP02', 'ACCOUNT_NOT_ACTIVE'],
  ])('the guarded function\'s own refusal %s maps to the same 403 (%s), never DEFERRED', async (sqlstate, code) => {
    const { service } = provisioningHarness({ workspace: workspaceRow(), fnError: Object.assign(new Error('refused'), { code: sqlstate }) });
    const error = await service.provisionOwnWorkspace(OWNER, WS_ID).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code });
  });

  it('always runs core-only, whatever workspace the session resolved', async () => {
    const { service, tenantContext } = provisioningHarness({ workspace: workspaceRow() });
    expect(await service.provisionOwnWorkspace(OWNER, WS_ID)).toBe('READY');
    expect(tenantContext.runInTenantContext.mock.calls[0]![0]).toEqual({ ...OWNER, workspaceId: null });
  });
});
