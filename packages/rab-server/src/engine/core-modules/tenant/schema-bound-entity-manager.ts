import { Logger } from '@nestjs/common';
import { BaseEntity, DataSource, DataSourceOptions, EntityManager, QueryRunner } from 'typeorm';

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
 *   - One schema per transaction: a second bind on the same query runner with another schema throws (review M1).
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
 * metadata set (measured ~0.4 MB heap and ~11-25 ms of synchronous CPU to build for the 42 entities): 512 is ~200 MB per base
 * DataSource worst case (~400 MB if the replica path also reaches 512 schemas). Above the cap every transaction of an evicted
 * workspace pays a rebuild (thrash), so builds are counted and logged (schemaBoundMetadataStats). Correctness never depends on
 * the cap. A configurable cap is proposed to the lead (env validation is lead-owned), see C2-STATUS.
 */
export const SCHEMA_BOUND_METADATA_CACHE_MAX = 512;

/** Process-wide counters (no schema names, no ids): cache hits, builds (misses), evictions. */
const stats = { hits: 0, builds: 0, evictions: 0 };
export function schemaBoundMetadataStats(): Readonly<typeof stats> {
  return { ...stats };
}
const logger = new Logger('SchemaBoundEntityManager');
const BUILD_WARN_INTERVAL_MS = 60_000;
let lastBuildWarnAt = 0;

/**
 * Connection fields shadowed as OWN `undefined` properties of the metadata source's options, so nothing reading them through
 * the prototype chain (the base options) can see the base's URL, credentials, TLS or pool settings.
 */
const SHADOWED_CONNECTION_FIELDS = ['url', 'host', 'port', 'username', 'password', 'database', 'ssl', 'extra', 'replication'] as const;

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
/**
 * query runner (= one transaction) -> the schema its entity metadata was bound to. The guard is per RUNNER, not per manager:
 * binding a second manager on the same runner re-points `runner.manager`, which `save()` uses, so a second schema on one
 * transaction would let an already handed-out manager persist into the other schema (review M1).
 */
const runnerSchemas = new WeakMap<QueryRunner, string>();

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
  // One schema per transaction (per query runner), whichever manager asks: a different schema needs its own transaction.
  const recorded = runnerSchemas.get(runner);
  const current = runner.manager;
  const currentInfo = current ? metadataSourceInfo.get(current.connection) : undefined;
  if ((recorded !== undefined && recorded !== schema) || (currentInfo && currentInfo.schema !== schema)) {
    throw new SchemaBoundEntityManagerError('refusing to bind a second schema on the same transaction');
  }
  if (currentInfo) return current; // already bound to this schema: persistence keeps using the same manager
  // Reserve the runner's schema BEFORE the await, so a concurrent bind with another schema on the same runner is refused
  // above instead of racing through the build (review re-check); released again if the build fails.
  const reserved = recorded === undefined;
  if (reserved) runnerSchemas.set(runner, schema);
  const existing = metadataSourceInfo.get(manager.connection);
  let metadataSource: DataSource;
  try {
    metadataSource = await metadataSourceFor(existing ? existing.base : manager.connection, schema);
  } catch (error) {
    if (reserved && runnerSchemas.get(runner) === schema) runnerSchemas.delete(runner);
    throw error;
  }
  // Re-check after the await: a concurrent bind of the SAME schema may already have bound the runner; reuse its manager.
  const now = runner.manager;
  const nowInfo = now ? metadataSourceInfo.get(now.connection) : undefined;
  if (nowInfo) {
    if (nowInfo.schema !== schema) throw new SchemaBoundEntityManagerError('refusing to bind a second schema on the same transaction');
    return now;
  }
  if (runnerSchemas.get(runner) !== schema) throw new SchemaBoundEntityManagerError('refusing to bind a second schema on the same transaction');
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
    stats.hits += 1;
    return cached;
  }
  const built = buildMetadataSource(base, schema);
  stats.builds += 1;
  bySchema.set(schema, built);
  built.catch(() => {
    if (bySchema!.get(schema) === built) bySchema!.delete(schema);
  });
  while (bySchema.size > SCHEMA_BOUND_METADATA_CACHE_MAX) {
    const oldest = bySchema.keys().next().value as string;
    bySchema.delete(oldest);
    stats.evictions += 1;
  }
  const now = Date.now();
  if (now - lastBuildWarnAt >= BUILD_WARN_INTERVAL_MS) {
    // Rate-limited; counters only (no schema name, no id). Steadily growing `evictions` means the cap is too small (thrash).
    lastBuildWarnAt = now;
    logger.warn(
      `schema-bound metadata built (cache miss): builds=${stats.builds} hits=${stats.hits} evictions=${stats.evictions} cached=${bySchema.size} cap=${SCHEMA_BOUND_METADATA_CACHE_MAX}`,
    );
  }
  return built;
}

async function buildMetadataSource(base: DataSource, schema: string): Promise<DataSource> {
  const entities = base.options.entities ?? [];
  // An entity-less DataSource (raw-SQL-only harnesses) gets an empty metadata source: every entity call keeps failing with
  // EntityMetadataNotFoundError exactly as on the base, and boundSchemaOf() still answers.
  if (!Array.isArray(entities)) throw new SchemaBoundEntityManagerError('entities must be an explicit list of classes');
  for (const entity of entities) {
    // Glob strings / EntitySchema objects are not used here and would bypass the checks below.
    if (typeof entity !== 'function') throw new SchemaBoundEntityManagerError('entities must be explicit classes');
    // BaseEntity.useDataSource() would re-point the CLASS (process-global) at whichever DataSource built metadata last.
    // Duck-typed as well (a lookalike with a static useDataSource is refused too).
    if (entity.prototype instanceof BaseEntity || typeof (entity as { useDataSource?: unknown }).useDataSource === 'function') {
      throw new SchemaBoundEntityManagerError(`${entity.name} is a BaseEntity (static useDataSource); its data source would be re-pointed process-wide`);
    }
  }
  // BEFORE building: building metadata for a lazy relation patches the entity PROTOTYPE with the new source's RelationLoader
  // (process-wide), so the check after the build alone would come too late.
  for (const metadata of base.entityMetadatas) {
    for (const relation of metadata.relations) {
      if (relation.isLazy) throw new SchemaBoundEntityManagerError(`${metadata.name}.${relation.propertyName} is a lazy relation`);
    }
  }
  // Inherit every base option (naming strategy, logger, driver value options, ...) through the prototype chain; override only
  // what must differ. `schema` must be an OWN property: EntityMetadata.build() reads `options.hasOwnProperty('schema')`.
  // Connection fields are shadowed as own `undefined` properties: this source never connects and never sees the base's URL,
  // credentials, TLS or pool settings through the prototype chain.
  const shadowed = Object.fromEntries(SHADOWED_CONNECTION_FIELDS.map((field) => [field, { value: undefined, enumerable: true }]));
  const options = Object.create(base.options, {
    ...shadowed,
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
  // It must never connect: initialize()/connect() and the driver's connect() reject before any pool is constructed.
  const refuse = (): Promise<never> => Promise.reject(new SchemaBoundEntityManagerError('a schema-bound metadata source never connects'));
  Object.assign(metadataSource, { initialize: refuse, connect: refuse });
  Object.assign(metadataSource.driver, { connect: refuse });
  // Protected in the typings; public at runtime. Builds entity metadata only: no connection, no query, no extension install.
  await (metadataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  for (const metadata of metadataSource.entityMetadatas) {
    for (const relation of metadata.relations) {
      // Second line of defence (the base check runs before the build): never hand out a source with a lazy relation.
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
