import { Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  LATEST_WORKSPACE_MODULE_VERSION,
  MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION,
} from '../../../database/typeorm/workspace-schema/workspace-schema-modules';
import { assertCompatibleModuleVersion, SchemaResolverService, WorkspaceRoutingError, workspaceSchemaName } from './schema-resolver.service';

describe('workspaceSchemaName (Phase 1 SchemaResolver)', () => {
  const WS_A = '11111111-1111-4111-8111-111111111111';
  // Derived inside PostgreSQL by core.provision_workspace_schema(uuid) on the migrated disposable DB.
  const WS_A_SCHEMA_FROM_DB = 'workspace_11111111111141118111111111111111';

  it('is deterministic for the same workspace id', () => {
    expect(workspaceSchemaName(WS_A)).toBe(workspaceSchemaName(WS_A));
  });

  it('matches the schema name PostgreSQL derives for the same UUID', () => {
    expect(workspaceSchemaName(WS_A)).toBe(WS_A_SCHEMA_FROM_DB);
  });

  it('canonicalises hyphen-less and upper-case input to the same name', () => {
    expect(workspaceSchemaName(WS_A.toUpperCase())).toBe(WS_A_SCHEMA_FROM_DB);
    expect(workspaceSchemaName(WS_A.replace(/-/g, ''))).toBe(WS_A_SCHEMA_FROM_DB);
  });

  it('always produces workspace_ + 32 lowercase hex, under the PostgreSQL identifier limit', () => {
    const name = workspaceSchemaName(WS_A);
    expect(name).toMatch(/^workspace_[0-9a-f]{32}$/);
    expect(name.length).toBe(42);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'issac'],
    ['schema name supplied as the id', 'workspace_11111111111141118111111111111111'],
    ['SQL injection attempt', "x'); DROP SCHEMA core CASCADE; --"],
    ['path-like traversal', '../../public'],
    ['public schema name', 'public'],
    ['uuid with extra characters', `${WS_A}x`],
    ['uuid with braces', `{${WS_A}}`],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { id: WS_A }],
  ])('rejects %s', (_label, value) => {
    expect(() => workspaceSchemaName(value as unknown as string)).toThrow();
  });

  it('never returns a name containing characters outside [a-z0-9_] for any accepted input', () => {
    for (const id of [WS_A, WS_A.toUpperCase(), WS_A.replace(/-/g, '')]) {
      expect(workspaceSchemaName(id)).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('SchemaResolverService', () => {
  it('delegates to the single canonical builder', () => {
    // schemaFor() is a pure derivation and never touches the cache — an unused stub is enough here.
    const service = new SchemaResolverService({ resolveSchema: async (_id: string, fetch: () => Promise<unknown>) => fetch() } as never);
    expect(service.schemaFor('11111111-1111-4111-8111-111111111111')).toBe(
      'workspace_11111111111141118111111111111111',
    );
  });
});

describe('SchemaResolverService: workspace module version (Phase B schema compatibility)', () => {
  const WS = '22222222-2222-4222-8222-222222222222';
  const SCHEMA = workspaceSchemaName(WS);

  function setup(moduleVersion: number, cached?: Record<string, unknown>) {
    const queries: string[] = [];
    const manager = {
      query: async (sql: string) => {
        queries.push(sql);
        return [{ schema_name: SCHEMA, status: 'READY', schema_version: 1, module_version: moduleVersion }];
      },
    } as unknown as EntityManager;
    const invalidated: string[] = [];
    const cache = {
      // A cache hit returns `cached` without calling fetch; otherwise read-through.
      resolveSchema: async (_id: string, fetch: () => Promise<unknown>) => cached ?? fetch(),
      invalidate: async (id: string) => {
        invalidated.push(id);
      },
    };
    return { service: new SchemaResolverService(cache as never), manager, queries, invalidated };
  }

  async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'resolved';
    } catch (error) {
      return error instanceof WorkspaceRoutingError ? error.code : `other: ${(error as Error).message}`;
    }
  }

  it('the floor never exceeds LATEST; the owner-login release keeps it at LATEST - 1 = 19', () => {
    // Phase D kept the floor at 18 (module 19 only added the statement dispatch pointer triggers). The owner-login PAY-1
    // release (module 20, WorkspaceGrantParityGuards1786721430000) raised it to 19, reviewed as E-10 in
    // workspace-schema-modules.spec.ts: a READY v18 workspace returns 503 (incompatible-module) until migrated. The release
    // migrates every READY workspace to 20 inside that migration, before migrate-on-start lets the API serve (a failing
    // schema throws and the deploy refuses). Raising or lowering it is a deliberate release decision, which must update
    // this assertion.
    expect(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION).toBeLessThanOrEqual(LATEST_WORKSPACE_MODULE_VERSION);
    expect(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION).toBe(19);
    expect(() => assertCompatibleModuleVersion(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION)).not.toThrow();
    expect(() => assertCompatibleModuleVersion(LATEST_WORKSPACE_MODULE_VERSION)).not.toThrow();
    expect(() => assertCompatibleModuleVersion(Number.NaN)).toThrow(WorkspaceRoutingError);
  });

  it('reads module_version with the registry row and routes a workspace at the floor', async () => {
    const { service, manager, queries } = setup(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION);
    await expect(service.resolve(manager, WS)).resolves.toBe(SCHEMA);
    expect(queries[0]).toMatch(/module_version/);
  });

  it.each([0, MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION - 1])('refuses a READY workspace at module %i with incompatible-module (503), never caching it', async (v) => {
    expect(await codeOf(setup(v).service.resolve(setup(v).manager, WS))).toBe('incompatible-module');
  });

  it('Part D (owner D2/D3): a workspace carrying the upgrade block is refused with upgrading (503), never cached; another marker text is not a block', async () => {
    const blockedManager = {
      query: async () => [{ schema_name: SCHEMA, status: 'READY', schema_version: 1, module_version: 20, migration_error: 'upgrade-blocked: 0.7.0_X_1786800000000 (FINGERPRINT_MISMATCH)' }],
    } as unknown as EntityManager;
    const cached: string[] = [];
    const service = new SchemaResolverService({
      resolveSchema: async (_id: string, fetch: () => Promise<unknown>) => {
        const v = await fetch();
        cached.push(String(v));
        return v;
      },
      invalidate: async () => undefined,
    } as never);
    expect(await codeOf(service.resolve(blockedManager, WS))).toBe('upgrading');
    expect(cached).toEqual([]);
    const oldMessage = { query: async () => [{ schema_name: SCHEMA, status: 'READY', schema_version: 1, module_version: 20, migration_error: 'module v1.020 failed (SQLSTATE_55P03)' }] } as unknown as EntityManager;
    expect(await codeOf(service.resolve(oldMessage, WS))).toBe('resolved');
  });

  it('a workspace ahead of the code (image rollback) routes, with ONE warning per workspace', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service, manager } = setup(LATEST_WORKSPACE_MODULE_VERSION + 1);
      await expect(service.resolve(manager, WS)).resolves.toBe(SCHEMA);
      await expect(service.resolve(manager, WS)).resolves.toBe(SCHEMA);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/above this code's module/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a cached value without a module version (written by an older image) is dropped and decided from Postgres', async () => {
    const stale = setup(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION - 1, { schemaName: SCHEMA, schemaVersion: 1 });
    expect(await codeOf(stale.service.resolve(stale.manager, WS))).toBe('incompatible-module');
    expect(stale.invalidated).toEqual([WS]);
    expect(stale.queries).toHaveLength(1);

    const fine = setup(LATEST_WORKSPACE_MODULE_VERSION, { schemaName: SCHEMA, schemaVersion: 1, moduleVersion: MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION - 1 });
    await expect(fine.service.resolve(fine.manager, WS)).resolves.toBe(SCHEMA);
    expect(fine.invalidated).toEqual([WS]);
  });

  it('a cached value at or above the floor is served without touching Postgres', async () => {
    const hit = setup(0, { schemaName: SCHEMA, schemaVersion: 1, moduleVersion: LATEST_WORKSPACE_MODULE_VERSION });
    await expect(hit.service.resolve(hit.manager, WS)).resolves.toBe(SCHEMA);
    expect(hit.queries).toHaveLength(0);
    expect(hit.invalidated).toEqual([]);
  });

  // ST-07 (T-1): the cached name becomes search_path, so a name that is not exactly the derived one is never served.
  describe('ST-07: a cached schema name is compared with the derived name', () => {
    const OTHER = workspaceSchemaName('33333333-3333-4333-8333-333333333333');
    it.each([
      ['another workspace schema', OTHER],
      ['a comma-separated list (search_path list injection)', `${SCHEMA}, core`],
      ['core', 'core'],
      ['public', 'public'],
      ['upper-case variant', SCHEMA.toUpperCase()],
      ['empty', ''],
    ])('refuses a cached %s: dropped from the cache and decided from Postgres (the registry name)', async (_label, planted) => {
      const s = setup(LATEST_WORKSPACE_MODULE_VERSION, { schemaName: planted, schemaVersion: 1, moduleVersion: LATEST_WORKSPACE_MODULE_VERSION });
      await expect(s.service.resolve(s.manager, WS)).resolves.toBe(SCHEMA);
      expect(s.invalidated).toEqual([WS]);
      expect(s.queries).toHaveLength(1);
    });

    it('fails closed with name-mismatch when Postgres does not confirm the name either', async () => {
      const queries: string[] = [];
      const manager = {
        query: async (sql: string) => {
          queries.push(sql);
          return [{ schema_name: OTHER, status: 'READY', schema_version: 1, module_version: LATEST_WORKSPACE_MODULE_VERSION }];
        },
      } as unknown as EntityManager;
      const invalidated: string[] = [];
      const cache = {
        resolveSchema: async () => ({ schemaName: OTHER, schemaVersion: 1, moduleVersion: LATEST_WORKSPACE_MODULE_VERSION }),
        invalidate: async (id: string) => void invalidated.push(id),
      };
      expect(await codeOf(new SchemaResolverService(cache as never).resolve(manager, WS))).toBe('name-mismatch');
      expect(invalidated).toEqual([WS]);
      expect(queries).toHaveLength(1);
    });
  });
});
