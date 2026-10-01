import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { StorageDriverFactory } from '../engine/core-modules/storage/storage-driver.factory';
import { normaliseKeyPrefix } from '../engine/core-modules/storage/storage-key-prefix';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import {
  MaintenanceScope,
  storageScopes,
} from '../engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '../engine/utils/assert-runtime-db-role';

interface Options {
  checkBytes?: boolean;
  reportFile?: string;
  failStalePending?: boolean;
  purgeDeletedImagesOlderThanDays?: number;
  purgeFailedObjects?: boolean;
}

/** Returned by `run()` in addition to being logged/written — lets a caller (e.g. the scheduled worker job) read the outcome without parsing stdout. Never changes what the CLI itself prints; purely additive. */
export interface ReconcileReport {
  driver: string;
  bucket: string | null;
  mode: string;
  checkedRows: number;
  missing_objects: Array<{
    fileId: string;
    organisationId: string;
    kind: string;
  }>;
  size_mismatches: Array<{ fileId: string; expected: number; actual: number }>;
  checksum_mismatches: Array<{ fileId: string }>;
  orphan_objects: Array<{ key: string; sizeBytes: number }>;
  stale_pending: Array<{ fileId: string; expiredAt: string | null }>;
  deleted_with_object: Array<{ fileId: string; kind: string }>;
  /** A FAILED row (terminal) whose object was never removed — a delete that failed after a successful claim, or a claim whose delete step hasn't run yet. Never auto-resolved; `--purge-failed-objects` removes it, with a fresh re-check immediately before deleting. */
  failed_with_object: Array<{ fileId: string; kind: string }>;
  actions: string[];
  summary: { integrityProblems: number; orphans: number; stalePending: number };
}

interface Row {
  id: string;
  organisation_id: string;
  workspace_id: string | null;
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
 *   PENDING upload past its expiry           -> stale_pending (--fail-stale-pending CLAIMS PENDING->FAILED, then removes the object ONLY if that claim won)
 *   FAILED row whose object still exists     -> failed_with_object (--purge-failed-objects removes it, re-checked fresh first)
 *   DELETED row whose object still exists    -> deleted_with_object (--purge-deleted-images-older-than-days N removes image objects only, re-checked fresh first)
 *
 * The stale-PENDING path is the one place this command mutates a row that
 * might be racing a real request (`FileService.completeUpload` flipping the
 * SAME row to AVAILABLE). Ownership of the object is decided by a single
 * atomic `UPDATE ... WHERE status = 'PENDING' ... RETURNING` claim: if it
 * affects zero rows, AVAILABLE (or another cleanup process) already won and
 * this command MUST NOT touch the object — the row's in-memory snapshot from
 * the page read is never trusted for the delete step, only the claim's own
 * `RETURNING` row is. The DELETED/FAILED purge paths apply the same
 * discipline for a different reason: the page read can be minutes old by the
 * time a slow page finishes, so both re-read the row immediately before
 * deleting and skip if anything about it changed.
 *
 * Exit code 1 when any integrity problem (missing/size/checksum) is found, so
 * it can gate a restore or run from cron.
 *
 * Uses rab_app for all metadata access and mutations. A separate read-only
 * catalogue connection enumerates organisation/workspace IDs only.
 */
@Command({
  name: 'storage:reconcile',
  description:
    'Compare stored_file metadata with the object store (report-only unless flags say otherwise)',
})
export class StorageReconcileCommand extends CommandRunner {
  /** Set at the end of every `run()` — lets a caller (e.g. the scheduled worker job) read the outcome directly instead of parsing stdout. `run()` itself must stay `Promise<void>` to satisfy `CommandRunner`'s own abstract signature. */
  lastReport?: ReconcileReport;

  /** Worker supplies its existing owner catalogue pool; standalone CLI opens/closes one. */
  catalogueDataSource?: DataSource;

  constructor(
    private readonly dataSource: DataSource,
    private readonly drivers: StorageDriverFactory,
    private readonly env: EnvironmentService,
  ) {
    super();
  }

  @Option({
    flags: '--check-bytes',
    description:
      'Download every AVAILABLE object and verify its SHA-256 (slow, thorough)',
  })
  parseCheckBytes(): boolean {
    return true;
  }

  @Option({
    flags: '--report-file <path>',
    description: 'Write the JSON report to this path',
  })
  parseReportFile(value: string): string {
    return value;
  }

  @Option({
    flags: '--fail-stale-pending',
    description:
      'MODIFIES: mark expired PENDING uploads FAILED and remove their partial objects',
  })
  parseFailStalePending(): boolean {
    return true;
  }

  @Option({
    flags: '--purge-deleted-images-older-than-days <n>',
    description:
      'MODIFIES: remove the objects of DELETED avatar/logo rows older than N days',
  })
  parsePurge(value: string): number {
    return Number(value);
  }

