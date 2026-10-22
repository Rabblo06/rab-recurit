import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { SchemaResolverService, WorkspaceRoutingError } from '../../../../engine/core-modules/tenant/schema-resolver.service';
import { WORKSPACE_TABLES } from '../provision-workspace-schema';
import { WORKSPACE_TABLE_COPY_ORDER } from './fk-graph';
import { PRIVILEGED_COPY_AUDIT_ACTION, PRIVILEGED_COPY_ORDER } from './privileged-copy';
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
  /** Who writes this table's rows: this tool, or the one-off privileged migration (PRIVILEGED_COPY_TABLES). */
  copiedBy: 'tool' | 'privileged-migration';
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
  /** `deferred-to-privileged-copy`: the table has source rows this tool must not write (see PRIVILEGED_COPY_TABLES). */
  state: 'completed' | 'failed' | 'blocked' | 'skipped-already-complete' | 'deferred-to-privileged-copy';
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
  /** Rows this tool can SEE in core under its bound identity. */
  sourceRowCount: number;
  /** Authoritative count recorded by the privileged census (migration identity, RLS-exempt); null when no census exists. */
  trueRowCount: number | null;
  targetRowCount: number;
  missingIds: string[];
  /** Same key in core and the physical schema, but the FULL row (every column, full timestamp precision) differs. */
  differentIds: string[];
  /** Keys present in the physical schema that are not in core for this workspace. */
  extraIds: string[];
  foreignWorkspaceRows: number;
  reasons: string[];
}

/**
 * Tables whose RUNTIME-ACTOR insert policies cannot accept historical rows (owner decision 2026-10-22, Option 1):
 * `shift_staff_review` requires `reviewer_user_id = current_uid()` and `payroll_record` requires `status =
 * 'pending_approval'`, so a historical review written by someone else or an already-approved payroll row can never be
 * written by this tool without inventing authority. The whole payroll family is kept together (its only FK children are
 * inside the family). These are copied ONLY by the one-off privileged migration
 * `HwsHistoricalRowsPrivilegedCopy1786719520000` (guarded runner, migration identity, no policy/grant/GUC change); this
 * tool never writes them, reports them `deferred-to-privileged-copy`, and still VERIFIES them.
 */
export const PRIVILEGED_COPY_TABLES: readonly string[] = PRIVILEGED_COPY_ORDER;

/** audit_log action the privileged copy writes per workspace; its metadata carries the authoritative per-table counts. */
export const HWS_PRIVILEGED_COPY_AUDIT_ACTION = PRIVILEGED_COPY_AUDIT_ACTION;

