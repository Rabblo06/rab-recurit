import { DataSource, EntityManager } from 'typeorm';

import { WORKSPACE_TABLES } from '../../../database/typeorm/workspace-schema/workspace-tables';
import { EnvironmentService } from '../environment/environment.service';
import {
  bindBusinessSchema,
  boundBusinessSchema,
  BusinessTablesError,
  businessSearchPath,
  businessTables,
  peekBusinessSchema,
  restoreBusinessSchema,
  SEARCH_PATH_TRAP_VAR,
  SearchPathTrapRefused,
  searchPathTrapEnabled,
  snapshotBusinessSchema,
  unbindBusinessSchema,
  withBusinessSchema,
  withBusinessSchemaScope,
} from './business-tables';
import { SchemaResolverService, workspaceSchemaName } from './schema-resolver.service';
import { TenantContextService } from './tenant-context.service';
import { WorkspaceExecutionContext } from './workspace-execution-context';

// C2-1: these binder fakes have no real QueryRunner/DataSource, so the entity-metadata binding is the identity here (the
// binders then bind businessTables() on the manager they hand out); schema-bound-entity-manager.spec.ts covers the real one.
jest.mock('./schema-bound-entity-manager', () => ({ bindEntityManagerToSchema: jest.fn(async (manager: unknown) => manager) }));

/**
 * Part C2-0 (HWS-AUDIT-C2-SIZING.md §5/§7): the businessTables(manager) primitive, unit level. The real-PostgreSQL proof
 * (qualified names resolve, the search_path trap turns an unqualified name into 42P01) is
 * __tests__/integration/business-tables.integration.spec.ts.
 */

const WS = '0b9a7c4e-1d2f-4a3b-8c5d-6e7f8091a2b3';
const SCHEMA = workspaceSchemaName(WS);
const OTHER_WS = '11111111-2222-4333-8444-555555555555';
const OTHER_SCHEMA = workspaceSchemaName(OTHER_WS);

/** A manager inside a live transaction (the shape TypeORM hands a transaction callback). */
function liveManager(name = 'm'): EntityManager & { queryRunner: { isReleased: boolean; isTransactionActive: boolean } } {
  return {
    name,
    queryRunner: { isReleased: false, isTransactionActive: true },
    query: jest.fn(async (sql: string) => (sql.startsWith(`SELECT set_config('rab.organisation_id'`) ? [{ cu: 'crewflow_owner', su: 'crewflow_owner' }] : undefined)),
  } as unknown as EntityManager & { queryRunner: { isReleased: boolean; isTransactionActive: boolean } };
}

/** A DataSource whose every transaction gets a FRESH manager (as TypeORM does: one query runner per transaction), ended after. */
function dataSourceOf(managers: Array<ReturnType<typeof liveManager>>) {
  return {
    transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => {
      const m = liveManager(`tx${managers.length}`);
      managers.push(m);
      try {
        return await fn(m);
      } finally {
        m.queryRunner.isTransactionActive = false;
        m.queryRunner.isReleased = true;
      }
    }),
  } as unknown as DataSource;
}

const environment = (hws: boolean) => ({ get: jest.fn((key: string) => (key === 'HWS_RUNTIME_ENABLED' ? hws : undefined)) }) as unknown as EnvironmentService;
const resolverFor = (schema: string) => ({ resolve: jest.fn().mockResolvedValue(schema) }) as unknown as SchemaResolverService;
const CTX = { organisationId: '22222222-3333-4444-8555-666666666666', workspaceId: WS, userId: '33333333-4444-4555-8666-777777777777', role: 'manager' };

// Restore (never just delete) whatever the run started with: the C2 trap CI job sets it for the whole run.
const TRAP_AT_START = process.env[SEARCH_PATH_TRAP_VAR];
beforeEach(() => {
  delete process.env[SEARCH_PATH_TRAP_VAR];
});
afterEach(() => {
  if (TRAP_AT_START === undefined) delete process.env[SEARCH_PATH_TRAP_VAR];
  else process.env[SEARCH_PATH_TRAP_VAR] = TRAP_AT_START;
});

