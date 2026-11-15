import type { EntityManager } from 'typeorm';

import type { AuthCacheRedisClientProvider } from '../../core-modules/auth/services/auth-cache-redis-client.provider';
import type { EnvironmentService } from '../../core-modules/environment/environment.service';
import { MetadataCacheContextError, MetadataVersionConflictError } from './metadata-cache.errors';
import { MetadataCacheService } from './metadata-cache.service';
import { HEAD_SQL, LOAD_SQL, LOCK_VERSION_SQL } from './metadata-snapshot';

/**
 * Unit level: a fake PostgreSQL (one row of state per workspace, answering HEAD/LOAD/LOCK) and a fake Redis (a Map). The
 * real-database, real-Redis, two-instance proofs are in src/__tests__/integration/metadata-cache.integration.spec.ts.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const WS_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const WS_B = '33333333-3333-4333-8333-333333333333';

interface FakeWorkspace {
  version: string | null;
  objects: Array<Record<string, unknown>>;
}

class FakeDb {
  workspaces = new Map<string, FakeWorkspace>();
  loads = 0;
  /** Runs right before a LOAD statement executes (to interleave a concurrent commit). */
  beforeLoad: (() => void) | null = null;

  commitObject(ws: string, name: string): void {
    const w = this.workspaces.get(ws) ?? { version: null, objects: [] };
    w.objects = [...w.objects, { id: name, name_singular: name }];
    w.version = String(Number(w.version ?? '0') + 1);
    this.workspaces.set(ws, w);
  }

  manager(org: string | null, ws: string | null, inTransaction = true): EntityManager {
    return {
      queryRunner: { isTransactionActive: inTransaction },
      query: async (sql: string) => {
        const w = ws ? this.workspaces.get(ws) : undefined;
        if (sql === HEAD_SQL) return [{ organisation_id: org, workspace_id: ws, metadata_version: w?.version ?? null }];
        if (sql === LOAD_SQL) {
          this.beforeLoad?.();
          this.beforeLoad = null;
          this.loads += 1;
          const now = ws ? this.workspaces.get(ws) : undefined;
          return [
            {
              organisation_id: org,
              workspace_id: ws,
              metadata_version: now?.version ?? null,
              objects: now?.objects ?? [],
              fields: [],
              field_options: [],
              indexes: [],
              index_fields: [],
            },
          ];
        }
        if (sql === LOCK_VERSION_SQL) return w?.version ? [{ metadata_version: w.version }] : [];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as EntityManager;
  }
}

class FakeRedis {
  store = new Map<string, string>();
  down = false;
  sets = 0;
  async get(key: string): Promise<string | null> {
    if (this.down) throw new Error('Connection is closed.');
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (this.down) throw new Error('Connection is closed.');
    if (args.includes('NX') && this.store.has(key)) return null;
    this.sets += 1;
    this.store.set(key, value);
    return 'OK';
  }
}

const env = {
  get: (key: string) => ({ APP_SECRET: 'unit-test-app-secret-unit-test-app-secret', APP_AUTH_CACHE_HMAC_KEY: undefined, NODE_ENV: 'test' })[key],
} as unknown as EnvironmentService;

function instance(redis: FakeRedis): MetadataCacheService {
  return new MetadataCacheService(env, { client: redis } as unknown as AuthCacheRedisClientProvider);
}

describe('MetadataCacheService (metadata engine E5, unit)', () => {
  let db: FakeDb;
  let redis: FakeRedis;

  beforeEach(() => {
    db = new FakeDb();
    redis = new FakeRedis();
    db.commitObject(WS_A, 'rocket');
  });

  describe('fail closed', () => {
    it('refuses outside a transaction', async () => {
      await expect(instance(redis).get(db.manager(ORG_A, WS_A, false))).rejects.toBeInstanceOf(MetadataCacheContextError);
    });

    it('refuses with no organisation or workspace bound', async () => {
      const cache = instance(redis);
      await expect(cache.get(db.manager(null, WS_A))).rejects.toBeInstanceOf(MetadataCacheContextError);
      await expect(cache.get(db.manager(ORG_A, null))).rejects.toBeInstanceOf(MetadataCacheContextError);
      expect(db.loads).toBe(0);
    });

    it('a workspace with no version row is read through and never cached', async () => {
      const cache = instance(redis);
      const snap = await cache.get(db.manager(ORG_B, WS_B));
      expect(snap).toMatchObject({ organisationId: ORG_B, workspaceId: WS_B, version: '0', objects: [] });
      await cache.get(db.manager(ORG_B, WS_B));
      expect(db.loads).toBe(2);
      expect(redis.store.size).toBe(0);
    });
  });

  it('loads once, then serves the same version from memory; a new version reloads', async () => {
    const cache = instance(redis);
    const first = await cache.get(db.manager(ORG_A, WS_A));
    expect(first.version).toBe('1');
    expect(Object.isFrozen(first) && Object.isFrozen(first.objects) && Object.isFrozen(first.objects[0])).toBe(true);
    expect(await cache.get(db.manager(ORG_A, WS_A))).toBe(first);
    expect(db.loads).toBe(1);

    db.commitObject(WS_A, 'comet');
    const second = await cache.get(db.manager(ORG_A, WS_A));
    expect(second.version).toBe('2');
    expect(second.objects.map((o) => o.name_singular)).toEqual(['rocket', 'comet']);
    expect(db.loads).toBe(2);
  });

  it('a second instance gets the entry from Redis, and sees a change made on the first immediately', async () => {
    const a = instance(redis);
    const b = instance(redis);
    await a.get(db.manager(ORG_A, WS_A));
    const viaRedis = await b.get(db.manager(ORG_A, WS_A));
    expect(viaRedis.objects).toHaveLength(1);
    expect(db.loads).toBe(1);
    expect(b.stats().redisHits).toBe(1);

    db.commitObject(WS_A, 'comet'); // "change on A"
    const fresh = await b.get(db.manager(ORG_A, WS_A));
    expect(fresh.version).toBe('2');
    expect(fresh.objects).toHaveLength(2);
  });

  it('a load that sees a newer commit than its head stores ONLY under the version read with the content', async () => {
    const cache = instance(redis);
    db.beforeLoad = () => db.commitObject(WS_A, 'comet'); // commit lands between HEAD (v1) and LOAD (v2)
    const snap = await cache.get(db.manager(ORG_A, WS_A));
    expect(snap.version).toBe('2');
    expect(snap.objects).toHaveLength(2);
    expect([...redis.store.keys()]).toEqual([cache.redisKey(ORG_A, WS_A, '2')]);
    // v1 was never written, so nobody can be served v2 content as "v1" or v1 content as "v2"
    expect(redis.store.has(cache.redisKey(ORG_A, WS_A, '1'))).toBe(false);
  });

  it('Redis down: reads come from PostgreSQL, changes are still seen at once', async () => {
    redis.down = true;
    const a = instance(redis);
    const b = instance(redis);
    expect((await a.get(db.manager(ORG_A, WS_A))).objects).toHaveLength(1);
    db.commitObject(WS_A, 'comet');
    expect((await b.get(db.manager(ORG_A, WS_A))).objects).toHaveLength(2);
    expect(a.stats().redisErrors + b.stats().redisErrors).toBeGreaterThan(0);
    expect(a.stats().redisHits + b.stats().redisHits).toBe(0);
  });

  it('a tampered or cross-workspace Redis value is rejected and rebuilt from PostgreSQL', async () => {
    db.commitObject(WS_B, 'secret-b');
    const a = instance(redis);
    await a.get(db.manager(ORG_B, WS_B)); // B's v1 in Redis
    // Copy B's (valid) value under A's v1 key.
    redis.store.set(a.redisKey(ORG_A, WS_A, '1'), redis.store.get(a.redisKey(ORG_B, WS_B, '1'))!);
    const b = instance(redis);
    const snap = await b.get(db.manager(ORG_A, WS_A));
    expect(snap.workspaceId).toBe(WS_A);
    expect(snap.objects.map((o) => o.name_singular)).toEqual(['rocket']);
    expect(b.stats().redisRejected.mac).toBe(1);
  });

  it('concurrent gets of one version share a single fill', async () => {
    const cache = instance(redis);
    const [x, y, z] = await Promise.all([1, 2, 3].map(() => cache.get(db.manager(ORG_A, WS_A))));
    expect(x).toBe(y);
    expect(y).toBe(z);
    expect(db.loads).toBe(1);
    expect(cache.stats().sharedFills).toBe(2);
  });

  it('lockExpectedVersion refuses a stale expected version with 409', async () => {
    const cache = instance(redis);
    await expect(cache.lockExpectedVersion(db.manager(ORG_A, WS_A), '1')).resolves.toBeUndefined();
    db.commitObject(WS_A, 'comet');
    await expect(cache.lockExpectedVersion(db.manager(ORG_A, WS_A), '1')).rejects.toBeInstanceOf(MetadataVersionConflictError);
  });
});
