import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { ManagerWorkspaceService } from './manager-workspace.service';

/**
 * Unit test (no database): ManagerWorkspaceService.create must write an explicit, NON-ROUTABLE initial schema lifecycle state.
 * NULL is legacy and must not be the state of a newly created workspace.
 */
describe('ManagerWorkspaceService.create: initial schema lifecycle', () => {
  it('saves the new workspace with schema_status CREATING (not NULL, not READY)', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const manager = {
      findOne: jest.fn(async (entity: unknown) => (entity === ManagerProfile ? { id: 'profile-1', userId: 'user-1' } : null)),
      create: jest.fn((_entity: unknown, values: Record<string, unknown>) => ({ id: 'workspace-1', ...values })),
      save: jest.fn(async (row: Record<string, unknown>) => {
        saved.push(row);
        return row;
      }),
      update: jest.fn(async () => undefined),
      // ManagerWorkspaceService.create binds rab.workspace_id via a raw `manager.query(...)` call
      // before the ManagerProfile update below (manager-workspace.service.ts:232) — added after
      // this mock was last updated, found live via a real `manager.query is not a function`.
      query: jest.fn(async () => undefined),
    };
    const tenantContext = { runInTenantContext: jest.fn((_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn(manager)) };
    const subdomainService = { checkAvailability: jest.fn(async () => ({ available: true, normalized: 'acme', reserved: false })) };
    const workspaceMembership = { assignOwnWorkspace: jest.fn(async () => undefined) };
    const auditService = { record: jest.fn(async () => undefined) };
    const provisioning = { provisionOwnWorkspace: jest.fn(async () => 'DEFERRED' as const) };

    const service = new ManagerWorkspaceService(
      tenantContext as never,
      workspaceMembership as never,
      auditService as never,
      subdomainService as never,
      {} as never,
      {} as never, // entityCache — unused by create(), which never reads or writes it.
      provisioning as never,
    );
    const created = await service.create(
      { organisationId: 'org-1', workspaceId: null, userId: 'user-1', role: '' },
      { name: 'Acme', subdomain: 'acme' },
    );

    expect(manager.create).toHaveBeenCalledWith(ManagerWorkspace, expect.objectContaining({ schemaStatus: 'CREATING' }));
    // Server-path provisioning runs AFTER the row is committed, for the server-derived id; DEFERRED keeps the real state.
    expect(provisioning.provisionOwnWorkspace).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', organisationId: 'org-1' }), 'workspace-1');
    expect(created.schemaStatus).toBe('CREATING');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.schemaStatus).toBe('CREATING');
    expect(saved[0]!.schemaStatus).not.toBeNull();
    expect(saved[0]!.schemaStatus).not.toBe('READY');
  });
});
