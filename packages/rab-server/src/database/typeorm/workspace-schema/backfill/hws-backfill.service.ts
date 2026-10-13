import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { SchemaResolverService, WorkspaceRoutingError } from '../../../../engine/core-modules/tenant/schema-resolver.service';
import { WORKSPACE_TABLES } from '../provision-workspace-schema';
import { WORKSPACE_TABLE_COPY_ORDER } from './fk-graph';
import { resolveUserNoteWorkspace } from './user-note-mapping';

export type BackfillMode = 'dry-run' | 'apply' | 'verify';

/**
 * Three of the 15 workspace tables are pure junction tables with a COMPOSITE primary key and no
 * `id` column at all (`venue_manager_staff`, `manager_venue`, `shift_request_staff` — consistent
 * with their raw-SQL-only, no-entity status per Part 1's classification): confirmed directly
 * against the live catalog, not assumed. `rowKey` below is this engine's one place that knows how
 * to identify a row for comparison/conflict-detection purposes on EITHER shape, so every other
 * method can stay table-shape-agnostic.
 */
const COMPOSITE_KEY_TABLES: Readonly<Record<string, readonly string[]>> = {
  venue_manager_staff: ['manager_profile_id', 'staff_profile_id'],
  manager_venue: ['manager_profile_id', 'venue_id'],
  shift_request_staff: ['shift_id', 'staff_profile_id'],
};

function rowKey(table: string, row: Record<string, unknown>): string {
  const compositeCols = COMPOSITE_KEY_TABLES[table];
  if (!compositeCols) return String(row.id);
  return compositeCols.map((col) => String(row[col])).join('\u0000');
}

export interface WorkspaceCandidate {
  workspaceId: string;
  organisationId: string;
}

export interface TableDryRunReport {
  table: string;
  sourceRowCount: number;
  targetRowCount: number;
  alreadyCopied: number;
  toCopy: number;
  conflicts: number;
  blocked: number;
  missingCoreFkTargets: number;
}

export interface WorkspaceDryRunReport {
  organisationId: string;
  workspaceId: string;
  registryStatus: 'MISSING' | 'NOT_READY' | 'UNSUPPORTED_VERSION' | 'READY';
  schemaName: string | null;
  schemaVersion: number | null;
  needsProvisioning: boolean;
  copyOrder: string[];
  tables: TableDryRunReport[];
  safeToApply: boolean;
  unsupportedConditions: string[];
}

export interface TableApplyResult {
  table: string;
  state: 'completed' | 'failed' | 'blocked' | 'skipped-already-complete';
  rowsCopied: number;
  alreadyPresent: number;
  conflicts: Array<{ id: string; category: string }>;
  blockedRows?: Array<{ id: string; reason: string }>;
  safeError?: string;
}

export interface WorkspaceApplyResult {
  organisationId: string;
  workspaceId: string;
  schemaName: string;
  tables: TableApplyResult[];
  overall: 'completed' | 'partial' | 'failed';
}

export interface TableVerifyResult {
  table: string;
  pass: boolean;
  sourceRowCount: number;
  targetRowCount: number;
  missingIds: string[];
  foreignWorkspaceRows: number;
  reasons: string[];
}

export interface WorkspaceVerifyResult {
  organisationId: string;
  workspaceId: string;
  pass: boolean;
  registryReady: boolean;
  schemaVersionSupported: boolean;
  tables: TableVerifyResult[];
}

/** `core` column names for each of the 14 workspace tables that already carry `workspace_id` in `core` (everything except `user_note` — see `user-note-mapping.ts`). */
const DIRECT_WORKSPACE_COLUMN_TABLES = WORKSPACE_TABLES.filter((t) => t !== 'user_note');

export class HwsBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwsBackfillError';
  }
}

