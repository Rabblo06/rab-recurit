import type { EntityManager } from 'typeorm';

import { WORKSPACE_TABLES, WorkspaceTable } from '../../../database/typeorm/workspace-schema/workspace-tables';
import { workspaceSchemaName } from './schema-resolver.service';

/**
 * Part C2-0 (HWS-AUDIT-C2-SIZING.md §5, §7): the runtime primitive for schema-qualified business-table SQL.
 *
 *   const t = businessTables(manager);
 *   await manager.query(`SELECT id FROM ${t.shift} WHERE id = $1`, [id]);   // → "workspace_<32 hex>"."shift" (or "core"."shift")
 *
 * It answers "which schema do THIS transaction's business tables live in" — `workspace_<32 hex>` with HWS on and a workspace
 * bound, `core` otherwise (HWS off, or a workspace-less tenant context: the same routing the transaction-local search_path
 * gives unqualified names today). It is NOT "a workspace schema", which is why `core` is a valid answer.
 *
 * Where the schema comes from: only the binders that already set search_path record it here, in a module-level
 * WeakMap<EntityManager, binding> — TenantContextService (runInTenantContext, runInWorkspaceContext, the replica read path),
 * WorkspaceExecutionContext.run, and the sites that switch search_path themselves inside a transaction (UserDeletionService's
 * per-workspace pass, the Worker's account-invite dependency check, the dev seed). Every one of them gets the name from the
 * workspace registry (SchemaResolverService or an equivalent READY-row lookup) or uses the constant 'core'. No request field,
 * header, claim or DTO ever reaches it.
 *
 * Fail closed:
 *   - an EntityManager no binder has bound (dataSource.manager, a manager from bindCoreIdentityGucs, a fixture) → throws;
 *   - a schema that is neither 'core' nor exactly workspaceSchemaName(<the bound workspace id>) → refused at bind time;
 *   - a manager whose transaction has ended (released query runner / no active transaction), or a `t` object kept and used
 *     after its transaction → throws (the binding never outlives the transaction; binders also unbind in `finally`);
 *   - an unknown lower-case table key → throws (a typo is already a compile error: keys are typed from WORKSPACE_TABLES).
 * Both identifiers are validated (`core` | `workspace_[0-9a-f]{32}`, and a frozen lower-case table list), then double-quoted.
 *
 * search_path stays bound in C2-0, so a converted call site behaves exactly as before; the test-only trap below (search_path
 * = '' in every binder) is what proves a module has no unqualified business-table reference left.
 *
 * Twenty reference (re-implemented, not copied; twentyhq/twenty @ eedb0a73): Twenty derives the schema per workspace and
 * builds a per-object table shape { schemaName, tableName } that its query layer qualifies every statement with
 * (packages/twenty-server/src/engine/twenty-orm/table-shape/utils/build-workspace-table-shape.util.ts:118-123, with
 * engine/workspace-datasource/utils/get-workspace-schema-name.util.ts:3-5), cached in WeakMaps keyed by metadata objects
 * (engine/twenty-orm/datasource/workspace-data-source.ts:32-35). Here the name comes from our registry-validated resolver and
 * the WeakMap is keyed by the transaction's EntityManager instead, because one pool serves every workspace.
 */

/** A fixed, non-sensitive refusal code; the message never contains a schema name, id or SQL. */
export class BusinessTablesError extends Error {
  constructor(readonly code: 'unbound' | 'invalid-schema' | 'transaction-ended' | 'unknown-table') {
    super(`businessTables refused (${code}).`);
    this.name = 'BusinessTablesError';
  }
}

export type BusinessTables = { readonly [K in WorkspaceTable]: string };

export const CORE_BUSINESS_SCHEMA = 'core';

const TABLE_SET: ReadonlySet<string> = new Set<string>(WORKSPACE_TABLES);
const TABLE_NAME = /^[a-z][a-z_]*$/;
const SCHEMA_NAME = /^workspace_[0-9a-f]{32}$/;

const bindings = new WeakMap<EntityManager, string>();

/**
 * Binder-only. Records the schema this transaction's business tables live in. `workspaceId` is the workspace the binder
 * bound into rab.workspace_id and resolved the schema for: a non-core schema must be exactly its canonical name, so a
 * well-formed but unrelated `workspace_…` name is refused too. Throws BusinessTablesError('invalid-schema') on anything else.
 */
