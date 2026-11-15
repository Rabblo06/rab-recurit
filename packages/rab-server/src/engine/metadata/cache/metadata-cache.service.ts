import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { AuthCacheRedisClientProvider } from '../../core-modules/auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../../core-modules/environment/environment.service';
import { resolveAuthCacheMacKey } from '../../core-modules/secret-encryption/keyring.util';
import { decodeEnvelope, deriveMetadataMacKey, encodeEnvelope, MacKey } from './metadata-cache-envelope';
import { MetadataCacheContextError, MetadataVersionConflictError } from './metadata-cache.errors';
import {
  cacheToken,
  HEAD_SQL,
  isCacheableVersion,
  isStamp,
  isRowArray,
  isUuid,
  LOAD_SQL,
  LOCK_VERSION_SQL,
  MetadataHead,
  NO_METADATA_VERSION,
  WorkspaceMetadataSnapshot,
} from './metadata-snapshot';
import { SnapshotLruStats, WorkspaceSnapshotLru } from './workspace-snapshot-lru';

/**
 * Metadata engine E5 — the versioned per-workspace metadata cache (OWNER-METADATA-ENGINE §1 E5, M0-BACKEND §5,
 * M0-THREAT-MODEL MT-11). Re-implements the behaviour of Twenty's `workspace-cache` (twentyhq/twenty @ eedb0a73
 * `packages/twenty-server/src/engine/workspace-cache/services/workspace-cache.service.ts`), never its code, with these
 * deliberate differences:
 *
 * | Twenty (file:line @ eedb0a73)                                                     | Crewflow                                                          |
 * |-----------------------------------------------------------------------------------|-------------------------------------------------------------------|
 * | Version bumped AFTER commit, read-then-write on another connection                | Bumped by a database trigger in the SAME transaction as the change |
 * |   (`metadata-modules/workspace-metadata-version/services/                         |   (M1-SQL-FOR-OWNER.md § M1-cache). PostgreSQL is the authority.   |
 * |   workspace-metadata-version.service.ts:25-58`)                                   |                                                                   |
 * | Keys `<name>:<workspaceId>` with a random hash, compare-and-swap publish          | Keys carry (organisation, workspace, version); a version's content |
 * |   (`workspace-cache.service.ts:1022-1027`, `:668-800`;                            |   never changes, so no CAS and no invalidation are needed           |
 * |   `constants/publish-workspace-cache-script.constant.ts:3-33`)                    |                                                                   |
 * | Local map re-validated against a Redis hash every 100 ms                           | Every call reads the version from PostgreSQL in the caller's own   |
 * |   (`workspace-cache.service.ts:63, 541-613`)                                      |   tenant transaction (one PK read): no stale window after commit   |
 * | Invalidate = new random hash + delete data (`workspace-cache.service.ts:484-511`) | Nothing to invalidate; old versions become unreachable              |
 * | Redis data trusted after a hash match (`workspace-cache.service.ts:615-666`)      | HMAC bound to the key + identity check; any doubt = rebuild from PG |
 * | Per-workspace promise memoizer (`workspace-cache.service.ts:123, 314-360`)        | Single-flight per (org, workspace, version), shared only on an      |
 * |                                                                                   |   exact identity + version match                                    |
 *
 * READ PATH (`get`), inside the caller's tenant transaction (runInTenantContext / runInWorkspaceContext):
 *  1. `HEAD_SQL`: the bound organisation + workspace (from the GUCs, never from an argument), the current version and its
 *     bump time (`stamp`; with the version it is the cache identity, so a reused version number — a restored backup, a
 *     recreated row — can never match an entry cached before).
 *     No tenant bound or no transaction → MetadataCacheContextError (fail closed).
 *  2. In-process entry for exactly that version → return.
 *  3. Redis `crewflow:<env>:metadata:v1:<org>:<ws>:<version>.<stamp>` → verify MAC + identity + shape → return. Any Redis error,
 *     timeout, absence or failed check is a miss.
 *  4. `LOAD_SQL` in the same transaction: version and rows from ONE statement (one snapshot), stored under THAT version.
 *
 * WHY A FILL CAN NEVER LEAVE STALE CONTENT UNDER A NEW VERSION: an entry is written only under the version returned by
 * the same statement that returned its rows. A concurrent change either committed before that statement's snapshot (then
 * both the rows and the version are new) or after it (then both are old, and the old entry sits under the old key, which
 * no reader that starts after the commit will ask for, because it reads the new version first). There is no ordering of
 * "invalidate" against "fill" to get wrong, because there is no invalidate. The entity cache's epoch race came from taking
 * the epoch from Redis and the content from PostgreSQL in two separate reads; this design has no such gap.
 *
 * CROSS-INSTANCE: no pub/sub is needed. The version comes from PostgreSQL on every call, so an instance that has never
 * heard of a change still reads the new version on its next transaction after the commit, and misses its old entry.
 * Stale-read window after commit: none, for any transaction that starts after the commit. A transaction that is already
 * running sees the version of its own snapshot (READ COMMITTED: of the HEAD statement), which is correct for that snapshot.
 *
 * NOT IN HERE: permissions, role data, record data. Permissions stay per-request (`role.permission_version`), so a
 * revocation is never delayed by this cache (M0-THREAT-MODEL 8.4).
 */

