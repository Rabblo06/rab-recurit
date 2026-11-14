// sql-injection-reviewed-file: every statement is a constant of this file with bound parameters ($n), except (a) the numeric,
// clamped lock_timeout and (b) the frozen, owner-reviewed workspace command SQL rendered for a validated `workspace_<32 hex>`
// schema name. No request or row data reaches any statement.
/**
 * OWNER-DB-ULTIMATE Part D: the workspace command runner. Runs the code version's WORKSPACE upgrade commands once per
 * workspace schema and records each (command, workspace) in core.upgrade_migration (Part B's logbook, workspace_id set).
 *
 * Twenty (twentyhq/twenty @ eedb0a73), re-implemented, not copied:
 *   - `engine/core-modules/upgrade/services/workspace-command-runner.service.ts:32-84,106-153`: per workspace, the pending
 *     commands serially; ONE `completed` row after each, ONE `failed` row on error, then stop that workspace;
 *   - `database/commands/command-runners/workspace-iterator.service.ts:79-170`: one workspace at a time, a failed workspace
 *     does not stop the others;
 *   - `upgrade-sequence-reader.service.ts:155-173` (pending commands from the cursor), `upgrade-migration.service.ts:222-301`
 *     (the cursor = the newest row; a provisioned workspace without one is an error);
 *   - `upgrade-sequence-reader.service.ts:175-204` (the new-workspace / adopted cursor = the version's last step).
 *
 * Crewflow additions (D-RUNNER.md §4): one REPEATABLE READ transaction per (workspace, command) with the tenant bound to that
 * workspace (FORCE RLS stays, §0.2), `SET LOCAL ROLE crewflow` like WorkspaceSchemaMigrator (M-T2), the per-schema advisory
 * lock and the registry row FOR UPDATE; then the post-step checks that replace the module fingerprints: session invariants,
 * catalog isolation (nothing outside this workspace schema written by the transaction) and the structure check
 * (core.verify_workspace_schema_v1 + core.workspace_schema_fingerprint == the expected fingerprint of the structure level).
 * Plus the one-time ADOPTION of the workspace-module history (D-RUNNER.md §5).
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
  WorkspaceCursor,
  withUpgradeScope,
} from './upgrade-migration.service';
import { InstanceRegistry, lastStepOfVersion, SequenceStep, sequenceForVersions, versionOfStep, WorkspaceRegistry } from './upgrade-sequence';
import { ADOPTION_RELEASE_VERSION, compareVersions } from './upgrade-version';
import {
  EXPECTED_WORKSPACE_FINGERPRINTS,
  FingerprintMajor,
  selectWorkspaceFingerprintsForServer,
} from '../../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';

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
}

export type WorkspaceOutcomeStatus = 'up-to-date' | 'upgraded' | 'adopted' | 'failed' | 'refused' | 'ahead';

export interface WorkspaceOutcome {
  workspaceId: string;
  status: WorkspaceOutcomeStatus;
  /** The step that failed or was refused (a step name) or the adoption label. */
  step?: string;
  errorClass?: string;
  attempt?: number;
  /** Steps completed for this workspace in this run. */
  completed: string[];
}

export interface WorkspaceRunReport {
  outcomes: WorkspaceOutcome[];
  /** Failed or refused workspaces (a failed step, a refused adoption, an unknown cursor). */
  failures: WorkspaceOutcome[];
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
  /** Test seam: the expected fingerprint of a structure level (default: the reviewed tables). */
  expectedFingerprint?: (level: number, major: FingerprintMajor) => string | undefined;
}

