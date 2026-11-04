import { DataSource, EntityManager } from 'typeorm';

import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';
import { TenantContextService, TenantSessionRoleError } from './tenant-context.service';
import { EnvironmentService } from '../environment/environment.service';

describe('TenantContextService', () => {
  // The exact single-round-trip GUC bind. Since e31bf934 it also RESETS the read-only shift-team capability
  // (`rab.team_shift_id` / `rab.team_staff_id`, set only by ShiftTeamService for one query) to '' on every
  // transaction, so a capability can never outlive the call that set it. Both resets are literal '' — never a
  // client-supplied parameter.
  // Owner-login pool safety: the same round trip also returns current_user / session_user (asserted equal), and it is
  // preceded by RESET ROLE (call 1).
  const BIND_GUCS_SQL =
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), current_user::text AS cu, session_user::text AS su`;

  /** The bind answers with the session identity; every other statement with nothing. `actingAs` simulates a SET ROLE. */
  function buildManager(actingAs = 'crewflow_owner') {
    return {
      query: jest.fn(async (sql: string) => (sql.startsWith(`SELECT set_config('rab.organisation_id'`) ? [{ cu: actingAs, su: 'crewflow_owner' }] : undefined)),
    } as unknown as EntityManager;
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
    expect(manager.query).toHaveBeenNthCalledWith(1, 'RESET ROLE');
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      BIND_GUCS_SQL,
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

    expect(manager.query).toHaveBeenNthCalledWith(1, 'RESET ROLE');
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      BIND_GUCS_SQL,
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

    expect(manager.query).toHaveBeenNthCalledWith(1, 'RESET ROLE');
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      BIND_GUCS_SQL,
      ['org-1', 'ws-1', '', '', 'worker'],
    );
  });

  it('resets the shift-team roster capability to empty on every bind, with exactly five client-derived parameters', async () => {
    const manager = buildManager();
    const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));

    await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'STAFF' }, async () => undefined);

    const [sql, params] = (manager.query as jest.Mock).mock.calls[1] as [string, unknown[]];
    expect(sql).toContain(`set_config('rab.team_shift_id', '', true)`);
    expect(sql).toContain(`set_config('rab.team_staff_id', '', true)`);
    expect(sql).not.toMatch(/\$6/);
    expect(params).toHaveLength(5);
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
      expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('search_path', $1, true)`, ['core']);
    });

    it('binds search_path to "core" when HWS_RUNTIME_ENABLED is true but ctx.workspaceId is null (a workspace-less actor)', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver();
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: null, userId: 'ceo-1', role: 'CEO' }, async () => undefined);

      expect(schemaResolver.resolve).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('search_path', $1, true)`, ['core']);
    });

    it('resolves the trusted physical schema and binds search_path to exactly that schema when HWS_RUNTIME_ENABLED is true and ctx.workspaceId is set', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver('workspace_deadbeefdeadbeefdeadbeefdeadbeef');
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, async () => undefined);

      expect(schemaResolver.resolve).toHaveBeenCalledWith(manager, 'ws-1');
      expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('search_path', $1, true)`, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
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
      // Only RESET ROLE and the GUC bind happened — the search_path set_config never ran because resolve() rejected first.
      expect(manager.query).toHaveBeenCalledTimes(2);
    });
  });

  // Owner-login pool safety (M0 §6.4 control 3, G-09): a session-level SET ROLE left on a pooled connection by an earlier
  // request must never reach this tenant transaction. Real-PostgreSQL proof: pool-session-role-reset.integration.spec.ts.
  describe('pool safety — RESET ROLE and current_user = session_user', () => {
    it('runs RESET ROLE as the first statement of every tenant transaction, before the tenant is bound', async () => {
      const manager = buildManager();
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: null, userId: 'u', role: 'MANAGER' }, async () => undefined);
      expect((manager.query as jest.Mock).mock.calls[0]).toEqual(['RESET ROLE']);
    });

    it('fails closed (no callback) when the session still acts as another role after the reset', async () => {
      const manager = buildManager('rab_secure_owner');
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      const callback = jest.fn();
      await expect(service.runInTenantContext({ organisationId: 'org-1', workspaceId: null, userId: 'u', role: 'MANAGER' }, callback)).rejects.toThrow(
        TenantSessionRoleError,
      );
      expect(callback).not.toHaveBeenCalled();
    });

    it('applies the same reset and check to bindCoreIdentityGucs (the auth security snapshot path)', async () => {
      const manager = buildManager('crewflow');
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      await expect(service.bindCoreIdentityGucs(manager, { organisationId: 'org-1', workspaceId: null, userId: 'u', role: 'MANAGER' })).rejects.toThrow(
        TenantSessionRoleError,
      );
      expect((manager.query as jest.Mock).mock.calls[0]).toEqual(['RESET ROLE']);
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
      expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('search_path', $1, true)`, ['core']);
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
      expect(manager.query).toHaveBeenNthCalledWith(3, `SELECT set_config('search_path', $1, true)`, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
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