export interface MetadataCacheOptions {
  /** Workspaces kept in process (one version each). */
  l1MaxEntries: number;
  l1MaxBytes: number;
  /** Larger snapshots are returned but never cached (neither tier). */
  maxEntryBytes: number;
  l1IdleTtlMs: number;
  /** Redis TTL: hygiene only, never a correctness input (content under a version never changes). */
  redisTtlSeconds: number;
}

export const METADATA_CACHE_OPTIONS = Symbol('METADATA_CACHE_OPTIONS');

export const DEFAULT_METADATA_CACHE_OPTIONS: Readonly<MetadataCacheOptions> = Object.freeze({
  l1MaxEntries: 500,
  l1MaxBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  l1IdleTtlMs: 30 * 60 * 1000,
  redisTtlSeconds: 7 * 24 * 60 * 60,
});

export interface MetadataCacheStats {
  l1Hits: number;
  redisHits: number;
  dbLoads: number;
  uncacheableLoads: number;
  sharedFills: number;
  redisErrors: number;
  redisWrites: number;
  redisRejected: { malformed: number; 'key-id': number; mac: number; identity: number; shape: number };
  l1: SnapshotLruStats;
}

@Injectable()
export class MetadataCacheService {
  private readonly logger = new Logger(MetadataCacheService.name);
  private readonly options: MetadataCacheOptions;
  private readonly macKey: MacKey;
  private readonly keyPrefix: string;
  private readonly l1: WorkspaceSnapshotLru<WorkspaceMetadataSnapshot>;
  private readonly inflight = new Map<string, Promise<WorkspaceMetadataSnapshot>>();
  private readonly counters = {
    l1Hits: 0,
    redisHits: 0,
    dbLoads: 0,
    uncacheableLoads: 0,
    sharedFills: 0,
    redisErrors: 0,
    redisWrites: 0,
    redisRejected: { malformed: 0, 'key-id': 0, mac: 0, identity: 0, shape: 0 },
  };

  constructor(
    env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
    @Optional() @Inject(METADATA_CACHE_OPTIONS) options?: Partial<MetadataCacheOptions>,
  ) {
    this.options = { ...DEFAULT_METADATA_CACHE_OPTIONS, ...(options ?? {}) };
    this.macKey = deriveMetadataMacKey(resolveAuthCacheMacKey(String(env.get('APP_SECRET')), env.get('APP_AUTH_CACHE_HMAC_KEY')));
    this.keyPrefix = `crewflow:${env.get('NODE_ENV')}:metadata:v1`;
    this.l1 = new WorkspaceSnapshotLru<WorkspaceMetadataSnapshot>({
      maxEntries: this.options.l1MaxEntries,
      maxBytes: this.options.l1MaxBytes,
      maxEntryBytes: this.options.maxEntryBytes,
      idleTtlMs: this.options.l1IdleTtlMs,
    });
  }

  /**
   * The Redis key of one (organisation, workspace, cache token `<version>.<stamp>`). Exposed for tests and operator tooling;
   * carries no secret. `token` may be a glob (`*`) for a SCAN.
   */
  redisKey(organisationId: string, workspaceId: string, token: string): string {
    return `${this.keyPrefix}:${organisationId}:${workspaceId}:${token}`;
  }

