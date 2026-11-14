// sql-injection-reviewed-file: every statement is a constant of this file or workspace-step-checks-sql.ts with bound
// parameters ($n), except (a) the numeric, clamped lock_timeout and (b) the frozen, owner-reviewed workspace command SQL
// rendered for a validated `workspace_<32 hex>` schema name. No request or row data reaches any statement.
/**
 * OWNER-DB-ULTIMATE Part D: the workspace command runner. Runs the pending WORKSPACE upgrade commands once per workspace
 * schema and records each (command, workspace) in core.upgrade_migration (Part B's logbook, workspace_id set).
 *
 * Twenty (twentyhq/twenty @ eedb0a73), re-implemented, not copied:
 *   - `engine/core-modules/upgrade/services/workspace-command-runner.service.ts:32-84,106-153`: per workspace, the pending
 *     commands serially; ONE `completed` row after each, ONE `failed` row on error, then stop that workspace;
 *   - `database/commands/command-runners/workspace-iterator.service.ts:79-170`: one workspace at a time, a failed workspace
 *     does not stop the others (:151-164 also survives a workspace deleted mid-run);
 *   - `upgrade-sequence-reader.service.ts:155-173` + `upgrade-sequence-runner.service.ts:98-247` (pending = the workspace steps
 *     after the cursor, walking the sequence from it), `upgrade-migration.service.ts:222-301` (cursor = the newest row; a
 *     provisioned workspace without one is an error);
 *   - `upgrade-sequence-reader.service.ts:175-204` (a new workspace's cursor = the version's last step).
 *
 * Crewflow additions (D-RUNNER.md §4): one REPEATABLE READ transaction per (workspace, command) with the tenant bound to that
 * workspace (FORCE RLS stays, §0.2), `SET LOCAL ROLE crewflow` like WorkspaceSchemaMigrator (M-T2), the per-schema advisory
 * lock and the registry row FOR UPDATE; then the post-step checks that replace the module fingerprints (session invariants,
 * catalog isolation, data / role-catalog writes outside the schema, extra structure, the fingerprint), and after the
 * transaction a clean-session check. Plus the one-time ADOPTION of the workspace-module history (D-RUNNER.md §5).
 *
 * Runs only on the LOCKED migration session (the migrate-on-start child, `upgrade --force`), never from a request path.
 */
import type { WorkspaceStructureDeclaration, WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import {
  adoptWorkspaceInitial,
  getWorkspaceCursors,
  Query,
  recordWorkspaceUpgradeMigration,
  UpgradeSession,
  UpgradeSessionError,
  WorkspaceCursor,
  withUpgradeScope,
} from './upgrade-migration.service';
import { InstanceRegistry, lastInstanceStepOfVersion, SequenceStep, sequenceForVersions, versionOfStep, WorkspaceRegistry } from './upgrade-sequence';
import { ADOPTION_RELEASE_VERSION, compareVersions } from './upgrade-version';
import {
  INVARIANTS_SQL,
  OUTSIDE_COUNTS_SQL,
  OUTSIDE_DATA_WRITES_SQL,
  OUTSIDE_WRITE_COUNTERS_SQL,
  OUTSIDE_WRITES_SQL,
  RELEASE_EXTRA_ADVISORY_SQL,
  SESSION_CLEAN_SQL,
  SESSION_RESET_SQL,
  TARGET_EXTRA_STRUCTURE_SQL,
  TRACK_COUNTS_SQL,
} from './workspace-step-checks-sql';
import { declaredFingerprint } from './workspace-structure-level';
import { isUpgradeBlocked, upgradeBlockMarker } from './workspace-upgrade-block';
import {
  EXPECTED_WORKSPACE_FINGERPRINTS,
  FingerprintMajor,
  selectWorkspaceFingerprintsForServer,
} from '../../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';

export { OUTSIDE_COUNTS_SQL, OUTSIDE_WRITES_SQL, OUTSIDE_DATA_WRITES_SQL, OUTSIDE_WRITE_COUNTERS_SQL, TARGET_EXTRA_STRUCTURE_SQL };

/** Pure (review M1): the relations whose write counter increased between two OUTSIDE_WRITE_COUNTERS_SQL reads. */
export function increasedCounters(before: ReadonlyArray<{ relid: string; what: string; n: string }>, after: ReadonlyArray<{ relid: string; what: string; n: string }>): string[] {
  const was = new Map(before.map((r) => [r.relid, BigInt(r.n)]));
  return after.filter((r) => BigInt(r.n) > (was.get(r.relid) ?? 0n)).map((r) => r.what);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACE_SCHEMA_RE = /workspace_[0-9a-f]{32}/gi;

/** The derived schema of a workspace (the same mapping as the provisioners and the resolver). */
export function workspaceSchemaOf(workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) throw new Error('workspace id is not a canonical uuid');
  return 'workspace_' + workspaceId.replace(/-/g, '');
}

/** A refusal of the runner's own checks; `errorClass` is a fixed label, stored in the logbook row with the detail. */
export class WorkspaceStepRefused extends Error {
  constructor(
    readonly errorClass: string,
    detail: string,
  ) {
    super(`${errorClass}: ${detail}`);
    this.name = 'WorkspaceStepRefused';
  }
}

/** A run-level fault (the session itself is unusable): rethrown, never recorded against one workspace. */
export class WorkspaceRunFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRunFault';
  }
}

