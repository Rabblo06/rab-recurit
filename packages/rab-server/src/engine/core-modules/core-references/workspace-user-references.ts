import { EntityManager } from 'typeorm';

import { coreReferences } from '../../../database/typeorm/workspace-schema/workspace-core-orphans';
import { WORKSPACE_CORE_FOREIGN_KEYS } from '../upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { workspaceSchemaName } from '../tenant/schema-resolver.service';
import { AuthContext } from '../tenant/auth-context.interface';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (structure level 22; SQL pending owner OK). With the workspace → core."user" foreign keys
 * gone, deleting a core user no longer CASCADEs, SETs NULL or RESTRICTs inside the workspace schemas. The user hard-delete path
 * (UserDeletionService) does it in the application, the Twenty way (twentyhq/twenty @ eedb0a73 keeps cross-schema references
 * application-enforced: workspace-schema-foreign-key-manager.service.ts:32), with the recommended choices of WS-COMMANDS.md §0a.5:
 *  - Q3 RESTRICT → `protectedWorkspaceReference`: before the delete, every former no-ON-DELETE user column of every candidate
 *    workspace schema is probed; a hit refuses the delete (409, the same structured refusal as the visible-history checks);
 *  - Q2 CASCADE / SET NULL → `cleanUpWorkspaceReferences`: after the delete, in the same transaction, the target's own
 *    staff_profile rows and the notes about them are deleted and the SET NULL columns are cleared;
 *  - anything a probe or a cleanup could not see (RLS: the caller's read rights) is what the daily orphan check reports.
 * Both run in the caller's tenant transaction, per READY workspace schema (rab.workspace_id + search_path moved, then restored);
 * with HWS off the workspace schemas hold no business data and both passes find nothing.
 */

/** The former ON DELETE actions of the dropped user constraints (WORKSPACE_CORE_FOREIGN_KEYS definitions). */
type UserAction = 'restrict' | 'cascade' | 'set-null';

export interface UserReferenceColumn {
  table: string;
  column: string;
  action: UserAction;
}

const IDENT = /^[a-z_]+$/;

/** Pure: the 31 user columns with their former ON DELETE action, from the frozen constraint definitions. */
export function userReferenceColumns(): UserReferenceColumn[] {
  return coreReferences()
    .filter((r) => r.target === 'core."user"')
    .map((r) => {
      const def = definitionOf(r.table, r.column);
      const action: UserAction = /ON DELETE CASCADE/.test(def) ? 'cascade' : /ON DELETE SET NULL/.test(def) ? 'set-null' : 'restrict';
      if (!IDENT.test(r.table) || !IDENT.test(r.column)) throw new Error(`unexpected identifier ${r.table}.${r.column}`);
      return { table: r.table, column: r.column, action };
    });
}

function definitionOf(table: string, column: string): string {
  for (const [, def] of WORKSPACE_CORE_FOREIGN_KEYS[table] ?? []) {
    if (def.startsWith(`FOREIGN KEY (${column}) `)) return def;
  }
  return '';
}

/** Candidate workspaces of the target inside the caller's organisation (the same set as Part C1's user-deletion scopes). */
export async function candidateWorkspaces(manager: EntityManager, ctx: AuthContext, userId: string): Promise<string[]> {
  if (!ctx.organisationId) return [];
  const rows = await manager.query<Array<{ workspace_id: string }>>(
    `SELECT id AS workspace_id FROM core.manager_workspace WHERE organisation_id = $1
     UNION SELECT workspace_id FROM core.manager_profile WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
     UNION SELECT workspace_id FROM core.workspace_membership WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
     ORDER BY 1`,
    [ctx.organisationId, userId],
  );
  const ids = new Set(rows.map((r) => r.workspace_id));
  if (ctx.workspaceId) ids.add(ctx.workspaceId);
  return [...ids].sort();
}

/** Runs `visit` in each candidate workspace's READY schema (rab.workspace_id + search_path moved), restoring both after success. */
async function inWorkspaceSchemas<T>(manager: EntityManager, workspaceIds: readonly string[], visit: (schema: string) => Promise<T | null>): Promise<T | null> {
  if (workspaceIds.length === 0) return null;
  const [entry] = await manager.query<Array<{ ws: string | null; sp: string }>>(`SELECT current_setting('rab.workspace_id', true) AS ws, current_setting('search_path') AS sp`);
  let found: T | null = null;
  for (const workspaceId of workspaceIds) {
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
    const [reg] = await manager.query<Array<{ status: string; schema_name: string }>>(
      `SELECT status, schema_name FROM core.workspace_schema_registry WHERE workspace_id = $1`,
      [workspaceId],
    );
    const schema = workspaceSchemaName(workspaceId);
    if (reg?.status !== 'READY' || reg.schema_name !== schema) continue;
    await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
    // No restore on failure, on purpose: any error has aborted the transaction (a restore would only fail with 25P02 and hide
    // the real error, e.g. WorkspaceReferenceBlocked), and the caller's rollback discards these SET LOCAL values anyway.
    found = await visit(schema);
    if (found !== null) break;
  }
  await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', $2, true)`, [entry?.ws ?? '', entry?.sp ?? 'core']);
  return found;
}

/**
 * Q3 (the former RESTRICT): the first `table.column` of a former no-ON-DELETE user column that references the target in any
 * candidate workspace schema, or null. Reads under the caller's RLS (a row the caller cannot see is not found here; the orphan
 * check reports it if the delete goes ahead).
 */
export async function protectedWorkspaceReference(manager: EntityManager, ctx: AuthContext, userId: string): Promise<string | null> {
  const restrict = userReferenceColumns().filter((c) => c.action === 'restrict');
  return inWorkspaceSchemas(manager, await candidateWorkspaces(manager, ctx, userId), async (schema) => {
    for (const c of restrict) {
      // sql-injection-reviewed: schema is the validated workspace_<32 hex> name; table / column are constants of the frozen list.
      const rows = await manager.query(`SELECT 1 FROM ${schema}.${c.table} WHERE ${c.column} = $1 LIMIT 1`, [userId]);
      if (rows.length) return `${c.table}.${c.column}`;
    }
    return null;
  });
}

/**
 * Q2 (the former CASCADE / SET NULL), after the core delete in the same transaction: the target's own rows are deleted
 * (staff_profile.user_id, user_note.subject_user_id) and the SET NULL columns cleared. Returns the rows touched per action.
 */
export async function cleanUpWorkspaceReferences(manager: EntityManager, ctx: AuthContext, userId: string, workspaceIds: readonly string[]): Promise<{ deleted: number; cleared: number }> {
  const columns = userReferenceColumns();
  const total = { deleted: 0, cleared: 0 };
  await inWorkspaceSchemas(manager, workspaceIds, async (schema) => {
    for (const c of columns.filter((x) => x.action === 'set-null')) {
      // sql-injection-reviewed: schema is the validated workspace_<32 hex> name; table / column are constants of the frozen list.
      const r = await manager.query(`UPDATE ${schema}.${c.table} SET ${c.column} = NULL WHERE ${c.column} = $1`, [userId]);
      total.cleared += rowCount(r);
    }
    for (const c of columns.filter((x) => x.action === 'cascade')) {
      try {
        // sql-injection-reviewed: schema is the validated workspace_<32 hex> name; table / column are constants of the frozen list.
        const r = await manager.query(`DELETE FROM ${schema}.${c.table} WHERE ${c.column} = $1`, [userId]);
        total.deleted += rowCount(r);
      } catch (error) {
        // A row of the workspace still references the profile (history the caller's checks could not see): refuse the whole
        // delete (the caller's transaction aborts), never a raw foreign-key 500.
        if ((error as { driverError?: { code?: string }; code?: string })?.driverError?.code === '23503' || (error as { code?: string })?.code === '23503') {
          throw new WorkspaceReferenceBlocked(`${c.table}.${c.column}`);
        }
        throw error;
      }
    }
    return null;
  });
  return total;
}

/** A workspace row the delete would orphan or break: mapped by UserDeletionService to its structured 409. */
export class WorkspaceReferenceBlocked extends Error {
  constructor(readonly reference: string) {
    super(`a workspace row still references the user (${reference})`);
    this.name = 'WorkspaceReferenceBlocked';
  }
}

/** TypeORM returns [rows, count] for UPDATE / DELETE through query() on postgres. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
