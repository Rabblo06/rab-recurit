import { DataSource, EntityManager } from 'typeorm';

import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';
import { bindGucsSql, TenantContextService, TenantSessionRoleError } from './tenant-context.service';
import { EnvironmentService } from '../environment/environment.service';

describe('TenantContextService', () => {
  // The exact single-round-trip GUC bind. Since e31bf934 it also RESETS the read-only shift-team capability
  // (`rab.team_shift_id` / `rab.team_staff_id`, set only by ShiftTeamService for one query) to '' on every
  // transaction, so a capability can never outlive the call that set it. Both resets are literal '' — never a
  // client-supplied parameter.
  // Owner-login pool safety: the same round trip also returns current_user / session_user (asserted equal), and it is
  // preceded by RESET ROLE (call 1).
  const BIND_GUCS_SQL =
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true), current_user::text AS cu, session_user::text AS su`;
  // T-1 / ST-01: when the schema is known before the bind (HWS off, or HWS on with no workspace) search_path is the
  // sixth set_config of the SAME SELECT, bound as $6 — never a separate statement. ST-02 adds transaction_read_only.
  const BIND_WITH_PATH_SQL =
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true), set_config('search_path', $6, true), current_user::text AS cu, session_user::text AS su`;
  const BIND_WITH_PATH_READ_ONLY_SQL =
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true), set_config('search_path', $6, true), set_config('transaction_read_only', 'on', true), current_user::text AS cu, session_user::text AS su`;
  const BIND_READ_ONLY_SQL =
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true), set_config('transaction_read_only', 'on', true), current_user::text AS cu, session_user::text AS su`;
  const SEARCH_PATH_SQL = `SELECT set_config('search_path', $1, true)`;

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
      BIND_WITH_PATH_SQL,
      ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core'],
    );
    expect(manager.query).toHaveBeenCalledTimes(2);
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
      BIND_WITH_PATH_SQL,
      ['', '', 'super-1', 'SUPER_ADMIN', '', 'core'],
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
      BIND_WITH_PATH_SQL,
      ['org-1', 'ws-1', '', '', 'worker', 'core'],
    );
  });

  it('resets the shift-team roster capability to empty on every bind, with exactly five client-derived parameters', async () => {
    const manager = buildManager();
    const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));

    await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'STAFF' }, async () => undefined);

    const [sql, params] = (manager.query as jest.Mock).mock.calls[1] as [string, unknown[]];
    expect(sql).toContain(`set_config('rab.team_shift_id', '', true)`);
    expect(sql).toContain(`set_config('rab.team_staff_id', '', true)`);
    // T-1: $1-$5 are the five client-derived values; $6 is the server constant 'core' (search_path), nothing beyond it.
    expect(sql).not.toMatch(/\$7/);
    expect(params).toHaveLength(6);
    expect(params.slice(0, 5)).toEqual(['org-1', 'ws-1', 'user-1', 'STAFF', '']);
    expect(params[5]).toBe('core');
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
      expect(manager.query).toHaveBeenNthCalledWith(2, BIND_WITH_PATH_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core']);
      expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('binds search_path to "core" when HWS_RUNTIME_ENABLED is true but ctx.workspaceId is null (a workspace-less actor)', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver();
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: null, userId: 'ceo-1', role: 'CEO' }, async () => undefined);

      expect(schemaResolver.resolve).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenNthCalledWith(2, BIND_WITH_PATH_SQL, ['org-1', '', 'ceo-1', 'CEO', '', 'core']);
      expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('resolves the trusted physical schema and binds search_path to exactly that schema when HWS_RUNTIME_ENABLED is true and ctx.workspaceId is set', async () => {
      const manager = buildManager();
      const schemaResolver = buildSchemaResolver('workspace_deadbeefdeadbeefdeadbeefdeadbeef');
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));

      await service.runInTenantContext({ organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' }, async () => undefined);

      expect(schemaResolver.resolve).toHaveBeenCalledWith(manager, 'ws-1');
      // The registry is FORCE RLS: the GUCs are bound first (no path), then the separate search_path after resolve().
      expect(manager.query).toHaveBeenNthCalledWith(2, BIND_GUCS_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '']);
      expect(manager.query).toHaveBeenNthCalledWith(3, SEARCH_PATH_SQL, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
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
      expect(manager.query).toHaveBeenNthCalledWith(2, BIND_WITH_PATH_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core']);
      expect(manager.query).toHaveBeenCalledTimes(2);
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
      expect(manager.query).toHaveBeenNthCalledWith(2, BIND_GUCS_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '']);
      expect(manager.query).toHaveBeenNthCalledWith(3, SEARCH_PATH_SQL, ['workspace_deadbeefdeadbeefdeadbeefdeadbeef']);
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
  // T-1 (ST-01 / ST-02): the exact statement sequence of every tenant-transaction shape. The owner kept both RESET ROLEs,
  // the current_user = session_user check, Admin Inspect's own first-statement READ ONLY and the separate search_path when
  // the schema is only known after the registry lookup. The pool-checkout RESET ROLE (layer 1) is not issued through the
  // manager, so it does not appear here: it is covered by owner-login-guards.integration.spec.ts.
  describe('T-1: exact statement sequence', () => {
    const CTX = { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' };
    const WS_SCHEMA = 'workspace_deadbeefdeadbeefdeadbeefdeadbeef';
    const calls = (manager: EntityManager) => (manager.query as jest.Mock).mock.calls as Array<[string, unknown[]?]>;

    it('HWS off: RESET ROLE, then ONE SELECT carrying search_path = core; no second set_config, no READ ONLY', async () => {
      const manager = buildManager();
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      await service.runInTenantContext(CTX, async () => undefined);
      expect(calls(manager)).toEqual([['RESET ROLE'], [BIND_WITH_PATH_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core']]]);
    });

    it('HWS on with a workspace: RESET ROLE, the bind (no path), resolve, then the separate search_path', async () => {
      const manager = buildManager();
      const order: string[] = [];
      (manager.query as jest.Mock).mockImplementation(async (sql: string) => {
        order.push(sql);
        return sql.startsWith(`SELECT set_config('rab.organisation_id'`) ? [{ cu: 'crewflow_owner', su: 'crewflow_owner' }] : undefined;
      });
      const schemaResolver = {
        resolve: jest.fn(async () => {
          order.push('<resolve>');
          return WS_SCHEMA;
        }),
      } as unknown as SchemaResolverService;
      const service = new TenantContextService(buildDataSource(manager), schemaResolver, buildEnvironment(true));
      await service.runInTenantContext(CTX, async () => undefined);
      expect(order).toEqual(['RESET ROLE', BIND_GUCS_SQL, '<resolve>', SEARCH_PATH_SQL]);
      expect(calls(manager)[2]).toEqual([SEARCH_PATH_SQL, [WS_SCHEMA]]);
    });

    it('readOnly (HWS off): transaction_read_only is in the SAME SELECT as the identity GUCs and the path', async () => {
      for (const run of ['tenant', 'workspace'] as const) {
        const manager = buildManager();
        const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
        if (run === 'tenant') await service.runInTenantContext(CTX, async () => undefined, { readOnly: true });
        else await service.runInWorkspaceContext(CTX, async () => undefined, { readOnly: true });
        expect(calls(manager)).toEqual([['RESET ROLE'], [BIND_WITH_PATH_READ_ONLY_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core']]]);
      }
    });

    it('readOnly (HWS on with a workspace): read-only in the bind, BEFORE the registry lookup; search_path still separate', async () => {
      const manager = buildManager();
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(WS_SCHEMA), buildEnvironment(true));
      await service.runInTenantContext(CTX, async () => undefined, { readOnly: true });
      expect(calls(manager)).toEqual([['RESET ROLE'], [BIND_READ_ONLY_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '']], [SEARCH_PATH_SQL, [WS_SCHEMA]]]);
    });

    it('Admin Inspect (CF-02) is unchanged: its own SET TRANSACTION READ ONLY stays the first statement', async () => {
      const manager = buildManager();
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      await service.runInTenantContext({ ...CTX, inspectedBy: 'admin-1' } as never, async () => undefined);
      expect(calls(manager)).toEqual([
        ['SET TRANSACTION READ ONLY'],
        ['RESET ROLE'],
        [BIND_WITH_PATH_SQL, ['org-1', 'ws-1', 'user-1', 'MANAGER', '', 'core']],
      ]);
    });

    it('bindCoreIdentityGucs (the auth security snapshot) still binds no search_path and no read-only flag', async () => {
      const manager = buildManager();
      const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
      await service.bindCoreIdentityGucs(manager, { organisationId: 'org-1', workspaceId: null, userId: 'u', role: 'MANAGER' });
      expect(calls(manager)).toEqual([['RESET ROLE'], [BIND_GUCS_SQL, ['org-1', '', 'u', 'MANAGER', '']]]);
    });

    it('bindGucsSql: GUC names and the read-only literal are constants; only $1-$6 carry values', () => {
      expect(bindGucsSql()).toBe(BIND_GUCS_SQL);
      expect(bindGucsSql({ searchPath: 'core' })).toBe(BIND_WITH_PATH_SQL);
      expect(bindGucsSql({ searchPath: 'core', readOnly: true })).toBe(BIND_WITH_PATH_READ_ONLY_SQL);
      expect(bindGucsSql({ readOnly: true })).toBe(BIND_READ_ONLY_SQL);
      // The search_path VALUE never reaches the statement text, whatever it is.
      expect(bindGucsSql({ searchPath: "x', true); DROP SCHEMA core; --" })).toBe(BIND_WITH_PATH_SQL);
      for (const sql of [BIND_GUCS_SQL, BIND_WITH_PATH_SQL, BIND_WITH_PATH_READ_ONLY_SQL, BIND_READ_ONLY_SQL]) {
        expect(sql).not.toMatch(/set_config\([^)]*,\s*false\)/); // nothing session-scoped
      }
    });

    it('injection payloads as role / organisationId / userId stay bound parameters; search_path stays the constant', async () => {
      const payloads = ["MANAGER'; SET ROLE rab_secure_owner; --", "x', false); SELECT set_config('search_path', 'public', false); --", 'core, public', '$6'];
      for (const payload of payloads) {
        const manager = buildManager();
        const service = new TenantContextService(buildDataSource(manager), buildSchemaResolver(), buildEnvironment(false));
        await service.runInTenantContext({ organisationId: payload, workspaceId: null, userId: payload, role: payload }, async () => undefined);
        expect(calls(manager)[1]).toEqual([BIND_WITH_PATH_SQL, [payload, '', payload, payload, '', 'core']]);
      }
    });
  });

  // T-1 framing-count guard: a counting fake DataSource counts TypeORM's own START TRANSACTION / COMMIT as statements, so
  // the whole TypeORM-issued framing of one tenant transaction is visible. Production shape (HWS off) and the Worker's
  // read-only scans must stay at <= 4 (START, RESET ROLE, the one binding SELECT, COMMIT). A regression that adds a round
  // trip fails here. (The pool-checkout RESET ROLE is the fifth, outside TypeORM; pg_stat_statements is the ground truth.)
  describe('T-1: framing-count guard', () => {
    function countingDataSource(manager: EntityManager) {
      const framing: string[] = [];
      let inCallback = false;
      (manager.query as jest.Mock).mockImplementation(async (sql: string) => {
        if (!inCallback) framing.push(sql);
        return sql.startsWith(`SELECT set_config('rab.organisation_id'`) ? [{ cu: 'crewflow_owner', su: 'crewflow_owner' }] : undefined;
      });
      const dataSource = {
        transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => {
          framing.push('START TRANSACTION');
          const out = await fn(manager);
          framing.push('COMMIT');
          return out;
        }),
      } as unknown as DataSource;
      const enter = async () => {
        inCallback = true;
      };
      const leave = () => {
        inCallback = false;
      };
      return { dataSource, framing, enter, leave };
    }
    const CTX = { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' };

    it.each([
      ['API runInTenantContext, HWS off', 'tenant', undefined],
      ['API runInWorkspaceContext, HWS off', 'workspace', undefined],
      ['Worker scan (readOnly), HWS off', 'tenant', { readOnly: true }],
      ['Worker scan (readOnly) via runInWorkspaceContext, HWS off', 'workspace', { readOnly: true }],
    ] as const)('%s: at most 4 framing statements', async (_label, entry, options) => {
      const manager = buildManager();
      const c = countingDataSource(manager);
      const service = new TenantContextService(c.dataSource, buildSchemaResolver(), buildEnvironment(false));
      const body = async (m: EntityManager) => {
        await c.enter();
        await m.query('SELECT 1 /* business */');
        c.leave();
      };
      if (entry === 'tenant') await service.runInTenantContext(CTX, body, options);
      else await service.runInWorkspaceContext(CTX, body, options);
      expect(c.framing).toHaveLength(4);
      expect(c.framing[0]).toBe('START TRANSACTION');
      expect(c.framing[1]).toBe('RESET ROLE');
      expect(c.framing[2]).toMatch(/^SELECT set_config\('rab.organisation_id'.*set_config\('search_path', \$6, true\)/);
      expect(c.framing[3]).toBe('COMMIT');
      expect(c.framing).not.toContain('SET TRANSACTION READ ONLY');
      expect(c.framing).not.toContain(SEARCH_PATH_SQL);
    });

    it('Admin Inspect: 5 (its own first-statement READ ONLY is kept on purpose)', async () => {
      const manager = buildManager();
      const c = countingDataSource(manager);
      const service = new TenantContextService(c.dataSource, buildSchemaResolver(), buildEnvironment(false));
      await service.runInTenantContext({ ...CTX, inspectedBy: 'admin-1' } as never, async () => undefined);
      expect(c.framing).toEqual(['START TRANSACTION', 'SET TRANSACTION READ ONLY', 'RESET ROLE', BIND_WITH_PATH_SQL, 'COMMIT']);
    });

    it('HWS on with a workspace: 5 plus the registry lookup (search_path cannot be folded before the GUCs exist)', async () => {
      const manager = buildManager();
      const c = countingDataSource(manager);
      const service = new TenantContextService(c.dataSource, buildSchemaResolver(), buildEnvironment(true));
      await service.runInTenantContext(CTX, async () => undefined, { readOnly: true });
      expect(c.framing).toEqual(['START TRANSACTION', 'RESET ROLE', BIND_READ_ONLY_SQL, SEARCH_PATH_SQL, 'COMMIT']);
    });
  });
});
