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
 * The read / write helpers take a `Query`; the transactions that SET the scope (withUpgradeScope) need an UpgradeSession,
 * i.e. ONE dedicated connection (a TypeORM QueryRunner or a pg client), never a pool (security review L4).
 */
export type Query = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;

/** One dedicated database connection: a TypeORM QueryRunner or a pg (Pool)Client. A DataSource / Pool is refused by type. */
export interface UpgradeSession {
  readonly upgradeSession: true;
  readonly query: Query;
}

export class UpgradeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeSessionError';
  }
}

/**
 * Wraps a dedicated connection. `createQueryRunner?: never` / `connect?: never` keep a DataSource or a pg Pool out at
 * compile time; withUpgradeScope also checks at run time that every statement of its transaction ran on one backend.
 */
export function upgradeSessionOf(conn: {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
  createQueryRunner?: never;
  totalCount?: never;
}): UpgradeSession {
  const query: Query = async (sql, parameters) => {
    const out = (await conn.query(sql, parameters)) as unknown;
    if (Array.isArray(out)) return out;
    const rows = (out as { rows?: unknown[] } | undefined)?.rows;
    return Array.isArray(rows) ? rows : [];
  };
  return { upgradeSession: true, query };
}

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

/** The setting NAME is a bind parameter too (no interpolation in any statement): $1 = UPGRADE_SCOPE_SETTING, $2 = the scope. */
const SET_SCOPE = 'SELECT pg_catalog.set_config($1, $2, true)';
const setScope = (query: Query, value: string) => query(SET_SCOPE, [UPGRADE_SCOPE_SETTING, value]);

/**
 * Runs `fn` in ONE transaction with `rab.upgrade_scope` set for that transaction only, on a DEDICATED session (security
 * review L4): before BEGIN the session must be outside any transaction that holds a transaction id
 * (txid_current_if_assigned() IS NULL), not inside an open transaction at all (transaction_timestamp() =
 * statement_timestamp(): an open read-only transaction has no transaction id but an older start time; review R2), and
 * carry no scope; before COMMIT the same backend must still be there with the
 * same scope, so a pooled connection that hands statements to different backends is refused (rolled back). Commits on
 * success, rolls back on error and rethrows.
 */
