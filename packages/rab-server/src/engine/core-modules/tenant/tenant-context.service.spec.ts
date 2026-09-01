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

  it('binds organisationId, workspaceId, userId and role via set_config inside the transaction, in order', async () => {
    const manager = buildManager();
    const dataSource = buildDataSource(manager);
    const service = new TenantContextService(dataSource);

    await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' },
      async () => 'result',
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true)`,
      ['org-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      `SELECT set_config('rab.workspace_id', $1, true)`,
      ['ws-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('rab.user_id', $1, true)`, [
      'user-1',
    ]);
    expect(manager.query).toHaveBeenNthCalledWith(4, `SELECT set_config('rab.role', $1, true)`, [
      'MANAGER',
    ]);
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
      `SELECT set_config('rab.organisation_id', $1, true)`,
      [''],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      `SELECT set_config('rab.workspace_id', $1, true)`,
      [''],
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
