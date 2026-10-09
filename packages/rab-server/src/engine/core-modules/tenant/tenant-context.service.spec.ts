import { DataSource, EntityManager } from 'typeorm';

import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';
import { TenantContextService } from './tenant-context.service';
import { EnvironmentService } from '../environment/environment.service';

describe('TenantContextService', () => {
  function buildManager() {
    return { query: jest.fn().mockResolvedValue(undefined) } as unknown as EntityManager;
  }

  function buildDataSource(manager: EntityManager) {
    return {
      transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => fn(manager)),
    } as unknown as DataSource;
  }

  function buildEnvironment(hwsEnabled: boolean) {
    return { get: jest.fn().mockReturnValue(hwsEnabled) } as unknown as EnvironmentService;
  }

  function buildSchemaResolver(resolved?: string | Error) {
    const resolve =
      resolved instanceof Error ? jest.fn().mockRejectedValue(resolved) : jest.fn().mockResolvedValue(resolved ?? 'workspace_deadbeefdeadbeefdeadbeefdeadbeef');
    return { resolve } as unknown as SchemaResolverService;
  }

  it('binds organisationId, workspaceId, userId, role and actorType via set_config inside the transaction, in one round trip', async () => {
    const manager = buildManager();
    const dataSource = buildDataSource(manager);
    const service = new TenantContextService(dataSource, buildSchemaResolver(), buildEnvironment(false));

    await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' },
      async () => 'result',
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true)`,
      ['org-1', 'ws-1', 'user-1', 'MANAGER', ''],
    );
  });

  it('binds an empty string, not the literal "null", for a platform actor with no organisation or workspace', async () => {
    const manager = buildManager();
    const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));

    await service.runInTenantContext(
      { organisationId: null, workspaceId: null, userId: 'super-1', role: 'SUPER_ADMIN' },
      async () => undefined,
    );

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true)`,
      ['', '', 'super-1', 'SUPER_ADMIN', ''],
    );
  });

  it('binds rab.actor_type = "worker" only when the context explicitly sets actorType — never for a human request', async () => {
    const manager = buildManager();
    const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));

    await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: 'ws-1', userId: '', role: '', actorType: 'worker' },
      async () => undefined,
    );

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true)`,
      ['org-1', 'ws-1', '', '', 'worker'],
    );
  });

  it('returns the callback result', async () => {
    const service = new TenantContextService(buildDataSource(buildManager()), buildSchemaResolver(), buildEnvironment(false));

    const result = await service.runInTenantContext(
      { organisationId: 'org-1', workspaceId: null, userId: 'user-1', role: 'STAFF' },
      async (manager) => {
        expect(manager).toBeDefined();
        return 42;
      },
    );

    expect(result).toBe(42);
  });

  // HWS runtime cutover (Part 2/4): search_path is always set explicitly, transaction-local, in exactly one of three
  // mutually exclusive ways — never a 'workspace, core' fallback chain.
  describe('HWS runtime cutover — search_path binding', () => {
    it('binds search_path to "core" when HWS_RUNTIME_ENABLED is false, regardless of ctx.workspaceId', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver();
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(false));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, async () => undefined);

      expect(schemaResolver.resolve).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenNthCalledWith(2, `SELECT set_config('search_path', $1, true)`, ['core']);
    });

    it('binds search_path to "core" when HWS_RUNTIME_ENABLED is true but ctx.workspaceId is null (a workspace-less actor)', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver();
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: null, userId: 'ceo-1', role: 'CEO' }, async () => undefined);

      expect(schemaResolver.resolve).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenNthCalledWith(2, `SELECT set_config('search_path', $1, true)`, ['core']);
    });

    it('resolves the trusted physical schema and binds search_path to exactly that schema when HWS_RUNTIME_ENABLED is true and ctx.workspaceId is set', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver('workspace_deadbeefdeadbeefdeadbeefdeadbeef');
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, async () => undefined);

      expect(schemaResolver.resolve).toHaveBeenCalledWith(manager, 'ws-1');
      expect(manager.query).toHaveBeenNthCalledWith(2, `SELECT set_config('search_path', $1, true)`, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
    });

    it('fails closed: a workspace that is not READY (or otherwise unroutable) rejects before any business callback runs, and search_path is never set', async () => {
      const manager = buildManager();
      const routingError = new WorkspaceRoutingError('not-ready');
      const schemaResolver = buildSchemaResolver(routingError);
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));
      const callback = jest.fn();

      await expect(
        service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, callback),
      ).rejects.toThrow(WorkspaceRoutingError);

      expect(callback).not.toHaveBeenCalled();
      // Only the GUC bind happened — the search_path set_config never ran because resolve() rejected first.
      expect(manager.query).toHaveBeenCalledTimes(1);
    });
  });

  // Section 1 of the runtime cutover: the canonical fail-closed boundary for workspace-business (the 15 physical
  // tables). Distinct from runInTenantContext precisely in that case 3 (no workspace → 'core') does not exist here.
  describe('runInWorkspaceContext — the workspace-business boundary', () => {
    it('fails closed with a missing-context WorkspaceRoutingError when ctx.workspaceId is null, in either HWS mode', async () => {
      for (const hwsEnabled of [false, true]) {
        const manager = buildManager();
        const dataSource = buildDataSource(manager);
        const schemaResolver = buildSchemaResolver();
        const service = new TenantContextService(dataSource, schemaResolver, buildEnvironment(hwsEnabled));
        const callback = jest.fn();

        await expect(
          service.runInWorkspaceContext({ organisationId: 'org-1', workspaceId: null, userId: 'ceo-1', role: 'CEO' }, callback),
        ).rejects.toThrow(WorkspaceRoutingError);

        expect(callback).not.toHaveBeenCalled();
        // The transaction itself is never opened: the check runs before dataSource.transaction is called, so no
        // connection is taken from the pool for a request this boundary is going to refuse anyway.
        expect(dataSource.transaction).not.toHaveBeenCalled();
        expect(schemaResolver.resolve).not.toHaveBeenCalled();
      }
    });

    it('binds search_path to "core" when HWS_RUNTIME_ENABLED is false, even with a workspace bound (legacy/compat: workspace tables still live in core)', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver();
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(false));

      const result = await service.runInWorkspaceContext(
        { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' },
        async (_manager, schema) => schema,
      );

      expect(schemaResolver.resolve).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenNthCalledWith(2, `SELECT set_config('search_path', $1, true)`, ['core']);
      expect(result).toBe('core');
    });

    it('resolves and binds the physical workspace schema when HWS_RUNTIME_ENABLED is true, and hands it to the callback', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver('workspace_deadbeefdeadbeefdeadbeefdeadbeef');
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      const result = await service.runInWorkspaceContext(
        { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' },
        async (_manager, schema) => schema,
      );

      expect(schemaResolver.resolve).toHaveBeenCalledWith(manager, 'ws-1');
      expect(manager.query).toHaveBeenNthCalledWith(2, `SELECT set_config('search_path', $1, true)`, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
      expect(result).toBe('workspace_deadbeefdeadbeefdeadbeefdeadbeef');
    });

    it('fails closed on a not-READY workspace without ever invoking the callback', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver(new WorkspaceRoutingError('not-ready'));
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));
      const callback = jest.fn();

      await expect(
        service.runInWorkspaceContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, callback),
      ).rejects.toThrow(WorkspaceRoutingError);

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
