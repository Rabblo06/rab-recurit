import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { MetadataCacheContextError, MetadataVersionConflictError } from '../../engine/metadata/cache/metadata-cache.errors';
import { MetadataCacheModule } from '../../engine/metadata/cache/metadata-cache.module';
import { MetadataCacheService } from '../../engine/metadata/cache/metadata-cache.service';
import { WorkspaceMetadataSnapshot } from '../../engine/metadata/cache/metadata-snapshot';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Metadata engine M1 / E5 — the versioned per-workspace metadata cache against a real PostgreSQL (throwaway, FORCE RLS,
 * the runtime role) and a real Redis. M0-TEST-STRATEGY.md §M1 "Cache (E5)", M0-THREAT-MODEL.md MT-11.
 *
 * "Two API instances" = two MetadataCacheService objects, each with its OWN Redis connection, its OWN in-process tier and
 * its OWN PostgreSQL pool (instance B uses a second DataSource). Those three things are the whole state of the cache, so
 * this is exactly what two processes would share and not share. Instance A is the one Nest builds (proves the module's DI).
 *
 * Tenant binding: the transaction-local GUCs `rab.organisation_id` / `rab.workspace_id` are set the way
 * TenantContextService.bindGucs sets them (set_config(..., true)); the seeded workspaces are not provisioned (no workspace
 * schema), which this cache does not need — it reads core.* only.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

interface Ws {
  org: string;
  ws: string;
}

describeIfDb('Metadata cache E5: versioned per-workspace cache, PostgreSQL authoritative (integration)', () => {
  let app: INestApplication;
  let env: EnvironmentService;
  let dsA: DataSource;
  let dsB: DataSource;
  let admin: DataSource;
  let cacheA: MetadataCacheService;
  let cacheB: MetadataCacheService;
  let redisB: AuthCacheRedisClientProvider;
  let inspect: Redis;
  const createdWorkspaces: Ws[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, MetadataCacheModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    env = moduleRef.get(EnvironmentService);
    dsA = moduleRef.get(DataSource);
    cacheA = moduleRef.get(MetadataCacheService);
    dsB = new DataSource({ ...dsA.options });
    await dsB.initialize();
    redisB = new AuthCacheRedisClientProvider(env);
    await ready(redisB.client);
    cacheB = new MetadataCacheService(env, redisB);
    await ready(moduleRef.get(AuthCacheRedisClientProvider).client);
    inspect = new Redis(env.get('REDIS_URL'), { maxRetriesPerRequest: 1 });
    admin = createAdminDataSource();
    await admin.initialize();
  });

  afterAll(async () => {
    // Remove only the keys this file wrote (by exact workspace prefix), never a broad flush.
    for (const w of createdWorkspaces) {
      const keys = await scanKeys(cacheA.redisKey(w.org, w.ws, '*'));
      if (keys.length) await inspect.del(...keys);
    }
    inspect?.disconnect();
    await redisB?.onModuleDestroy();
    await dsB?.destroy();
    await admin?.destroy();
    await app?.close();
  });

  // ------------------------------------------------------------------------------------------------ helpers

  async function ready(client: Redis): Promise<void> {
    if (client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('redis not ready')), 10_000);
      client.once('ready', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async function scanKeys(pattern: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await inspect.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out;
  }

  /** Organisation + owner user + workspace row (owner connection), the FK target of every metadata table. */
  async function seedWorkspace(orgId?: string): Promise<Ws> {
    const label = `mdc-${randomUUID().slice(0, 12)}`;
    let org = orgId;
    if (!org) {
      const [o] = (await admin.query(`INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id`, [label])) as Array<{ id: string }>;
      org = o!.id;
    }
    const [u] = (await admin.query(
      `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1::uuid, $2::text, 'Md', 'Cache', 'active') RETURNING id`,
      [org, `${label}@mdc.invalid`],
    )) as Array<{ id: string }>;
    const [w] = (await admin.query(
      `INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
       VALUES ($1::uuid, $2::uuid, $3::text, $3::text, 'active', 'CREATING') RETURNING id`,
      [org, u!.id, label],
    )) as Array<{ id: string }>;
    const seeded = { org: org!, ws: w!.id };
    createdWorkspaces.push(seeded);
    return seeded;
  }

  /** A tenant transaction on the runtime role, bound like TenantContextService.bindGucs. */
  function inTenant<T>(ds: DataSource, w: Ws | null, fn: (m: EntityManager) => Promise<T>, isolation?: 'REPEATABLE READ'): Promise<T> {
    const run = async (m: EntityManager) => {
      if (w) await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [w.org, w.ws]);
      return fn(m);
    };
    return isolation ? ds.transaction(isolation, run) : ds.transaction(run);
  }

  /**
   * One custom object row (M1-meta's core.object_metadata). Inserted by the runtime role inside the tenant transaction,
   * like the real metadata service will — so the version trigger runs under FORCE RLS.
   */
  async function insertObject(m: EntityManager, w: Ws, name: string): Promise<void> {
    await m.query(
      `INSERT INTO core.object_metadata (organisation_id, workspace_id, name_singular, name_plural, label_singular, label_plural, physical_table, is_custom, allows_custom_fields)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $3::text, $4::text, $5::text, true, true)`,
      [w.org, w.ws, name, `${name}s`, `c_${randomUUID().replace(/-/g, '').slice(0, 20)}`],
    );
  }

  /** Commit one object in its own transaction (one version step). */
  const commitObject = (ds: DataSource, w: Ws, name: string) => inTenant(ds, w, (m) => insertObject(m, w, name));
  const versionOf = async (w: Ws) =>
    ((await admin.query(`SELECT metadata_version::text AS v FROM core.workspace_metadata_state WHERE workspace_id = $1`, [w.ws])) as Array<{ v: string }>)[0]?.v ?? null;
  const names = (s: WorkspaceMetadataSnapshot) => s.objects.map((o) => String(o.name_singular)).sort();

  // ------------------------------------------------------------------------------------------------ version authority

  describe('the version is bumped by PostgreSQL in the same transaction as the change', () => {
    it('first change creates version 1, the next transaction makes it 2', async () => {
      const w = await seedWorkspace();
      expect(await versionOf(w)).toBeNull();
      await commitObject(dsA, w, 'alpha');
      expect(await versionOf(w)).toBe('1');
      await commitObject(dsA, w, 'beta');
      expect(await versionOf(w)).toBe('2');
    });

    // Owner condition 1 (M1 SQL approval): concurrent FIRST changes of a workspace that has no version row yet. Plain
    // metadata writes take no advisory lock (only lockExpectedVersion does); the bump trigger's INSERT ... ON CONFLICT
    // must make them safe on its own: no unique violation, and exactly one version step per committed transaction.
    const objectCount = async (w: Ws) =>
      ((await admin.query(`SELECT count(*)::int AS n FROM core.object_metadata WHERE workspace_id = $1`, [w.ws])) as Array<{ n: number }>)[0]!.n;

    it('two concurrent FIRST changes (no version row yet) both commit: no unique violation, version 2, no lost increment', async () => {
      const w = await seedWorkspace();
      expect(await versionOf(w)).toBeNull();
      let firstInserted!: () => void;
      const firstHasInserted = new Promise<void>((r) => (firstInserted = r));
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((r) => (releaseFirst = r));
      const first = inTenant(dsA, w, async (m) => {
        await insertObject(m, w, 'racea'); // creates the version row, uncommitted
        firstInserted();
        await firstMayCommit;
      });
      await firstHasInserted;
      let secondDone = false;
      // The second first-change starts while the first one's version row is uncommitted: its bump must wait on that row,
      // then take the ON CONFLICT path once the first commits (never 23505, never a second "version 1").
      const second = inTenant(dsB, w, (m) => insertObject(m, w, 'raceb')).then(() => {
        secondDone = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(secondDone).toBe(false);
      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(await versionOf(w)).toBe('2');
      expect(await objectCount(w)).toBe(2);
    });

    it('six uncoordinated concurrent first changes on two API instances: all commit, version = 6 (one step each)', async () => {
      const w = await seedWorkspace();
      expect(await versionOf(w)).toBeNull();
      const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => commitObject(i % 2 ? dsB : dsA, w, `swarm${i}`)));
      expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      expect(await versionOf(w)).toBe('6');
      expect(await objectCount(w)).toBe(6);
    });

    it('a rolled-back change leaves the version unchanged', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await expect(
        inTenant(dsA, w, async (m) => {
          await insertObject(m, w, 'beta');
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await versionOf(w)).toBe('1');
    });

    it('several statements and a released savepoint in one transaction are ONE version step', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await inTenant(dsA, w, async (m) => {
        await insertObject(m, w, 'beta');
        await m.query('SAVEPOINT s1');
        await insertObject(m, w, 'gamma');
        await m.query('RELEASE SAVEPOINT s1');
        await m.query(`UPDATE core.object_metadata SET label_singular = 'Beta!' WHERE name_singular = 'beta'`);
        await m.query(`DELETE FROM core.object_metadata WHERE name_singular = 'gamma'`);
      });
      expect(await versionOf(w)).toBe('2');
    });

    it('the version can never decrease, and the app cannot delete the version row', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await commitObject(dsA, w, 'beta');
      await expect(inTenant(dsA, w, (m) => m.query(`UPDATE core.workspace_metadata_state SET metadata_version = 1`))).rejects.toMatchObject({ code: '42501' });
      await expect(inTenant(dsA, w, (m) => m.query(`DELETE FROM core.workspace_metadata_state`))).rejects.toMatchObject({ code: '42501' });
      expect(await versionOf(w)).toBe('2');
    });

    it('no tenant bound: zero rows from the version table and the cached tables', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      const counts = await inTenant(dsA, null, (m) =>
        m.query(
          `SELECT (SELECT count(*) FROM core.workspace_metadata_state)::int AS s, (SELECT count(*) FROM core.object_metadata)::int AS o`,
        ),
      );
      expect(counts).toEqual([{ s: 0, o: 0 }]);
    });

    it('a version number reused with a new bump time (restore / recreated row) never serves the old entry', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await inTenant(dsA, w, (m) => cacheA.get(m)); // v1 cached
      // Simulate a restore to before v1 plus a different change: owner connection resets the row and the content.
      await admin.query(`ALTER TABLE core.workspace_metadata_state DISABLE TRIGGER workspace_metadata_state_guard`);
      try {
        await admin.query(`DELETE FROM core.workspace_metadata_state WHERE workspace_id = $1`, [w.ws]);
      } finally {
        await admin.query(`ALTER TABLE core.workspace_metadata_state ENABLE TRIGGER workspace_metadata_state_guard`);
      }
      await commitObject(dsA, w, 'beta'); // recreates version 1 with a new bump time
      expect(await versionOf(w)).toBe('1');
      const snap = await inTenant(dsB, w, (m) => cacheB.get(m));
      expect(names(snap)).toEqual(['alpha', 'beta']);
      // A still holds the old "version 1" in memory; it must not serve it.
      expect(names(await inTenant(dsA, w, (m) => cacheA.get(m)))).toEqual(['alpha', 'beta']);
    });

    it('deleting the workspace still cascades its metadata and version row', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await admin.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [w.ws]);
      expect(await versionOf(w)).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------------------ two instances

  describe('two instances with real Redis', () => {
    it('a change committed on A is seen by B on its very next read (no message, no TTL)', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      const before = await inTenant(dsB, w, (m) => cacheB.get(m));
      expect(names(before)).toEqual(['alpha']);
      // B now holds v1 in memory and in Redis.
      expect((await inTenant(dsB, w, (m) => cacheB.get(m))).version).toBe('1');

      await commitObject(dsA, w, 'beta'); // the change, on instance A's pool

      const after = await inTenant(dsB, w, (m) => cacheB.get(m));
      expect(after.version).toBe('2');
      expect(names(after)).toEqual(['alpha', 'beta']);
    });

    it('B is served what A filled into Redis, verified, without touching the metadata tables', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await inTenant(dsA, w, (m) => cacheA.get(m)); // A fills v1
      const loadsBefore = cacheB.stats().dbLoads;
      const hitsBefore = cacheB.stats().redisHits;
      const snap = await inTenant(dsB, w, (m) => cacheB.get(m));
      expect(names(snap)).toEqual(['alpha']);
      expect(cacheB.stats().dbLoads).toBe(loadsBefore);
      expect(cacheB.stats().redisHits).toBe(hitsBefore + 1);
    });
  });

  // ------------------------------------------------------------------------------------------------ fill vs change

  describe('a concurrent fill and change never leave stale content under the new version', () => {
    it('a commit between the version read and the load is stored only under the version read with the content', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      let statements = 0;
      const snap = await inTenant(dsB, w, async (m) => {
        // Interleave: let B's version read run (v1), then commit a change on A before B's load statement runs.
        const interleaved = new Proxy(m, {
          get(target, prop, receiver) {
            if (prop !== 'query') return Reflect.get(target, prop, receiver);
            return async (sql: string, params?: unknown[]) => {
              statements += 1;
              if (statements === 2) await commitObject(dsA, w, 'beta');
              return target.query(sql, params);
            };
          },
        });
        return cacheB.get(interleaved);
      });
      expect(snap.version).toBe('2');
      expect(names(snap)).toEqual(['alpha', 'beta']);
      const keys = await scanKeys(cacheA.redisKey(w.org, w.ws, '*'));
      expect(keys).toHaveLength(1);
      expect(keys[0]!.startsWith(cacheA.redisKey(w.org, w.ws, '2.'))).toBe(true);
      // and a fresh reader of v2 gets the same content
      cacheA.clearLocal();
      expect(names(await inTenant(dsA, w, (m) => cacheA.get(m)))).toEqual(['alpha', 'beta']);
    });

    it('a reader still on an old snapshot fills only the OLD version; the next transaction gets the new content', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      cacheB.clearLocal();
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      let snapshotTaken!: () => void;
      const taken = new Promise<void>((r) => (snapshotTaken = r));
      const slowReader = inTenant(
        dsB,
        w,
        async (m) => {
          await m.query('SELECT 1'); // REPEATABLE READ: the snapshot is fixed at the first statement
          snapshotTaken();
          await gate;
          return cacheB.get(m);
        },
        'REPEATABLE READ',
      );
      await taken;
      await commitObject(dsA, w, 'beta'); // v2 commits while the slow reader holds its v1 snapshot
      resume();
      const old = await slowReader;
      expect(old.version).toBe('1');
      expect(names(old)).toEqual(['alpha']);

      const fresh = await inTenant(dsB, w, (m) => cacheB.get(m));
      expect(fresh.version).toBe('2');
      expect(names(fresh)).toEqual(['alpha', 'beta']);
    });

    it('stress: concurrent fills on two instances while versions advance — every entry matches its version', async () => {
      const w = await seedWorkspace();
      const WRITES = 25;
      let writing = true;
      const seen: WorkspaceMetadataSnapshot[] = [];
      const writer = (async () => {
        for (let i = 1; i <= WRITES; i++) await commitObject(dsA, w, `obj${i}`);
        writing = false;
      })();
      const reader = (ds: DataSource, cache: MetadataCacheService) =>
        (async () => {
          while (writing) seen.push(await inTenant(ds, w, (m) => cache.get(m)));
        })();
      await Promise.all([writer, reader(dsA, cacheA), reader(dsB, cacheB), reader(dsA, cacheA), reader(dsB, cacheB)]);

      // Invariant: version k has exactly the objects obj1..objk (each commit adds one object in one transaction).
      const expectedFor = (v: string) => Array.from({ length: Number(v) }, (_, i) => `obj${i + 1}`).sort();
      for (const s of seen.filter((x) => x.version !== '0')) expect(names(s)).toEqual(expectedFor(s.version));
      // Every Redis entry for this workspace decodes (through a cold instance) to the content of ITS version.
      const cold = new MetadataCacheService(env, redisB);
      const keys = await scanKeys(cacheA.redisKey(w.org, w.ws, '*'));
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const raw = JSON.parse((await inspect.get(key))!) as { d: string };
        const payload = JSON.parse(raw.d) as { v: string; s: string; objects: Array<{ name_singular: string }> };
        expect(key).toBe(cacheA.redisKey(w.org, w.ws, `${payload.v}.${payload.s}`));
        expect(payload.objects.map((o) => o.name_singular).sort()).toEqual(expectedFor(payload.v));
      }
      expect(names(await inTenant(dsB, w, (m) => cold.get(m)))).toEqual(expectedFor(String(WRITES)));
    });
  });

  // ------------------------------------------------------------------------------------------------ own writes (review #164)

  describe("a transaction's own uncommitted metadata change is never cached", () => {
    it('get() between two changes of one transaction caches nothing; after commit everyone sees both', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await inTenant(dsA, w, async (m) => {
        await insertObject(m, w, 'beta');
        const mid = await cacheA.get(m);
        expect(names(mid)).toEqual(['alpha', 'beta']);
        await insertObject(m, w, 'gamma');
        // nothing for this workspace's new version was published while uncommitted
        expect((await scanKeys(cacheA.redisKey(w.org, w.ws, '2.*'))).length).toBe(0);
      });
      expect(names(await inTenant(dsA, w, (m) => cacheA.get(m)))).toEqual(['alpha', 'beta', 'gamma']);
      expect(names(await inTenant(dsB, w, (m) => cacheB.get(m)))).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('a rolled-back savepoint read inside the transaction never reaches the cache', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await inTenant(dsA, w, async (m) => {
        await m.query('SAVEPOINT s1');
        await insertObject(m, w, 'beta');
        expect(names(await cacheA.get(m))).toEqual(['alpha', 'beta']);
        await m.query('ROLLBACK TO SAVEPOINT s1');
        await insertObject(m, w, 'gamma');
      });
      expect(names(await inTenant(dsB, w, (m) => cacheB.get(m)))).toEqual(['alpha', 'gamma']);
      expect(names(await inTenant(dsA, w, (m) => cacheA.get(m)))).toEqual(['alpha', 'gamma']);
    });

    it('the version row is written only by the trigger: direct UPDATE / INSERT are refused, normal changes still bump', async () => {
      const w = await seedWorkspace();
      await commitObject(dsA, w, 'alpha');
      await expect(
        inTenant(dsA, w, (m) => m.query(`UPDATE core.workspace_metadata_state SET last_bump_xact = pg_catalog.pg_current_xact_id()`)),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(inTenant(dsA, w, (m) => m.query(`UPDATE core.workspace_metadata_state SET metadata_version = metadata_version + 5`))).rejects.toMatchObject({ code: '42501' });
      const fresh = await seedWorkspace();
      await expect(
        inTenant(dsA, fresh, (m) =>
          m.query(`INSERT INTO core.workspace_metadata_state (workspace_id, organisation_id) VALUES ($1::uuid, $2::uuid)`, [fresh.ws, fresh.org]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await commitObject(dsA, w, 'beta');
      expect(await versionOf(w)).toBe('2');
    });

    it("lockExpectedVersion('0'): two concurrent first changes of a workspace — exactly one wins, the other gets 409", async () => {
      const w = await seedWorkspace();
      let releaseFirst!: () => void;
      const firstHolds = new Promise<void>((r) => (releaseFirst = r));
      let firstLocked!: () => void;
      const locked = new Promise<void>((r) => (firstLocked = r));
      const first = inTenant(dsA, w, async (m) => {
        await cacheA.lockExpectedVersion(m, '0');
        firstLocked();
        await insertObject(m, w, 'first');
        await firstHolds;
      });
      await locked;
      const second = inTenant(dsB, w, async (m) => {
        await cacheB.lockExpectedVersion(m, '0');
        await insertObject(m, w, 'second');
      });
      await new Promise((r) => setTimeout(r, 300)); // the second is now waiting on the workspace lock
      releaseFirst();
      await first;
      await expect(second).rejects.toBeInstanceOf(MetadataVersionConflictError);
      expect(names(await inTenant(dsA, w, (m) => cacheA.get(m)))).toEqual(['first']);
    });
  });

  // ------------------------------------------------------------------------------------------------ tenant scoping

  describe('a key can never be served to another workspace or organisation', () => {
    it('two workspaces at the same version number each get only their own metadata', async () => {
      const w1 = await seedWorkspace();
      const w2 = await seedWorkspace(); // another organisation
      const w3 = await seedWorkspace(w1.org); // same organisation, other workspace
      await commitObject(dsA, w1, 'onlyInW1');
      await commitObject(dsA, w2, 'onlyInW2');
      await commitObject(dsA, w3, 'onlyInW3');
      expect([await versionOf(w1), await versionOf(w2), await versionOf(w3)]).toEqual(['1', '1', '1']);
      expect(names(await inTenant(dsA, w1, (m) => cacheA.get(m)))).toEqual(['onlyInW1']);
      expect(names(await inTenant(dsA, w2, (m) => cacheA.get(m)))).toEqual(['onlyInW2']);
      expect(names(await inTenant(dsA, w3, (m) => cacheA.get(m)))).toEqual(['onlyInW3']);
      expect(names(await inTenant(dsB, w2, (m) => cacheB.get(m)))).toEqual(['onlyInW2']);
    });

    it("another workspace's valid entry copied under this workspace's key is rejected and rebuilt from PostgreSQL", async () => {
      const w1 = await seedWorkspace();
      const w2 = await seedWorkspace();
      await commitObject(dsA, w1, 'secretOfW1');
      await commitObject(dsA, w2, 'ownOfW2');
      await inTenant(dsA, w1, (m) => cacheA.get(m)); // W1 v1 in Redis
      const [k1] = await scanKeys(cacheA.redisKey(w1.org, w1.ws, '*'));
      const head2 = await inTenant(dsA, w2, (m) => cacheA.readHead(m));
      const k2 = cacheA.redisKey(w2.org, w2.ws, `${head2.version}.${head2.stamp}`);
      await inspect.set(k2, (await inspect.get(k1!))!); // attacker with Redis write access
      const cold = new MetadataCacheService(env, redisB);
      const snap = await inTenant(dsB, w2, (m) => cold.get(m));
      expect(snap.workspaceId).toBe(w2.ws);
      expect(names(snap)).toEqual(['ownOfW2']);
      expect(cold.stats().redisRejected.mac).toBe(1);
      expect(cold.stats().dbLoads).toBe(1);
    });

    it('with no tenant bound the cache refuses (fail closed), it never reads "all workspaces"', async () => {
      await expect(inTenant(dsA, null, (m) => cacheA.get(m))).rejects.toBeInstanceOf(MetadataCacheContextError);
      await expect(cacheA.get(dsA.manager)).rejects.toBeInstanceOf(MetadataCacheContextError);
    });
  });

  // ------------------------------------------------------------------------------------------------ Redis down

  describe('Redis down: reads come from PostgreSQL (fail closed, not open)', () => {
    it('an instance whose Redis is unreachable reads PostgreSQL and still sees every change at once', async () => {
      const dead = { client: new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 300, commandTimeout: 150, retryStrategy: () => null }) };
      dead.client.on('error', () => undefined);
      const cacheD = new MetadataCacheService(env, dead as unknown as AuthCacheRedisClientProvider);
      try {
        const w = await seedWorkspace();
        await commitObject(dsA, w, 'alpha');
        expect(names(await inTenant(dsB, w, (m) => cacheD.get(m)))).toEqual(['alpha']);
        await commitObject(dsA, w, 'beta');
        expect(names(await inTenant(dsB, w, (m) => cacheD.get(m)))).toEqual(['alpha', 'beta']);
        const stats = cacheD.stats();
        expect(stats.redisHits).toBe(0);
        expect(stats.redisErrors).toBeGreaterThan(0);
        expect(stats.dbLoads).toBe(2);
      } finally {
        dead.client.disconnect();
      }
    });

    it('Redis dropping mid-way changes nothing about correctness', async () => {
      const live = new AuthCacheRedisClientProvider(env);
      await ready(live.client);
      const cacheE = new MetadataCacheService(env, live);
      try {
        const w = await seedWorkspace();
        await commitObject(dsA, w, 'alpha');
        expect(names(await inTenant(dsB, w, (m) => cacheE.get(m)))).toEqual(['alpha']);
        live.client.disconnect();
        await commitObject(dsA, w, 'beta');
        expect(names(await inTenant(dsB, w, (m) => cacheE.get(m)))).toEqual(['alpha', 'beta']);
      } finally {
        live.client.disconnect();
      }
    });
  });
});