/**
 * HWS backfill engine (Parts 2-19 of the backfill brief). Runs entirely as `crewflow` (the runtime role since the Crewflow single-credential cutover) — no
 * `rab_owner` connection anywhere in this class. Two deliberately-separate transaction helpers,
 * neither of which goes through `TenantContextService`, because this tool's job is explicitly NOT
 * subject to `HWS_RUNTIME_ENABLED`'s current value in whatever environment it runs:
 *   - `readCore` always binds `search_path = 'core'` — the backfill SOURCE is categorically the
 *     legacy table, regardless of global routing mode.
 *   - `writePhysical` always resolves and binds the workspace's PHYSICAL schema via
 *     `SchemaResolverService` (fail-closed: missing/not-READY/unsupported-version all refuse) —
 *     the backfill TARGET is categorically the physical schema, never `core`, regardless of mode.
 * Workspace discovery goes through `core.worker_list_workspaces()`, the same narrow,
 * `crewflow`-granted SECURITY DEFINER function the worker's own `discoverInWorkspaces` already uses
 * — no new discovery mechanism, no arbitrary cross-tenant read.
 *
 * All READS (legacy `core` rows, the physical schema's own rows for comparison/verification) run
 * as `crewflow` with `rab.actor_type='worker'` bound — the exact same bypass the worker's own
 * `staff_profile_worker_scan`-style policies exist for (confirmed empirically: `staff_profile`'s
 * normal SELECT policy requires either owning the profile or being a manager who owns the
 * workspace — neither holds for a maintenance tool with no human actor behind it — so without this
 * binding the tool would silently see zero rows on several tables, not an error).
 *
 * The actual physical-schema WRITE (`insertRows`) is the one place this tool needs `rab_owner`
 * (`ownerDataSource`, set by the command — same optional-settable-property pattern
 * `StorageReconcileCommand.catalogueDataSource` already uses). Reason, concretely: Part 7 requires
 * preserving each row's ORIGINAL attribution (`created_by`, `requested_by`, ...) — this is a
 * historical copy, not a new write by a current actor — and the normal `..._insert` WITH CHECK
 * policies on these tables are designed around exactly the opposite case ("the current session is
 * the one performing this write"), e.g. `staff_profile_insert` requires `workspace_id IN (SELECT
 * mp.workspace_id FROM manager_profile mp WHERE mp.user_id = current_uid() ...)` — a real, current
 * manager identity this tool has no business asserting. RLS stays ENABLED and FORCED throughout
 * (GUCs are bound exactly as for any other write — see `writePhysical`); only the connecting ROLE
 * differs, the same precedent `BootstrapAdminCommand`/`account-invite-cleanup.job.ts`/
 * `provisionWorkspaceSchema` itself already establish for privileged maintenance writes that can't
 * authentically claim to be the row's own actor.
 */