export function bindBusinessSchema(manager: EntityManager, schema: string, workspaceId: string | null | undefined): void {
  if (!manager || typeof manager !== 'object') throw new BusinessTablesError('unbound');
  bindings.set(manager, validatedSchema(schema, workspaceId));
}

/** Binder-only. Drops the binding (called in `finally` when the binder's transaction callback ends). */
export function unbindBusinessSchema(manager: EntityManager): void {
  if (manager && typeof manager === 'object') bindings.delete(manager);
}

/** The bound schema, or undefined when none is (no throw). */
export function peekBusinessSchema(manager: EntityManager): string | undefined {
  return manager && typeof manager === 'object' ? bindings.get(manager) : undefined;
}

/** An opaque record of one manager's binding (or of none), restorable only onto that same manager. */
export interface BusinessSchemaSnapshot {
  readonly schema: string | undefined;
}
const snapshots = new WeakMap<BusinessSchemaSnapshot, EntityManager>();

/**
 * Binder-only, for a site that switches search_path inside a transaction and must put the entry state back: the value was
 * validated when it was bound, so restoring it needs no workspace id. Only a snapshot taken by this function, for this
 * manager, is accepted.
 *
 * SAVEPOINTS: `ROLLBACK TO SAVEPOINT` reverts a transaction-local search_path, but NOT this WeakMap. A binder that switches
 * schemas inside a savepoint must take a snapshot BEFORE the SAVEPOINT and restore it right AFTER the ROLLBACK TO SAVEPOINT
 * (account-invite-cleanup.job.ts does), so the binding again matches the search_path the rollback put back.
 */
export function snapshotBusinessSchema(manager: EntityManager): BusinessSchemaSnapshot {
  const snapshot = Object.freeze({ schema: peekBusinessSchema(manager) });
  snapshots.set(snapshot, manager);
  return snapshot;
}

export function restoreBusinessSchema(manager: EntityManager, snapshot: BusinessSchemaSnapshot): void {
  if (snapshots.get(snapshot) !== manager) throw new BusinessTablesError('invalid-schema');
  if (snapshot.schema === undefined) bindings.delete(manager);
  else bindings.set(manager, snapshot.schema);
}

/**
 * Binder-only. Runs `run` and, however it settles, puts back the binding `manager` had on entry (none, for the fresh manager
 * of a new transaction). The binder calls bindBusinessSchema INSIDE `run`, before its set_config (validate first, review #7).
 */
export async function withBusinessSchemaScope<T>(manager: EntityManager, run: () => Promise<T>): Promise<T> {
  const entry = snapshotBusinessSchema(manager);
  try {
    return await run();
  } finally {
    restoreBusinessSchema(manager, entry);
  }
}

/**
 * Binder-only. bindBusinessSchema(manager, schema, workspaceId), then `run`, then the entry binding restored (not merely
 * deleted, so a nested use on a manager that was already bound gets its own binding back).
 */
export function withBusinessSchema<T>(
  manager: EntityManager,
  schema: string,
  workspaceId: string | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return withBusinessSchemaScope(manager, async () => {
    bindBusinessSchema(manager, schema, workspaceId);
    return run();
  });
}

/** The bound schema of a live transaction. Throws when unbound or when the transaction has ended. */
export function boundBusinessSchema(manager: EntityManager): string {
  const schema = manager && typeof manager === 'object' ? bindings.get(manager) : undefined;
  if (schema === undefined) throw new BusinessTablesError('unbound');
  assertLiveTransaction(manager);
  return schema;
}

/**
 * The quoted, schema-qualified business tables of `manager`'s transaction. Every property read re-checks the binding, so a
 * `t` kept past its transaction (or past an unbind) throws instead of naming a schema that is no longer routed.
 */
export function businessTables(manager: EntityManager): BusinessTables {
  boundBusinessSchema(manager);
  const target = Object.create(null) as Record<string, string>;
  return new Proxy(target, {
    get(_target, key) {
      if (typeof key !== 'string' || !TABLE_SET.has(key)) {
        // A lower-case snake key is a table read with a wrong name: refuse it. Anything else (symbols, `then` for Promise
        // resolution, camelCase inspection probes such as toJSON / asymmetricMatch / $$typeof) is not a table read.
        if (typeof key === 'string' && key !== 'then' && TABLE_NAME.test(key)) throw new BusinessTablesError('unknown-table');
        return undefined;
      }
      return qualify(boundBusinessSchema(manager), key);
    },
    has: (_target, key) => typeof key === 'string' && TABLE_SET.has(key),
    ownKeys: () => [...WORKSPACE_TABLES],
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === 'string' && TABLE_SET.has(key)
        ? { enumerable: true, configurable: true, writable: false, value: qualify(boundBusinessSchema(manager), key) }
        : undefined,
    set: () => { throw new TypeError('businessTables is read-only'); },
    defineProperty: () => { throw new TypeError('businessTables is read-only'); },
    deleteProperty: () => { throw new TypeError('businessTables is read-only'); },
  }) as unknown as BusinessTables;
}

