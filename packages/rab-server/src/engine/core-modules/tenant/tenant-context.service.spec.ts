import { DataSource, EntityManager } from 'typeorm';

import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  function buildManager() {
    return { query: jest.fn().mockResolvedValue(undefined) } as unknown as EntityManager;
  }

  function buildDataSource(manager: EntityManager) {
    return {
      transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => fn(manager)),
    } as unknown as DataSource;
  }

  it('binds organisationId, workspaceId, userId and role via set_config inside the transaction, in one round trip', async () => {
    const manager = buildManager();
    const dataSource = buildDataSource(manager);
    const service = new TenantContextService(dataSource);

    await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' },
      async () => 'result',
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true)`,
      ['org-1', 'ws-1', 'user-1', 'MANAGER'],
    );
  });

  it('binds an empty string, not the literal "null", for a platform actor with no organisation or workspace', async () => {
    const manager = buildManager();
    const service = new TenantContextService(buildDataSource(manager));

    await service.runInTenantContext(
      { organisationId: null, workspaceId: null, userId: 'super-1', role: 'SUPER_ADMIN' },
      async () => undefined,
    );

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true)`,
      ['', '', 'super-1', 'SUPER_ADMIN'],
    );
  });

  it('returns the callback result', async () => {
    const service = new TenantContextService(buildDataSource(buildManager()));

    const result = await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: null, userId: 'user-1', role: 'STAFF' },
      async (manager) => {
        expect(manager).toBeDefined();
        return 42;
      },
    );

    expect(result).toBe(42);
  });
});
