import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { WorkspaceMetadataCacheService } from '../entity-cache/workspace-metadata-cache.service';

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
 */
export class WorkspaceRoutingError extends Error {
  constructor(readonly code: 'missing-context' | 'registry-missing' | 'name-mismatch' | 'not-ready' | 'unsupported-version') {
    super('Workspace routing refused.');
    this.name = 'WorkspaceRoutingError';
  }
}

@Injectable()
export class SchemaResolverService {
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
   * moment it was written — re-validating it again on every hit would be pure overhead against
   * something structurally impossible to violate, so this deliberately doesn't. See
   * `WorkspaceMetadataCacheService`'s own doc comment for the full "why this can never route to an
   * unready/mismatched/inaccessible workspace" argument.
   */
  async resolve(manager: EntityManager, workspaceId: string | null | undefined): Promise<string> {
    if (!workspaceId) throw new WorkspaceRoutingError('missing-context');
    const expected = workspaceSchemaName(workspaceId);

    const resolved = await this.workspaceMetadataCache.resolveSchema(workspaceId, async () => {
      const rows: Array<{ schema_name: string; status: string; schema_version: number }> = await manager.query(
        `SELECT schema_name, status, schema_version FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (rows.length !== 1) throw new WorkspaceRoutingError('registry-missing');
      const row = rows[0];
      if (row.schema_name !== expected) throw new WorkspaceRoutingError('name-mismatch');
      if (row.status !== 'READY') throw new WorkspaceRoutingError('not-ready');
      if (!SUPPORTED_WORKSPACE_SCHEMA_VERSIONS.has(Number(row.schema_version))) throw new WorkspaceRoutingError('unsupported-version');
      return { schemaName: row.schema_name, schemaVersion: Number(row.schema_version) };
    });
    return resolved.schemaName;
  }
}
