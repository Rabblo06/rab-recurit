import { BaseEntity, DataSource, DataSourceOptions, EntityManager } from 'typeorm';

/**
 * Part C2-1 (HWS-AUDIT-C2-SIZING.md §6, option A): an EntityManager whose ENTITY metadata carries the transaction's schema, so
 * TypeORM itself writes `"workspace_<hex>"."shift"` (or `"core"."shift"` with HWS off) into every entity-API query instead of a
 * bare `shift` that only resolves through `search_path`.
 *
 * How:
 *   - Per (base DataSource, schema), ONE metadata-only DataSource is built and cached: the base options with `schema` set, the
 *     same entity classes, no migrations, no subscribers. It is NEVER initialised (no driver connection, no pool):
 *     `buildMetadatas()` only. Core entities declare `schema: 'core'` (hws-startup-guard check 4), so they resolve exactly as
 *     on the base DataSource; the 14 workspace entities declare no schema (check 3) and take the bound one.
 *   - Per transaction, the binder wraps the REAL transactional QueryRunner in `new EntityManager(metadataDs, queryRunner)`.
 *     The EntityManager constructor re-points `queryRunner.manager` at it, so persistence (`save` builds its INSERT/UPDATE
 *     through `queryRunner.manager`) and nested `manager.transaction(...)` see the same schema-bound metadata. Every statement
 *     still runs on the binder's one connection, inside its transaction, after its RLS GUCs, RESET ROLE and search_path.
 *   - Escape paths fail closed: anything that would open its OWN query runner from the bound manager (`manager.connection
 *     .createQueryRunner()`, `metadataDs.manager.find(...)`) reaches the unconnected metadata driver and throws "Driver not
 *     Connected" — never an unbound connection, never a different transaction.
 *
 * Twenty reference (re-implemented, not copied; local twenty-main download, commit not verified against eedb0a73):
 * `engine/twenty-orm/factories/entity-schema.factory.ts:39,49` puts the workspace schema into every entity schema,
 * `global-workspace-datasource/workspace-orm-entity-metadatas-cache.service.ts:34-79` builds and caches the per-workspace
 * EntityMetadata, and `global-workspace-datasource/global-workspace-datasource.ts:82-122` resolves metadata and binds new
 * query runners' managers through the workspace-specific source. Here the per-schema metadata lives in its own unconnected
 * DataSource instead of an AsyncLocalStorage context, because this codebase hands one transactional manager to callers.
 *
 * The schema is never taken from a request: the binders pass only the constant 'core' or a value returned by
 * SchemaResolverService.resolve() (registry match + `workspace_<32 hex>`), and this module re-checks the format (fail closed).
 * TypeORM quotes each path segment (`"workspace_<hex>"."shift"`).
 */

/** The only schema names a transaction's business tables may live in. */
const BOUND_SCHEMA_PATTERN = /^(?:core|workspace_[0-9a-f]{32})$/;

/**
 * Upper bound on cached metadata-only DataSources per base DataSource (least recently used evicted). One entry costs a full
 * metadata set (measured ~0.4 MB heap and ~11 ms to build for the 42 entities, so the cap is ~50 MB); an evicted one is
 * rebuilt on its next use. Correctness never depends on the cap.
 */
export const SCHEMA_BOUND_METADATA_CACHE_MAX = 128;

export class SchemaBoundEntityManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaBoundEntityManagerError';
  }
}

interface MetadataSourceInfo {
  base: DataSource;
  schema: string;
}

/** base DataSource -> schema -> metadata-only DataSource (promise, so concurrent first uses build it once). */
const metadataSources = new WeakMap<DataSource, Map<string, Promise<DataSource>>>();
/** metadata-only DataSource -> what it was built for. */
const metadataSourceInfo = new WeakMap<DataSource, MetadataSourceInfo>();

export function assertBindableSchema(schema: unknown): asserts schema is string {
  if (typeof schema !== 'string' || !BOUND_SCHEMA_PATTERN.test(schema)) {
    throw new SchemaBoundEntityManagerError('refusing to bind entity metadata to a schema that is not "core" or workspace_<32 hex>');
  }
}

/**
 * The schema the manager's entity metadata is bound to, or null for a manager that is not schema-bound (the base DataSource's
 * own managers). For the C2 raw-SQL primitive and for tests.
 */
export function boundSchemaOf(manager: EntityManager | null | undefined): string | null {
  if (!manager) return null;
  return metadataSourceInfo.get(manager.connection)?.schema ?? null;
}

/**
 * The DataSource the manager's statements really run on: for a schema-bound manager its query runner's connection (the primary,
 * or the replica on the routed-read path), otherwise `manager.connection`. Code that compares a manager with "the primary
 * DataSource" or subscribes to transaction events must use this, not `manager.connection` (the metadata-only source emits no
 * events and has no pool).
 */
export function executingDataSourceOf(manager: EntityManager): DataSource {
  if (metadataSourceInfo.has(manager.connection)) {
    const runner = manager.queryRunner;
    if (!runner) throw new SchemaBoundEntityManagerError('a schema-bound manager has no query runner');
    return runner.connection;
  }
  return manager.connection;
}