  /**
   * The bound workspace's metadata at the version current in the caller's transaction. `manager` MUST be the
   * transactional manager of runInTenantContext / runInWorkspaceContext (tenant GUCs bound). The returned snapshot is
   * deeply frozen and shared; derive, never mutate.
   */
  async get(manager: EntityManager): Promise<WorkspaceMetadataSnapshot> {
    const head = await this.readHead(manager);
    if (!isCacheableVersion(head.version) || !isStamp(head.stamp)) {
      // No version row: nothing has ever been written for this workspace. Read through, never cache.
      this.counters.uncacheableLoads += 1;
      return this.load(manager, head);
    }
    const version = head.version;
    const token = cacheToken(version, head.stamp);
    const wsKey = `${head.organisationId}:${head.workspaceId}`;
    const local = this.l1.get(wsKey, token);
    if (local) {
      this.counters.l1Hits += 1;
      return local;
    }

    const flightKey = `${wsKey}:${token}`;
    const running = this.inflight.get(flightKey);
    if (running) {
      // Share a concurrent fill only when it produced exactly what we asked for; otherwise (it failed with its own
      // transaction, or read a newer version) do our own fill on our own transaction.
      const shared = await running.catch(() => null);
      if (shared && cacheToken(shared.version, shared.stamp) === token && shared.organisationId === head.organisationId && shared.workspaceId === head.workspaceId) {
        this.counters.sharedFills += 1;
        return shared;
      }
      return this.fill(manager, head, version, head.stamp);
    }
    const fill = this.fill(manager, head, version, head.stamp);
    this.inflight.set(flightKey, fill);
    const clear = () => {
      if (this.inflight.get(flightKey) === fill) this.inflight.delete(flightKey);
    };
    fill.then(clear, clear);
    return fill;
  }

  /**
   * The authority read on its own: bound organisation + workspace and the current version (null = no version row).
   * Throws MetadataCacheContextError when no tenant transaction is bound.
   */
  async readHead(manager: EntityManager): Promise<MetadataHead> {
    assertTenantTransaction(manager);
    const rows = (await manager.query(HEAD_SQL)) as Array<{ organisation_id: unknown; workspace_id: unknown; metadata_version: unknown; metadata_stamp: unknown }>;
    const row = rows?.[0];
    if (!row || !isUuid(row.organisation_id) || !isUuid(row.workspace_id)) {
      throw new MetadataCacheContextError('Metadata cache used without a bound organisation and workspace.');
    }
    const version = row.metadata_version;
    const stamp = row.metadata_stamp;
    if (version !== null && (!isCacheableVersion(version) || !isStamp(stamp))) {
      throw new Error('core.workspace_metadata_state holds an invalid version row.');
    }
    return {
      organisationId: row.organisation_id,
      workspaceId: row.workspace_id,
      version: version as string | null,
      stamp: version === null ? null : (stamp as string),
    };
  }

  /**
   * For M2's change runner (optimistic concurrency): locks the bound workspace's version row until the transaction ends
   * and refuses with 409 unless it equals `expectedVersion` (`'0'` = the workspace has no metadata yet; the first change's
   * concurrent creators then serialise on the version row's primary key inside the trigger). The database trigger bumps
   * the version once in this transaction.
   */
  async lockExpectedVersion(manager: EntityManager, expectedVersion: string): Promise<void> {
    await this.readHead(manager); // tenant + transaction checks
    const rows = (await manager.query(LOCK_VERSION_SQL)) as Array<{ metadata_version: string }>;
    // No version row yet = version '0' (nothing was ever written for this workspace).
    const current = rows?.[0]?.metadata_version ?? NO_METADATA_VERSION;
    if (current !== expectedVersion) throw new MetadataVersionConflictError(expectedVersion, current);
  }

  stats(): MetadataCacheStats {
    return { ...this.counters, redisRejected: { ...this.counters.redisRejected }, l1: this.l1.stats() };
  }

