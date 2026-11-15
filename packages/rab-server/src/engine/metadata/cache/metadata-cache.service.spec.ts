import type { EntityManager } from 'typeorm';

import type { AuthCacheRedisClientProvider } from '../../core-modules/auth/services/auth-cache-redis-client.provider';
import type { EnvironmentService } from '../../core-modules/environment/environment.service';
import { MetadataCacheContextError, MetadataVersionConflictError } from './metadata-cache.errors';
import { MetadataCacheService } from './metadata-cache.service';
import { HEAD_SQL, LOAD_SQL, LOCK_VERSION_SQL, LOCK_WORKSPACE_METADATA_SQL } from './metadata-snapshot';

/**
 * Unit level: a fake PostgreSQL (one row of state per workspace, answering HEAD/LOAD/LOCK) and a fake Redis (a Map). The
 * real-database, real-Redis, two-instance proofs are in src/__tests__/integration/metadata-cache.integration.spec.ts.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const WS_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const WS_B = '33333333-3333-4333-8333-333333333333';

/** The fake bump time of a version (the real one is updated_at in microseconds). */
const stampOf = (version: string) => String(1_700_000_000_000_000 + Number(version));
const token = (version: string) => `${version}.${stampOf(version)}`;

interface FakeWorkspace {
  version: string | null;
  objects: Array<Record<string, unknown>>;
}

class FakeDb {
  workspaces = new Map<string, FakeWorkspace>();
  loads = 0;
  /** Workspaces whose version was bumped by the (fake) current transaction, not yet committed. */
  ownBump = new Set<string>();
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
        if (sql === HEAD_SQL) {
          return [
            {
              organisation_id: org,
              workspace_id: ws,
              metadata_version: w?.version ?? null,
              metadata_stamp: w?.version ? stampOf(w.version) : null,
              own_bump: ws ? this.ownBump.has(ws) : false,
            },
          ];
        }
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
              metadata_stamp: now?.version ? stampOf(now.version) : null,
              own_bump: ws ? this.ownBump.has(ws) : false,
              objects: now?.objects ?? [],
              fields: [],
              field_options: [],
              indexes: [],
              index_fields: [],
            },
          ];
        }
        if (sql === LOCK_WORKSPACE_METADATA_SQL) return [{}];
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
    expect([...redis.store.keys()]).toEqual([cache.redisKey(ORG_A, WS_A, token('2'))]);
    // v1 was never written, so nobody can be served v2 content as "v1" or v1 content as "v2"
    expect(redis.store.has(cache.redisKey(ORG_A, WS_A, token('1')))).toBe(false);
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
    redis.store.set(a.redisKey(ORG_A, WS_A, token('1')), redis.store.get(a.redisKey(ORG_B, WS_B, token('1')))!);
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

  it('a reused version number with another bump time never matches the old entry (restore / recreated row)', async () => {
    const a = instance(redis);
    const old = await a.get(db.manager(ORG_A, WS_A)); // v1 cached under 1.<stamp>
    // Simulate a restore to an earlier point followed by a different change: version 1 again, new bump time, new content.
    db.workspaces.set(WS_A, { version: '1', objects: [{ id: 'other', name_singular: 'other' }] });
    const realStamp = stampOf;
    const manager = db.manager(ORG_A, WS_A);
    const query = manager.query.bind(manager);
    (manager as { query: unknown }).query = async (sql: string) => {
      const rows = (await query(sql)) as Array<Record<string, unknown>>;
      return rows.map((r) => ('metadata_stamp' in r && r.metadata_version ? { ...r, metadata_stamp: String(Number(realStamp('1')) + 99) } : r));
    };
    const fresh = await a.get(manager);
    expect(old.objects.map((o) => o.name_singular)).toEqual(['rocket']);
    expect(fresh.objects.map((o) => o.name_singular)).toEqual(['other']);
  });

  it("a transaction reading its own uncommitted metadata change is read through and never cached", async () => {
    const cache = instance(redis);
    db.commitObject(WS_A, 'comet'); // the fake: this transaction's own write, version 2 not committed yet
    db.ownBump.add(WS_A);
    const mid = await cache.get(db.manager(ORG_A, WS_A));
    expect(mid.version).toBe('2');
    expect(redis.store.size).toBe(0);
    await cache.get(db.manager(ORG_A, WS_A));
    expect(db.loads).toBe(2); // nothing in memory either
    expect(cache.stats().l1.entries).toBe(0);
  });

  it('a load that sees its own bump (head did not) is not stored either', async () => {
    const cache = instance(redis);
    db.beforeLoad = () => db.ownBump.add(WS_A);
    await cache.get(db.manager(ORG_A, WS_A));
    expect(redis.store.size).toBe(0);
    expect(cache.stats().l1.entries).toBe(0);
  });

  it('an oversized Redis value is rejected before it is parsed', async () => {
    const cache = new MetadataCacheService(env, { client: redis } as unknown as AuthCacheRedisClientProvider, { maxEntryBytes: 4096 });
    redis.store.set(cache.redisKey(ORG_A, WS_A, token('1')), 'x'.repeat(5000));
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const snap = await cache.get(db.manager(ORG_A, WS_A));
      expect(snap.objects).toHaveLength(1);
      expect(parse.mock.calls.some(([arg]) => typeof arg === 'string' && arg.length === 5000)).toBe(false);
    } finally {
      parse.mockRestore();
    }
    expect(cache.stats().redisRejected.malformed).toBe(1);
  });

  it('an oversized snapshot is encoded once per version, then read through', async () => {
    const cache = new MetadataCacheService(env, { client: redis } as unknown as AuthCacheRedisClientProvider, { maxEntryBytes: 10 });
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      await cache.get(db.manager(ORG_A, WS_A));
      const afterFirst = stringify.mock.calls.length;
      await cache.get(db.manager(ORG_A, WS_A));
      expect(stringify.mock.calls.length).toBe(afterFirst);
    } finally {
      stringify.mockRestore();
    }
    expect(redis.store.size).toBe(0);
    expect(db.loads).toBe(2);
  });

  it('lockExpectedVersion refuses a stale expected version with 409', async () => {
    const cache = instance(redis);
    await expect(cache.lockExpectedVersion(db.manager(ORG_A, WS_A), '1')).resolves.toBeUndefined();
    db.commitObject(WS_A, 'comet');
    await expect(cache.lockExpectedVersion(db.manager(ORG_A, WS_A), '1')).rejects.toBeInstanceOf(MetadataVersionConflictError);
  });
});
