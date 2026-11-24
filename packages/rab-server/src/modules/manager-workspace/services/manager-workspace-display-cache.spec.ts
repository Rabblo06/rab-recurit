import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { managerWorkspaceByOwnerCached, toManagerWorkspaceProjection } from './manager-workspace-display-cache';

/**
 * The by-owner workspace display read moved out of engine/'s CoreEntityCacheService (engine/ never imports modules/). It must
 * keep the cache kind and key the engine method used, or entries written before the move would be orphaned and
 * `invalidate('manager_workspace_by_owner', ownerUserId)` (ManagerWorkspaceService, WorkspaceProvisioningService) would
 * stop reaching them; and it must keep the projection.
 */
describe('managerWorkspaceByOwnerCached', () => {
  const row = Object.assign(new ManagerWorkspace(), {
    id: 'ws-1',
    organisationId: 'org-1',
    ownerUserId: 'user-1',
    name: 'Acme',
    subdomain: 'acme',
    logoKey: 'logos/ws-1.png',
    logoFileId: undefined,
    status: 'active',
    schemaStatus: undefined,
    createdAt: new Date('2026-10-29T09:00:00.000Z'),
    onboardingCompletedAt: undefined,
  });

  it("uses kind 'manager_workspace_by_owner' keyed by the owner's user id, and reads by ownerUserId on a miss", async () => {
    const manager = { findOne: jest.fn(async () => row) };
    const cache = { getOrFetch: jest.fn(async (_kind: string, _id: string, fetch: () => Promise<unknown>) => fetch()) };

    const out = await managerWorkspaceByOwnerCached(cache as never, manager as never, 'user-1');

    expect(cache.getOrFetch).toHaveBeenCalledTimes(1);
    expect(cache.getOrFetch.mock.calls[0]!.slice(0, 2)).toEqual(['manager_workspace_by_owner', 'user-1']);
    // No `enabled` / `ttlSeconds` argument: the service's own on/off switch and the default TTL apply, as before.
    expect(cache.getOrFetch.mock.calls[0]).toHaveLength(3);
    expect(manager.findOne).toHaveBeenCalledWith(ManagerWorkspace, { where: { ownerUserId: 'user-1' } });
    expect(out).toEqual({
      id: 'ws-1',
      organisationId: 'org-1',
      ownerUserId: 'user-1',
      name: 'Acme',
      subdomain: 'acme',
      logoFileId: null,
      status: 'active',
      schemaStatus: null,
      createdAt: '2026-10-29T09:00:00.000Z',
      onboardingCompletedAt: null,
    });
  });

  it('returns null (never cached by getOrFetch) when the owner has no workspace', async () => {
    const manager = { findOne: jest.fn(async () => null) };
    const cache = { getOrFetch: jest.fn(async (_kind: string, _id: string, fetch: () => Promise<unknown>) => fetch()) };
    await expect(managerWorkspaceByOwnerCached(cache as never, manager as never, 'user-2')).resolves.toBeNull();
  });

  it('projects exactly the display fields, nothing else from the row (no logoKey)', () => {
    const projected = toManagerWorkspaceProjection(
      Object.assign(new ManagerWorkspace(), row, {
        logoFileId: 'file-1',
        schemaStatus: 'READY',
        onboardingCompletedAt: new Date('2026-10-30T10:00:00.000Z'),
      }),
    );
    expect(Object.keys(projected).sort()).toEqual(
      ['createdAt', 'id', 'logoFileId', 'name', 'onboardingCompletedAt', 'organisationId', 'ownerUserId', 'schemaStatus', 'status', 'subdomain'],
    );
    expect(projected).toMatchObject({ logoFileId: 'file-1', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-30T10:00:00.000Z' });
  });
});