  /** Drops this process's in-memory tier (tests, operator tooling). Never needed for correctness. */
  clearLocal(): void {
    this.l1.clear();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private async fill(manager: EntityManager, head: MetadataHead, version: string, stamp: string): Promise<WorkspaceMetadataSnapshot> {
    const fromRedis = await this.readRedis(head.organisationId, head.workspaceId, version, stamp);
    if (fromRedis) return fromRedis;
    const snapshot = await this.load(manager, head);
    if (isCacheableVersion(snapshot.version)) await this.store(snapshot);
    return snapshot;
  }

  private async load(manager: EntityManager, head: MetadataHead): Promise<WorkspaceMetadataSnapshot> {
    this.counters.dbLoads += 1;
    const rows = (await manager.query(LOAD_SQL)) as Array<Record<string, unknown>>;
    const row = rows?.[0];
    if (!row || row.organisation_id !== head.organisationId || row.workspace_id !== head.workspaceId) {
      // The tenant GUCs changed between two statements of one transaction: never return or cache anything.
      throw new MetadataCacheContextError('The bound tenant changed while the metadata cache was reading.');
    }
    const version = row.metadata_version === null ? NO_METADATA_VERSION : row.metadata_version;
    const stamp = row.metadata_version === null ? NO_METADATA_VERSION : row.metadata_stamp;
    if (version !== NO_METADATA_VERSION && (!isCacheableVersion(version) || !isStamp(stamp))) {
      throw new Error('core.workspace_metadata_state holds an invalid version row.');
    }
    const { objects, fields, field_options: fieldOptions, indexes, index_fields: indexFields } = row;
    if (!isRowArray(objects) || !isRowArray(fields) || !isRowArray(fieldOptions) || !isRowArray(indexes) || !isRowArray(indexFields)) {
      throw new Error('Metadata cache load returned an unexpected shape.');
    }
    return deepFreeze({
      organisationId: head.organisationId,
      workspaceId: head.workspaceId,
      version: version as string,
      stamp: stamp as string,
      objects,
      fields,
      fieldOptions,
      indexes,
      indexFields,
    });
  }

  private async store(snapshot: WorkspaceMetadataSnapshot): Promise<void> {
    const token = cacheToken(snapshot.version, snapshot.stamp);
    const key = this.redisKey(snapshot.organisationId, snapshot.workspaceId, token);
    const value = encodeEnvelope(this.macKey, key, snapshot);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.options.maxEntryBytes) {
      this.logger.warn(`Metadata snapshot of ${bytes} bytes exceeds the cache entry limit; served uncached.`);
      return;
    }
    this.l1.set(`${snapshot.organisationId}:${snapshot.workspaceId}`, snapshot.version, token, snapshot, bytes);
    try {
      // NX: content under a version is immutable, so the first writer's bytes are as good as ours.
      await this.redis.client.set(key, value, 'EX', this.options.redisTtlSeconds, 'NX');
      this.counters.redisWrites += 1;
    } catch (error) {
      this.counters.redisErrors += 1;
      this.logger.debug(`metadata cache SET failed, continuing uncached in Redis: ${(error as Error).message}`);
    }
  }

  private async readRedis(organisationId: string, workspaceId: string, version: string, stamp: string): Promise<WorkspaceMetadataSnapshot | null> {
    const token = cacheToken(version, stamp);
    const key = this.redisKey(organisationId, workspaceId, token);
    let raw: string | null;
    try {
      raw = await this.redis.client.get(key);
    } catch (error) {
      this.counters.redisErrors += 1;
      this.logger.debug(`metadata cache GET failed, reading PostgreSQL: ${(error as Error).message}`);
      return null;
    }
    if (raw === null) return null;
    const decoded = decodeEnvelope(this.macKey, key, raw, { organisationId, workspaceId, version, stamp });
    if (!decoded.ok) {
      this.counters.redisRejected[decoded.reason] += 1;
      if (decoded.reason !== 'key-id') this.logger.warn(`metadata cache entry rejected (${decoded.reason}); rebuilding from PostgreSQL`);
      return null;
    }
    this.counters.redisHits += 1;
    const snapshot = deepFreeze(decoded.snapshot);
    this.l1.set(`${organisationId}:${workspaceId}`, version, token, snapshot, Buffer.byteLength(raw, 'utf8'));
    return snapshot;
  }
}

function assertTenantTransaction(manager: EntityManager): void {
  if (manager?.queryRunner?.isTransactionActive !== true) {
    throw new MetadataCacheContextError('Metadata cache used outside a tenant transaction.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