export async function withUpgradeScope<T>(session: UpgradeSession, scope: Exclude<UpgradeScope, 'workspace_init'>, fn: (q: Query) => Promise<T>): Promise<T> {
  const query = session.query;
  // Part D fix: this pre-check must be a SIMPLE-protocol query (no bind parameter). With a parameter the driver uses the
  // extended protocol, whose implicit transaction starts at Parse while statement_timestamp() moves at Execute, so `fresh` was
  // false on every call (found by the PG16 ci-db fresh install after ef7f56c0). The setting name is a literal constant.
  const [pre] = (await query(
    `SELECT pg_catalog.txid_current_if_assigned() IS NULL AS free,
            pg_catalog.transaction_timestamp() = pg_catalog.statement_timestamp() AS fresh,
            COALESCE(pg_catalog.current_setting('rab.upgrade_scope', true), '') AS scope,
            pg_catalog.pg_backend_pid() AS pid`,
  )) as Array<{ free: boolean; fresh: boolean; scope: string; pid: number }>;
  if (!pre || pre.free !== true || pre.fresh !== true || pre.scope !== '') {
    throw new UpgradeSessionError('withUpgradeScope needs a dedicated session outside any transaction and with no upgrade scope set. Refusing.');
  }
  await query('BEGIN');
  try {
    await setScope(query, scope);
    const result = await fn(query);
    const [post] = (await query(
      `SELECT pg_catalog.pg_backend_pid() AS pid, COALESCE(pg_catalog.current_setting($1, true), '') AS scope`,
      [UPGRADE_SCOPE_SETTING],
    )) as Array<{ pid: number; scope: string }>;
    if (!post || Number(post.pid) !== Number(pre.pid) || post.scope !== scope) {
      throw new UpgradeSessionError('the upgrade scope transaction did not stay on one backend (a pooled connection?). Rolled back; refusing.');
    }
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
 *
 * The policy's organisation check reads core.manager_workspace under that table's own tenant RLS (visible: the workspace the
 * transaction is bound to, or one the user owns). The creating user is not always the owner (an administrator may create a
 * workspace for a manager), so `rab.workspace_id` is bound to the NEW workspace for the two statements and restored after,
 * exactly as the creating transaction already binds it for the manager_profile write.
 */
async function markAsWorkspaceInitial(
  query: Query,
  input: { workspaceId: string; name: string; status: UpgradeMigrationStatus; executedByVersion: string },
): Promise<boolean> {
  const [prior] = (await query(`SELECT pg_catalog.current_setting('rab.workspace_id', true) AS v`)) as Array<{ v: string | null }>;
  await setScope(query, 'workspace_init');
  await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [input.workspaceId]);
  // Security review L3: restore only after SUCCESS. After a failed statement the transaction is aborted: running the restore
  // there would replace the original error with 25P02, and the caller rolls the transaction back anyway (the settings are
  // transaction-local), so the original error is rethrown untouched.
  let succeeded = false;
  try {
    const existing = (await query(
      `SELECT 1 FROM core.upgrade_migration m WHERE m.name = $1 AND m.attempt = 1 AND m.workspace_id = $2::uuid AND m.is_initial LIMIT 1`,
      [input.name, input.workspaceId],
    )) as unknown[];
    if (existing.length) {
      succeeded = true;
      return false;
    }
    await query(
      `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced)
       VALUES ($1, $2, 1, $3, true, $4::uuid, false)`,
      [input.name, input.status, input.executedByVersion, input.workspaceId],
    );
    succeeded = true;
    return true;
  } finally {
    if (succeeded) {
      await setScope(query, '');
      await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [prior?.v ?? '']);
    }
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

/** The saved core.manager_workspace row createFor just wrote (its entity; never a free-form id). */
export interface SavedWorkspace {
  readonly id: string;
  readonly organisationId: string;
}

/**
 * Workspace creation (ManagerWorkspaceService.createFor), inside its tenant transaction: the new workspace's is_initial row
 * at the code version, named after that version's last step, `completed` (Twenty workspace.service.ts:813; Crewflow has no
 * workspace commands before Part D, so the cursor is the version's last step). Takes the SAVED workspace entity (security
 * review L3) and refuses one whose organisation is not the transaction's bound organisation. No row when the logbook table
 * does not exist yet (a database migrated outside the upgrade path). Lazy import keeps the module graph small.
 */
export async function markNewWorkspaceInitial(query: Query, workspace: SavedWorkspace): Promise<boolean> {
  if (!workspace?.id || !workspace.organisationId) throw new Error('markNewWorkspaceInitial needs the saved workspace entity');
  if (!(await upgradeLedgerExists(query))) return false;
  const [bound] = (await query(`SELECT COALESCE(pg_catalog.current_setting('rab.organisation_id', true), '') AS org`)) as Array<{ org: string }>;
  if (bound?.org !== workspace.organisationId) throw new Error('markNewWorkspaceInitial: the workspace is not in the bound organisation');
  const { readAppVersion } = await import('./upgrade-version');
  const { lastStepOfVersion } = await import('./upgrade-sequence');
  const version = readAppVersion();
  return markAsWorkspaceInitial(query, { workspaceId: workspace.id, name: lastStepOfVersion(version), status: 'completed', executedByVersion: version });
}

/** Of these workspace ids, the ones with no logbook row at all (scope 'upgrade' or 'status'). */
export async function workspacesWithoutRows(query: Query, workspaceIds: readonly string[]): Promise<string[]> {
  if (!workspaceIds.length) return [];
  const rows = (await query(
    `SELECT w.id::text AS id FROM pg_catalog.unnest($1::uuid[]) AS w(id)
      WHERE NOT EXISTS (SELECT 1 FROM core.upgrade_migration m WHERE m.workspace_id = w.id)`,
    [workspaceIds],
  )) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// OWNER-DB-ULTIMATE Part D: per-workspace rows (workspace_id set), read and written by the workspace command runner on the
// LOCKED migration session under scope 'upgrade' (no tenant bound; the instance INSERT policy admits a workspace_id and the
// FK proves the workspace exists). Twenty `upgrade-migration.service.ts` @ eedb0a73.
// ---------------------------------------------------------------------------------------------------------------------

/** A workspace's cursor: its newest logbook row (Twenty :222-282 getWorkspaceLastAttemptedCommandName). */
export interface WorkspaceCursor {
  workspaceId: string;
  name: string;
  status: UpgradeMigrationStatus;
  isInitial: boolean;
  attempt: number;
}

/** Twenty :222-282: the newest row (created_at, then attempt) per workspace. Needs scope 'upgrade' or 'status'. */
export async function getWorkspaceCursors(query: Query, workspaceIds: readonly string[]): Promise<Map<string, WorkspaceCursor>> {
  const out = new Map<string, WorkspaceCursor>();
  if (!workspaceIds.length) return out;
  const rows = (await query(
    `SELECT w.id AS "workspaceId", latest.name, latest.status, latest.is_initial AS "isInitial", latest.attempt
       FROM pg_catalog.unnest($1::uuid[]) AS w(id)
       CROSS JOIN LATERAL (
         SELECT m.name, m.status, m.is_initial, m.attempt FROM core.upgrade_migration m
          WHERE m.workspace_id = w.id
          ORDER BY m.created_at DESC, m.attempt DESC
          LIMIT 1) latest`,
    [workspaceIds],
  )) as Array<{ workspaceId: string; name: string; status: UpgradeMigrationStatus; isInitial: boolean; attempt: number }>;
  for (const r of rows) out.set(r.workspaceId, { ...r, attempt: Number(r.attempt) });
  return out;
}

/**
 * Twenty :51-137 for one workspace (workspace-command-runner.service.ts:130-149): ONE row when a workspace step ends;
 * attempt = previous rows of (name, workspace) + 1 in the same statement (every writer holds the migration lock). Needs scope
 * 'upgrade'. Returns the attempt written.
 */
export async function recordWorkspaceUpgradeMigration(
  query: Query,
  input: { name: string; workspaceId: string; status: UpgradeMigrationStatus; executedByVersion: string; forced: boolean; error?: unknown },
): Promise<number> {
  const message = input.status === 'failed' ? errorMessageForStorage(input.error ?? 'failed') : null;
  const [row] = (await query(
    `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced)
     SELECT $1, $2, pg_catalog.count(*)::int + 1, $3, $4, false, $5::uuid, $6
       FROM core.upgrade_migration m WHERE m.name = $1 AND m.workspace_id = $5::uuid
     RETURNING attempt`,
    [input.name, input.status, input.executedByVersion, message, input.workspaceId, input.forced],
  )) as Array<{ attempt: number }>;
  return Number(row!.attempt);
}

/**
 * Part D adoption: the ONE is_initial row (attempt 1, completed, not forced) of an existing workspace that has NO logbook row
 * at all, written in one statement (idempotent: nothing when any row of the workspace exists). Needs scope 'upgrade'.
 * Returns whether a row was written.
 */
export async function adoptWorkspaceInitial(query: Query, input: { workspaceId: string; name: string; executedByVersion: string }): Promise<boolean> {
  const rows = (await query(
    `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced)
     SELECT $1, 'completed', 1, $2, true, $3::uuid, false
      WHERE NOT EXISTS (SELECT 1 FROM core.upgrade_migration m WHERE m.workspace_id = $3::uuid)
     RETURNING attempt`,
    [input.name, input.executedByVersion, input.workspaceId],
  )) as unknown[];
  return rows.length === 1;
}

/**
 * For the status read (scope 'status'): how many workspaces have a FAILED cursor, whatever the step (security review M4: a
 * failed step of an earlier version, e.g. left behind by --force, counts too). Never a workspace id or a message.
 */
export async function countFailedWorkspaceCursors(query: Query): Promise<number> {
  const [row] = (await query(
    `SELECT pg_catalog.count(*)::int AS n FROM (
       SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.name, m.status
         FROM core.upgrade_migration m
        WHERE m.workspace_id IS NOT NULL
        ORDER BY m.workspace_id, m.created_at DESC, m.attempt DESC) c
      WHERE c.status = 'failed'`,
  )) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}
