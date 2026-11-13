// sql-injection-reviewed-file: every statement is a constant of this file; every value is a bound parameter ($n).
/**
 * OWNER-DB-ULTIMATE Part B1/B2/B3: the upgrade logbook `core.upgrade_migration`, read and written with PLAIN QUERIES like
 * Twenty's repository (twentyhq/twenty @ eedb0a73 `engine/core-modules/upgrade/services/upgrade-migration.service.ts`).
 * Re-implemented, not copied:
 *   - isLastAttemptCompleted            :33-49   the row with the highest attempt for (name, scope) is `completed`;
 *   - recordUpgradeMigration            :51-137  one row when a step ends; attempt = previous rows of (name, scope) + 1;
 *                                                 errorMessage only on `failed` (:78-81);
 *   - markAsWorkspaceInitial            :139-172 one is_initial row per workspace, attempt 1, idempotent (:156-162);
 *   - getLastAttemptedInstanceCommand   :334-374 instance rows, is_initial excluded, the max attempt per name, newest first.
 *
 * Access (Crewflow addition, OWNER-DB-ULTIMATE §0.2: FORCE RLS stays): the table's policies admit a transaction only when it
 * set the transaction-local `rab.upgrade_scope` (UpgradeMigration1786721470000):
 *   - 'upgrade'         read + insert, no tenant bound, insert only while THIS session holds the migration advisory lock;
 *   - 'status'          read, no tenant bound (/healthz, the admin banner, `upgrade` command output);
 *   - 'workspace_init'  read + insert the bound organisation's workspace rows (workspace creation).
 * Ordinary request handlers never set it and see nothing. This is a code-path convention enforced by the database, NOT a
 * boundary against code that runs as the same login and sets the scope itself (see the SECURITY TRADE-OFF in
 * UPGRADES-LEDGER-SQL.md "REVISED"); a source-guard spec limits which files may name the setting.
 *
 * Every function takes a `Query` (a pg client, a TypeORM query runner or a DataSource), so the migrate child, the
 * `upgrade --force` command, the health read and workspace creation share one implementation.
 */
export type Query = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;

export const UPGRADE_SCOPE_SETTING = 'rab.upgrade_scope';
export type UpgradeScope = 'upgrade' | 'status' | 'workspace_init';

/** Stored as-is (owner: like Twenty), only cut to this length; the table's CHECK backs it. */
export const MAX_ERROR_MESSAGE_LENGTH = 4000;

export type UpgradeMigrationStatus = 'completed' | 'failed';

export interface UpgradeMigrationRow {
  name: string;
  status: UpgradeMigrationStatus;
  attempt: number;
  executedByVersion: string;
  isInitial: boolean;
  forced: boolean;
  createdAt: Date;
}

const SET_SCOPE = `SELECT pg_catalog.set_config('${UPGRADE_SCOPE_SETTING}', $1, true)`;

/**
 * Runs `fn` in ONE transaction with `rab.upgrade_scope` set for that transaction only. The caller's session must not be
 * inside a transaction (the migrate child and the command call it on the locked session between steps). Commits on
 * success, rolls back on error and rethrows.
 */
