import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';
import { codeWorkspaceStructureLevel } from '../upgrade/workspace-structure-level';
import { isUpgradeBlocked } from '../upgrade/workspace-upgrade-block';
import { CachedResolvedSchema, WorkspaceMetadataCacheService } from '../entity-cache/workspace-metadata-cache.service';

/**
 * The ONE canonical builder of a workspace schema name (Hyper Workspace Phase 3, steps 2 and 8).
 * Nothing else may build `workspace_…` identifiers.
 *
 * - Input must be a UUID in any letter case, with or without hyphens. Anything else throws.
 * - Output is `workspace_` + the 32 lowercase hex digits (42 characters, under PostgreSQL's 63-byte limit).
 * - The database enforces the same derivation: core.workspace_schema_registry CHECK
 *   (schema_name = 'workspace_' || replace(workspace_id::text,'-','')). A test asserts both agree.
 *
 * Inputs are server-derived workspace ids only. Never a request field, route parameter, header, JWT claim or DTO.
 */
export const WORKSPACE_SCHEMA_PREFIX = 'workspace_';

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const SCHEMA_NAME_PATTERN = /^workspace_[0-9a-f]{32}$/;

export function workspaceSchemaName(workspaceId: unknown): string {
  if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
    throw new Error('Workspace id must be a UUID.');
  }
  const name = WORKSPACE_SCHEMA_PREFIX + workspaceId.replace(/-/g, '').toLowerCase();
  if (!SCHEMA_NAME_PATTERN.test(name)) {
    // Unreachable when the input passed UUID_PATTERN; kept as a fail-closed backstop.
    throw new Error('Derived workspace schema name failed canonical check.');
  }
  return name;
}

/** Schema versions this runtime knows how to route to. Raise deliberately when a new template version ships. */
export const SUPPORTED_WORKSPACE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * Fail-closed routing error. The message is a fixed, non-sensitive code; no schema name, id or row content is included.
 *
 * 'incompatible-module' (Phase B schema compatibility): the workspace is READY but its `module_version` is below
 * MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION — this code would query columns/tables that schema does not have. It is an
 * availability fault, not authorisation: AllExceptionsFilter maps it to 503 (every other code stays 404).
 */
export class WorkspaceRoutingError extends Error {
  constructor(readonly code: 'missing-context' | 'registry-missing' | 'name-mismatch' | 'not-ready' | 'unsupported-version' | 'incompatible-module' | 'upgrading') {
    super('Workspace routing refused.');
    this.name = 'WorkspaceRoutingError';
  }
}

/** Throws 'incompatible-module' below the floor. Pure. */
export function assertCompatibleModuleVersion(moduleVersion: number, minimum: number = MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION): void {
  if (!Number.isInteger(moduleVersion) || moduleVersion < minimum) throw new WorkspaceRoutingError('incompatible-module');
}

@Injectable()
export class SchemaResolverService {
  private readonly logger = new Logger(SchemaResolverService.name);
  /** Workspaces already reported as ahead of this code (one warning per workspace per process, not per request). */
  private readonly warnedAhead = new Set<string>();

  constructor(private readonly workspaceMetadataCache: WorkspaceMetadataCacheService) {}

  /** Derived name only. Kept for callers that need the pure mapping without a database round trip. */
  schemaFor(workspaceId: string): string {
    return workspaceSchemaName(workspaceId);
  }

  /**
   * Resolve the TRUSTED physical schema for a server-derived workspace id.
   * Must run inside a transaction whose rab.organisation_id is already bound: the registry is FORCE RLS, so an unbound
   * session sees no row and the call fails closed with 'registry-missing'.
   *
   * Redis checkpoint — Workspace Metadata Cache: `resolveSchema()`'s `fetch` callback below is the
   * ENTIRE validated Postgres path, unchanged — every failure throws `WorkspaceRoutingError`
   * exactly as before, and `getOrFetch` (underneath `resolveSchema`) only ever caches a value this
   * callback actually returned, which can only be a validated, matching, `READY`, supported-version
   * success. A cache HIT therefore only ever returns a value that was ALREADY proven valid at the
   * moment it was written. See `WorkspaceMetadataCacheService`'s own doc comment for the full "why
   * this can never route to an unready/mismatched/inaccessible workspace" argument.
   *
   * ST-07 (T-1): that argument holds only for values THIS code wrote. Redis is not the authority, and the returned name
   * becomes `search_path` (now folded into a bound SELECT parameter, which stops SQL injection but not a comma-separated
   * list). So a cached name is still compared with the name derived from the server-side workspace id, in memory (no
   * round trip): anything else is dropped from the cache and decided from Postgres again, which throws on any mismatch.
   */
  async resolve(manager: EntityManager, workspaceId: string | null | undefined): Promise<string> {
    if (!workspaceId) throw new WorkspaceRoutingError('missing-context');
    const expected = workspaceSchemaName(workspaceId);

    const fetch = async (): Promise<CachedResolvedSchema> => {
      const rows: Array<{ schema_name: string; status: string; schema_version: number; module_version: number; migration_error: string | null }> = await manager.query(
        `SELECT schema_name, status, schema_version, module_version, migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (rows.length !== 1) throw new WorkspaceRoutingError('registry-missing');
      const row = rows[0];
      if (row.schema_name !== expected) throw new WorkspaceRoutingError('name-mismatch');
      if (row.status !== 'READY') throw new WorkspaceRoutingError('not-ready');
      if (!SUPPORTED_WORKSPACE_SCHEMA_VERSIONS.has(Number(row.schema_version))) throw new WorkspaceRoutingError('unsupported-version');
      // Part D, owner decisions D2/D3: an upgrade step failed with a structure that does not match this code: the workspace is
      // blocked until the step succeeds (503 "being upgraded"; never cached). Raised only after the caller's organisation is
      // bound and the row is visible to it, so another tenant still gets 'registry-missing' (404).
      if (isUpgradeBlocked(row.migration_error)) throw new WorkspaceRoutingError('upgrading');
      const moduleVersion = Number(row.module_version);
      // Phase B: below the floor is refused here, so it is never cached.
      assertCompatibleModuleVersion(moduleVersion);
      return { schemaName: row.schema_name, schemaVersion: Number(row.schema_version), moduleVersion };
    };

    let resolved = await this.workspaceMetadataCache.resolveSchema(workspaceId, fetch);
    // A cached value written by another image (no module version, or one below THIS code's floor) is never trusted:
    // drop it and decide from Postgres. A value this code wrote already passed the floor in `fetch`.
    // ST-07: nor is a cached schema name that is not exactly the derived one (planted or corrupted in Redis).
    if (
      resolved.schemaName !== expected ||
      typeof resolved.moduleVersion !== 'number' ||
      resolved.moduleVersion < MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION
    ) {
      await this.workspaceMetadataCache.invalidate(workspaceId);
      resolved = await fetch();
    }
    const codeLevel = codeWorkspaceStructureLevel();
    if ((resolved.moduleVersion ?? 0) > codeLevel && !this.warnedAhead.has(workspaceId)) {
      // c2 (image rollback after a module migration): old code on a superset schema is allowed; report it once.
      this.warnedAhead.add(workspaceId);
      this.logger.warn(
        `workspace ${workspaceId} schema is at module ${resolved.moduleVersion}, above this code's module (structure level) ${codeLevel} (an image rollback); routing continues`,
      );
    }
    // Unreachable unless fetch() itself broke its contract (it throws 'name-mismatch'); fail closed regardless.
    if (resolved.schemaName !== expected) throw new WorkspaceRoutingError('name-mismatch');
    return resolved.schemaName;
  }
}
