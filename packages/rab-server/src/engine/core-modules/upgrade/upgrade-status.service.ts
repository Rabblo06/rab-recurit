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
  getLastAttemptedInstanceStep,
  instanceVersions,
  isLastAttemptCompleted,
  Query,
  upgradeLedgerExists,
  withUpgradeScope,
} from './upgrade-migration.service';
import { lastStepOfVersion, stepsForVersion } from './upgrade-sequence';
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

/** Pure: the state from the facts (exported for its spec). */
export function upgradeStateOf(f: { ledgerExists: boolean; appComplete: boolean; newer: boolean; appStepFailed: boolean; anyRow: boolean }): UpgradeState {
  if (!f.ledgerExists || !f.anyRow) return 'none';
  if (f.newer) return 'ahead';
  if (f.appComplete) return 'ok';
  if (f.appStepFailed) return 'failed';
  return 'behind';
}

export async function readUpgradeStatus(query: Query, appVersion: string): Promise<UpgradeStatus> {
  const empty: UpgradeStatus = { appVersion, state: 'none', step: null, executedByVersion: null, attempt: null, forced: null, at: null };
  if (!(await upgradeLedgerExists(query))) return empty;
  return withUpgradeScope(query, 'status', async (q) => {
    const last = await getLastAttemptedInstanceStep(q);
    const versions = await instanceVersions(q);
    const appComplete = await isLastAttemptCompleted(q, { name: lastStepOfVersion(appVersion), workspaceId: null });
    let appStepFailed = false;
    for (const name of stepsForVersion(appVersion)) {
      const rows = (await q(`SELECT m.status FROM core.upgrade_migration m WHERE m.name = $1 AND m.workspace_id IS NULL ORDER BY m.attempt DESC LIMIT 1`, [name])) as Array<{ status: string }>;
      if (rows[0]?.status === 'failed') appStepFailed = true;
    }
    const state = upgradeStateOf({
      ledgerExists: true,
      anyRow: versions.length > 0,
      newer: versions.some((v) => compareVersions(v, appVersion) > 0),
      appComplete,
      appStepFailed,
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

  constructor(private readonly dataSource: DataSource) {}

  async status(): Promise<UpgradeStatus> {
    if (this.cached && Date.now() - this.cached.at < UpgradeStatusService.CACHE_MS) return this.cached.value;
    let value: UpgradeStatus;
    let appVersion: string | null = null;
    try {
      appVersion = readAppVersion();
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        value = await readUpgradeStatus((sql, params) => runner.query(sql, params) as Promise<unknown[]>, appVersion);
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