/** Layer 1 (static): refuses SQL text that names any workspace schema other than the target. Pure. */
export function assertOnlyTargetSchema(sql: string, schemaName: string): void {
  for (const m of sql.matchAll(WORKSPACE_SCHEMA_RE)) {
    if (m[0] !== schemaName) throw new WorkspaceStepRefused('FOREIGN_SCHEMA_NAME', `the statement names ${m[0]}, not this workspace's schema ${schemaName}`);
  }
}

export interface ReadyWorkspace {
  workspaceId: string;
  organisationId: string;
  schemaName: string;
  moduleVersion: number;
  /** D2/D3: the workspace carried an upgrade block when the run started. */
  blocked?: boolean;
}

export type WorkspaceOutcomeStatus = 'up-to-date' | 'upgraded' | 'adopted' | 'failed' | 'refused' | 'ahead';

export interface WorkspaceOutcome {
  workspaceId: string;
  status: WorkspaceOutcomeStatus;
  /** The step that failed or was refused (a step name), or a `<v>_Workspace…` label. */
  step?: string;
  errorClass?: string;
  attempt?: number;
  /** Steps completed for this workspace in this run. */
  completed: string[];
  /** D2/D3: blocked (503, Worker paused) after this run. */
  blocked?: boolean;
  /** Internal: whether the failure requires the block (a structural step, a structure mismatch, a refused / unknown cursor). */
  needsBlock?: boolean;
}

export interface WorkspaceRunReport {
  outcomes: WorkspaceOutcome[];
  /** Failed or refused workspaces (a failed step, a refused adoption, an unknown cursor, a vanished workspace). */
  failures: WorkspaceOutcome[];
  /** D2/D3: whether any workspace was blocked or unblocked by this run (the resolver cache must be refreshed). */
  blockChanged: boolean;
}

export interface WorkspaceRunOptions {
  codeVersion: string;
  /** Every version of this code's sequence (CREWFLOW_PREVIOUS_VERSIONS + the code version). */
  versions: readonly string[];
  force: boolean;
  /** Adopt workspaces without a cursor (the adoption release only). */
  adopt: boolean;
  log: (line: string) => void;
  registry?: InstanceRegistry;
  workspaceRegistry?: WorkspaceRegistry;
  /** `SET LOCAL lock_timeout` per step. Default 5 s, clamped to 100 ms … 60 s. */
  lockTimeoutMs?: number;
  /** Restrict to these workspaces (tests). */
  workspaceIds?: readonly string[];
  /** Test seam: the expected fingerprint of a structure level (default: the reviewed tables + the declared levels). */
  expectedFingerprint?: (level: number, major: FingerprintMajor) => string | undefined;
  /** Test seam (integration specs only, never from env): runs before each workspace's iteration. */
  onBeforeWorkspace?: (workspaceId: string) => Promise<void>;
}

export interface ReadyWorkspaceScan {
  ready: ReadyWorkspace[];
  /** READY rows whose registry schema name differs from the derived one (refused per workspace, never routed). */
  mismatched: string[];
}

