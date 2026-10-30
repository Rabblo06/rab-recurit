import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { StorageObjectHead } from '../engine/core-modules/storage/drivers/interfaces/storage-driver.interface';
import { StorageDriverFactory } from '../engine/core-modules/storage/storage-driver.factory';
import { normaliseKeyPrefix } from '../engine/core-modules/storage/storage-key-prefix';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import {
  MaintenanceScope,
  storageScopes,
} from '../engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '../engine/utils/assert-runtime-db-role';
import { createPgClient, detectTransactionPooler, resolvePgEnvironmentCached } from '../database/postgres';

interface Options {
  checkBytes?: boolean;
  reportFile?: string;
  failStalePending?: boolean;
  purgeDeletedImagesOlderThanDays?: number;
  purgeFailedObjects?: boolean;
  /**
   * Phase A (storage): how long to wait for the cluster-wide reconciliation lock before giving up. The CLI default
   * (`DEFAULT_CLI_LOCK_WAIT_SECONDS`) waits a bounded time so an operator run simply queues behind a scheduled one;
   * the Worker passes 0 (one non-blocking attempt: a replica that loses skips, the winner is already doing the work).
   */
  lockWaitSeconds?: number;
}

/**
 * Phase A (storage) — cluster-wide reconciliation lock. Session-level PostgreSQL advisory lock taken by the restricted
 * runtime role (`crewflow_app`) on a dedicated lock connection from the connection factory (PG_DATABASE_URL; exactly
 * like the Worker's own direct connection and scan lock). `pg_try_advisory_lock` needs no grant, function or migration.
 * Its own key namespace: distinct from the BullMQ per-scan lock (`crewflow:scan-lock:v1:*`) and every other inner lock.
 * Crash-safe: PostgreSQL releases a session lock when the session ends, so a killed process never wedges reconciliation.
 */
export const STORAGE_RECONCILE_LOCK = 'crewflow:storage-reconcile:v1';
export const DEFAULT_CLI_LOCK_WAIT_SECONDS = 120;
const LOCK_POLL_MS = 500;
/** CLI exit code when the lock could not be taken within the wait (1 stays reserved for "integrity problems found"). */
export const RECONCILE_LOCKED_EXIT_CODE = 3;

/**
 * Phase A review F1: the reconcile lock is a SESSION advisory lock, which a transaction-mode pooler (`-pooler` host,
 * e.g. rab-api's pooled URL) can neither hold nor release reliably — the unlock may reach another backend (leak) or
 * a second client may re-enter the same backend's lock (no exclusion). Refuse such a URL before connecting; the error
 * names the variables only, never the URL. Phase B: the lock connection now comes from the connection factory, which
 * applies the full documented-pooler denylist (pg-url-policy.ts) to every session-affine connection; this URL-level
 * check is the same rule for callers that only hold a string.
 */
export function assertDirectLockUrl(url: string): void {
  let host = '';
  let port = 5432;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : 5432;
  } catch {
    throw new Error('storage reconciliation: PG_DATABASE_URL / DATABASE_DIRECT_URL / DATABASE_URL is not a valid connection URL');
  }
  if (/-pooler\./.test(host) || detectTransactionPooler(host, port)) {
    throw new Error(
      'storage reconciliation: the lock needs a direct (non -pooler) database connection; point PG_DATABASE_URL (or, outside production, the deprecated DATABASE_DIRECT_URL) at a direct host',
    );
  }
}

/** Why the last `run()` did not reconcile (nothing else ever sets it). */
export type ReconcileSkipReason = 'locked';

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
  /** A row whose object_key does not sit under its OWN organisation/workspace namespace. Never read as a delete target, never mutated: a corrupted or forged row must not reach another tenant's object. Counted as an integrity problem. */
  key_outside_namespace: Array<{ fileId: string; organisationId: string; workspaceId: string | null }>;
  actions: string[];
  summary: { integrityProblems: number; orphans: number; stalePending: number };
}