describe('businessTables(manager): the primitive', () => {
  it('returns the quoted, schema-qualified name of every WORKSPACE_TABLES entry, and only those', () => {
    const m = liveManager();
    bindBusinessSchema(m, SCHEMA, WS);
    const t = businessTables(m);
    expect(t.shift).toBe(`"${SCHEMA}"."shift"`);
    expect(t.payslip_document).toBe(`"${SCHEMA}"."payslip_document"`);
    expect(Object.keys(t).sort()).toEqual([...WORKSPACE_TABLES].sort());
    for (const table of WORKSPACE_TABLES) expect(t[table]).toBe(`"${SCHEMA}"."${table}"`);
    expect({ ...t }).toEqual(Object.fromEntries(WORKSPACE_TABLES.map((table) => [table, `"${SCHEMA}"."${table}"`])));
  });

  it('returns "core" when the binder bound core (HWS off, or a workspace-less tenant context)', () => {
    const m = liveManager();
    bindBusinessSchema(m, 'core', null);
    expect(businessTables(m).venue).toBe('"core"."venue"');
    bindBusinessSchema(m, 'core', WS); // HWS off with a workspace in the context: still core
    expect(businessTables(m).staff_profile).toBe('"core"."staff_profile"');
  });

  it('refuses an unbound manager: dataSource.manager, a fixture manager, anything no binder bound', () => {
    const m = liveManager();
    expect(() => businessTables(m)).toThrow(BusinessTablesError);
    expect(() => businessTables(m)).toThrow(expect.objectContaining({ code: 'unbound' }));
    expect(() => boundBusinessSchema(m)).toThrow(expect.objectContaining({ code: 'unbound' }));
    expect(() => businessTables(undefined as unknown as EntityManager)).toThrow(expect.objectContaining({ code: 'unbound' }));
    expect(peekBusinessSchema(m)).toBeUndefined();
  });

  it.each([
    ['public', WS],
    ['pg_catalog', WS],
    ['', WS],
    ['CORE', null],
    [`${SCHEMA}, core`, WS],
    [`"${SCHEMA}"`, WS],
    [SCHEMA.toUpperCase(), WS],
    ['workspace_abc', WS],
    [`${SCHEMA}x`, WS],
    [`${SCHEMA}"; DROP TABLE x; --`, WS],
    [SCHEMA, null], // a workspace schema needs the workspace it was resolved for
    [SCHEMA, 'not-a-uuid'],
    [OTHER_SCHEMA, WS], // well-formed, but not the bound workspace's registry name
  ])('refuses a non-registry schema %p (workspace %p) at bind time, and keeps the previous binding', (schema, workspaceId) => {
    const m = liveManager();
    bindBusinessSchema(m, 'core', null);
    expect(() => bindBusinessSchema(m, schema as string, workspaceId)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
    expect(businessTables(m).shift).toBe('"core"."shift"');
  });

  it('refuses an unknown lower-case table key at run time (a typo is also a compile error)', () => {
    const m = liveManager();
    bindBusinessSchema(m, SCHEMA, WS);
    const t = businessTables(m) as unknown as Record<string, string>;
    expect(() => t.shfit).toThrow(expect.objectContaining({ code: 'unknown-table' }));
    expect(() => t.user).toThrow(expect.objectContaining({ code: 'unknown-table' }));
    expect(() => t.workspace_schema_registry).toThrow(expect.objectContaining({ code: 'unknown-table' }));
    expect(t.then).toBeUndefined(); // awaiting / resolving it must not throw
  });

  it('is read-only', () => {
    const m = liveManager();
    bindBusinessSchema(m, SCHEMA, WS);
    const t = businessTables(m) as unknown as Record<string, string>;
    expect(() => { t.shift = 'public.shift'; }).toThrow(TypeError);
    expect(() => { delete t.shift; }).toThrow(TypeError);
    expect(t.shift).toBe(`"${SCHEMA}"."shift"`);
  });

  it('never leaks past the transaction: an ended transaction, a kept `t`, and an unbind all throw', () => {
    const m = liveManager();
    bindBusinessSchema(m, SCHEMA, WS);
    const t = businessTables(m);
    expect(t.shift).toBe(`"${SCHEMA}"."shift"`);
    m.queryRunner.isTransactionActive = false; // COMMIT / ROLLBACK
    expect(() => t.shift).toThrow(expect.objectContaining({ code: 'transaction-ended' }));
    expect(() => businessTables(m)).toThrow(BusinessTablesError);
    expect(peekBusinessSchema(m)).toBeUndefined(); // the dead binding was dropped

    const released = liveManager();
    bindBusinessSchema(released, SCHEMA, WS);
    released.queryRunner.isReleased = true;
    expect(() => businessTables(released)).toThrow(expect.objectContaining({ code: 'transaction-ended' }));

    const noRunner = { query: jest.fn() } as unknown as EntityManager; // a non-transactional manager
    bindBusinessSchema(noRunner, 'core', null);
    expect(() => businessTables(noRunner)).toThrow(expect.objectContaining({ code: 'transaction-ended' }));

    const unbound = liveManager();
    bindBusinessSchema(unbound, SCHEMA, WS);
    const kept = businessTables(unbound);
    unbindBusinessSchema(unbound);
    expect(() => kept.venue).toThrow(expect.objectContaining({ code: 'unbound' }));
  });

  it('snapshot/restore puts the entry binding (or its absence) back, only on the manager it was taken from', () => {
    const m = liveManager();
    bindBusinessSchema(m, SCHEMA, WS);
    const snap = snapshotBusinessSchema(m);
    bindBusinessSchema(m, 'core', OTHER_WS); // a switch inside the transaction (UserDeletionService)
    bindBusinessSchema(m, OTHER_SCHEMA, OTHER_WS);
    restoreBusinessSchema(m, snap);
    expect(businessTables(m).shift).toBe(`"${SCHEMA}"."shift"`);

    const fresh = liveManager();
    const none = snapshotBusinessSchema(fresh);
    bindBusinessSchema(fresh, 'core', null);
    restoreBusinessSchema(fresh, none);
    expect(peekBusinessSchema(fresh)).toBeUndefined();

    expect(() => restoreBusinessSchema(liveManager(), snap)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
    expect(() => restoreBusinessSchema(m, { schema: 'public' })).toThrow(expect.objectContaining({ code: 'invalid-schema' })); // forged
  });

  it('withBusinessSchema binds for exactly the callback, and unbinds even when it throws', async () => {
    const m = liveManager();
    await expect(withBusinessSchema(m, SCHEMA, WS, async () => businessTables(m).shift)).resolves.toBe(`"${SCHEMA}"."shift"`);
    expect(peekBusinessSchema(m)).toBeUndefined();
    await expect(withBusinessSchema(m, SCHEMA, WS, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(peekBusinessSchema(m)).toBeUndefined();
    await expect(withBusinessSchema(m, 'public', WS, async () => 'never')).rejects.toThrow(BusinessTablesError);
  });

  it('withBusinessSchema / withBusinessSchemaScope restore the entry binding (not merely delete it)', async () => {
    const m = liveManager();
    bindBusinessSchema(m, 'core', null);
    await withBusinessSchema(m, SCHEMA, WS, async () => expect(businessTables(m).shift).toBe(`"${SCHEMA}"."shift"`));
    expect(peekBusinessSchema(m)).toBe('core');
    await expect(withBusinessSchemaScope(m, async () => { bindBusinessSchema(m, OTHER_SCHEMA, OTHER_WS); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(peekBusinessSchema(m)).toBe('core');
  });
});

describe('the binders bind it (and nothing leaks across transactions)', () => {
  it('runInWorkspaceContext, HWS on: the registry-resolved schema; a fresh manager per transaction; gone after COMMIT', async () => {
    const managers: Array<ReturnType<typeof liveManager>> = [];
    const service = new TenantContextService(dataSourceOf(managers), resolverFor(SCHEMA), environment(true));
    let kept: ReturnType<typeof businessTables> | undefined;
    const inside = await service.runInWorkspaceContext(CTX, async (m, schema) => {
      kept = businessTables(m);
      return { shift: kept.shift, schema };
    });
    expect(inside).toEqual({ shift: `"${SCHEMA}"."shift"`, schema: SCHEMA });
    expect(managers[0]!.query).toHaveBeenCalledWith(`SELECT set_config('search_path', $1, true)`, [`${SCHEMA}, pg_temp`]); // still bound: behaviour identical
    expect(() => kept!.shift).toThrow(BusinessTablesError);
    expect(() => businessTables(managers[0]!)).toThrow(BusinessTablesError);

    // The next transaction (another workspace) never sees the first one's schema.
    const other = new TenantContextService(dataSourceOf(managers), resolverFor(OTHER_SCHEMA), environment(true));
    await expect(other.runInWorkspaceContext({ ...CTX, workspaceId: OTHER_WS }, async (m) => businessTables(m).venue)).resolves.toBe(`"${OTHER_SCHEMA}"."venue"`);
    expect(managers[1]).not.toBe(managers[0]);
  });

  it('runInWorkspaceContext refuses a resolver answer that is not the workspace\'s canonical name (defence in depth)', async () => {
    const service = new TenantContextService(dataSourceOf([]), resolverFor(OTHER_SCHEMA), environment(true));
    await expect(service.runInWorkspaceContext(CTX, async () => 'never')).rejects.toThrow(BusinessTablesError);
  });

  it('review #7: a refused schema never reaches set_config (validated and recorded first)', async () => {
    const managers: Array<ReturnType<typeof liveManager>> = [];
    const service = new TenantContextService(dataSourceOf(managers), resolverFor(OTHER_SCHEMA), environment(true));
    await expect(service.runInWorkspaceContext(CTX, async () => 'never')).rejects.toThrow(BusinessTablesError);
    const calls = (managers[0]!.query as jest.Mock).mock.calls.map(([sql]) => String(sql));
    expect(calls.some((sql) => sql.includes(`set_config('search_path'`))).toBe(false);
    expect(peekBusinessSchema(managers[0]!)).toBeUndefined();
    const exec = new WorkspaceExecutionContext(dataSourceOf(managers), resolverFor(OTHER_SCHEMA));
    await expect(exec.run(CTX, async () => 'never')).rejects.toThrow(BusinessTablesError);
    expect((managers[1]!.query as jest.Mock).mock.calls.some(([sql]) => String(sql).includes(`set_config('search_path'`))).toBe(false);
  });

  it('runInTenantContext: "core" with HWS off, and with HWS on but no workspace; the schema with HWS on and a workspace', async () => {
    const off = new TenantContextService(dataSourceOf([]), resolverFor(SCHEMA), environment(false));
    await expect(off.runInTenantContext(CTX, async (m) => businessTables(m).shift)).resolves.toBe('"core"."shift"');
    const on = new TenantContextService(dataSourceOf([]), resolverFor(SCHEMA), environment(true));
    await expect(on.runInTenantContext({ ...CTX, workspaceId: null }, async (m) => businessTables(m).shift)).resolves.toBe('"core"."shift"');
    await expect(on.runInTenantContext(CTX, async (m) => businessTables(m).shift)).resolves.toBe(`"${SCHEMA}"."shift"`);
  });

  it('a callback that throws still unbinds', async () => {
    const managers: Array<ReturnType<typeof liveManager>> = [];
    const service = new TenantContextService(dataSourceOf(managers), resolverFor(SCHEMA), environment(true));
    await expect(service.runInWorkspaceContext(CTX, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(peekBusinessSchema(managers[0]!)).toBeUndefined();
  });

  it('the replica read path binds too (useReplica, no replica configured → primary READ ONLY)', async () => {
    const service = new TenantContextService(dataSourceOf([]), resolverFor(SCHEMA), environment(true));
    await expect(service.runInWorkspaceContext(CTX, async (m) => businessTables(m).attendance, { useReplica: true })).resolves.toBe(`"${SCHEMA}"."attendance"`);
    const off = new TenantContextService(dataSourceOf([]), resolverFor(SCHEMA), environment(false));
    await expect(off.runInTenantContext(CTX, async (m) => businessTables(m).attendance, { useReplica: true })).resolves.toBe('"core"."attendance"');
  });

  it('the replica read path with a live replica: schema resolved on the primary, bound on the replica manager', async () => {
    const primary: Array<ReturnType<typeof liveManager>> = [];
    const replicaManagers: Array<ReturnType<typeof liveManager>> = [];
    const replicaDataSource = dataSourceOf(replicaManagers);
    const replica = { routeRead: jest.fn(() => ({ dataSource: replicaDataSource })), shouldRetryOnPrimary: jest.fn(() => false) };
    const service = new TenantContextService(dataSourceOf(primary), resolverFor(SCHEMA), environment(true), replica as never);
    await expect(service.runInWorkspaceContext(CTX, async (m) => businessTables(m).payroll_record, { useReplica: true })).resolves.toBe(`"${SCHEMA}"."payroll_record"`);
    expect(replicaManagers).toHaveLength(1);
    expect(() => businessTables(replicaManagers[0]!)).toThrow(BusinessTablesError);
  });

  it('bindCoreIdentityGucs binds no search_path and therefore no business schema', async () => {
    const service = new TenantContextService(dataSourceOf([]), resolverFor(SCHEMA), environment(true));
    const m = liveManager();
    await service.bindCoreIdentityGucs(m, CTX);
    expect(() => businessTables(m)).toThrow(expect.objectContaining({ code: 'unbound' }));
  });

  it('WorkspaceExecutionContext.run binds the resolved schema for its callback only', async () => {
    const managers: Array<ReturnType<typeof liveManager>> = [];
    const exec = new WorkspaceExecutionContext(dataSourceOf(managers), resolverFor(SCHEMA));
    await expect(exec.run(CTX, async (m) => businessTables(m).job_offer)).resolves.toBe(`"${SCHEMA}"."job_offer"`);
    expect(peekBusinessSchema(managers[0]!)).toBeUndefined();
  });
});

describe('the test-only search_path trap', () => {
  it('is off unless set; with NODE_ENV=test every binder sets search_path to \'\' while businessTables keeps the real schema', async () => {
    expect(searchPathTrapEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(businessSearchPath(SCHEMA, { NODE_ENV: 'test' })).toBe(`${SCHEMA}, pg_temp`);
    expect(businessSearchPath('core', { NODE_ENV: 'production' })).toBe('core, pg_temp');

    process.env[SEARCH_PATH_TRAP_VAR] = 'true'; // jest runs with NODE_ENV=test
    expect(businessSearchPath(SCHEMA)).toBe('');
    expect(businessSearchPath('core')).toBe('');

    const managers: Array<ReturnType<typeof liveManager>> = [];
    const on = new TenantContextService(dataSourceOf(managers), resolverFor(SCHEMA), environment(true));
    await expect(on.runInWorkspaceContext(CTX, async (m) => businessTables(m).shift)).resolves.toBe(`"${SCHEMA}"."shift"`);
    expect(managers[0]!.query).toHaveBeenCalledWith(`SELECT set_config('search_path', $1, true)`, ['']);

    const off = new TenantContextService(dataSourceOf(managers), resolverFor(SCHEMA), environment(false));
    await expect(off.runInTenantContext(CTX, async (m) => businessTables(m).shift)).resolves.toBe('"core"."shift"');
    const folded = (managers[1]!.query as jest.Mock).mock.calls.find(([sql]) => String(sql).includes(`set_config('search_path', $6, true)`));
    expect(folded?.[1]?.[5]).toBe(''); // the folded $6

    const exec = new WorkspaceExecutionContext(dataSourceOf(managers), resolverFor(SCHEMA));
    await exec.run(CTX, async () => undefined);
    expect(managers[2]!.query).toHaveBeenCalledWith(`SELECT set_config('search_path', $1, true)`, ['']);
  });

  it('refuses (throws) outside NODE_ENV=test or with any value but exactly "true" — never silently ignored', () => {
    expect(() => searchPathTrapEnabled({ [SEARCH_PATH_TRAP_VAR]: 'true', NODE_ENV: 'production' })).toThrow(SearchPathTrapRefused);
    expect(() => searchPathTrapEnabled({ [SEARCH_PATH_TRAP_VAR]: 'true' })).toThrow(SearchPathTrapRefused);
    expect(() => searchPathTrapEnabled({ [SEARCH_PATH_TRAP_VAR]: '1', NODE_ENV: 'test' })).toThrow(SearchPathTrapRefused);
    expect(() => businessSearchPath('core', { [SEARCH_PATH_TRAP_VAR]: 'yes', NODE_ENV: 'test' })).toThrow(SearchPathTrapRefused);
  });

  it('businessSearchPath refuses a value that is not core or a canonical workspace schema (a list, public, a quoted name)', () => {
    for (const bad of ['public', `${SCHEMA}, core`, `"${SCHEMA}"`, '', 'workspace_abc']) {
      expect(() => businessSearchPath(bad, { NODE_ENV: 'test' })).toThrow(BusinessTablesError);
    }
  });
});
