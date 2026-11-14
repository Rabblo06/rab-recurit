/**
 * OWNER-DB-ULTIMATE Part B3: the upgrade status for `/healthz` and the admin Health banner, Twenty's upgrade status / gauge
 * (twentyhq/twenty @ eedb0a73 `engine/core-modules/upgrade/services/upgrade-status.service.ts:102-116`,
 * `upgrade-gauge.service.ts:37-56`: up to date / behind / failed). Re-implemented, not copied.
 *
 * Read with PLAIN queries in one short transaction that sets `rab.upgrade_scope = 'status'` (read-only policy; no tenant is
 * bound on this connection). Returns fixed fields only: never `error_message` (it is stored as-is and may hold what a failing
 * step printed), never a workspace. Cached for CACHE_MS so /healthz polling does not hit the database each time; a read
 * failure reports `unknown` (informational: /healthz stays 200 by the owner's decision).
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  countFailedWorkspaceCursors,
  failedWorkspaceCursors,
  workspacesWithoutRows,
  getLastAttemptedInstanceStep,
  instanceVersions,
  isLastAttemptCompleted,
  upgradeLedgerExists,
  upgradeSessionOf,
  UpgradeSession,
  withUpgradeScope,
} from './upgrade-migration.service';
import { instanceStepsForVersion, lastInstanceStepOfVersion } from './upgrade-sequence';
import { compareVersions, readAppVersion } from './upgrade-version';
import { listReadyWorkspaces } from './workspace-command-runner';
import { parseUpgradeBlock } from './workspace-upgrade-block';

export type UpgradeState = 'ok' | 'failed' | 'behind' | 'ahead' | 'none' | 'unknown';

export interface UpgradeStatus {
  appVersion: string | null;
  state: UpgradeState;
  /** The last attempted instance step (name, its version, attempt, forced, when). Null when none. */
  step: string | null;
  executedByVersion: string | null;
  attempt: number | null;
  forced: boolean | null;
  at: string | null;
  /**
   * Owner D2/D3: the workspaces that failed a step or were refused (admin health only; /healthz uses `state` alone). Workspace
   * id, step name, an error CLASS label and whether it is blocked (503, Worker paused); never a message. At most 50.
   */
  workspaces?: WorkspaceUpgradeIssue[];
}

export interface WorkspaceUpgradeIssue {
  workspaceId: string;
  step: string | null;
  errorClass: string;
  blocked: boolean;
}

/** Pure: a class label from the start of a stored message (`WorkspaceStepRefused: CLASS: …` or `<ErrorName>: …`), nothing else. */
export function errorClassLabel(stored: string): string {
  const refused = /^WorkspaceStepRefused: ([A-Z][A-Z0-9_]{1,40}):/.exec(stored);
  if (refused) return refused[1]!;
  const named = /^([A-Za-z][A-Za-z0-9]{0,60}):/.exec(stored);
  return named ? named[1]! : 'Error';
}

/**
 * Pure: the state from the facts (exported for its spec). Part D: `workspaceStepFailed` = some workspace's cursor is a failed
 * step (any version), or a READY workspace has no logbook row at all (not adopted: the child exited 70); either turns an
 * otherwise complete instance to 'failed' (Twenty's per-workspace upgrade status).
 */
export function upgradeStateOf(f: { ledgerExists: boolean; appComplete: boolean; newer: boolean; appStepFailed: boolean; anyRow: boolean; workspaceStepFailed?: boolean }): UpgradeState {
  if (!f.ledgerExists || !f.anyRow) return 'none';
  if (f.newer) return 'ahead';
  if (f.appComplete && !f.workspaceStepFailed) return 'ok';
  if (f.appStepFailed || f.workspaceStepFailed) return 'failed';
  return 'behind';
}

