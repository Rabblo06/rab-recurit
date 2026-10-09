import { DataSource } from 'typeorm';

import { SUPPORTED_WORKSPACE_SCHEMA_VERSIONS } from '../../../engine/core-modules/tenant/schema-resolver.service';

export class HwsStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwsStartupError';
  }
}

/**
 * The 15 physical workspace-business tables (rab-workforce-architecture.md). 14 have a TypeORM entity;
 * `venue_manager_staff` is workspace-owned but raw-SQL-accessed only (owner decision, Phase 3) and so has no
 * entity metadata to check here — its absence from this list is deliberate, not an oversight.
 */
export const WORKSPACE_TABLE_NAMES: ReadonlySet<string> = new Set([
  'staff_profile',
  'user_note',
  'venue',
  'job_role',
  'venue_role_rate',
  'manager_venue',
  'shift',
  'shift_request_staff',
  'shift_assignment',
  'job_offer',
  'replacement_request',
  'attendance',
  'attendance_correction',
  'shift_report',
]);

/**
 * HWS runtime cutover, Part 14/26: when `HWS_RUNTIME_ENABLED=true`, verify the invariants the whole cutover depends
 * on BEFORE the process serves a single request or job — a hole here is a silent, repo-wide "every workspace query
 * reads core" regression, not a one-off bug, so it is caught at boot, the same way `assertRuntimeDbRole` catches a
 * misconfigured DATABASE_URL at boot rather than via a cross-tenant leak. No-op when `HWS_RUNTIME_ENABLED` is false
 * (legacy/compat deployments keep today's behaviour and never run these checks).
 *
 * Checks, in order:
 *   1. `core.workspace_schema_registry` exists — the table every workspace-business transaction's search_path
 *      resolution depends on (`SchemaResolverService.resolve`). Existence only, not row count: an empty registry on
 *      a fresh deployment is legitimate (no workspace provisioned yet), but a missing TABLE means the registry
 *      migration never ran, and nothing can ever resolve.
 *   2. `SUPPORTED_WORKSPACE_SCHEMA_VERSIONS` is non-empty — a build-time constant, but if it were ever emptied by
 *      mistake every workspace, including already-READY ones, would fail closed on 'unsupported-version' for every
 *      request. Catching that at boot is strictly better than catching it on the first request after a bad deploy.
 *   3. Every entity whose table name is one of the 15 physical workspace tables declares NO fixed `schema` — it
 *      must resolve through the transaction-local `search_path` `TenantContextService`/`WorkspaceExecutionContext`
 *      bind, never a DataSource-level default. A fixed `schema:'core'` here would mean that entity's queries keep
 *      reading/writing `core.*` even after search_path routes everything else to the physical workspace schema —
 *      exactly the split-brain Part 14 found and fixed in raw SQL; this guard is the same check for entity metadata.
 *   4. Every OTHER entity (by elimination: every core/global entity) declares EXACTLY `schema: 'core'` — the
 *      inverse check, so a workspace table silently added without a `schema` option, or a core entity someone
 *      forgot to mark `schema: 'core'`, both fail loudly at boot instead of resolving ambiguously at runtime.
 *   5. The migrations table is the dotted, schema-qualified `'core.migrations'` — the Part 2 fix that only works
 *      once the DataSource's default schema is removed; an unqualified `'migrations'` here would (per the measured
 *      behaviour in HYPER-WORKSPACE-PHASE3-FOUNDATION.md) make every migration appear perpetually pending.
 */
export async function assertHwsStartupInvariants(dataSource: DataSource, hwsRuntimeEnabled: boolean): Promise<void> {
  if (!hwsRuntimeEnabled) return;

  const [{ exists }] = await dataSource.query<[{ exists: boolean }]>(
    `SELECT to_regclass('core.workspace_schema_registry') IS NOT NULL AS exists`,
  );
  if (!exists) {
    throw new HwsStartupError(
      'HWS_RUNTIME_ENABLED=true but core.workspace_schema_registry does not exist. Every workspace-business transaction depends on this table to resolve its physical schema. Refusing to start.',
    );
  }

  if (SUPPORTED_WORKSPACE_SCHEMA_VERSIONS.size === 0) {
    throw new HwsStartupError(
      'HWS_RUNTIME_ENABLED=true but SUPPORTED_WORKSPACE_SCHEMA_VERSIONS is empty — no workspace, including an already-READY one, could ever resolve. Refusing to start.',
    );
  }

  const misclassified: string[] = [];
  for (const metadata of dataSource.entityMetadatas) {
    const isWorkspaceTable = WORKSPACE_TABLE_NAMES.has(metadata.tableName);
    const fixedSchema = metadata.schema ?? null;
    if (isWorkspaceTable && fixedSchema !== null) {
      misclassified.push(`${metadata.name} (table "${metadata.tableName}") is a physical workspace table but declares a fixed schema ("${fixedSchema}") — it must resolve through search_path, not a DataSource default.`);
    } else if (!isWorkspaceTable && fixedSchema !== 'core') {
      misclassified.push(`${metadata.name} (table "${metadata.tableName}") is not one of the 15 workspace tables but does not declare schema:'core' (got "${fixedSchema ?? 'none'}").`);
    }
  }
  if (misclassified.length > 0) {
    throw new HwsStartupError(`HWS_RUNTIME_ENABLED=true but entity metadata is misclassified. Refusing to start:\n  - ${misclassified.join('\n  - ')}`);
  }

  const migrationsTableName = (dataSource.options as { migrationsTableName?: string }).migrationsTableName;
  if (migrationsTableName !== 'core.migrations') {
    throw new HwsStartupError(
      `HWS_RUNTIME_ENABLED=true but migrationsTableName is "${migrationsTableName ?? 'unset'}", not the schema-qualified "core.migrations". An unqualified name resolves against the now-dynamic search_path instead of always targeting core. Refusing to start.`,
    );
  }
}