/** A non-empty object-key tail with no empty, `.` or `..` segment (blocks traversal and double slashes inside a namespace). */
function isCleanTail(tail: string): boolean {
  return tail.length > 0 && !tail.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
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
  /** updated_at as exact text (microseconds kept). The purge's compare-and-set uses it: a JS Date would lose precision and never match. */
  updated_at_text: string;
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
 * Uses the restricted runtime connection (`crewflow_app`) for ALL metadata access, mutations AND
 * catalogue enumeration — a single connection, not a privileged separate one. Worker credential
 * isolation checkpoint: this previously opened a SEPARATE connection on `DATABASE_URL_UNPOOLED`
 * purely to enumerate organisation/workspace IDs via `maintenance-catalogue.ts`'s SECURITY DEFINER
 * functions — but those functions never needed elevated privilege in the first place (confirmed:
 * both `worker_list_organisations` and, after this same checkpoint's fix, `worker_list_workspaces`
 * are already granted to `crewflow_app`). Removing the separate connection removes one of this
 * command's two reasons to ever see `DATABASE_URL_UNPOOLED` at all — the only remaining privileged
 * consumer in this whole package is the separate workspace-provisioner entrypoint.
 *
 * Phase A (storage) — cost and concurrency, same report shape and same safety rules:
 *  - ONE reconciliation at a time, cluster-wide (CLI and every Worker replica): `STORAGE_RECONCILE_LOCK`, see above.
 *  - `STORAGE_RECONCILE_METHOD=list` (default): the object store is enumerated ONCE with paginated LIST (key + size)
 *    BEFORE the metadata pass, and that one listing serves both the per-row comparison and the orphan report. HEAD is
 *    kept only where the listing alone could be stale or wrong for that row: an AVAILABLE row whose object is absent from
 *    the listing or listed with a different size (the HEAD result decides missing/size mismatch exactly as before), and a
 *    DELETED/FAILED row whose object IS listed (the HEAD decides deleted_with_object/failed_with_object, and the purge
 *    path still re-checks with its own HEAD before deleting). PENDING rows never needed the HEAD (its result was unused)
 *    and terminal rows whose object is not listed need no storage call at all. `head` restores the per-row HEAD exactly.
 *    The HEAD's only fields this command ever used are existence and ContentLength; LIST returns both (Size), so no
 *    integrity check is lost. `--check-bytes` (GET + SHA-256) is unchanged.
 */
@Command({
  name: 'storage:reconcile',
  description:
    'Compare stored_file metadata with the object store (report-only unless flags say otherwise)',
})
export class StorageReconcileCommand extends CommandRunner {
  /** Set at the end of every `run()` — lets a caller (e.g. the scheduled worker job) read the outcome directly instead of parsing stdout. `run()` itself must stay `Promise<void>` to satisfy `CommandRunner`'s own abstract signature. */
  lastReport?: ReconcileReport;
  /** Phase A (storage): set when the last `run()` did NOT reconcile (lock held elsewhere). Reset at the start of every run, with `lastReport`. */
  lastSkipped?: ReconcileSkipReason;

  constructor(
    private readonly dataSource: DataSource,
    private readonly drivers: StorageDriverFactory,
    private readonly env: EnvironmentService,
    private readonly tenantContext: TenantContextService,
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

  @Option({
    flags: '--lock-wait-seconds <n>',
    description: `Wait at most N seconds for another running reconciliation to finish (default ${DEFAULT_CLI_LOCK_WAIT_SECONDS}; 0 = try once)`,
  })
  parseLockWaitSeconds(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error('--lock-wait-seconds must be an integer between 0 and 3600');
    return n;
  }

  async run(_params: string[], options: Options): Promise<void> {
    this.lastReport = undefined;
    this.lastSkipped = undefined;
    // Role check first, before any lock or storage access (unchanged order: a misconfigured owner connection is refused outright).
    await assertRuntimeDbRole(this.dataSource, 'storage reconciliation');
    const waitSeconds = options.lockWaitSeconds ?? DEFAULT_CLI_LOCK_WAIT_SECONDS;
    const lock = await this.acquireReconcileLock(waitSeconds * 1000);
    if (!lock) {
      this.lastSkipped = 'locked';
      // eslint-disable-next-line no-console
      console.error(
        `storage:reconcile: another storage reconciliation holds the lock (waited ${waitSeconds}s); nothing was checked or changed. Re-run later.`,
      );
      process.exitCode = RECONCILE_LOCKED_EXIT_CODE;
      return;
    }
    try {
      await this.reconcile(options, this.dataSource);
    } finally {
      await this.releaseReconcileLock(lock);
    }
  }

  /**
   * Bounded acquisition: `pg_try_advisory_lock` (never blocks inside PostgreSQL), retried every LOCK_POLL_MS until
   * `waitMs` elapses. The lock connection is verified to be the restricted runtime role before it is used, with the same
   * guard as every other runtime connection. Returns the connection holding the lock, or null when the wait ran out.
   */
  private async acquireReconcileLock(waitMs: number): Promise<Client | null> {
    // Phase B: the factory's lock connection (PG_DATABASE_URL; legacy DATABASE_DIRECT_URL / DATABASE_URL outside
    // production), with explicit TLS and the pooler denylist (session affinity). Short timeouts as before: lock calls
    // are instantaneous.
    const client = createPgClient(resolvePgEnvironmentCached(process.env), {
      endpoint: 'lock',
      purpose: 'storage-lock',
      statementTimeoutMs: 5_000,
      queryTimeoutMs: 5_000,
    });
    // A dropped lock connection must not crash the process: the server has released the lock with the session, and the
    // run's own protections (CAS claims, leases, fresh re-checks) keep an overlapping run correct — only wasted work.
    client.on('error', (error: Error) => {
      // eslint-disable-next-line no-console
      console.warn(`storage reconciliation lock connection error (${error.message}); the lock is released with the session`);
    });
    await client.connect();
    try {
      const shim = { query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows } as unknown as DataSource;
      await assertRuntimeDbRole(shim, 'storage reconciliation lock');
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [
          STORAGE_RECONCILE_LOCK,
        ]);
        if (rows[0]?.locked === true) return client;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_POLL_MS, remaining)));
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    await client.end().catch(() => undefined);
    return null;
  }

  /** Never throws: closing the session releases the lock even if the explicit unlock fails. */
  private async releaseReconcileLock(client: Client): Promise<void> {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [STORAGE_RECONCILE_LOCK]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }

  /**
   * One paginated LIST of everything under our own prefix (key -> size). Only built in `list` mode. Keys are unique
   * (S3/LOCAL semantics), so a plain Map suffices; it is the same order of memory as the `knownKeys` set this command
   * always kept for the orphan pass.
   */
  private async listObjects(prefix: string): Promise<Map<string, number>> {
    const objects = new Map<string, number>();
    for await (const object of this.drivers.getDriver().list(prefix)) objects.set(object.key, object.sizeBytes);
    return objects;
  }

  /**
   * The storage view of one in-namespace row. `head` mode: one HEAD per row (the historical behaviour, unchanged).
   * `list` mode: decided from the listing, with a HEAD only where the listing could be stale or wrong for the outcome
   * (see the class comment). The returned value feeds the SAME decision code as before, so every report category and
   * every mutation path is reached under exactly the same conditions.
   */
  private async probe(
    row: Row,
    listing: Map<string, number> | null,
  ): Promise<StorageObjectHead | null> {
    const driver = this.drivers.getDriver();
    if (!listing) return driver.head(row.object_key);
    const listedSize = listing.get(row.object_key);
    switch (row.status) {
      case 'AVAILABLE':
        // Listed with the expected size: present and the size matches — the only facts the HEAD was ever used for.
        if (listedSize !== undefined && listedSize === Number(row.size_bytes)) return { sizeBytes: listedSize };
        // Absent (or different size): confirm with a fresh HEAD so an object written after the listing is never reported
        // missing, and a real missing object / size mismatch is reported from the same HEAD result as before.
        return driver.head(row.object_key);
      case 'DELETED':
      case 'FAILED':
        // Terminal row (assumption: DELETED and FAILED are the terminal states of core.stored_file's CHECK constraint).
        // Not listed → nothing to reconcile, no storage call. Listed → confirm fresh, exactly as before.
        return listedSize === undefined ? null : driver.head(row.object_key);
      default:
        // PENDING: the decision below never reads the storage view for PENDING rows (stale-PENDING is time-based and its
        // purge path does its own HEAD). Any unknown status is also left untouched by the decision code.
        return null;
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
      key_outside_namespace: [] as Array<{
        fileId: string;
        organisationId: string;
        workspaceId: string | null;
      }>,
      actions: [] as string[],
    };
    const knownKeys = new Set<string>();
    // `list` (default): enumerate the store ONCE, before the metadata pass (the old order listed after it). Taking the
    // listing first narrows the orphan race to uploads in flight at listing time; an object stored after the listing is
    // simply not judged in this run (next run), and an AVAILABLE row whose object is not in the listing is HEAD-confirmed.
    const listing = this.env.get('STORAGE_RECONCILE_METHOD') === 'head' ? null : await this.listObjects(prefix);

    for await (const scope of storageScopes(catalogue)) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const page = await this.readPage(after, scope);
        if (page.length === 0) break;
        after = page[page.length - 1]!.id;
        for (const row of page) {
          report.checkedRows += 1;
          knownKeys.add(row.object_key);
          // Namespace guard, before any storage call or mutation: this row's key must belong to this row's own tenant.
          if (!this.keyWithinNamespace(row)) {
            report.key_outside_namespace.push({
              fileId: row.id,
              organisationId: row.organisation_id,
              workspaceId: row.workspace_id,
            });
            continue;
          }
          const head = await this.probe(row, listing);
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
                // The stale claim just bumped updated_at; the purge leases against THAT version, not the page snapshot.
                await this.purgeTerminal(row, 'FAILED', undefined, claimed.updated_at_text).catch(() => false);
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
              'VENUE_PHOTO',
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
    // `list` mode reuses the listing taken above (no second enumeration); `head` mode lists here, as it always did.
    const objects = listing
      ? (function* (entries: Map<string, number>) {
          for (const [key, sizeBytes] of entries) yield { key, sizeBytes };
        })(listing)
      : driver.list(prefix);
    for await (const object of objects) {
      if (!knownKeys.has(object.key))
        report.orphan_objects.push({
          key: object.key,
          sizeBytes: object.sizeBytes,
        });
    }

    const integrityProblems =
      report.missing_objects.length +
      report.size_mismatches.length +
      report.checksum_mismatches.length +
      report.key_outside_namespace.length;
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
    return this.tenantContext.runInTenantContext(
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
        size_bytes::text, sha256, expires_at, deleted_at, updated_at::text AS updated_at_text FROM core.stored_file
        WHERE id > $1 AND workspace_id IS NOT DISTINCT FROM $2::uuid ORDER BY id LIMIT 200`,
          [afterId, scope.workspaceId],
        );
      },
    );
  }

  /**
   * True only when the row's object key is `{prefix}organisations/{its org}/workspaces/{its workspace or 'none'}/…`, with no empty,
   * `.` or `..` segment after that namespace. Built from the ROW's own ids, not from anything the caller supplied, so a key that names
   * another organisation or workspace fails here regardless of what the database or a queue claimed.
   */
  private keyWithinNamespace(row: Pick<Row, 'object_key' | 'organisation_id' | 'workspace_id'>): boolean {
    const orgNamespace = `${normaliseKeyPrefix(this.env.get('STORAGE_KEY_PREFIX'))}organisations/${row.organisation_id}/`;
    if (!row.object_key.startsWith(orgNamespace)) return false;
    const rest = row.object_key.slice(orgNamespace.length);
    // Keys written since the workspace segment was introduced name their workspace explicitly, and it must be this row's workspace.
    // Older keys (committed format `organisations/{org}/…`, no workspace segment) are accepted at organisation level only.
    if (rest.startsWith('workspaces/')) {
      const workspaceNamespace = `workspaces/${row.workspace_id ?? 'none'}/`;
      if (!rest.startsWith(workspaceNamespace)) return false;
      return isCleanTail(rest.slice(workspaceNamespace.length));
    }
    return isCleanTail(rest);
  }

  /** Commit the stale-PENDING CAS before touching storage. Failed deletion remains retriable as FAILED. */
  private async claimStalePending(
    row: Row,
  ): Promise<{ id: string; object_key: string; updated_at_text: string } | null> {
    if (!this.keyWithinNamespace(row)) return null;
    return this.scoped(row, async (manager) => {
      const [rows] = await manager.query(
        `UPDATE core.stored_file SET status = 'FAILED', updated_at = now()
        WHERE id = $1 AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= now()
          AND object_key = $2 AND workspace_id IS NOT DISTINCT FROM $3::uuid
        RETURNING id, object_key, updated_at::text AS updated_at_text`,
        [row.id, row.object_key, row.workspace_id],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Purge of one terminal object, without holding a database transaction across storage I/O.
   *
   *  1. LEASE (short transaction): one compare-and-set UPDATE re-checks every condition against live state (status, object key,
   *     workspace, and for DELETED rows: image kind and age, judged by PostgreSQL's now()). It bumps updated_at, and it only matches
   *     if updated_at still equals the version the caller saw. Two cleaners cannot both win: the second finds a changed version.
   *     The transaction commits before any storage call.
   *  2. STORAGE (no transaction): HEAD, then DELETE. An absent object is a successful no-op.
   *
   * There is no finalise step. A DELETED or FAILED row's status does not change when its object is removed, and the next reconcile
   * observes the object is gone (no longer listed as deleted_with_object / failed_with_object). Each failure case therefore leaves
   * the row retryable:
   *   - crash after the lease, before the delete: updated_at was bumped, status unchanged, so the next run leases a fresh version and retries;
   *   - delete fails: nothing was committed beyond the lease; the next run retries;
   *   - delete succeeds, then the process dies: the next run's HEAD finds nothing and does nothing;
   *   - row modified after the page snapshot: the version no longer matches, so the purge is skipped, not run on a stale snapshot.
   * A corrupted namespace key is refused before any lease is taken.
   */
  private async purgeTerminal(
    row: Row,
    status: 'DELETED' | 'FAILED',
    minimumAgeDays?: number,
    expectedVersion: string = row.updated_at_text,
  ): Promise<boolean> {
    if (!this.keyWithinNamespace(row)) return false;

    const leased = await this.scoped(row, async (manager) => {
      const [rows] = await manager.query(
        `UPDATE core.stored_file SET updated_at = now()
          WHERE id = $1 AND status = $2 AND object_key = $3
            AND workspace_id IS NOT DISTINCT FROM $4::uuid
            AND updated_at::text = $5
            AND ($2 <> 'DELETED' OR (
                  kind IN ('PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'VENUE_PHOTO')
              AND deleted_at IS NOT NULL
              AND deleted_at <= now() - ($6::double precision * interval '1 day')))
          RETURNING kind`,
        [row.id, status, row.object_key, row.workspace_id, expectedVersion, minimumAgeDays ?? 0],
      );
      return (rows[0] as { kind: string } | undefined) ?? null;
    });
    if (!leased) return false;

    // Storage I/O happens here, outside any database transaction.
    try {
      const driver = this.drivers.getDriver();
      if (!(await driver.head(row.object_key))) return false;
      await driver.delete(row.object_key);
      return true;
    } catch (error) {
      // The lease already committed and the row's status did not change, so the object stays retryable. Logged, not swallowed silently.
      // eslint-disable-next-line no-console
      console.warn(`storage purge: delete failed for ${row.id}; row stays retryable:`, error instanceof Error ? error.message : error);
      return false;
    }
  }
}