@Injectable()
export class HwsBackfillService {
  /** Set by the command before any `apply()` call — never DI-injected, the same pattern `StorageReconcileCommand.catalogueDataSource` uses. `dryRun`/`verify` never need it (read-only). */
  ownerDataSource?: DataSource;

  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaResolver: SchemaResolverService,
  ) {}

  // ---------------------------------------------------------------- discovery

  /** Pages `core.worker_list_workspaces` to find one workspace id. Never trusts a caller-supplied organisationId — returns the trusted one from the registry-backed function. */
  async findCandidate(workspaceId: string): Promise<WorkspaceCandidate | null> {
    let after: string | null = null;
    for (;;) {
      const page: Array<{ workspace_id: string; organisation_id: string }> = await this.dataSource.transaction(async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        return manager.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [after, 100]);
      });
      if (!page.length) return null;
      const hit = page.find((row) => row.workspace_id === workspaceId);
      if (hit) return { workspaceId: hit.workspace_id, organisationId: hit.organisation_id };
      after = page[page.length - 1]!.workspace_id;
    }
  }

  /** Lists up to `limit` candidates, for `--all`/bounded-batch runs. */
  async listCandidates(limit: number): Promise<WorkspaceCandidate[]> {
    const result: WorkspaceCandidate[] = [];
    let after: string | null = null;
    while (result.length < limit) {
      const page: Array<{ workspace_id: string; organisation_id: string }> = await this.dataSource.transaction(async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        return manager.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [after, 100]);
      });
      if (!page.length) break;
      for (const row of page) {
        if (result.length >= limit) break;
        result.push({ workspaceId: row.workspace_id, organisationId: row.organisation_id });
      }
      after = page[page.length - 1]!.workspace_id;
    }
    return result;
  }

  // ---------------------------------------------------------------- transaction helpers

  /** `crewflow`, `rab.actor_type='worker'` bound (see class doc comment), `search_path='core'`. Read-only in spirit (every caller only ever SELECTs here) though not DB-enforced read-only, to allow the checkpoint table's INSERT/UPDATE to share this same helper. */
  private async readCore<T>(ctx: WorkspaceCandidate, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true), set_config('rab.role', '', true), set_config('rab.actor_type', 'worker', true)`,
        [ctx.organisationId, ctx.workspaceId],
      );
      await manager.query(`SELECT set_config('search_path', 'core', true)`);
      return fn(manager);
    });
  }

  /** `crewflow`, `rab.actor_type='worker'` bound, resolved physical schema — READ ONLY (`SET TRANSACTION READ ONLY`), for comparison/verification reads of the target schema's own rows. Fails closed exactly like `runInWorkspaceContext` (same resolver, same guarantee). */
  private async readPhysical<T>(ctx: WorkspaceCandidate, fn: (manager: EntityManager, schema: string) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      await manager.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true), set_config('rab.role', '', true), set_config('rab.actor_type', 'worker', true)`,
        [ctx.organisationId, ctx.workspaceId],
      );
      const schema = await this.schemaResolver.resolve(manager, ctx.workspaceId);
      await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
      return fn(manager, schema);
    });
  }

  /**
   * `rab_owner` (`this.ownerDataSource`, required — see class doc comment for exactly why). GUCs
   * bound identically to `readPhysical`, PLUS `rab.user_id` bound to the workspace's own owning
   * manager (`core.manager_workspace.owner_user_id` — a NOT_FORCED core table, trivially readable
   * here even with GUCs bound). This is not a new authority being asserted: several per-table
   * `..._insert` WITH CHECK policies (confirmed empirically for `staff_profile`: FORCE RLS applies
   * the ownership check even to `rab_owner`) require `workspace_id IN (SELECT ... WHERE
   * mp.user_id = current_uid() ...)` — the workspace's rightful owning manager IS exactly the one
   * identity that check is designed to authorize, so binding it here correctly satisfies the
   * existing policy rather than weakening it. The copied row's own `created_by`/`requested_by`/
   * etc. columns keep their ORIGINAL historical values regardless — this GUC only affects which
   * policy predicate passes, never what the inserted row itself says.
   */
  private async writePhysical<T>(ctx: WorkspaceCandidate, fn: (manager: EntityManager, schema: string) => Promise<T>): Promise<T> {
    if (!this.ownerDataSource) throw new HwsBackfillError('writePhysical requires an owner connection (HwsBackfillService.ownerDataSource was never set) — refusing rather than guessing a role.');
    return this.ownerDataSource.transaction(async (manager) => {
      const [owner] = await manager.query<Array<{ owner_user_id: string }>>(`SELECT owner_user_id FROM core.manager_workspace WHERE id = $1`, [ctx.workspaceId]);
      if (!owner) throw new HwsBackfillError(`workspace ${ctx.workspaceId}: no core.manager_workspace row found — cannot determine its owning manager.`);
      await manager.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', '', true)`,
        [ctx.organisationId, ctx.workspaceId, owner.owner_user_id],
      );
      const schema = await this.schemaResolver.resolve(manager, ctx.workspaceId);
      await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
      return fn(manager, schema);
    });
  }

  private async resolveTargetStatus(
    ctx: WorkspaceCandidate,
  ): Promise<{ status: WorkspaceDryRunReport['registryStatus']; schemaName: string | null; schemaVersion: number | null }> {
    return this.readCore(ctx, async (manager) => {
      const rows: Array<{ schema_name: string; status: string; schema_version: number }> = await manager.query(
        `SELECT schema_name, status, schema_version FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [ctx.workspaceId],
      );
      if (rows.length !== 1) return { status: 'MISSING', schemaName: null, schemaVersion: null };
      const row = rows[0]!;
      try {
        await this.schemaResolver.resolve(manager, ctx.workspaceId);
        return { status: 'READY', schemaName: row.schema_name, schemaVersion: row.schema_version };
      } catch (error) {
        if (error instanceof WorkspaceRoutingError && error.code === 'unsupported-version') {
          return { status: 'UNSUPPORTED_VERSION', schemaName: row.schema_name, schemaVersion: row.schema_version };
        }
        return { status: 'NOT_READY', schemaName: row.schema_name, schemaVersion: row.schema_version };
      }
    });
  }

  // ---------------------------------------------------------------- dry run (Part 5)

  async dryRun(ctx: WorkspaceCandidate): Promise<WorkspaceDryRunReport> {
    const target = await this.resolveTargetStatus(ctx);
    const unsupportedConditions: string[] = [];
    if (target.status !== 'READY') unsupportedConditions.push(`registry status is ${target.status}, not READY`);

    const tables: TableDryRunReport[] = [];
    for (const table of WORKSPACE_TABLE_COPY_ORDER) {
      const sourceRowCount = await this.countSourceRows(ctx, table);
      let targetRowCount = 0;
      let alreadyCopied = 0;
      let conflicts = 0;
      if (target.status === 'READY') {
        const comparison = await this.compareRows(ctx, table);
        targetRowCount = comparison.targetRowCount;
        alreadyCopied = comparison.alreadyCopied;
        conflicts = comparison.conflicts.length;
      }
      let blocked = 0;
      let missingCoreFkTargets = 0;
      if (table === 'user_note') {
        const mapping = await this.previewUserNoteMapping(ctx);
        blocked = mapping.blocked;
      }
      tables.push({
        table,
        sourceRowCount,
        targetRowCount,
        alreadyCopied,
        toCopy: Math.max(0, sourceRowCount - alreadyCopied - blocked),
        conflicts,
        blocked,
        missingCoreFkTargets,
      });
      if (conflicts > 0) unsupportedConditions.push(`${table} has ${conflicts} conflicting row(s) between core and the physical schema`);
      if (blocked > 0) unsupportedConditions.push(`user_note has ${blocked} row(s) that cannot be mapped to exactly one workspace`);
    }

    return {
      organisationId: ctx.organisationId,
      workspaceId: ctx.workspaceId,
      registryStatus: target.status,
      schemaName: target.schemaName,
      schemaVersion: target.schemaVersion,
      needsProvisioning: target.status !== 'READY',
      copyOrder: [...WORKSPACE_TABLE_COPY_ORDER],
      tables,
      safeToApply: unsupportedConditions.length === 0,
      unsupportedConditions,
    };
  }

  private async countSourceRows(ctx: WorkspaceCandidate, table: string): Promise<number> {
    return this.readCore(ctx, async (manager) => {
      if (table === 'user_note') {
        const [{ n }] = await manager.query<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM core.user_note n
             WHERE n.subject_user_id IN (
               SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
               UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
             )`,
          [ctx.workspaceId],
        );
        return n;
      }
      const [{ n }] = await manager.query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM core.${table} WHERE workspace_id = $1`, [ctx.workspaceId]);
      return n;
    });
  }

  private async previewUserNoteMapping(ctx: WorkspaceCandidate): Promise<{ blocked: number }> {
    return this.readCore(ctx, async (manager) => {
      const rows: Array<{ id: string; subject_user_id: string }> = await manager.query(
        `SELECT n.id, n.subject_user_id FROM core.user_note n
           WHERE n.subject_user_id IN (
             SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
             UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
           )`,
        [ctx.workspaceId],
      );
      let blocked = 0;
      for (const row of rows) {
        const mapping = await resolveUserNoteWorkspace(manager, row.subject_user_id);
        if (!mapping.ok || mapping.workspaceId !== ctx.workspaceId) blocked += 1;
      }
      return { blocked };
    });
  }

  /** Reads source rows (core) and target rows (physical) for `table`, classifies each source id as already-copied (business-equivalent), conflicting (same id, different data), or new. */
  private async compareRows(
    ctx: WorkspaceCandidate,
    table: string,
  ): Promise<{ sourceRows: Record<string, unknown>[]; targetRowCount: number; alreadyCopied: number; conflicts: Array<{ id: string }>; toInsert: Record<string, unknown>[] }> {
    const sourceRows =
      table === 'user_note'
        ? await this.readCore(ctx, (manager) =>
            manager.query<Record<string, unknown>[]>(
              `SELECT n.* FROM core.user_note n
                 WHERE n.subject_user_id IN (
                   SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
                   UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
                 )`,
              [ctx.workspaceId],
            ),
          )
        : await this.readCore(ctx, (manager) => manager.query<Record<string, unknown>[]>(`SELECT * FROM core.${table} WHERE workspace_id = $1`, [ctx.workspaceId]));

    const targetRows = await this.readPhysical(ctx, (manager) => manager.query<Record<string, unknown>[]>(`SELECT * FROM "${table}"`));
    const targetByKey = new Map(targetRows.map((r) => [rowKey(table, r), r]));

    let alreadyCopied = 0;
    const conflicts: Array<{ id: string }> = [];
    const toInsert: Record<string, unknown>[] = [];
    for (const row of sourceRows) {
      const key = rowKey(table, row);
      const existing = targetByKey.get(key);
      if (!existing) {
        toInsert.push(row);
        continue;
      }
      if (rowsBusinessEquivalent(row, existing, table)) {
        alreadyCopied += 1;
      } else {
        conflicts.push({ id: key });
      }
    }
    return { sourceRows, targetRowCount: targetRows.length, alreadyCopied, conflicts, toInsert };
  }

  // ---------------------------------------------------------------- apply (Parts 7, 9, 10, 14, 15)

  async apply(ctx: WorkspaceCandidate): Promise<WorkspaceApplyResult> {
    // Fail fast on a service MISCONFIGURATION (never attempted — this is a programmer/caller
    // error, not a per-workspace data problem) rather than let it surface as a confusing
    // per-table 'failed' result once `writePhysical` is finally reached for the first table.
    if (!this.ownerDataSource) throw new HwsBackfillError('apply() requires HwsBackfillService.ownerDataSource to be set first — refusing rather than guessing a role.');

    const target = await this.resolveTargetStatus(ctx);
    if (target.status !== 'READY' || !target.schemaName) {
      throw new HwsBackfillError(`workspace ${ctx.workspaceId}: registry status is ${target.status}, not READY — provision it first, this tool never auto-provisions`);
    }

    const tables: TableApplyResult[] = [];
    for (const table of WORKSPACE_TABLE_COPY_ORDER) {
      const checkpoint = await this.readCheckpoint(ctx, table);
      if (checkpoint?.state === 'completed') {
        tables.push({ table, state: 'skipped-already-complete', rowsCopied: checkpoint.rows_copied, alreadyPresent: checkpoint.rows_copied, conflicts: [] });
        continue;
      }
      const result = await this.applyTable(ctx, table);
      tables.push(result);
      if (result.state === 'failed') break; // later tables depend on this one via the FK copy order — stop, don't guess
    }

    const overall: WorkspaceApplyResult['overall'] = tables.some((t) => t.state === 'failed')
      ? 'failed'
      : tables.every((t) => t.state === 'completed' || t.state === 'skipped-already-complete')
        ? 'completed'
        : 'partial';
    return { organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, schemaName: target.schemaName, tables, overall };
  }

  private async applyTable(ctx: WorkspaceCandidate, table: string): Promise<TableApplyResult> {
    await this.writeCheckpoint(ctx, table, { state: 'in_progress', startedAt: new Date() });

    if (table === 'user_note') {
      return this.applyUserNoteTable(ctx);
    }

    try {
      const { toInsert, conflicts, alreadyCopied } = await this.compareRows(ctx, table);
      if (conflicts.length > 0) {
        const safeError = `${conflicts.length} row(s) conflict between core and the physical schema (same id, different data)`;
        await this.writeCheckpoint(ctx, table, { state: 'failed', lastSafeError: safeError });
        return { table, state: 'failed', rowsCopied: 0, alreadyPresent: alreadyCopied, conflicts: conflicts.map((c) => ({ id: c.id, category: 'id-exists-different-data' })), safeError };
      }

      let rowsCopied = 0;
      if (toInsert.length > 0) {
        rowsCopied = await this.writePhysical(ctx, async (manager) => insertRows(manager, table, toInsert));
      }
      await this.writeCheckpoint(ctx, table, { state: 'completed', rowsCopied: rowsCopied + alreadyCopied, completedAt: new Date() });
      return { table, state: 'completed', rowsCopied, alreadyPresent: alreadyCopied, conflicts: [] };
    } catch (error) {
      const safeError = error instanceof Error ? error.constructor.name : 'unknown_error';
      await this.writeCheckpoint(ctx, table, { state: 'failed', lastSafeError: safeError });
      return { table, state: 'failed', rowsCopied: 0, alreadyPresent: 0, conflicts: [], safeError };
    }
  }

  private async applyUserNoteTable(ctx: WorkspaceCandidate): Promise<TableApplyResult> {
    const sourceRows = await this.readCore(ctx, (manager) =>
      manager.query<Record<string, unknown>[]>(
        `SELECT n.* FROM core.user_note n
           WHERE n.subject_user_id IN (
             SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
             UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
           )`,
        [ctx.workspaceId],
      ),
    );

    const blockedRows: Array<{ id: string; reason: string }> = [];
    const mappable: Record<string, unknown>[] = [];
    await this.readCore(ctx, async (manager) => {
      for (const row of sourceRows) {
        const mapping = await resolveUserNoteWorkspace(manager, String(row.subject_user_id));
        if (!mapping.ok) {
          blockedRows.push({ id: String(row.id), reason: mapping.reason });
        } else if (mapping.workspaceId !== ctx.workspaceId) {
          blockedRows.push({ id: String(row.id), reason: 'maps-to-different-workspace' });
        } else {
          mappable.push({ ...row, workspace_id: mapping.workspaceId });
        }
      }
    });

    if (blockedRows.length > 0) {
      await this.writeCheckpoint(ctx, 'user_note', {
        state: 'blocked',
        lastSafeError: `${blockedRows.length} row(s) could not be mapped to exactly this workspace — refusing user_note for this workspace (Part 15)`,
      });
      return { table: 'user_note', state: 'blocked', rowsCopied: 0, alreadyPresent: 0, conflicts: [], blockedRows };
    }

    const targetRows = await this.readPhysical(ctx, (manager) => manager.query<Record<string, unknown>[]>(`SELECT * FROM "user_note"`));
    const targetById = new Map(targetRows.map((r) => [String(r.id), r]));
    const toInsert = mappable.filter((r) => !targetById.has(String(r.id)));
    const conflicts: Array<{ id: string }> = [];
    for (const row of mappable) {
      const existing = targetById.get(String(row.id));
      if (existing && !rowsBusinessEquivalent(row, existing, 'user_note')) conflicts.push({ id: String(row.id) });
    }
    if (conflicts.length > 0) {
      const safeError = `${conflicts.length} row(s) conflict between core and the physical schema`;
      await this.writeCheckpoint(ctx, 'user_note', { state: 'failed', lastSafeError: safeError });
      return { table: 'user_note', state: 'failed', rowsCopied: 0, alreadyPresent: 0, conflicts: conflicts.map((c) => ({ id: c.id, category: 'id-exists-different-data' })), safeError };
    }

    const rowsCopied = toInsert.length > 0 ? await this.writePhysical(ctx, (manager) => insertRows(manager, 'user_note', toInsert)) : 0;
    await this.writeCheckpoint(ctx, 'user_note', { state: 'completed', rowsCopied: rowsCopied + (mappable.length - toInsert.length), completedAt: new Date() });
    return { table: 'user_note', state: 'completed', rowsCopied, alreadyPresent: mappable.length - toInsert.length, conflicts: [] };
  }

  // ---------------------------------------------------------------- verify (Part 13)

  async verify(ctx: WorkspaceCandidate): Promise<WorkspaceVerifyResult> {
    const target = await this.resolveTargetStatus(ctx);
    const registryReady = target.status === 'READY';
    const schemaVersionSupported = target.schemaVersion === 1;

    const tables: TableVerifyResult[] = [];
    if (registryReady) {
      for (const table of WORKSPACE_TABLE_COPY_ORDER) {
        tables.push(await this.verifyTable(ctx, table));
      }
    }

    const pass = registryReady && schemaVersionSupported && tables.every((t) => t.pass);
    return { organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, pass, registryReady, schemaVersionSupported, tables };
  }

  private async verifyTable(ctx: WorkspaceCandidate, table: string): Promise<TableVerifyResult> {
    const sourceRowCount = await this.countSourceRows(ctx, table);
    const sourceRows: Record<string, unknown>[] =
      table === 'user_note'
        ? await this.readCore(ctx, (manager) =>
            manager.query<Record<string, unknown>[]>(
              `SELECT n.* FROM core.user_note n
                 WHERE n.subject_user_id IN (
                   SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
                   UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
                 )`,
              [ctx.workspaceId],
            ),
          )
        : await this.readCore(ctx, (manager) => manager.query<Record<string, unknown>[]>(`SELECT * FROM core.${table} WHERE workspace_id = $1`, [ctx.workspaceId]));
    const sourceKeys = sourceRows.map((r) => rowKey(table, r));

    // SELECT *, not SELECT id — 3 of the 15 tables (see COMPOSITE_KEY_TABLES) have no `id` column.
    const targetRows = await this.readPhysical(ctx, (manager) => manager.query<Record<string, unknown>[]>(`SELECT * FROM "${table}"`));
    const targetKeys = new Set(targetRows.map((r) => rowKey(table, r)));
    const missingIds = sourceKeys.filter((key) => !targetKeys.has(key));
    const foreignWorkspaceRows = targetRows.filter((r) => String(r.workspace_id) !== ctx.workspaceId).length;

    const reasons: string[] = [];
    if (missingIds.length > 0) reasons.push(`${missingIds.length} source row(s) not found in the physical schema`);
    if (foreignWorkspaceRows > 0) reasons.push(`${foreignWorkspaceRows} row(s) in the physical schema belong to a DIFFERENT workspace_id`);

    return { table, pass: reasons.length === 0, sourceRowCount, targetRowCount: targetRows.length, missingIds, foreignWorkspaceRows, reasons };
  }

  // ---------------------------------------------------------------- checkpoint (Part 17)

  private async readCheckpoint(ctx: WorkspaceCandidate, table: string): Promise<{ state: string; rows_copied: number } | null> {
    return this.readCoreCheckpoint(ctx, async (manager) => {
      const rows: Array<{ state: string; rows_copied: number }> = await manager.query(
        `SELECT state, rows_copied FROM core.hws_backfill_checkpoint WHERE workspace_id = $1 AND table_name = $2`,
        [ctx.workspaceId, table],
      );
      return rows[0] ?? null;
    });
  }

  private async writeCheckpoint(
    ctx: WorkspaceCandidate,
    table: string,
    fields: { state: string; rowsCopied?: number; startedAt?: Date; completedAt?: Date; lastSafeError?: string },
  ): Promise<void> {
    await this.readCoreCheckpoint(ctx, (manager) =>
      manager.query(
        `INSERT INTO core.hws_backfill_checkpoint (organisation_id, workspace_id, table_name, state, rows_copied, started_at, completed_at, last_safe_error, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6, $7, $8, now())
         ON CONFLICT (workspace_id, table_name) DO UPDATE SET
           state = EXCLUDED.state,
           rows_copied = CASE WHEN $5 IS NULL THEN core.hws_backfill_checkpoint.rows_copied ELSE EXCLUDED.rows_copied END,
           started_at = COALESCE(core.hws_backfill_checkpoint.started_at, EXCLUDED.started_at),
           completed_at = EXCLUDED.completed_at,
           last_safe_error = EXCLUDED.last_safe_error,
           updated_at = now()`,
        [ctx.organisationId, ctx.workspaceId, table, fields.state, fields.rowsCopied ?? null, fields.startedAt ?? null, fields.completedAt ?? null, fields.lastSafeError ?? null],
      ),
    );
  }

  /** The checkpoint table lives in `core` and is always read/written with `search_path='core'` — reuses the same read-core transaction helper, never the physical-schema one. */
  private async readCoreCheckpoint<T>(ctx: WorkspaceCandidate, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.readCore(ctx, fn);
  }
}

/** Builds and executes one parameterised multi-row INSERT from already-fetched `core` rows, into the physical schema's table (unquoted — `manager`'s `search_path` is already bound to exactly that one schema). Column list comes from the rows themselves (`SELECT *` from `core`), so every column — ids, timestamps, statuses, business references — copies as-is; nothing is regenerated or reinterpreted (Part 7). */
async function insertRows(manager: EntityManager, table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]!);
  const values: unknown[] = [];
  const valueRows: string[] = [];
  for (const row of rows) {
    const placeholders: string[] = [];
    for (const col of columns) {
      values.push(row[col]);
      placeholders.push(`$${values.length}`);
    }
    valueRows.push(`(${placeholders.join(',')})`);
  }
  await manager.query(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES ${valueRows.join(',')}`, values);
  return rows.length;
}

/** Part 10's conflict check: are these two rows (same `id`, one from `core`, one from the physical schema) the same business row? Deep, column-by-column equality — not a hash, so a mismatch can be reported precisely if ever needed. `updated_at` is excluded: a row touched by an unrelated `ON UPDATE` trigger bump after an earlier, partial copy attempt must not be treated as a real conflict. */
function rowsBusinessEquivalent(a: Record<string, unknown>, b: Record<string, unknown>, _table: string): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('updated_at');
  for (const key of keys) {
    const av = a[key] instanceof Date ? (a[key] as Date).toISOString() : a[key];
    const bv = b[key] instanceof Date ? (b[key] as Date).toISOString() : b[key];
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
  }
  return true;
}

export { DIRECT_WORKSPACE_COLUMN_TABLES };
