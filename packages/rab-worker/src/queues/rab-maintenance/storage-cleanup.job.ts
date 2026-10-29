import { Logger } from '@nestjs/common';

import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';

const logger = new Logger('StorageCleanupJob');

export type StorageCleanupResult =
  | { ran: true; checkedRows: number; integrityProblems: number; orphans: number; actionsTaken: number }
  /** Another replica (or an operator's CLI run) holds the cluster-wide reconciliation lock: nothing was checked or changed. */
  | { ran: false; skipped: 'locked' };

/**
 * Schedules the EXISTING, already-safe `storage:reconcile` CLI command
 * (`StorageReconcileCommand`) — nothing about its reconciliation logic is
 * reimplemented here. `@Command()`-decorated classes are plain NestJS
 * providers; this is `WorkerModule.providers`' own copy of the class,
 * resolved via `appContext.get(StorageReconcileCommand)` in main.ts and
 * invoked exactly like the CLI would (`.run([], options)`), no different
 * code path. `command.lastReport` (a small additive property on the
 * existing class — see its own doc comment) is how this reads the outcome
 * without parsing stdout.
 *
 * The two flags enabled here are the same two narrow, already-reviewed
 * mutating actions the command's own author scoped it to — nothing new:
 *  - `failStalePending: true` — only ever touches a `PENDING` row already
 *    past its OWN `expires_at` (an abandoned partial upload nobody is still
 *    finishing); never a referenced/AVAILABLE file.
 *  - `purgeDeletedImagesOlderThanDays` — only ever removes the object of a
 *    row ALREADY marked `DELETED`, and only after
 *    `STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS` (default 30) days'
 *    grace, and only for image kinds (avatar/logo) — the command's own
 *    existing, narrow allowlist.
 *
 * `orphan_objects` (an object under our own prefix with no owning row at
 * all) is NEVER auto-deleted by the underlying command — there is no flag
 * for that, and none is added here. That safety boundary is preserved
 * exactly as the command's own doc comment states: reported, always, for a
 * human to review; this scheduled run inherits that, it does not loosen it.
 *
 * `--check-bytes` (downloads and re-hashes every AVAILABLE object) is
 * deliberately NOT enabled on a schedule — real, unbounded egress/CPU cost
 * against production storage; left as an on-demand, manually-run CLI
 * capability only.
 *
 * Phase A (storage): `lockWaitSeconds: 0` — one non-blocking attempt at the command's cluster-wide reconciliation lock.
 * A replica that loses returns `ran: false` (the processor then does NOT stamp `lastStorageCleanupAt`): the winner is
 * already reconciling, and a second pass straight after it would only repeat the same storage calls.
 */
export async function runStorageCleanupCycle(
  command: StorageReconcileCommand,
  purgeDeletedImagesOlderThanDays: number,
): Promise<StorageCleanupResult> {
  await command.run([], { failStalePending: true, purgeDeletedImagesOlderThanDays, lockWaitSeconds: 0 });
  if (command.lastSkipped === 'locked') return { ran: false, skipped: 'locked' };
  const report = command.lastReport;
  const result: StorageCleanupResult = {
    ran: true,
    checkedRows: report?.checkedRows ?? 0,
    integrityProblems: report?.summary.integrityProblems ?? 0,
    orphans: report?.summary.orphans ?? 0,
    actionsTaken: report?.actions.length ?? 0,
  };
  if (result.integrityProblems > 0 || result.orphans > 0 || result.actionsTaken > 0) {
    logger.log(
      `storage cleanup: checked=${result.checkedRows} integrityProblems=${result.integrityProblems} orphans=${result.orphans} actions=${result.actionsTaken}`,
    );
  }
  return result;
}

/** Clock-skew tolerance: a stamp further than this in the future is ignored (never allowed to suppress runs indefinitely). */
const FUTURE_STAMP_TOLERANCE_MS = 5 * 60 * 1000;

export type RecentRunCheck =
  | { recent: true; lastRunAt: number; ageMs: number }
  | { recent: false; reason: 'disabled' | 'no-stamp' | 'stale' | 'future-stamp' | 'unreadable'; lastRunAt?: number };

/**
 * Phase A (storage) — boot/replica de-duplication WITHOUT touching the scheduler. Interval mode runs every loop once at
 * boot (`WorkerRuntime.every()`), so every Worker restart — and every interval-mode replica — re-ran the full 24 h
 * reconciliation. This reads the EXISTING persisted success stamp (`lastStorageCleanupAt` in the Worker stats hash,
 * written by the runtime only when a storage-cleanup cycle SUCCEEDED, on any replica) and reports whether a successful
 * run finished less than `minSpacingMs` ago.
 *
 * Fails toward running (the historical behaviour): no stamp, an unreadable/invalid stamp, a Redis error, or a stamp
 * from the future (clock skew) all answer "not recent". A skipped cycle must return `false` from the processor so it is
 * never itself stamped as a success (otherwise a skip would refresh the stamp and suppress runs forever).
 */
export async function checkRecentStorageCleanup(
  readLastRunAt: () => Promise<string | null | undefined>,
  minSpacingMs: number,
  now: number = Date.now(),
): Promise<RecentRunCheck> {
  if (!(minSpacingMs > 0)) return { recent: false, reason: 'disabled' };
  let raw: string | null | undefined;
  try {
    raw = await readLastRunAt();
  } catch {
    return { recent: false, reason: 'unreadable' };
  }
  if (raw === null || raw === undefined || raw === '') return { recent: false, reason: 'no-stamp' };
  const lastRunAt = Number(raw);
  if (!Number.isFinite(lastRunAt) || lastRunAt <= 0) return { recent: false, reason: 'unreadable' };
  if (lastRunAt > now + FUTURE_STAMP_TOLERANCE_MS) return { recent: false, reason: 'future-stamp', lastRunAt };
  const ageMs = Math.max(0, now - lastRunAt);
  return ageMs < minSpacingMs ? { recent: true, lastRunAt, ageMs } : { recent: false, reason: 'stale', lastRunAt };
}