/** `"<schema>"."<table>"` for an already validated schema and a WORKSPACE_TABLES name. */
function qualify(schema: string, table: string): string {
  if (!TABLE_SET.has(table) || !TABLE_NAME.test(table)) throw new BusinessTablesError('unknown-table');
  return `"${schema}"."${table}"`;
}

function validatedSchema(schema: unknown, workspaceId: string | null | undefined): string {
  if (schema === CORE_BUSINESS_SCHEMA) return CORE_BUSINESS_SCHEMA;
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema) || !workspaceId) throw new BusinessTablesError('invalid-schema');
  let expected: string;
  try {
    expected = workspaceSchemaName(workspaceId);
  } catch {
    throw new BusinessTablesError('invalid-schema');
  }
  if (expected !== schema) throw new BusinessTablesError('invalid-schema');
  return schema;
}

/** A transaction's manager carries its query runner; once it is released or the transaction is over, the binding is dead. */
function assertLiveTransaction(manager: EntityManager): void {
  const runner = (manager as { queryRunner?: { isReleased?: boolean; isTransactionActive?: boolean } }).queryRunner;
  if (!runner || runner.isReleased === true || runner.isTransactionActive !== true) {
    bindings.delete(manager);
    throw new BusinessTablesError('transaction-ended');
  }
}

/**
 * Test-only runtime trap (HWS-AUDIT-C2-SIZING.md §7, layer 2). With CREWFLOW_TEST_SEARCH_PATH_TRAP=true AND NODE_ENV=test,
 * every binder sets search_path to '' instead of the schema (the WeakMap above still records the real schema), so any
 * unqualified table reference fails with 42P01 instead of silently resolving through routing. Postgres still searches
 * pg_catalog implicitly, so built-ins keep working.
 *
 * Read at call time (a suite can switch it per test). Set to anything but exactly 'true', or set without NODE_ENV=test, it
 * REFUSES (throws) instead of being ignored: a mis-set trap must never silently change routing in a real deployment.
 * Also refused at start-up outside NODE_ENV=test: TEST_SEAM_VARS (database/owner-login/runtime-db-config.ts: env validation and
 * the runtime guard), api-prestart.sh and worker-start.sh.
 */
export const SEARCH_PATH_TRAP_VAR = 'CREWFLOW_TEST_SEARCH_PATH_TRAP';

export class SearchPathTrapRefused extends Error {
  constructor(reason: 'not-test' | 'bad-value') {
    super(
      reason === 'not-test'
        ? `${SEARCH_PATH_TRAP_VAR} is a test seam: it is allowed only with NODE_ENV=test. Remove it.`
        : `${SEARCH_PATH_TRAP_VAR} must be exactly "true" when set.`,
    );
    this.name = 'SearchPathTrapRefused';
  }
}

/** True when the trap is on (and allowed). Throws SearchPathTrapRefused when it is set but not allowed. */
export function searchPathTrapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[SEARCH_PATH_TRAP_VAR];
  if (value === undefined || value === '') return false;
  if (value !== 'true') throw new SearchPathTrapRefused('bad-value');
  if (env.NODE_ENV !== 'test') throw new SearchPathTrapRefused('not-test');
  return true;
}

/**
 * The value a binder passes to set_config('search_path', $n, true) for `schema`: the schema itself, or '' under the trap.
 * The schema is validated the same way as bindBusinessSchema (format only here: the binder binds it with its workspace id).
 */
export function businessSearchPath(schema: string, env: Record<string, string | undefined> = process.env): string {
  if (schema !== CORE_BUSINESS_SCHEMA && !SCHEMA_NAME.test(schema)) throw new BusinessTablesError('invalid-schema');
  return searchPathTrapEnabled(env) ? '' : schema;
}