export async function withUpgradeScope<T>(query: Query, scope: Exclude<UpgradeScope, 'workspace_init'>, fn: (q: Query) => Promise<T>): Promise<T> {
  await query('BEGIN');
  try {
    await query(SET_SCOPE, [scope]);
    const result = await fn(query);
    await query('COMMIT');
    return result;
  } catch (error) {
    await query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Whether the logbook table exists (it is created by a pending migration on an adoption start). */
export async function upgradeLedgerExists(query: Query): Promise<boolean> {
  const rows = (await query(`SELECT pg_catalog.to_regclass('core.upgrade_migration') IS NOT NULL AS "exists"`)) as Array<{ exists: boolean }> | undefined;
  return Array.isArray(rows) && rows[0]?.exists === true;
}

/** Twenty :33-49. Instance scope when workspaceId is null. Needs scope 'upgrade' or 'status' (or 'workspace_init' for a workspace). */
export async function isLastAttemptCompleted(query: Query, input: { name: string; workspaceId: string | null }): Promise<boolean> {
  const rows = (await query(
    `SELECT m.status FROM core.upgrade_migration m
      WHERE m.name = $1 AND m.workspace_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY m.attempt DESC LIMIT 1`,
    [input.name, input.workspaceId],
  )) as Array<{ status: string }>;
  return rows[0]?.status === 'completed';
}

/** Whether the logbook has any instance row (adoption happens only on a logbook without one). */
export async function hasInstanceRows(query: Query): Promise<boolean> {
  const rows = (await query(`SELECT 1 FROM core.upgrade_migration m WHERE m.workspace_id IS NULL LIMIT 1`)) as unknown[];
  return rows.length > 0;
}

/** Every version that appears on an instance row (completed or not). */
export async function instanceVersions(query: Query): Promise<string[]> {
  const rows = (await query(`SELECT DISTINCT m.executed_by_version AS v FROM core.upgrade_migration m WHERE m.workspace_id IS NULL`)) as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

export function errorMessageForStorage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (text.length ? text : 'unknown error').slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Twenty :51-137, instance rows: ONE row when a step ends. attempt = previous rows of this name + 1, computed in the same
 * statement; correct because every writer holds the migration lock (the INSERT policy refuses a session without it).
 * Needs scope 'upgrade'. Returns the attempt written.
 */
export async function recordUpgradeMigration(
  query: Query,
  input: { name: string; status: UpgradeMigrationStatus; executedByVersion: string; forced: boolean; error?: unknown },
): Promise<number> {
  const message = input.status === 'failed' ? errorMessageForStorage(input.error ?? 'failed') : null;
  const [row] = (await query(
    `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced)
     SELECT $1, $2, pg_catalog.count(*)::int + 1, $3, $4, false, NULL, $5
       FROM core.upgrade_migration m WHERE m.name = $1 AND m.workspace_id IS NULL
     RETURNING attempt`,
    [input.name, input.status, input.executedByVersion, message, input.forced],
  )) as Array<{ attempt: number }>;
  return Number(row!.attempt);
}

/**
 * B3 adoption: the one instance is_initial row (attempt 1) for an R254 / R256 history. Written only while the logbook has
 * no instance row (checked here, under the lock). Needs scope 'upgrade'. Returns false when a row already existed.
 */
export async function markAsInstanceInitial(query: Query, input: { name: string; executedByVersion: string }): Promise<boolean> {
  if (await hasInstanceRows(query)) return false;
  await query(
    `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced)
     VALUES ($1, 'completed', 1, $2, true, NULL, false)`,
    [input.name, input.executedByVersion],
  );
  return true;
}

/**
 * Twenty :139-172 + `workspace.service.ts:813`: a new workspace's is_initial row, INSIDE the caller's workspace-creation
 * transaction (tenant bound). Sets `rab.upgrade_scope = 'workspace_init'` for the statement pair and clears it again, so the
 * rest of the caller's transaction runs without it. Idempotent (an existing initial row with that name is left alone).
 */
export async function markAsWorkspaceInitial(
  query: Query,
  input: { workspaceId: string; name: string; status: UpgradeMigrationStatus; executedByVersion: string },
): Promise<boolean> {
  await query(SET_SCOPE, ['workspace_init']);
  try {
    const existing = (await query(
      `SELECT 1 FROM core.upgrade_migration m WHERE m.name = $1 AND m.attempt = 1 AND m.workspace_id = $2::uuid AND m.is_initial LIMIT 1`,
      [input.name, input.workspaceId],
    )) as unknown[];
    if (existing.length) return false;
    await query(
      `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced)
       VALUES ($1, $2, 1, $3, true, $4::uuid, false)`,
      [input.name, input.status, input.executedByVersion, input.workspaceId],
    );
    return true;
  } finally {
    await query(SET_SCOPE, ['']);
  }
}

/**
 * Twenty :334-374: the newest instance row among the latest attempts per name, is_initial excluded. Needs scope 'upgrade'
 * or 'status'. Null when there is none.
 */
export async function getLastAttemptedInstanceStep(query: Query): Promise<UpgradeMigrationRow | null> {
  const rows = (await query(
    `SELECT m.name, m.status, m.attempt, m.executed_by_version AS "executedByVersion", m.is_initial AS "isInitial",
            m.forced, m.created_at AS "createdAt"
       FROM core.upgrade_migration m
      WHERE m.workspace_id IS NULL AND NOT m.is_initial
        AND m.attempt = (SELECT pg_catalog.max(x.attempt) FROM core.upgrade_migration x
                          WHERE x.name = m.name AND x.workspace_id IS NULL)
      ORDER BY m.created_at DESC
      LIMIT 1`,
  )) as Array<UpgradeMigrationRow>;
  const r = rows[0];
  return r ? { ...r, attempt: Number(r.attempt), createdAt: new Date(r.createdAt) } : null;
}

/**
 * Workspace creation (ManagerWorkspaceService.createFor), inside its tenant transaction: the new workspace's is_initial row
 * at the code version, named after that version's last step, `completed` (Twenty workspace.service.ts:813; Crewflow has no
 * workspace commands before Part D, so the cursor is the version's last step). No row when the logbook table does not
 * exist yet (a database migrated outside the upgrade path). Lazy import keeps the module graph small.
 */
export async function markNewWorkspaceInitial(query: Query, workspaceId: string): Promise<boolean> {
  if (!(await upgradeLedgerExists(query))) return false;
  const { readAppVersion } = await import('./upgrade-version');
  const { lastStepOfVersion } = await import('./upgrade-sequence');
  const version = readAppVersion();
  return markAsWorkspaceInitial(query, { workspaceId, name: lastStepOfVersion(version), status: 'completed', executedByVersion: version });
}
