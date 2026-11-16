import { EntityManager } from 'typeorm';

import { coreReferences } from '../../../database/typeorm/workspace-schema/workspace-core-orphans';
import type { WorkspaceTable } from '../../../database/typeorm/workspace-schema/workspace-tables';
import { WORKSPACE_CORE_FOREIGN_KEYS } from '../upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { businessTables } from '../tenant/business-tables';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (structure level 22; owner approved 2026-11-15). With the workspace → core."user"
 * foreign keys gone, removing a core user row no longer CASCADEs, SETs NULL or RESTRICTs inside a workspace schema. Since
 * owner decision 0g a user is SOFT deleted (the row stays, every reference keeps resolving); the only path that removes the
 * row is UserDeletionService's hard delete of a never-activated invite with no history, inside its own savepoint, run in
 * every scope the target can have rows in (UserDeletionService.inEveryScope binds each scope for businessTables). In that
 * path, the Twenty way (twentyhq/twenty @ eedb0a73 keeps cross-schema references application-enforced:
 * workspace-schema-foreign-key-manager.service.ts:32), with the choices of WS-COMMANDS.md §0a.5:
 *  - Q3 RESTRICT → `workspaceRestrictReference`: before the delete, every former no-ON-DELETE user column is probed in the
 *    bound scope; a hit makes the hard delete unsafe (the caller soft-deletes instead);
 *  - Q2 CASCADE / SET NULL → `clearWorkspaceUserReferences`: after the delete, in the same savepoint, the target's own
 *    staff_profile rows and the notes about them are deleted and the SET NULL columns cleared. A row of the schema that still
 *    needs the profile (an in-schema foreign key) raises 23503, which rolls the savepoint back (soft delete instead).
 * In the `core` scope the real core foreign keys still act, so both are no-ops there. Anything a probe could not see (RLS:
 * the caller's read rights, owner decision R-1) is what the daily orphan check reports.
 */

/** The former ON DELETE actions of the dropped user constraints (WORKSPACE_CORE_FOREIGN_KEYS definitions). */
type UserAction = 'restrict' | 'cascade' | 'set-null';

export interface UserReferenceColumn {
  table: WorkspaceTable;
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
      return { table: r.table as WorkspaceTable, column: r.column, action };
    });
}

function definitionOf(table: string, column: string): string {
  for (const [, def] of WORKSPACE_CORE_FOREIGN_KEYS[table] ?? []) {
    if (def.startsWith(`FOREIGN KEY (${column}) `)) return def;
  }
  return '';
}

/**
 * Q3 (the former RESTRICT), in the scope businessTables(manager) is bound to: the first `table.column` of a former
 * no-ON-DELETE user column that references the target, or null. Reads under the caller's RLS.
 */
export async function workspaceRestrictReference(manager: EntityManager, userId: string): Promise<string | null> {
  const t = businessTables(manager);
  for (const c of userReferenceColumns().filter((x) => x.action === 'restrict')) {
    // sql-injection-reviewed: the table comes from businessTables (validated schema, WORKSPACE_TABLES name); the column is a constant of the frozen list.
    const rows = await manager.query(`SELECT 1 FROM ${t[c.table]} WHERE ${c.column} = $1 LIMIT 1`, [userId]);
    if (rows.length) return `${c.table}.${c.column}`;
  }
  return null;
}

/**
 * Q2 (the former CASCADE / SET NULL), after the core row is gone, in the bound scope: SET NULL columns cleared, then the
 * target's own staff_profile rows and the notes about them deleted. Returns the rows touched. A 23503 (an in-schema row still
 * needs the profile) propagates: the caller's savepoint rolls back.
 */
export async function clearWorkspaceUserReferences(manager: EntityManager, userId: string): Promise<{ deleted: number; cleared: number }> {
  const t = businessTables(manager);
  const columns = userReferenceColumns();
  const total = { deleted: 0, cleared: 0 };
  for (const c of columns.filter((x) => x.action === 'set-null')) {
    // sql-injection-reviewed: the table comes from businessTables (validated schema, WORKSPACE_TABLES name); the column is a constant of the frozen list.
    total.cleared += rowCount(await manager.query(`UPDATE ${t[c.table]} SET ${c.column} = NULL WHERE ${c.column} = $1`, [userId]));
  }
  for (const c of columns.filter((x) => x.action === 'cascade')) {
    // sql-injection-reviewed: the table comes from businessTables (validated schema, WORKSPACE_TABLES name); the column is a constant of the frozen list.
    total.deleted += rowCount(await manager.query(`DELETE FROM ${t[c.table]} WHERE ${c.column} = $1`, [userId]));
  }
  return total;
}

/** TypeORM returns [rows, count] for UPDATE / DELETE through query() on postgres. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