/** One row read as canonical jsonb TEXT (never through JS Date/number), so nothing loses precision on the way through. */
interface JsonRow {
  key: string;
  /** `to_jsonb(row)::text` — every column, full precision. */
  full: string;
  /** Same without `updated_at` (the apply-time conflict check's long-standing rule). */
  cmp: string;
  workspaceId: string | null;
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
      await this.bindReadIdentity(manager, ctx);
      await manager.query(`SELECT set_config('search_path', 'core', true)`);
      return fn(manager);
    });
  }

  /**
   * Read identity for BOTH sides of the comparison (2026-10-22 under-count fix): the worker binding
   * (`actor_type='worker'`, for the `*_worker_scan` policies) PLUS the workspace's own owning manager as `rab.user_id` —
   * the identity `writePhysical` already asserts. Found on a restored copy of the dev database: with no user bound,
   * `venue_manager_staff` (no worker-scan policy; visible to the workspace OWNER via `venue_manager_staff_owner`) read as
   * 0 rows, so 15 rows were silently never copied and the old verify passed. Every policy here is PERMISSIVE (none is
   * RESTRICTIVE — checked), so binding the owner can only ADD visibility, never hide a row. No policy, grant or GUC
   * semantics change. The true count is still cross-checked against the privileged census in `verifyTable`.
   */
  private async bindReadIdentity(manager: EntityManager, ctx: WorkspaceCandidate): Promise<void> {
    await manager.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true), set_config('rab.role', '', true), set_config('rab.actor_type', 'worker', true)`,
      [ctx.organisationId, ctx.workspaceId],
    );
    // Visible through manager_workspace_member (`id = current_workspace()`), bound just above.
    const [owner] = await manager.query<Array<{ owner_user_id: string }>>(`SELECT owner_user_id FROM core.manager_workspace WHERE id = $1`, [ctx.workspaceId]);
    if (!owner) throw new HwsBackfillError(`workspace ${ctx.workspaceId}: no core.manager_workspace row found — cannot determine its owning manager.`);
    await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [owner.owner_user_id]);
  }

  /** Source rows (core) for `table` as canonical jsonb text. user_note gets the mapped workspace_id merged in by the caller. */
  private async readSourceJson(ctx: WorkspaceCandidate, table: string): Promise<JsonRow[]> {
    const sql =
      table === 'user_note'
        ? `SELECT to_jsonb(n)::text AS full_json, (to_jsonb(n) - 'updated_at')::text AS cmp_json FROM core.user_note n
             WHERE n.subject_user_id IN (
               SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
               UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
             )`
        : `SELECT to_jsonb(t)::text AS full_json, (to_jsonb(t) - 'updated_at')::text AS cmp_json FROM core.${table} t WHERE t.workspace_id = $1`;
    const rows = await this.readCore(ctx, (manager) => manager.query<Array<{ full_json: string; cmp_json: string }>>(sql, [ctx.workspaceId]));
    return rows.map((r) => toJsonRow(table, r.full_json, r.cmp_json));
  }

  /** Target rows (the workspace's physical schema) as canonical jsonb text. For user_note the source side is compared with the workspace_id merged in. */
  private async readTargetJson(ctx: WorkspaceCandidate, table: string): Promise<JsonRow[]> {
    const rows = await this.readPhysical(ctx, (manager) =>
      manager.query<Array<{ full_json: string; cmp_json: string }>>(
        `SELECT to_jsonb(t)::text AS full_json, (to_jsonb(t) - 'updated_at')::text AS cmp_json FROM "${table}" t`,
      ),
    );
    return rows.map((r) => toJsonRow(table, r.full_json, r.cmp_json));
  }

  /** Source rows for `table` normalised to the target's shape (user_note: workspace_id merged in by the database, not by JS). */
  private async readSourceAsTarget(ctx: WorkspaceCandidate, table: string): Promise<JsonRow[]> {
    if (table !== 'user_note') return this.readSourceJson(ctx, table);
    const rows = await this.readCore(ctx, (manager) =>
      manager.query<Array<{ full_json: string; cmp_json: string }>>(
        `SELECT (to_jsonb(n) || jsonb_build_object('workspace_id', $1::uuid))::text AS full_json,
                ((to_jsonb(n) || jsonb_build_object('workspace_id', $1::uuid)) - 'updated_at')::text AS cmp_json
           FROM core.user_note n
          WHERE n.subject_user_id IN (
            SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
            UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
          )`,
        [ctx.workspaceId],
      ),
    );
    return rows.map((r) => toJsonRow(table, r.full_json, r.cmp_json));
  }

  /** The latest privileged census for this workspace (audit_log row written by the migration identity), or null. */
  private async readCensus(ctx: WorkspaceCandidate): Promise<Record<string, number> | null> {
    const rows = await this.readCore(ctx, (manager) =>
      manager.query<Array<{ metadata: { trueCounts?: Record<string, number> } }>>(
        `SELECT metadata FROM core.audit_log
          WHERE organisation_id = $1 AND entity_id = $2 AND action = $3
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.organisationId, ctx.workspaceId, HWS_PRIVILEGED_COPY_AUDIT_ACTION],
      ),
    );
    return rows[0]?.metadata?.trueCounts ?? null;
  }

  /** `crewflow`, `rab.actor_type='worker'` bound, resolved physical schema — READ ONLY (`SET TRANSACTION READ ONLY`), for comparison/verification reads of the target schema's own rows. Fails closed exactly like `runInWorkspaceContext` (same resolver, same guarantee). */
  private async readPhysical<T>(ctx: WorkspaceCandidate, fn: (manager: EntityManager, schema: string) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      await this.bindReadIdentity(manager, ctx);
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
      // Bind the target organisation + workspace FIRST (2026-10-22 dev-cutover rehearsal fix): since the role split,
      // core.manager_workspace is owned by rab_secure_owner, so the owner connection (`crewflow`) is NOT exempt from its
      // RLS — with no GUC bound the row is invisible and every workspace with rows to copy failed here. The existing
      // `manager_workspace_member` policy (`id = core.current_workspace()`) makes exactly this one workspace visible; no
      // policy, grant or role changes.
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [
        ctx.organisationId,
        ctx.workspaceId,
      ]);
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
        copiedBy: PRIVILEGED_COPY_TABLES.includes(table) ? 'privileged-migration' : 'tool',
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

  /**
   * Reads source rows (core) and target rows (physical) for `table` as canonical jsonb TEXT and classifies each source key
   * as already-copied (identical except `updated_at`), conflicting (same key, different data), or new. Nothing passes
   * through JS Date/number, so full timestamp precision and exact numerics are compared and copied (2026-10-22 fix).
   */
  private async compareRows(
    ctx: WorkspaceCandidate,
    table: string,
  ): Promise<{ sourceRows: JsonRow[]; targetRowCount: number; alreadyCopied: number; conflicts: Array<{ id: string }>; toInsert: JsonRow[] }> {
    const sourceRows = await this.readSourceAsTarget(ctx, table);
    const targetRows = await this.readTargetJson(ctx, table);
    const targetByKey = new Map(targetRows.map((r) => [r.key, r]));

    let alreadyCopied = 0;
    const conflicts: Array<{ id: string }> = [];
    const toInsert: JsonRow[] = [];
    for (const row of sourceRows) {
      const existing = targetByKey.get(row.key);
      if (!existing) {
        toInsert.push(row);
        continue;
      }
      if (existing.cmp === row.cmp) {
        alreadyCopied += 1;
      } else {
        conflicts.push({ id: row.key });
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
      if (PRIVILEGED_COPY_TABLES.includes(table)) {
        // Never written by this tool (runtime-actor policies; owner decision Option 1). The privileged one-off copy owns
        // these rows; later tables in the copy order never depend on them (their FK children are all inside the family).
        const sourceRowCount = await this.countSourceRows(ctx, table);
        const state: TableApplyResult['state'] = sourceRowCount === 0 ? 'completed' : 'deferred-to-privileged-copy';
        tables.push({ table, state, rowsCopied: 0, alreadyPresent: 0, conflicts: [] });
        continue;
      }
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
        rowsCopied = await this.writePhysical(ctx, async (manager) => insertJsonRows(manager, table, toInsert));
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
    // Mapping is decided per subject (Part 15); the rows themselves stay canonical jsonb text end to end.
    const sourceRows = await this.readSourceAsTarget(ctx, 'user_note');
    const subjects = await this.readCore(ctx, (manager) =>
      manager.query<Array<{ id: string; subject_user_id: string }>>(
        `SELECT n.id, n.subject_user_id FROM core.user_note n
           WHERE n.subject_user_id IN (
             SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
             UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1
           )`,
        [ctx.workspaceId],
      ),
    );

    const blockedRows: Array<{ id: string; reason: string }> = [];
    const mappableIds = new Set<string>();
    await this.readCore(ctx, async (manager) => {
      for (const row of subjects) {
        const mapping = await resolveUserNoteWorkspace(manager, String(row.subject_user_id));
        if (!mapping.ok) {
          blockedRows.push({ id: String(row.id), reason: mapping.reason });
        } else if (mapping.workspaceId !== ctx.workspaceId) {
          blockedRows.push({ id: String(row.id), reason: 'maps-to-different-workspace' });
        } else {
          mappableIds.add(String(row.id));
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

    const mappable = sourceRows.filter((r) => mappableIds.has(r.key));
    const targetById = new Map((await this.readTargetJson(ctx, 'user_note')).map((r) => [r.key, r]));
    const toInsert = mappable.filter((r) => !targetById.has(r.key));
    const conflicts = mappable.filter((r) => targetById.has(r.key) && targetById.get(r.key)!.cmp !== r.cmp).map((r) => ({ id: r.key }));
    if (conflicts.length > 0) {
      const safeError = `${conflicts.length} row(s) conflict between core and the physical schema`;
      await this.writeCheckpoint(ctx, 'user_note', { state: 'failed', lastSafeError: safeError });
      return { table: 'user_note', state: 'failed', rowsCopied: 0, alreadyPresent: 0, conflicts: conflicts.map((c) => ({ id: c.id, category: 'id-exists-different-data' })), safeError };
    }

    const rowsCopied = toInsert.length > 0 ? await this.writePhysical(ctx, (manager) => insertJsonRows(manager, 'user_note', toInsert)) : 0;
    await this.writeCheckpoint(ctx, 'user_note', { state: 'completed', rowsCopied: rowsCopied + (mappable.length - toInsert.length), completedAt: new Date() });
    return { table: 'user_note', state: 'completed', rowsCopied, alreadyPresent: mappable.length - toInsert.length, conflicts: [] };
  }

  // ---------------------------------------------------------------- verify (Part 13)

  /**
   * FAIL-CLOSED verification (2026-10-22): a workspace passes only when, for EVERY table,
   *  - a privileged census exists (audit_log `workspace.hws_backfill_privileged_copy`, written by the migration
   *    identity, which no RLS policy can hide rows from) and the count this tool can SEE equals that true count — a
   *    visibility gap can never pass silently again;
   *  - every source key is present, no extra key exists, and every row is identical in EVERY column at full precision
   *    (canonical jsonb text, including `updated_at` and microsecond timestamps).
   * Without a census, verify fails with an explicit reason rather than trusting what it happens to see.
   */
  async verify(ctx: WorkspaceCandidate): Promise<WorkspaceVerifyResult> {
    const target = await this.resolveTargetStatus(ctx);
    const registryReady = target.status === 'READY';
    const schemaVersionSupported = target.schemaVersion === 1;
    const census = registryReady ? await this.readCensus(ctx) : null;

    const tables: TableVerifyResult[] = [];
    if (registryReady) {
      for (const table of WORKSPACE_TABLE_COPY_ORDER) {
        tables.push(await this.verifyTable(ctx, table, census));
      }
    }

    const pass = registryReady && schemaVersionSupported && tables.every((t) => t.pass);
    return { organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, pass, registryReady, schemaVersionSupported, tables };
  }

  private async verifyTable(ctx: WorkspaceCandidate, table: string, census: Record<string, number> | null): Promise<TableVerifyResult> {
    const sourceRows = await this.readSourceAsTarget(ctx, table);
    const targetRows = await this.readTargetJson(ctx, table);
    const targetByKey = new Map(targetRows.map((r) => [r.key, r]));
    const sourceKeys = new Set(sourceRows.map((r) => r.key));

    const missingIds = sourceRows.filter((r) => !targetByKey.has(r.key)).map((r) => r.key);
    const differentIds = sourceRows.filter((r) => targetByKey.has(r.key) && targetByKey.get(r.key)!.full !== r.full).map((r) => r.key);
    const extraIds = targetRows.filter((r) => !sourceKeys.has(r.key)).map((r) => r.key);
    const foreignWorkspaceRows = targetRows.filter((r) => r.workspaceId !== ctx.workspaceId).length;
    const trueRowCount = census && typeof census[table] === 'number' ? census[table]! : null;

    const reasons: string[] = [];
    if (trueRowCount === null) reasons.push('no privileged census for this workspace/table — the true source count is unknown, refusing to pass');
    else if (sourceRows.length !== trueRowCount) reasons.push(`visible source count ${sourceRows.length} differs from the true count ${trueRowCount}`);
    if (trueRowCount !== null && targetRows.length !== trueRowCount) reasons.push(`physical row count ${targetRows.length} differs from the true count ${trueRowCount}`);
    if (missingIds.length > 0) reasons.push(`${missingIds.length} source row(s) not found in the physical schema`);
    if (differentIds.length > 0) reasons.push(`${differentIds.length} row(s) differ from core at full precision`);
    if (extraIds.length > 0) reasons.push(`${extraIds.length} row(s) in the physical schema have no source row in core`);
    if (foreignWorkspaceRows > 0) reasons.push(`${foreignWorkspaceRows} row(s) in the physical schema belong to a DIFFERENT workspace_id`);

    return {
      table,
      pass: reasons.length === 0,
      sourceRowCount: sourceRows.length,
      trueRowCount,
      targetRowCount: targetRows.length,
      missingIds,
      differentIds,
      extraIds,
      foreignWorkspaceRows,
      reasons,
    };
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

/** Parses ONLY the key columns (and workspace_id) out of a canonical jsonb text row; the text itself is what is compared and copied. */
function toJsonRow(table: string, full: string, cmp: string): JsonRow {
  const parsed = JSON.parse(full) as Record<string, unknown>;
  return { key: rowKey(table, parsed), full, cmp, workspaceId: parsed.workspace_id == null ? null : String(parsed.workspace_id) };
}

/**
 * Inserts canonical jsonb rows into the physical table (`manager`'s search_path is bound to exactly that schema) with
 * `jsonb_populate_record` against the TARGET table's own row type: every column — ids, timestamps (full microsecond
 * precision), money (exact bigint), statuses, references — is converted by PostgreSQL itself, never by JS (Part 7).
 */
async function insertJsonRows(manager: EntityManager, table: string, rows: JsonRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await manager.query(
    `INSERT INTO "${table}" SELECT r.* FROM jsonb_array_elements($1::jsonb) AS e(v), LATERAL jsonb_populate_record(NULL::"${table}", e.v) AS r`,
    [`[${rows.map((r) => r.full).join(',')}]`],
  );
  return rows.length;
}

export { DIRECT_WORKSPACE_COLUMN_TABLES };
