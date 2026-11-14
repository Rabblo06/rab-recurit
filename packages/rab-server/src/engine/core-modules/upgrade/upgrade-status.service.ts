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
  getLastAttemptedInstanceStep,
  instanceVersions,
  isLastAttemptCompleted,
  upgradeLedgerExists,
  upgradeSessionOf,
  UpgradeSession,
  withUpgradeScope,
} from './upgrade-migration.service';
import { commandStepName, instanceStepsForVersion, lastInstanceStepOfVersion, workspaceCommandsForVersion } from './upgrade-sequence';
import { compareVersions, readAppVersion } from './upgrade-version';

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
}

/**
 * Pure: the state from the facts (exported for its spec). Part D: `workspaceStepFailed` = some workspace's cursor is a failed
 * workspace step of the app version (Twenty's per-workspace upgrade status); it turns an otherwise complete instance to 'failed'.
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
  return withUpgradeScope(session, 'status', async (q) => {
    const last = await getLastAttemptedInstanceStep(q);
    const versions = await instanceVersions(q);
    const appComplete = await isLastAttemptCompleted(q, { name: lastInstanceStepOfVersion(appVersion), workspaceId: null });
    const workspaceSteps = workspaceCommandsForVersion(appVersion).map((c) => commandStepName(appVersion, c));
    const workspaceStepFailed = (await countFailedWorkspaceCursors(q, workspaceSteps)) > 0;
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
    };
  });
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