  @Option({
    flags: '--purge-failed-objects',
    description:
      'MODIFIES: remove leftover objects belonging to already-FAILED rows (re-checked fresh before delete)',
  })
  parsePurgeFailedObjects(): boolean {
    return true;
  }

  async run(_params: string[], options: Options): Promise<void> {
    await assertRuntimeDbRole(this.dataSource, 'storage reconciliation');
    if (!this.catalogueDataSource && !process.env.DATABASE_URL_UNPOOLED)
      throw new Error('Storage reconciliation requires a catalogue connection');
    const catalogue =
      this.catalogueDataSource ??
      new DataSource({
        ...this.dataSource.options,
        url: process.env.DATABASE_URL_UNPOOLED,
      } as import('typeorm').DataSourceOptions);
    const ownsCatalogue = !this.catalogueDataSource;
    if (ownsCatalogue) await catalogue.initialize();
    try {
      await this.reconcile(options, catalogue);
    } finally {
      if (ownsCatalogue) await catalogue.destroy();
    }
  }

  private async reconcile(
    options: Options,
    catalogue: DataSource,
  ): Promise<void> {
    const driver = this.drivers.getDriver();
    const prefix = `${normaliseKeyPrefix(this.env.get('STORAGE_KEY_PREFIX'))}organisations/`;
    const report = {
      driver: driver.name,
      bucket: driver.bucket,
      mode:
        options.failStalePending ||
        options.purgeDeletedImagesOlderThanDays ||
        options.purgeFailedObjects
          ? 'MODIFYING (explicit flags)'
          : 'REPORT-ONLY',
      checkedRows: 0,
      missing_objects: [] as Array<{
        fileId: string;
        organisationId: string;
        kind: string;
      }>,
      size_mismatches: [] as Array<{
        fileId: string;
        expected: number;
        actual: number;
      }>,
      checksum_mismatches: [] as Array<{ fileId: string }>,
      orphan_objects: [] as Array<{ key: string; sizeBytes: number }>,
      stale_pending: [] as Array<{ fileId: string; expiredAt: string | null }>,
      deleted_with_object: [] as Array<{ fileId: string; kind: string }>,
      failed_with_object: [] as Array<{ fileId: string; kind: string }>,
      actions: [] as string[],
    };
    const knownKeys = new Set<string>();

    for await (const scope of storageScopes(catalogue)) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const page = await this.readPage(after, scope);
        if (page.length === 0) break;
        after = page[page.length - 1]!.id;
        for (const row of page) {
          report.checkedRows += 1;
          knownKeys.add(row.object_key);
          const head = await driver.head(row.object_key);
          if (row.status === 'AVAILABLE') {
            if (!head)
              report.missing_objects.push({
                fileId: row.id,
                organisationId: row.organisation_id,
                kind: row.kind,
              });
            else if (head.sizeBytes !== Number(row.size_bytes))
              report.size_mismatches.push({
                fileId: row.id,
                expected: Number(row.size_bytes),
                actual: head.sizeBytes,
              });
            else if (options.checkBytes) {
              const bytes = await driver.get(row.object_key);
              const { createHash } = await import('node:crypto');
              if (
                !bytes ||
                createHash('sha256').update(bytes).digest('hex') !== row.sha256
              )
                report.checksum_mismatches.push({ fileId: row.id });
            }
          } else if (
            row.status === 'PENDING' &&
            row.expires_at &&
            row.expires_at.getTime() < Date.now()
          ) {
            // Report-only visibility uses the page snapshot's timestamp (cheap, advisory). The MUTATING claim below never
            // trusts it — the claim's own WHERE clause re-checks expiry against PostgreSQL's `now()`, not this JS Date.now().
            report.stale_pending.push({
              fileId: row.id,
              expiredAt: row.expires_at.toISOString(),
            });
            if (options.failStalePending) {
              const claimed = await this.claimStalePending(row);
              if (claimed) {
                await this.purgeTerminal(row, 'FAILED').catch(() => false);
                report.actions.push(`failed stale pending ${row.id}`);
              }
              // else: the claim affected zero rows — AVAILABLE (or another cleanup run) already won this row.
              // Do not touch the object: it may now be exactly the bytes a completed upload is relying on.
            }
          } else if (row.status === 'DELETED' && head) {
            report.deleted_with_object.push({ fileId: row.id, kind: row.kind });
            const imageKind = [
              'PROFILE_IMAGE',
              'ORGANISATION_LOGO',
              'WORKSPACE_LOGO',
            ].includes(row.kind);
            const ageDays = row.deleted_at
              ? (Date.now() - row.deleted_at.getTime()) / 86_400_000
              : 0;
            if (
              options.purgeDeletedImagesOlderThanDays &&
              imageKind &&
              ageDays >= options.purgeDeletedImagesOlderThanDays
            ) {
              // The page this row came from may be minutes old by now. Re-read the row fresh and require every
              // condition to still hold, including the object key, before deleting anything.
              if (
                await this.purgeTerminal(
                  row,
                  'DELETED',
                  options.purgeDeletedImagesOlderThanDays,
                )
              ) {
                report.actions.push(`purged object of deleted image ${row.id}`);
              }
            }
          } else if (row.status === 'FAILED' && head) {
            report.failed_with_object.push({ fileId: row.id, kind: row.kind });
            if (options.purgeFailedObjects) {
              if (await this.purgeTerminal(row, 'FAILED')) {
                report.actions.push(
                  `purged leftover object of failed upload ${row.id}`,
                );
              }
            }
          }
        }
      }
    }