export async function readUpgradeStatus(session: UpgradeSession, appVersion: string): Promise<UpgradeStatus> {
  const empty: UpgradeStatus = { appVersion, state: 'none', step: null, executedByVersion: null, attempt: null, forced: null, at: null };
  if (!(await upgradeLedgerExists(session.query))) return empty;
  // L3: workspaces with no logbook row at all (cheap in steady state: after adoption every workspace has one); only those are
  // then checked for READY, each with its organisation bound in its own short transaction, outside the status scope.
  const scan = await withUpgradeScope(session, 'status', async (q) => {
    const orgs = new Map<string, string>();
    let after: string | null = null;
    for (;;) {
      const page = (await q('SELECT workspace_id::text AS id, organisation_id::text AS org FROM core.worker_list_workspaces($1, 100)', [after])) as Array<{ id: string; org: string }>;
      for (const p of page) orgs.set(p.id, p.org);
      if (page.length < 100) break;
      after = page[page.length - 1]!.id;
    }
    return { orgs, withoutRows: await workspacesWithoutRows(q, [...orgs.keys()]), failed: await failedWorkspaceCursors(q) };
  });
  const readyWithoutRows = scan.withoutRows.length ? await listReadyWorkspaces(session.query, scan.withoutRows) : [];
  const readyWithoutCursor = readyWithoutRows.length;
  const workspaces = await readWorkspaceIssues(session, scan.orgs, scan.failed, readyWithoutRows.map((w) => w.workspaceId));
  return withUpgradeScope(session, 'status', async (q) => {
    const last = await getLastAttemptedInstanceStep(q);
    const versions = await instanceVersions(q);
    const appComplete = await isLastAttemptCompleted(q, { name: lastInstanceStepOfVersion(appVersion), workspaceId: null });
    const workspaceStepFailed = (await countFailedWorkspaceCursors(q)) > 0 || readyWithoutCursor > 0;
    let appStepFailed = false;
    for (const name of instanceStepsForVersion(appVersion)) {
      const rows = (await q(`SELECT m.status FROM core.upgrade_migration m WHERE m.name = $1 AND m.workspace_id IS NULL ORDER BY m.attempt DESC LIMIT 1`, [name])) as Array<{ status: string }>;
      if (rows[0]?.status === 'failed') appStepFailed = true;
    }
    const state = upgradeStateOf({
      ledgerExists: true,
      anyRow: versions.length > 0,
      newer: versions.some((v) => compareVersions(v, appVersion) > 0),
      appComplete,
      appStepFailed,
      workspaceStepFailed,
    });
    return {
      appVersion,
      state,
      step: last?.name ?? null,
      executedByVersion: last?.executedByVersion ?? null,
      attempt: last?.attempt ?? null,
      forced: last?.forced ?? null,
      at: last ? last.createdAt.toISOString() : null,
      ...(workspaces.length ? { workspaces } : {}),
    };
  });
}

/**
 * Owner D2/D3: one entry per failed / refused workspace. The block marker (registry, read with the workspace's organisation
 * bound, each in its own short transaction) gives `blocked` and its class; otherwise the class label of the stored message.
 */
async function readWorkspaceIssues(
  session: UpgradeSession,
  orgs: ReadonlyMap<string, string>,
  failed: ReadonlyArray<{ workspaceId: string; name: string; label: string }>,
  withoutRows: readonly string[],
): Promise<WorkspaceUpgradeIssue[]> {
  const entries = new Map<string, WorkspaceUpgradeIssue>();
  for (const f of failed) entries.set(f.workspaceId, { workspaceId: f.workspaceId, step: f.name, errorClass: errorClassLabel(f.label), blocked: false });
  for (const id of withoutRows) if (!entries.has(id)) entries.set(id, { workspaceId: id, step: null, errorClass: 'NO_CURSOR', blocked: false });
  const q = session.query;
  for (const e of [...entries.values()].slice(0, 50)) {
    const org = orgs.get(e.workspaceId);
    if (!org) continue;
    await q('BEGIN');
    try {
      await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true)`, [org]);
      const [r] = (await q('SELECT migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1', [e.workspaceId])) as Array<{ migration_error: string | null }>;
      await q('COMMIT');
      const block = parseUpgradeBlock(r?.migration_error);
      if (block) Object.assign(e, { blocked: true, errorClass: block.errorClass, step: block.step || e.step });
    } catch {
      await q('ROLLBACK').catch(() => undefined);
    }
  }
  return [...entries.values()].slice(0, 50);
}

@Injectable()
export class UpgradeStatusService {
  static readonly CACHE_MS = 30_000;
  private readonly logger = new Logger(UpgradeStatusService.name);
  private cached: { at: number; value: UpgradeStatus } | null = null;
  /** Security review L5: ONE read in flight; concurrent callers on an expired cache share it (one connection, not N). */
  private inFlight: Promise<UpgradeStatus> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async status(): Promise<UpgradeStatus> {
    if (this.cached && Date.now() - this.cached.at < UpgradeStatusService.CACHE_MS) return this.cached.value;
    if (!this.inFlight) {
      this.inFlight = this.read().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async read(): Promise<UpgradeStatus> {
    let value: UpgradeStatus;
    let appVersion: string | null = null;
    try {
      appVersion = readAppVersion();
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        value = await readUpgradeStatus(upgradeSessionOf(runner), appVersion);
      } finally {
        await runner.release();
      }
    } catch (error) {
      this.logger.warn(`upgrade status unavailable (${error instanceof Error ? error.name : 'error'})`);
      value = { appVersion, state: 'unknown', step: null, executedByVersion: null, attempt: null, forced: null, at: null };
    }
    this.cached = { at: Date.now(), value };
    return value;
  }
}