/**
 * Hands out the schema-bound manager for the binder's open transaction. `manager` must be the binder's transactional manager
 * (open, not released). `schema` must be what the binder just bound as search_path ('core' or the resolved workspace schema),
 * so entity SQL and search_path always agree and the change is behaviour-identical while search_path stays bound.
 */
export async function bindEntityManagerToSchema(manager: EntityManager, schema: string): Promise<EntityManager> {
  assertBindableSchema(schema);
  const runner = manager.queryRunner;
  if (!runner || runner.isReleased || !runner.isTransactionActive) {
    throw new SchemaBoundEntityManagerError('entity metadata can only be schema-bound inside an open transaction');
  }
  const existing = metadataSourceInfo.get(manager.connection);
  if (existing) {
    if (existing.schema === schema) return manager;
    throw new SchemaBoundEntityManagerError('refusing to re-bind a schema-bound manager to a different schema');
  }
  const metadataSource = await metadataSourceFor(manager.connection, schema);
  // The EntityManager constructor assigns `runner.manager = this`: persistence and nested transactions use it from here on.
  const bound = new EntityManager(metadataSource, runner);
  if (runner.manager !== bound) throw new SchemaBoundEntityManagerError('the query runner was not re-pointed at the schema-bound manager');
  return bound;
}

/** The cached metadata-only DataSource of `base` for `schema` (built on first use; concurrent first uses share one build). */
export async function metadataSourceFor(base: DataSource, schema: string): Promise<DataSource> {
  assertBindableSchema(schema);
  if (metadataSourceInfo.has(base)) throw new SchemaBoundEntityManagerError('the base DataSource is itself a schema-bound metadata source');
  let bySchema = metadataSources.get(base);
  if (!bySchema) {
    bySchema = new Map();
    metadataSources.set(base, bySchema);
  }
  const cached = bySchema.get(schema);
  if (cached) {
    // LRU: most recently used last.
    bySchema.delete(schema);
    bySchema.set(schema, cached);
    return cached;
  }
  const built = buildMetadataSource(base, schema);
  bySchema.set(schema, built);
  built.catch(() => {
    if (bySchema!.get(schema) === built) bySchema!.delete(schema);
  });
  while (bySchema.size > SCHEMA_BOUND_METADATA_CACHE_MAX) {
    const oldest = bySchema.keys().next().value as string;
    bySchema.delete(oldest);
  }
  return built;
}

async function buildMetadataSource(base: DataSource, schema: string): Promise<DataSource> {
  const entities = base.options.entities;
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new SchemaBoundEntityManagerError('the base DataSource lists no entity classes');
  }
  for (const entity of entities) {
    // Glob strings / EntitySchema objects are not used here and would bypass the checks below.
    if (typeof entity !== 'function') throw new SchemaBoundEntityManagerError('entities must be explicit classes');
    // BaseEntity.useDataSource() would re-point the CLASS (process-global) at whichever DataSource built metadata last.
    if (entity.prototype instanceof BaseEntity) {
      throw new SchemaBoundEntityManagerError(`${entity.name} extends BaseEntity; its static data source would be re-pointed process-wide`);
    }
  }
  // Inherit every base option (naming strategy, logger, driver value options, ...) through the prototype chain; override only
  // what must differ. `schema` must be an OWN property: EntityMetadata.build() reads `options.hasOwnProperty('schema')`.
  // Connection fields are NOT copied (Object.assign in the driver copies own properties only): this source never connects.
  const options = Object.create(base.options, {
    name: { value: `${base.name}:schema-bound:${schema}`, enumerable: true },
    schema: { value: schema, enumerable: true },
    migrations: { value: [], enumerable: true },
    migrationsRun: { value: false, enumerable: true },
    subscribers: { value: [], enumerable: true },
    synchronize: { value: false, enumerable: true },
    dropSchema: { value: false, enumerable: true },
    cache: { value: false, enumerable: true },
  }) as DataSourceOptions;
  const metadataSource = new DataSource(options);
  // Protected in the typings; public at runtime. Builds entity metadata only: no connection, no query, no extension install.
  await (metadataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  for (const metadata of metadataSource.entityMetadatas) {
    for (const relation of metadata.relations) {
      // A lazy relation patches the entity PROTOTYPE with this source's RelationLoader (process-global).
      if (relation.isLazy) throw new SchemaBoundEntityManagerError(`${metadata.name}.${relation.propertyName} is a lazy relation`);
    }
    const baseMetadata = base.hasMetadata(metadata.target) ? base.getMetadata(metadata.target) : null;
    if (!baseMetadata) throw new SchemaBoundEntityManagerError(`${metadata.name} has no metadata on the base DataSource`);
    // Core entities (fixed schema) must resolve exactly as on the base; schema-less ones must take the bound schema.
    const expectedSchema = baseMetadata.schema ?? schema;
    if (metadata.schema !== expectedSchema || metadata.tablePath !== `${expectedSchema}.${metadata.tableName}`) {
      throw new SchemaBoundEntityManagerError(`${metadata.name} resolved to "${metadata.tablePath}", expected "${expectedSchema}.${metadata.tableName}"`);
    }
  }
  metadataSourceInfo.set(metadataSource, { base, schema });
  return metadataSource;
}