    // Orphans: objects we can see under our own prefix that no row owns. Reported, never auto-deleted.
    for await (const object of driver.list(prefix)) {
      if (!knownKeys.has(object.key))
        report.orphan_objects.push({
          key: object.key,
          sizeBytes: object.sizeBytes,
        });
    }

    const integrityProblems =
      report.missing_objects.length +
      report.size_mismatches.length +
      report.checksum_mismatches.length;
    const fullReport: ReconcileReport = {
      ...report,
      summary: {
        integrityProblems,
        orphans: report.orphan_objects.length,
        stalePending: report.stale_pending.length,
      },
    };
    const json = JSON.stringify(fullReport, null, 2);
    if (options.reportFile) writeFileSync(options.reportFile, json);
    // eslint-disable-next-line no-console
    console.log(json);
    this.lastReport = fullReport;
    if (integrityProblems > 0) process.exitCode = 1;
  }

  private scoped<T>(
    row: Pick<Row, 'organisation_id' | 'workspace_id'>,
    fn: (manager: import('typeorm').EntityManager) => Promise<T>,
  ): Promise<T> {
    return new TenantContextService(this.dataSource).runInTenantContext(
      {
        organisationId: row.organisation_id,
        workspaceId: row.workspace_id,
        userId: '',
        role: '',
      },
      fn,
    );
  }

  private async readPage(
    afterId: string,
    scope: MaintenanceScope,
  ): Promise<Row[]> {
    return this.scoped(
      {
        organisation_id: scope.organisationId,
        workspace_id: scope.workspaceId,
      },
      async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        // Explicit equality prevents org-owned rows repeating in each workspace and
        // excludes any extra report rows the existing read policy may permit.
        return manager.query<Row[]>(
          `SELECT id, organisation_id, workspace_id, kind, status, object_key,
        size_bytes::text, sha256, expires_at, deleted_at FROM core.stored_file
        WHERE id > $1 AND workspace_id IS NOT DISTINCT FROM $2::uuid ORDER BY id LIMIT 200`,
          [afterId, scope.workspaceId],
        );
      },
    );
  }

  /** Commit the stale-PENDING CAS before touching storage. Failed deletion remains retriable as FAILED. */
  private async claimStalePending(
    row: Row,
  ): Promise<{ id: string; object_key: string } | null> {
    return this.scoped(row, async (manager) => {
      const [rows] = await manager.query(
        `UPDATE core.stored_file SET status = 'FAILED', updated_at = now()
        WHERE id = $1 AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= now()
          AND object_key = $2 AND workspace_id IS NOT DISTINCT FROM $3::uuid
        RETURNING id, object_key`,
        [row.id, row.object_key, row.workspace_id],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Lock through final revalidation AND object action. A concurrent purge waits,
   * rechecks HEAD and skips an already-removed object. A concurrent restore cannot
   * change metadata between validation and deletion. Storage and DB are not an
   * atomic transaction: terminal metadata is retained on all failures for retry.
   */
  private async purgeTerminal(
    row: Row,
    status: 'DELETED' | 'FAILED',
    minimumAgeDays?: number,
  ): Promise<boolean> {
    return this.scoped(row, async (manager) => {
      const rows = await manager.query<
        Array<{ kind: string; eligible: boolean }>
      >(
        `SELECT kind,
        (deleted_at IS NOT NULL AND deleted_at <= now() - ($5::double precision * interval '1 day')) AS eligible
        FROM core.stored_file WHERE id = $1 AND status = $2 AND object_key = $3
          AND workspace_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE`,
        [row.id, status, row.object_key, row.workspace_id, minimumAgeDays ?? 0],
      );
      const fresh = rows[0];
      if (
        !fresh ||
        (status === 'DELETED' &&
          (!fresh.eligible ||
            !['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO'].includes(
              fresh.kind,
            )))
      )
        return false;
      const driver = this.drivers.getDriver();
      if (!(await driver.head(row.object_key))) return false;
      await driver.delete(row.object_key);
      return true;
    });
  }
}
