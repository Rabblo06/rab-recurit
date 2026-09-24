import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { StorageDriverFactory } from '../engine/core-modules/storage/storage-driver.factory';
import { normaliseKeyPrefix } from '../engine/core-modules/storage/storage-key-prefix';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import { beginRlsDiscovery } from '../queue-worker/shared/discovery-lock';

interface Options {
  checkBytes?: boolean;
  reportFile?: string;
  failStalePending?: boolean;
  purgeDeletedImagesOlderThanDays?: number;
}

interface Row {
  id: string;
  organisation_id: string;
  kind: string;
  status: string;
  object_key: string;
  size_bytes: string;
  sha256: string | null;
  expires_at: Date | null;
  deleted_at: Date | null;
}

/**
 * `storage:reconcile` — compares PostgreSQL metadata with the object store and
 * REPORTS. PostgreSQL and S3 are not one transaction, so drift is possible by
 * design (a crash between upload and commit; an object deleted out of band; a
 * restored database). This is the tool that finds it.
 *
 * Default is REPORT-ONLY (dry run). Nothing is modified unless an explicit
 * flag says so, and an object with no database owner is NEVER deleted
 * automatically — it is listed for a human to review.
 *
 *   DB says AVAILABLE, object missing        -> missing_objects
 *   object size differs from the row         -> size_mismatches
 *   sha256 differs (with --check-bytes)      -> checksum_mismatches
 *   object under our prefix with no row      -> orphan_objects
 *   PENDING upload past its expiry           -> stale_pending (--fail-stale-pending marks FAILED + removes the partial object)
 *   DELETED row whose object still exists    -> deleted_with_object (--purge-deleted-images-older-than-days N removes image objects only)
 *
 * Exit code 1 when any integrity problem (missing/size/checksum) is found, so
 * it can gate a restore or run from cron.
 *
 * Connects as `rab_owner` like the other CLI commands; it brackets its
 * cross-tenant metadata read with the same bounded-lock-timeout RLS toggle the
 * worker's discovery scans use, in short per-page transactions.
 */
@Command({ name: 'storage:reconcile', description: 'Compare stored_file metadata with the object store (report-only unless flags say otherwise)' })
export class StorageReconcileCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly drivers: StorageDriverFactory,
    private readonly env: EnvironmentService,
  ) {
    super();
  }

  @Option({ flags: '--check-bytes', description: 'Download every AVAILABLE object and verify its SHA-256 (slow, thorough)' })
  parseCheckBytes(): boolean {
    return true;
  }

  @Option({ flags: '--report-file <path>', description: 'Write the JSON report to this path' })
  parseReportFile(value: string): string {
    return value;
  }

  @Option({ flags: '--fail-stale-pending', description: 'MODIFIES: mark expired PENDING uploads FAILED and remove their partial objects' })
  parseFailStalePending(): boolean {
    return true;
  }

  @Option({ flags: '--purge-deleted-images-older-than-days <n>', description: 'MODIFIES: remove the objects of DELETED avatar/logo rows older than N days' })
  parsePurge(value: string): number {
    return Number(value);
  }

  async run(_params: string[], options: Options): Promise<void> {
    const driver = this.drivers.getDriver();
    const prefix = `${normaliseKeyPrefix(this.env.get('STORAGE_KEY_PREFIX'))}organisations/`;
    const report = {
      driver: driver.name,
      bucket: driver.bucket,
      mode: options.failStalePending || options.purgeDeletedImagesOlderThanDays ? 'MODIFYING (explicit flags)' : 'REPORT-ONLY',
      checkedRows: 0,
      missing_objects: [] as Array<{ fileId: string; organisationId: string; kind: string }>,
      size_mismatches: [] as Array<{ fileId: string; expected: number; actual: number }>,
      checksum_mismatches: [] as Array<{ fileId: string }>,
      orphan_objects: [] as Array<{ key: string; sizeBytes: number }>,
      stale_pending: [] as Array<{ fileId: string; expiredAt: string | null }>,
      deleted_with_object: [] as Array<{ fileId: string; kind: string }>,
      actions: [] as string[],
    };
    const knownKeys = new Set<string>();

    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await this.readPage(after);
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      for (const row of page) {
        report.checkedRows += 1;
        knownKeys.add(row.object_key);
        const head = await driver.head(row.object_key);
        if (row.status === 'AVAILABLE') {
          if (!head) report.missing_objects.push({ fileId: row.id, organisationId: row.organisation_id, kind: row.kind });
          else if (head.sizeBytes !== Number(row.size_bytes)) report.size_mismatches.push({ fileId: row.id, expected: Number(row.size_bytes), actual: head.sizeBytes });
          else if (options.checkBytes) {
            const bytes = await driver.get(row.object_key);
            const { createHash } = await import('node:crypto');
            if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) report.checksum_mismatches.push({ fileId: row.id });
          }
        } else if (row.status === 'PENDING' && row.expires_at && row.expires_at.getTime() < Date.now()) {
          report.stale_pending.push({ fileId: row.id, expiredAt: row.expires_at.toISOString() });
          if (options.failStalePending) {
            await this.markFailed(row.id);
            await driver.delete(row.object_key).catch(() => undefined);
            report.actions.push(`failed stale pending ${row.id}`);
          }
        } else if (row.status === 'DELETED' && head) {
          report.deleted_with_object.push({ fileId: row.id, kind: row.kind });
          const imageKind = ['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO'].includes(row.kind);
          const ageDays = row.deleted_at ? (Date.now() - row.deleted_at.getTime()) / 86_400_000 : 0;
          if (options.purgeDeletedImagesOlderThanDays && imageKind && ageDays >= options.purgeDeletedImagesOlderThanDays) {
            await driver.delete(row.object_key);
            report.actions.push(`purged object of deleted image ${row.id}`);
          }
        }
      }
    }

    // Orphans: objects we can see under our own prefix that no row owns. Reported, never auto-deleted.
    for await (const object of driver.list(prefix)) {
      if (!knownKeys.has(object.key)) report.orphan_objects.push({ key: object.key, sizeBytes: object.sizeBytes });
    }

    const integrityProblems = report.missing_objects.length + report.size_mismatches.length + report.checksum_mismatches.length;
    const json = JSON.stringify({ ...report, summary: { integrityProblems, orphans: report.orphan_objects.length, stalePending: report.stale_pending.length } }, null, 2);
    if (options.reportFile) writeFileSync(options.reportFile, json);
    // eslint-disable-next-line no-console
    console.log(json);
    if (integrityProblems > 0) process.exitCode = 1;
  }

  private async readPage(afterId: string): Promise<Row[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_storage_reconcile'))`);
      await beginRlsDiscovery(manager);
      await manager.query(`ALTER TABLE core.stored_file DISABLE ROW LEVEL SECURITY;`);
      try {
        return await manager.query<Row[]>(
          `SELECT id, organisation_id, kind, status, object_key, size_bytes::text, sha256, expires_at, deleted_at
             FROM core.stored_file WHERE id > $1 ORDER BY id LIMIT 200`,
          [afterId],
        );
      } finally {
        await manager.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY;`);
      }
    });
  }

  private async markFailed(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await beginRlsDiscovery(manager);
      await manager.query(`ALTER TABLE core.stored_file DISABLE ROW LEVEL SECURITY;`);
      try {
        await manager.query(`UPDATE core.stored_file SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [id]);
      } finally {
        await manager.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY;`);
      }
    });
  }
}