/** READY workspaces in id order: core.worker_list_workspaces pages, each registry row read with its organisation bound. */
export async function scanReadyWorkspaces(query: Query, only?: readonly string[]): Promise<ReadyWorkspaceScan> {
  const out: ReadyWorkspaceScan = { ready: [], mismatched: [] };
  let after: string | null = null;
  for (;;) {
    const page = (await query('SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, 100)', [after])) as Array<{
      workspace_id: string;
      organisation_id: string;
    }>;
    for (const ws of page) {
      if (only && !only.includes(ws.workspace_id)) continue;
      await query('BEGIN');
      try {
        await query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true)`, [ws.organisation_id]);
        const rows = (await query('SELECT status, schema_name, module_version, migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.workspace_id])) as Array<{
          status: string;
          schema_name: string;
          module_version: number;
          migration_error: string | null;
        }>;
        await query('COMMIT');
        const r = rows[0];
        if (r?.status === 'READY') {
          const schemaName = workspaceSchemaOf(ws.workspace_id);
          if (r.schema_name !== schemaName) out.mismatched.push(ws.workspace_id);
          else out.ready.push({ workspaceId: ws.workspace_id, organisationId: ws.organisation_id, schemaName, moduleVersion: Number(r.module_version), blocked: isUpgradeBlocked(r.migration_error) });
        }
      } catch (error) {
        await query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    if (page.length < 100) break;
    after = page[page.length - 1]!.workspace_id;
  }
  return out;
}

export async function listReadyWorkspaces(query: Query, only?: readonly string[]): Promise<ReadyWorkspace[]> {
  return (await scanReadyWorkspaces(query, only)).ready;
}

/**
 * Pure (Twenty: the sequence is walked from the cursor, upgrade-sequence-runner.service.ts:98-247): every workspace step after
 * the cursor up to and including the code version, in sequence order, or from the cursor when it is `failed`. So an earlier
 * version's failed step (e.g. left behind by `upgrade --force`) runs again first, never skipped. `null` = the cursor is not in
 * this code's sequence.
 */
export function pendingWorkspaceSteps(sequence: readonly SequenceStep[], codeVersion: string, cursor: Pick<WorkspaceCursor, 'name' | 'status'>): SequenceStep[] | null {
  const at = sequence.findIndex((s) => s.name === cursor.name);
  if (at === -1) return null;
  return sequence.filter(
    (s, i) => s.kind === 'workspace' && compareVersions(s.version, codeVersion) <= 0 && (i > at || (i === at && cursor.status === 'failed')),
  );
}

/**
 * Pure (Twenty areAllWorkspacesAtCommand, by position so a workspace created at a later step also counts): whether this cursor
 * has completed `stepName`.
 */
export function cursorHasCompleted(sequence: readonly SequenceStep[], codeVersion: string, cursor: Pick<WorkspaceCursor, 'name' | 'status'> | undefined, stepName: string): boolean {
  if (!cursor) return false;
  const target = sequence.findIndex((s) => s.name === stepName);
  if (target === -1) return false;
  const at = sequence.findIndex((s) => s.name === cursor.name);
  if (at === -1) {
    const v = versionOfStep(cursor.name);
    return v !== null && compareVersions(v, codeVersion) > 0;
  }
  return at > target || (at === target && cursor.status === 'completed');
}

/** The structure declarations of every workspace command in the sequence, by level (validated: strictly +1 from 21). */
export function structureLevels(sequence: readonly SequenceStep[]): Map<number, WorkspaceStructureDeclaration> {
  const out = new Map<number, WorkspaceStructureDeclaration>();
  let level = LATEST_WORKSPACE_MODULE_VERSION;
  for (const s of sequence) {
    const d = s.command?.structure;
    if (!d) continue;
    if (d.level !== level + 1) throw new Error(`workspace command ${s.name}: structure level ${d.level}, expected ${level + 1}`);
    level = d.level;
    out.set(level, d);
  }
  return out;
}

interface Invariants {
  pid: number;
  tx: string;
  role: string;
  search_path: string;
  who: string;
  org: string;
  ws: string;
  scope: string;
  rab: string;
}

interface SessionState {
  role: string;
  same_user: boolean;
  search_path: string;
  rab: string;
  advisory: string;
}

export class WorkspaceCommandRunner {
  private major: FingerprintMajor | null = null;
  private baselineSearchPath: string | null = null;
  /** N4: the session-level advisory locks held when the run started (the migration lock); anything else after a step leaked. */
  private baselineAdvisory = '';

  constructor(private readonly options: WorkspaceRunOptions) {}

  private get lockTimeout(): number {
    return Math.max(100, Math.min(this.options.lockTimeoutMs ?? 5_000, 60_000));
  }

  /** Runs every workspace; never throws for one workspace's failure (reported). Throws only for a run-level fault. */
  async run(session: UpgradeSession): Promise<WorkspaceRunReport> {
    const { codeVersion, versions, log, registry, workspaceRegistry, force } = this.options;
    // N1: the M1 write counters (layer 4b) read zero when statistics are off, so the check would pass silently. Refuse.
    const [tc] = (await session.query(TRACK_COUNTS_SQL)) as Array<{ track_counts: string }>;
    if (tc?.track_counts !== 'on') {
      throw new WorkspaceRunFault(`track_counts is ${JSON.stringify(tc?.track_counts ?? null)}, not 'on': the workspace runner's write-counter check cannot work. Refusing to run workspace steps.`);
    }
    const sequence = sequenceForVersions([...versions, codeVersion], registry, workspaceRegistry);
    const levels = structureLevels(sequence);
    const scan = await scanReadyWorkspaces(session.query, this.options.workspaceIds);
    const workspaces = scan.ready;
    if (workspaces.length) this.major = await selectWorkspaceFingerprintsForServer(session.query as (sql: string) => Promise<Array<Record<string, unknown>>>);
    const [baseline] = (await session.query(SESSION_CLEAN_SQL)) as SessionState[];
    this.baselineSearchPath = baseline?.search_path ?? null;
    this.baselineAdvisory = baseline?.advisory ?? '';
    const cursors = await withUpgradeScope(session, 'upgrade', (q) => getWorkspaceCursors(q, workspaces.map((w) => w.workspaceId)));
    // Adopted workspaces are at the frozen template (structure 20): their cursor is the code version's last INSTANCE step, so
    // every workspace step of the adoption release still runs for them.
    const adoptedName = lastInstanceStepOfVersion(codeVersion, registry);
    const report: WorkspaceRunReport = { outcomes: [], failures: [], blockChanged: false };
    const total = workspaces.length;
    log(`workspace upgrade (${codeVersion}${force ? ', --force' : ''}): ${total} READY workspace(s)`);

    for (const id of scan.mismatched) {
      const outcome: WorkspaceOutcome = { workspaceId: id, status: 'refused', step: `${codeVersion}_WorkspaceRegistry`, errorClass: 'NAME_MISMATCH', completed: [] };
      report.outcomes.push(outcome);
      report.failures.push(outcome);
      log(`ERROR: workspace ${id}: its registry schema name differs from the derived name; refused, nothing run`);
    }

    for (const [index, ws] of workspaces.entries()) {
      const outcome: WorkspaceOutcome = { workspaceId: ws.workspaceId, status: 'up-to-date', completed: [] };
      report.outcomes.push(outcome);
      try {
        if (this.options.onBeforeWorkspace) await this.options.onBeforeWorkspace(ws.workspaceId);
        await this.runWorkspace(session, ws, sequence, levels, cursors.get(ws.workspaceId), adoptedName, outcome, `${index + 1}/${total}`);
      } catch (error) {
        // L1: a per-workspace fault outside a step (a logbook write, adoption, a workspace deleted mid-run) is reported
        // against that workspace; only a run-level fault (the session is unusable) stops the run.
        if (error instanceof WorkspaceRunFault || error instanceof UpgradeSessionError) throw error;
        const code = (error as { code?: unknown })?.code;
        Object.assign(outcome, {
          status: 'refused',
          step: outcome.step ?? `${codeVersion}_WorkspaceRun`,
          errorClass: code === '23503' ? 'WORKSPACE_GONE' : error instanceof WorkspaceStepRefused ? error.errorClass : errorClassOf(error),
        });
        report.failures.push(outcome);
        log(`ERROR: workspace ${ws.workspaceId}: ${outcome.errorClass} outside a step; refused, the next start retries it`);
        await this.assertSessionClean(session.query);
        // D3: a refused adoption / no or unknown cursor leaves the structure unverified for this code: blocked. A vanished or
        // no-longer-READY workspace is not routed anyway (nothing to write).
        outcome.needsBlock = !['WORKSPACE_GONE', 'NOT_READY'].includes(outcome.errorClass ?? '');
      }
      if (outcome.status === 'failed' && !report.failures.includes(outcome)) report.failures.push(outcome);
      // D2/D3: block, or lift a block once the workspace's structure matches this code again.
      if (outcome.needsBlock) {
        await this.block(session, ws, outcome.step ?? `${codeVersion}_WorkspaceRun`, outcome.errorClass ?? 'UNKNOWN');
        outcome.blocked = true;
        if (!ws.blocked) report.blockChanged = true;
        log(`workspace ${ws.workspaceId} BLOCKED (${outcome.errorClass}): its requests get 503 and its Worker jobs pause until the step succeeds`);
      } else if (ws.blocked && outcome.status !== 'refused') {
        outcome.blocked = !(await this.unblock(session, ws));
        if (!outcome.blocked) {
          report.blockChanged = true;
          log(`workspace ${ws.workspaceId} unblocked: its structure matches this code`);
        }
      }
      delete outcome.needsBlock;
    }
    log(`workspace upgrade: ${report.outcomes.length - report.failures.length} ok, ${report.failures.length} failed or refused`);
    return report;
  }

  private async runWorkspace(
    session: UpgradeSession,
    ws: ReadyWorkspace,
    sequence: readonly SequenceStep[],
    levels: Map<number, WorkspaceStructureDeclaration>,
    found: WorkspaceCursor | undefined,
    adoptedName: string,
    outcome: WorkspaceOutcome,
    position: string,
  ): Promise<void> {
    const { codeVersion, log, force } = this.options;
    let cursor: Pick<WorkspaceCursor, 'name' | 'status'> | undefined = found;
    if (!cursor) {
      if (!this.options.adopt) {
        Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceCursor`, errorClass: 'NO_CURSOR' });
        log(`ERROR: workspace ${ws.workspaceId} (${position}) has no upgrade logbook row (only ${ADOPTION_RELEASE_VERSION} adopts the workspace-module history); refused, nothing run`);
        throw new WorkspaceStepRefused('NO_CURSOR', 'no cursor');
      }
      const refusal = await this.adopt(session, ws, adoptedName);
      if (refusal) {
        Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceAdoption`, errorClass: refusal });
        log(`ERROR: workspace ${ws.workspaceId} (${position}) not adopted (${refusal}); no row written, retried on the next start`);
        throw new WorkspaceStepRefused(refusal, 'adoption refused');
      }
      outcome.status = 'adopted';
      cursor = { name: adoptedName, status: 'completed' };
      log(`workspace ${ws.workspaceId} (${position}) adopted: is_initial row ${adoptedName}`);
    }

    const pending = pendingWorkspaceSteps(sequence, codeVersion, cursor);
    if (pending === null) {
      const v = versionOfStep(cursor.name);
      if (v !== null && compareVersions(v, codeVersion) > 0) {
        outcome.status = 'ahead';
        log(`WARNING: workspace ${ws.workspaceId} is at ${cursor.name}, newer than this code (${codeVersion}): rollback, nothing run`);
        return;
      }
      Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceCursor`, errorClass: 'UNKNOWN_CURSOR' });
      log(`ERROR: workspace ${ws.workspaceId}: its cursor is not a step this code knows; refused, nothing run`);
      throw new WorkspaceStepRefused('UNKNOWN_CURSOR', 'unknown cursor');
    }

    for (const step of pending) {
      const command = step.command!;
      let stepError: unknown = null;
      try {
        await this.runStep(session, ws, step.name, command, levels);
      } catch (error) {
        stepError = error;
      }
      // L2: whatever happened, the session must carry nothing into the next workspace (a session-level SET leaks past COMMIT).
      const dirty = await this.assertSessionClean(session.query);
      if (!stepError && dirty) stepError = new WorkspaceStepRefused('SESSION_LEAK', `${step.name} left session-level state behind (${dirty}); it was reset`);
      if (stepError) {
        if (stepError instanceof WorkspaceRunFault || stepError instanceof UpgradeSessionError) throw stepError;
        outcome.step = step.name;
        const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
          recordWorkspaceUpgradeMigration(q, { name: step.name, workspaceId: ws.workspaceId, status: 'failed', executedByVersion: codeVersion, forced: force, error: stepError }),
        );
        Object.assign(outcome, {
          status: 'failed',
          errorClass: stepError instanceof WorkspaceStepRefused ? stepError.errorClass : errorClassOf(stepError),
          attempt,
        });
        // D2: a structural step always blocks (the code expects the new structure); a data step blocks only when the
        // workspace's structure no longer matches its level (verify + fingerprint + extra checks), else it is served.
        outcome.needsBlock = command.structure !== undefined || !(await this.structureMatches(session, ws));
        log(`ERROR: workspace ${ws.workspaceId} (${position}): ${step.name} FAILED (attempt ${attempt}, ${outcome.errorClass}); its later steps skipped, the next start retries it`);
        return;
      }
      outcome.step = step.name;
      const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
        recordWorkspaceUpgradeMigration(q, { name: step.name, workspaceId: ws.workspaceId, status: 'completed', executedByVersion: codeVersion, forced: force }),
      );
      outcome.step = undefined;
      outcome.completed.push(step.name);
      if (outcome.status === 'up-to-date') outcome.status = 'upgraded';
      log(`workspace ${ws.workspaceId} (${position}): ${step.name} completed (attempt ${attempt})`);
    }
  }

  /** Adoption (D-RUNNER.md §5). Returns null when adopted, else the refusal class. */
  private async adopt(session: UpgradeSession, ws: ReadyWorkspace, name: string): Promise<string | null> {
    const q = session.query;
    let refusal: string | null = null;
    await q('BEGIN');
    try {
      await this.enterWorkspace(q, ws);
      const level = await this.lockRegistry(q, ws);
      if (level < LATEST_WORKSPACE_MODULE_VERSION) refusal = 'BEHIND';
      else if (level > LATEST_WORKSPACE_MODULE_VERSION) refusal = 'AHEAD';
      else refusal = (await this.extraStructureProblem(q, ws)) ?? (await this.structureProblem(q, ws, level));
      await q('COMMIT');
    } catch (error) {
      await q('ROLLBACK').catch(() => undefined);
      return error instanceof WorkspaceStepRefused ? error.errorClass : errorClassOf(error);
    }
    if (refusal) return refusal;
    await withUpgradeScope(session, 'upgrade', (s) => adoptWorkspaceInitial(s, { workspaceId: ws.workspaceId, name, executedByVersion: this.options.codeVersion }));
    return null;
  }

  /** One (workspace, command) in ONE REPEATABLE READ transaction with every post-step check. Throws on any failure. */
  private async runStep(session: UpgradeSession, ws: ReadyWorkspace, name: string, command: WorkspaceUpgradeCommand, levels: Map<number, WorkspaceStructureDeclaration>): Promise<void> {
    const q = session.query;
    const { log } = this.options;
    await q('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      // sql-injection-reviewed: lockTimeout is a number clamped to 100..60000 by the getter above; nothing else is interpolated.
      await q(`SET LOCAL lock_timeout = '${this.lockTimeout}ms'`);
      await this.enterWorkspace(q, ws);
      const level = await this.lockRegistry(q, ws);
      const before = await this.invariants(q);
      const [countsBefore] = (await q(OUTSIDE_COUNTS_SQL, [ws.schemaName])) as Array<{ counts: string }>;
      const writesBefore = (await q(OUTSIDE_WRITE_COUNTERS_SQL, [ws.schemaName])) as Array<{ relid: string; what: string; n: string }>;

      let target = level;
      if (command.structure) {
        if (!levels.has(command.structure.level)) throw new WorkspaceStepRefused('LEVEL_UNKNOWN', `${name} declares structure level ${command.structure.level}, not in this code's sequence`);
        // At level - 1: this step moves it to its level. Already at the level or beyond (a crash after COMMIT, or a workspace
        // provisioned later from a newer template): no bump, and the idempotent re-run must leave the structure unchanged.
        if (level === command.structure.level - 1) target = command.structure.level;
        else if (level < command.structure.level - 1) throw new WorkspaceStepRefused('LEVEL_MISMATCH', `${name} moves the structure to ${command.structure.level}; the workspace is at ${level}`);
      }

      const guarded: Query = async (sql, parameters) => {
        assertOnlyTargetSchema(sql, ws.schemaName);
        return q(sql, parameters);
      };
      if (command.precheck) {
        const [pre] = (await guarded(command.precheck(ws.schemaName))) as Array<{ n: number }>;
        if (Number(pre?.n ?? 0) !== 0) throw new WorkspaceStepRefused('PRECHECK_VIOLATION', `${name}: the data pre-check found ${Number(pre?.n)} row(s)`);
      }
      if (command.sql) await guarded(command.sql(ws.schemaName));
      if (command.run) await command.run({ schemaName: ws.schemaName, workspaceId: ws.workspaceId, organisationId: ws.organisationId, query: guarded, log });
      if (!command.sql && !command.run) throw new WorkspaceStepRefused('EMPTY_COMMAND', `${name} has neither sql nor run`);

      // Layer 3: the command did not end the transaction, change the role, the tenant binding, search_path or the scope.
      const after = await this.invariants(q);
      const changed = (Object.keys(before) as Array<keyof Invariants>).filter((k) => String(before[k]) !== String(after[k]));
      if (changed.length) throw new WorkspaceStepRefused('SESSION_CHANGED', `${name} changed ${changed.join(', ')} (it must not end the transaction, re-bind or change role)`);

      // Layer 4: nothing outside this workspace schema was written or dropped by this transaction: catalog rows (xmin), object
      // counts, and (M1) data rows of any other table and the role / database / publication catalogs (per-transaction counters).
      const outside = (await q(OUTSIDE_WRITES_SQL, [ws.schemaName])) as Array<{ what: string }>;
      if (outside.length) throw new WorkspaceStepRefused('OUTSIDE_SCHEMA', `${name} changed objects outside ${ws.schemaName}: ${outside.map((o) => o.what).join('; ')}`);
      const [countsAfter] = (await q(OUTSIDE_COUNTS_SQL, [ws.schemaName])) as Array<{ counts: string }>;
      if (countsBefore?.counts !== countsAfter?.counts) throw new WorkspaceStepRefused('OUTSIDE_SCHEMA', `${name} added or dropped objects outside ${ws.schemaName}`);
      const writesAfter = (await q(OUTSIDE_WRITE_COUNTERS_SQL, [ws.schemaName])) as Array<{ relid: string; what: string; n: string }>;
      const data = [...increasedCounters(writesBefore, writesAfter), ...((await q(OUTSIDE_DATA_WRITES_SQL, [ws.schemaName])) as Array<{ what: string }>).map((o) => o.what)];
      if (data.length) throw new WorkspaceStepRefused('OUTSIDE_SCHEMA', `${name} wrote outside ${ws.schemaName}: ${data.join('; ')}`);

      // Layer 5: what the v1 fingerprint does not hash (M2), then the level (bumped BEFORE the verify function, M3: it may read
      // module_version), then verify + fingerprint == the expected one of that level.
      const extra = await this.extraStructureProblem(q, ws);
      if (extra) throw new WorkspaceStepRefused(extra, `${name}: the workspace has structure the template does not allow`);
      if (target !== level) {
        await q(`UPDATE core.workspace_schema_registry SET module_version = $2, last_migrated_at = now() WHERE workspace_id = $1`, [ws.workspaceId, target]);
      }
      const problem = await this.structureProblem(q, ws, target);
      if (problem) throw new WorkspaceStepRefused(problem, `${name}: the workspace structure after the step is not structure level ${target}`);
      if (target !== level) {
        const [fp] = (await q('SELECT core.workspace_schema_fingerprint($1) AS f', [ws.workspaceId])) as Array<{ f: string }>;
        await q(
          `UPDATE core.workspace_schema_registry
              SET expected_fingerprint = $2, observed_fingerprint = $2, fingerprint_checked_at = now(),
                  drift_status = 'OK', drift_detail = NULL, migration_error = NULL
            WHERE workspace_id = $1`,
          [ws.workspaceId, fp!.f],
        );
      }
      await q('COMMIT');
    } catch (error) {
      await q('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /**
   * L2: after COMMIT / ROLLBACK nothing may remain at session level. Returns null when clean; otherwise resets the session
   * (role none, every rab.* empty) and returns what was found. Throws a run-level fault when it cannot be made clean.
   */
  private async assertSessionClean(q: Query): Promise<string | null> {
    const read = async () => ((await q(SESSION_CLEAN_SQL)) as SessionState[])[0]!;
    const found = await read().catch(() => null);
    const describe = (s: SessionState) =>
      [
        s.role !== 'none' ? `role=${s.role}` : '',
        s.same_user ? '' : 'current_user<>session_user',
        this.baselineSearchPath !== null && s.search_path !== this.baselineSearchPath ? 'search_path' : '',
        s.rab ? `settings=${s.rab.replace(/=[^,]*/g, '')}` : '',
        s.advisory !== this.baselineAdvisory ? 'advisory locks' : '',
      ]
        .filter(Boolean)
        .join(', ');
    const problem = found ? describe(found) : 'unreadable session';
    if (!problem) return null;
    await q('ROLLBACK').catch(() => undefined);
    await q(SESSION_RESET_SQL).catch(() => undefined);
    for (let i = 0; i < 10; i += 1) {
      const [r] = (await q(RELEASE_EXTRA_ADVISORY_SQL, [this.baselineAdvisory]).catch(() => [{ released: 0 }])) as Array<{ released: number | string }>;
      if (!Number(r?.released ?? 0)) break;
    }
    if (this.baselineSearchPath !== null) await q(`SELECT pg_catalog.set_config('search_path', $1, false)`, [this.baselineSearchPath]).catch(() => undefined);
    const again = await read().catch(() => null);
    if (!again || describe(again)) throw new WorkspaceRunFault(`the migration session could not be reset after a workspace step (${problem}). Refusing to continue.`);
    return problem;
  }

  /** D2: whether the workspace's structure is exactly its recorded level (read-only). Any error = false (fail closed). */
  private async structureMatches(session: UpgradeSession, ws: ReadyWorkspace): Promise<boolean> {
    const q = session.query;
    try {
      await q('BEGIN');
      await this.enterWorkspace(q, ws);
      const level = await this.lockRegistry(q, ws);
      const problem = (await this.extraStructureProblem(q, ws)) ?? (await this.structureProblem(q, ws, level));
      await q('COMMIT');
      return problem === null;
    } catch {
      await q('ROLLBACK').catch(() => undefined);
      return false;
    }
  }

  /** D2/D3: write the block marker. A block that cannot be written stops the whole start (never serve a mismatched workspace). */
  private async block(session: UpgradeSession, ws: ReadyWorkspace, step: string, errorClass: string): Promise<void> {
    const q = session.query;
    try {
      await q('BEGIN');
      await this.enterWorkspace(q, ws);
      await q('UPDATE core.workspace_schema_registry SET migration_error = $2 WHERE workspace_id = $1', [ws.workspaceId, upgradeBlockMarker(step, errorClass)]);
      await q('COMMIT');
    } catch (error) {
      await q('ROLLBACK').catch(() => undefined);
      throw new WorkspaceRunFault(`workspace ${ws.workspaceId} must be blocked but the block could not be written (${errorClassOf(error)}). Refusing to serve.`);
    }
  }

  /** D2/D3: lift the block only when the structure matches the workspace's level. Returns whether it was lifted. */
  private async unblock(session: UpgradeSession, ws: ReadyWorkspace): Promise<boolean> {
    const q = session.query;
    try {
      await q('BEGIN');
      await this.enterWorkspace(q, ws);
      const level = await this.lockRegistry(q, ws);
      const problem = (await this.extraStructureProblem(q, ws)) ?? (await this.structureProblem(q, ws, level));
      if (!problem) {
        await q(`UPDATE core.workspace_schema_registry SET migration_error = NULL WHERE workspace_id = $1 AND migration_error LIKE 'upgrade-blocked: %'`, [ws.workspaceId]);
      }
      await q('COMMIT');
      return problem === null;
    } catch {
      await q('ROLLBACK').catch(() => undefined);
      return false;
    }
  }

  /**
   * Role (M-T2, as WorkspaceSchemaMigrator.actAsMigrationRole), search_path, tenant binding, per-schema lock. Inside a
   * transaction. L2: a session that is neither allowed nor able to SET ROLE crewflow is refused (never fail-open).
   */
  private async enterWorkspace(q: Query, ws: ReadyWorkspace): Promise<void> {
    const [r] = (await q(
      `SELECT (current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
               OR coalesce((SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user), false)) AS allowed,
              EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'SET') AS can_set`,
    )) as Array<{ allowed: boolean; can_set: boolean }>;
    if (!r?.allowed) {
      if (!r?.can_set) throw new WorkspaceStepRefused('NO_MIGRATION_ROLE', 'this session is neither crewflow nor able to SET ROLE crewflow');
      await q(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
    }
    await q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [ws.organisationId, ws.workspaceId]);
    await q('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))', [ws.schemaName]);
  }

  /** The registry row FOR UPDATE: must still be READY with the derived name. Returns its structure level (module_version). */
  private async lockRegistry(q: Query, ws: ReadyWorkspace): Promise<number> {
    const rows = (await q('SELECT status, schema_name, module_version FROM core.workspace_schema_registry WHERE workspace_id = $1 FOR UPDATE', [ws.workspaceId])) as Array<{
      status: string;
      schema_name: string;
      module_version: number;
    }>;
    const r = rows[0];
    if (!r || r.status !== 'READY' || r.schema_name !== ws.schemaName) throw new WorkspaceStepRefused('NOT_READY', `workspace ${ws.workspaceId} is no longer READY under its derived schema`);
    return Number(r.module_version);
  }

  private async invariants(q: Query): Promise<Invariants> {
    const [row] = (await q(INVARIANTS_SQL)) as Invariants[];
    return row!;
  }

  /** M2: null when the target has none of the structure the v1 fingerprint cannot see, else 'STRUCTURE_EXTRA'. */
  private async extraStructureProblem(q: Query, ws: ReadyWorkspace): Promise<string | null> {
    const rows = (await q(TARGET_EXTRA_STRUCTURE_SQL, [ws.schemaName])) as Array<{ what: string }>;
    return rows.length ? 'STRUCTURE_EXTRA' : null;
  }

  /** null when the schema is exactly structure level `level` (verify function clean, fingerprint equal), else the class. */
  private async structureProblem(q: Query, ws: ReadyWorkspace, level: number): Promise<string | null> {
    const expected = this.expectedFingerprint(level);
    if (!expected) return 'NO_EXPECTED_FINGERPRINT';
    const [v] = (await q('SELECT core.verify_workspace_schema_v1($1) AS p', [ws.workspaceId])) as Array<{ p: string | null }>;
    if (v?.p) return 'VERIFY_FAILED';
    const [f] = (await q('SELECT core.workspace_schema_fingerprint($1) AS f', [ws.workspaceId])) as Array<{ f: string | null }>;
    if (!f?.f || f.f !== expected) return 'FINGERPRINT_MISMATCH';
    return null;
  }

  private expectedFingerprint(level: number): string | undefined {
    const major = this.major ?? 16;
    if (this.options.expectedFingerprint) return this.options.expectedFingerprint(level, major);
    if (level <= LATEST_WORKSPACE_MODULE_VERSION) return EXPECTED_WORKSPACE_FINGERPRINTS[level];
    return declaredFingerprint(level, major, this.options.workspaceRegistry);
  }
}

/** A safe class for an unexpected error: the SQLSTATE or the error name (the full text goes to the logbook row as-is). */
export function errorClassOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === '55P03') return 'LOCK_TIMEOUT';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : 'INTERNAL';
}
