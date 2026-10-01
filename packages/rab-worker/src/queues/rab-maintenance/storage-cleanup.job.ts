import { Logger } from '@nestjs/common';

import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';

const logger = new Logger('StorageCleanupJob');

export interface StorageCleanupResult {
  checkedRows: number;
  integrityProblems: number;
  orphans: number;
  actionsTaken: number;
}

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
 */
export async function runStorageCleanupCycle(
  command: StorageReconcileCommand,
  purgeDeletedImagesOlderThanDays: number,
): Promise<StorageCleanupResult> {
  await command.run([], { failStalePending: true, purgeDeletedImagesOlderThanDays });
  const report = command.lastReport;
  const result: StorageCleanupResult = {
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