/** READY workspaces in id order: core.worker_list_workspaces pages, each registry row read with its organisation bound. */
export async function listReadyWorkspaces(query: Query, only?: readonly string[]): Promise<ReadyWorkspace[]> {
  const out: ReadyWorkspace[] = [];
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
        const rows = (await query('SELECT status, schema_name, module_version FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.workspace_id])) as Array<{
          status: string;
          schema_name: string;
          module_version: number;
        }>;
        await query('COMMIT');
        const r = rows[0];
        if (r?.status === 'READY') {
          const schemaName = workspaceSchemaOf(ws.workspace_id);
          if (r.schema_name !== schemaName) throw new Error(`workspace ${ws.workspace_id}: registry schema name differs from the derived name. Refusing.`);
          out.push({ workspaceId: ws.workspace_id, organisationId: ws.organisation_id, schemaName, moduleVersion: Number(r.module_version) });
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

/**
 * Pure (Twenty getPendingWorkspaceCommands, by sequence position): the code version's workspace steps that are after the
 * cursor, or from it when the cursor is `failed`. `null` = the cursor is not in this code's sequence.
 */
export function pendingWorkspaceSteps(sequence: readonly SequenceStep[], codeVersion: string, cursor: Pick<WorkspaceCursor, 'name' | 'status'>): SequenceStep[] | null {
  const at = sequence.findIndex((s) => s.name === cursor.name);
  if (at === -1) return null;
  return sequence.filter((s, i) => s.kind === 'workspace' && s.version === codeVersion && (i > at || (i === at && cursor.status === 'failed')));
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

const INVARIANTS_SQL = `SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.transaction_timestamp()::text AS tx,
  pg_catalog.current_setting('role') AS role, pg_catalog.current_setting('search_path') AS search_path,
  COALESCE(pg_catalog.current_setting('rab.organisation_id', true), '') AS org,
  COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS ws,
  COALESCE(pg_catalog.current_setting('rab.upgrade_scope', true), '') AS scope`;

/**
 * Layer 4, counts: objects OUTSIDE the target schema (TOAST and temporary namespaces excluded), so a DROP elsewhere is seen
 * (a dropped row leaves no xmin). Internal (constraint) triggers are excluded: a foreign key of the target table to a core
 * table adds them on the referenced table.
 */
export const OUTSIDE_COUNTS_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
o AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname <> $1 AND n.nspname !~ '^pg_(toast|temp_|toast_temp_)')
SELECT pg_catalog.concat_ws(',',
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace n WHERE n.oid NOT IN (SELECT oid FROM t) AND n.nspname !~ '^pg_(temp_|toast_temp_)'),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint k WHERE k.connamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc f WHERE f.pronamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type y WHERE y.typnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class WHERE c.relnamespace IN (SELECT oid FROM o))
) AS counts`;

/**
 * Layer 4, writes: catalog rows written by THIS transaction (REPEATABLE READ: `age(xmin) <= 0` is this transaction or one of
 * its subtransactions; a concurrent commit is not in the snapshot) that belong to anything outside the target schema. The
 * target's own TOAST relations and the internal RI triggers of the target's own constraints are allowed.
 */
export const OUTSIDE_WRITES_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
inside AS (
  SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM t)
  UNION ALL SELECT c.reltoastrelid FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM t) AND c.reltoastrelid <> 0
  UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.reltoastrelid = i.indrelid
             WHERE c.relnamespace IN (SELECT oid FROM t) AND c.reltoastrelid <> 0),
w AS (
  SELECT 'schema ' || n.nspname AS what FROM pg_catalog.pg_namespace n WHERE pg_catalog.age(n.xmin) <= 0 AND n.oid NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'relation ' || c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c WHERE pg_catalog.age(c.xmin) <= 0 AND c.oid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'column ' || a.attrelid::pg_catalog.regclass::text || '.' || a.attname FROM pg_catalog.pg_attribute a
             WHERE pg_catalog.age(a.xmin) <= 0 AND a.attrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'constraint ' || k.conname FROM pg_catalog.pg_constraint k WHERE pg_catalog.age(k.xmin) <= 0 AND k.connamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'trigger ' || g.tgname FROM pg_catalog.pg_trigger g WHERE pg_catalog.age(g.xmin) <= 0 AND g.tgrelid NOT IN (SELECT oid FROM inside)
             AND NOT (g.tgisinternal AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.oid = g.tgconstraint AND k.connamespace IN (SELECT oid FROM t)))
  UNION ALL SELECT 'policy ' || p.polname FROM pg_catalog.pg_policy p WHERE pg_catalog.age(p.xmin) <= 0 AND p.polrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'function ' || f.proname FROM pg_catalog.pg_proc f WHERE pg_catalog.age(f.xmin) <= 0 AND f.pronamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'type ' || y.typname FROM pg_catalog.pg_type y WHERE pg_catalog.age(y.xmin) <= 0 AND y.typnamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'index ' || x.indexrelid::pg_catalog.regclass::text FROM pg_catalog.pg_index x WHERE pg_catalog.age(x.xmin) <= 0 AND x.indrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'default ' || d.adrelid::pg_catalog.regclass::text FROM pg_catalog.pg_attrdef d WHERE pg_catalog.age(d.xmin) <= 0 AND d.adrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'rule ' || r.rulename FROM pg_catalog.pg_rewrite r WHERE pg_catalog.age(r.xmin) <= 0 AND r.ev_class NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'default privileges' FROM pg_catalog.pg_default_acl a WHERE pg_catalog.age(a.xmin) <= 0 AND a.defaclnamespace NOT IN (SELECT oid FROM t))
SELECT what FROM w LIMIT 10`;

interface Invariants {
  pid: number;
  tx: string;
  role: string;
  search_path: string;
  org: string;
  ws: string;
  scope: string;
}

export class WorkspaceCommandRunner {
  private major: FingerprintMajor | null = null;

  constructor(private readonly options: WorkspaceRunOptions) {}

  private get lockTimeout(): number {
    return Math.max(100, Math.min(this.options.lockTimeoutMs ?? 5_000, 60_000));
  }

  /** Runs every workspace; never throws for one workspace's failure (reported). Throws only for a run-level problem. */
  async run(session: UpgradeSession): Promise<WorkspaceRunReport> {
    const { codeVersion, versions, log, registry, workspaceRegistry, force } = this.options;
    const sequence = sequenceForVersions([...versions, codeVersion], registry, workspaceRegistry);
    const levels = structureLevels(sequence);
    const workspaces = await listReadyWorkspaces(session.query, this.options.workspaceIds);
    if (workspaces.length) this.major = await selectWorkspaceFingerprintsForServer(session.query as (sql: string) => Promise<Array<Record<string, unknown>>>);
    const cursors = await withUpgradeScope(session, 'upgrade', (q) => getWorkspaceCursors(q, workspaces.map((w) => w.workspaceId)));
    const adoptedName = lastStepOfVersion(codeVersion, registry, workspaceRegistry);
    const report: WorkspaceRunReport = { outcomes: [], failures: [] };
    const total = workspaces.length;
    log(`workspace upgrade (${codeVersion}${force ? ', --force' : ''}): ${total} READY workspace(s)`);

    for (const [index, ws] of workspaces.entries()) {
      const outcome: WorkspaceOutcome = { workspaceId: ws.workspaceId, status: 'up-to-date', completed: [] };
      report.outcomes.push(outcome);
      let cursor: Pick<WorkspaceCursor, 'name' | 'status'> | undefined = cursors.get(ws.workspaceId);

      if (!cursor) {
        if (!this.options.adopt) {
          Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceCursor`, errorClass: 'NO_CURSOR' });
          report.failures.push(outcome);
          log(`ERROR: workspace ${ws.workspaceId} (${index + 1}/${total}) has no upgrade logbook row (only ${ADOPTION_RELEASE_VERSION} adopts the workspace-module history); refused, nothing run`);
          continue;
        }
        const refusal = await this.adopt(session, ws, adoptedName);
        if (refusal) {
          Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceAdoption`, errorClass: refusal });
          report.failures.push(outcome);
          log(`ERROR: workspace ${ws.workspaceId} (${index + 1}/${total}) not adopted (${refusal}); no row written, retried on the next start`);
          continue;
        }
        outcome.status = 'adopted';
        cursor = { name: adoptedName, status: 'completed' };
        log(`workspace ${ws.workspaceId} (${index + 1}/${total}) adopted: is_initial row ${adoptedName}`);
      }

      const pending = pendingWorkspaceSteps(sequence, codeVersion, cursor);
      if (pending === null) {
        const v = versionOfStep(cursor.name);
        if (v !== null && compareVersions(v, codeVersion) > 0) {
          outcome.status = 'ahead';
          log(`WARNING: workspace ${ws.workspaceId} is at ${cursor.name}, newer than this code (${codeVersion}): rollback, nothing run`);
        } else {
          Object.assign(outcome, { status: 'refused', step: `${codeVersion}_WorkspaceCursor`, errorClass: 'UNKNOWN_CURSOR' });
          report.failures.push(outcome);
          log(`ERROR: workspace ${ws.workspaceId}: its cursor is not a step this code knows; refused, nothing run`);
        }
        continue;
      }

      for (const step of pending) {
        const command = step.command!;
        try {
          await this.runStep(session, ws, step.name, command, levels);
        } catch (error) {
          const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
            recordWorkspaceUpgradeMigration(q, { name: step.name, workspaceId: ws.workspaceId, status: 'failed', executedByVersion: codeVersion, forced: force, error }),
          );
          Object.assign(outcome, {
            status: 'failed',
            step: step.name,
            errorClass: error instanceof WorkspaceStepRefused ? error.errorClass : errorClassOf(error),
            attempt,
          });
          report.failures.push(outcome);
          log(`ERROR: workspace ${ws.workspaceId} (${index + 1}/${total}): ${step.name} FAILED (attempt ${attempt}, ${outcome.errorClass}); rolled back, its later steps skipped, the next start retries it`);
          break;
        }
        const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
          recordWorkspaceUpgradeMigration(q, { name: step.name, workspaceId: ws.workspaceId, status: 'completed', executedByVersion: codeVersion, forced: force }),
        );
        outcome.completed.push(step.name);
        if (outcome.status === 'up-to-date') outcome.status = 'upgraded';
        log(`workspace ${ws.workspaceId} (${index + 1}/${total}): ${step.name} completed (attempt ${attempt})`);
      }
    }
    log(`workspace upgrade: ${report.outcomes.length - report.failures.length} ok, ${report.failures.length} failed or refused`);
    return report;
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
      else refusal = await this.structureProblem(q, ws, level);
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

      // Layer 4: nothing outside this workspace schema was written or dropped by this transaction.
      const outside = (await q(OUTSIDE_WRITES_SQL, [ws.schemaName])) as Array<{ what: string }>;
      if (outside.length) throw new WorkspaceStepRefused('OUTSIDE_SCHEMA', `${name} changed objects outside ${ws.schemaName}: ${outside.map((o) => o.what).join('; ')}`);
      const [countsAfter] = (await q(OUTSIDE_COUNTS_SQL, [ws.schemaName])) as Array<{ counts: string }>;
      if (countsBefore?.counts !== countsAfter?.counts) throw new WorkspaceStepRefused('OUTSIDE_SCHEMA', `${name} added or dropped objects outside ${ws.schemaName}`);

      // Layer 5: the structure check (the fingerprint safety, kept inside the runner).
      const problem = await this.structureProblem(q, ws, target);
      if (problem) throw new WorkspaceStepRefused(problem, `${name}: the workspace structure after the step is not structure level ${target}`);
      if (target !== level) {
        const [fp] = (await q('SELECT core.workspace_schema_fingerprint($1) AS f', [ws.workspaceId])) as Array<{ f: string }>;
        await q(
          `UPDATE core.workspace_schema_registry
              SET module_version = $2, expected_fingerprint = $3, observed_fingerprint = $3, fingerprint_checked_at = now(),
                  drift_status = 'OK', drift_detail = NULL, migration_error = NULL, last_migrated_at = now()
            WHERE workspace_id = $1`,
          [ws.workspaceId, target, fp!.f],
        );
      }
      await q('COMMIT');
    } catch (error) {
      await q('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** Role (M-T2, as WorkspaceSchemaMigrator.actAsMigrationRole), search_path, tenant binding, per-schema lock. Inside a transaction. */
  private async enterWorkspace(q: Query, ws: ReadyWorkspace): Promise<void> {
    const [r] = (await q(
      `SELECT (current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
               OR coalesce((SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user), false)) AS allowed,
              EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'SET') AS can_set`,
    )) as Array<{ allowed: boolean; can_set: boolean }>;
    if (!r?.allowed && r?.can_set) await q(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
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
    const { registry, workspaceRegistry, versions, codeVersion } = this.options;
    return structureLevels(sequenceForVersions([...versions, codeVersion], registry, workspaceRegistry)).get(level)?.fingerprints[major];
  }
}

/** A safe class for an unexpected error: the SQLSTATE or the error name (the full text goes to the logbook row as-is). */
export function errorClassOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === '55P03') return 'LOCK_TIMEOUT';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : 'INTERNAL';
}

