process.env.CORE_ENTITY_CACHE_ENABLED = 'true';
process.env.WORKSPACE_METADATA_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import Redis from 'ioredis';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { CoreEntityCacheService } from '../../engine/core-modules/entity-cache/core-entity-cache.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation, User } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Redis checkpoint — Core Entity Cache. `CORE_ENTITY_CACHE_ENABLED`/`WORKSPACE_METADATA_CACHE_ENABLED`
 * are forced `true` at the very top of this file, before any NestJS module compiles, since the
 * code-level default is `false` (see `EnvironmentVariables`'s own doc comment for why) — every
 * OTHER integration suite in this codebase runs with caching off and is unaffected.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('Core Entity Cache (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let entityCache: CoreEntityCacheService;
  let tenantContext: TenantContextService;
  let redis: AuthCacheRedisClientProvider;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    entityCache = moduleRef.get(CoreEntityCacheService);
    tenantContext = moduleRef.get(TenantContextService);
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    env = moduleRef.get(EnvironmentService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('is enabled for this suite (sanity check on the env override above)', () => {
    expect(entityCache.isEnabled()).toBe(true);
  });

  describe('generic mechanism — MISS, then HIT, with zero further Postgres reads', () => {
    it('a cold lookup is a MISS (calls fetch), a warm lookup is a HIT (never calls fetch again)', async () => {
      let fetchCalls = 0;
      const id = randomUUID();
      const fetch = async () => {
        fetchCalls += 1;
        return { marker: 'value-for-' + id };
      };

      const first = await entityCache.getOrFetch('user', id, fetch);
      expect(first).toEqual({ marker: 'value-for-' + id });
      expect(fetchCalls).toBe(1);

      const second = await entityCache.getOrFetch('user', id, fetch);
      expect(second).toEqual({ marker: 'value-for-' + id });
      expect(fetchCalls).toBe(1); // still 1 — the second call never touched `fetch` at all
    });

    it('never caches a null ("not found") result — every subsequent call retries fetch', async () => {
      let fetchCalls = 0;
      const id = randomUUID();
      const fetch = async () => {
        fetchCalls += 1;
        return null;
      };
      await entityCache.getOrFetch('user', id, fetch);
      await entityCache.getOrFetch('user', id, fetch);
      expect(fetchCalls).toBe(2); // no negative caching
    });
  });

  describe('invalidate() — the epoch mechanism', () => {
    it('invalidate() makes the previously-cached entry unreachable; the next call re-fetches', async () => {
      let fetchCalls = 0;
      const id = randomUUID();
      let currentValue = 'v1';
      const fetch = async () => {
        fetchCalls += 1;
        return { value: currentValue };
      };

      expect(await entityCache.getOrFetch('venue', id, fetch)).toEqual({ value: 'v1' });
      expect(fetchCalls).toBe(1);
      expect(await entityCache.getOrFetch('venue', id, fetch)).toEqual({ value: 'v1' }); // still cached
      expect(fetchCalls).toBe(1);

      currentValue = 'v2';
      await entityCache.invalidate('venue', id);

      expect(await entityCache.getOrFetch('venue', id, fetch)).toEqual({ value: 'v2' }); // re-fetched, new value
      expect(fetchCalls).toBe(2);
      expect(await entityCache.getOrFetch('venue', id, fetch)).toEqual({ value: 'v2' }); // cached again, under the new epoch
      expect(fetchCalls).toBe(2);
    });

    it('PROOF: a concurrent fill that read the OLD epoch before a write\'s invalidate() can never resurface stale data afterward', async () => {
      const id = randomUUID();
      const kind = 'manager_workspace' as const;

      // Simulates the race directly at the mechanism level (CoreEntityCacheService has no public
      // "read epoch then later write under it" seam, so this reconstructs the same sequence
      // `getOrFetch` performs internally, using the service's own public Redis-backed behaviour):
      // 1. A reader starts a fetch under the CURRENT (pre-write) epoch and is SLOW — its own
      //    Postgres read is modelled by `slowFetch`, which doesn't resolve until after step 2.
      let resolveSlowFetch!: (v: { value: string }) => void;
      const slowFetchPromise = new Promise<{ value: string }>((resolve) => {
        resolveSlowFetch = resolve;
      });
      const readerPromise = entityCache.getOrFetch(kind, id, () => slowFetchPromise);

      // Give getOrFetch time to read the epoch and call `fetch` (which is now suspended on the
      // unresolved promise) before the write below runs.
      await new Promise((r) => setTimeout(r, 50));

      // 2. A WRITER commits its change (modelled as already-done — this test only needs the
      //    invalidate() call, which every real call site in this codebase issues after its own
      //    commit) and invalidates.
      await entityCache.invalidate(kind, id);

      // 3. The slow reader's Postgres read finally "returns" — carrying the OLD (pre-write) value,
      //    exactly as a real concurrent read that started before the write's commit would.
      resolveSlowFetch({ value: 'STALE-value-read-before-the-write' });
      const readerResult = await readerPromise;
      expect(readerResult).toEqual({ value: 'STALE-value-read-before-the-write' }); // the reader's own return value is correct for what IT saw — this is not a bug

      // 4. The real proof: a NEW lookup, after the write, must NEVER see that stale value — it must
      // re-fetch, because the epoch it now reads is the POST-invalidate one, under which nothing is cached.
      let freshFetchCalls = 0;
      const freshValue = { value: 'FRESH-value-after-the-write' };
      const freshResult = await entityCache.getOrFetch(kind, id, async () => {
        freshFetchCalls += 1;
        return freshValue;
      });
      expect(freshResult).toEqual(freshValue);
      expect(freshFetchCalls).toBe(1); // genuinely re-fetched, not served from the stale reader's write

      // 5. And the stale reader's own write (which landed under the OLD, now-unreachable epoch) must
      // never resurface even on a THIRD lookup.
      const thirdResult = await entityCache.getOrFetch(kind, id, async () => freshValue);
      expect(thirdResult).toEqual(freshValue);
    });
  });

  describe('Redis outage and corruption fallback', () => {
    it('falls through to fetch() when Redis is unreachable, and never throws', async () => {
      // An ISOLATED, throwaway service instance pointed at a port nothing listens on — never the
      // shared app-wide Redis connection every other test in this file depends on, so this test
      // cannot leak a broken connection into anything that runs after it.
      const deadRedis = { client: new Redis({ port: 1, host: '127.0.0.1', connectTimeout: 300, commandTimeout: 150, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null }) };
      deadRedis.client.on('error', () => undefined);
      const isolated = new CoreEntityCacheService(env, deadRedis as unknown as AuthCacheRedisClientProvider);
      try {
        const id = randomUUID();
        const result = await isolated.getOrFetch('user', id, async () => ({ ok: true }));
        expect(result).toEqual({ ok: true }); // the fetch still ran and its result was still returned — never an exception
      } finally {
        deadRedis.client.disconnect();
      }
    });

    it('treats a corrupted (non-JSON) cache entry as a miss and recovers, rather than throwing', async () => {
      const id = randomUUID();
      // Write garbage directly under the epoch this lookup will read (epoch 0 — nothing invalidated it yet).
      await redis.client.set(`crewflow:${process.env.NODE_ENV ?? 'test'}:entitycache:user:${id}:v0`, 'not valid json {{{');
      const result = await entityCache.getOrFetch('user', id, async () => ({ recovered: true }));
      expect(result).toEqual({ recovered: true });
    });

    it('PROOF of the precise freshness guarantee (Phase 0A): a failed invalidate() leaves a BOUNDED staleness window, closed by the NEXT successful invalidate() — never unbounded, never silently permanent', async () => {
      const id = randomUUID();
      let currentValue = 'before-write';
      const fetch = async () => ({ value: currentValue });

      // Warm the cache normally, through the real shared Redis connection every other test uses.
      expect(await entityCache.getOrFetch('organisation', id, fetch)).toEqual({ value: 'before-write' });

      // The write happens (modelled: just flip the variable `fetch` reads — the real equivalent is
      // a committed Postgres UPDATE). Its own invalidate() call is simulated as FAILING every
      // attempt, via an isolated service instance pointed at a dead Redis — the shared `entityCache`
      // instance used for reads below is completely untouched and stays healthy throughout, exactly
      // modelling "the specific invalidate() call experiences a transient failure while Redis
      // otherwise keeps answering reads normally" (this file's own top doc comment explains why
      // that's the realistic failure mode, not a sustained outage).
      currentValue = 'after-write';
      const deadRedis = { client: new Redis({ port: 1, host: '127.0.0.1', connectTimeout: 100, commandTimeout: 100, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null }) };
      deadRedis.client.on('error', () => undefined);
      const failingInvalidate = new CoreEntityCacheService(env, deadRedis as unknown as AuthCacheRedisClientProvider);
      await failingInvalidate.invalidate('organisation', id); // all 3 retries fail silently (never throws)
      deadRedis.client.disconnect();

      // The bounded staleness window: a read through the REAL, healthy Redis connection still sees
      // the OLD value — this is the one case in this design where that is the documented, correct
      // (if unwelcome) outcome, not a bug.
      expect(await entityCache.getOrFetch('organisation', id, fetch)).toEqual({ value: 'before-write' });

      // The window closes the moment a LATER invalidate() actually succeeds (a retried write, a
      // subsequent mutation, or simply Redis recovering in time for the NEXT write to this same
      // row) — never unbounded, never requiring an operator to intervene.
      await entityCache.invalidate('organisation', id);
      expect(await entityCache.getOrFetch('organisation', id, fetch)).toEqual({ value: 'after-write' });
    });
  });

  describe('wired consumers — real entities, real tenant context', () => {
    it('User display: HIT/MISS, cross-manager isolation, and profile-update invalidation reflect correctly', async () => {
      const orgA = await factory.createOrganisation('cache-user-a');
      const orgB = await factory.createOrganisation('cache-user-b');
      const managerA = await factory.createInternalManager(orgA, { label: 'cache-ua' });
      const managerB = await factory.createInternalManager(orgB, { label: 'cache-ub' });

      const resultA = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getUserDisplay(manager, managerA.userId),
      );
      const resultB = await tenantContext.runInTenantContext({ organisationId: orgB.id, workspaceId: null, userId: managerB.userId, role: '' }, (manager) =>
        entityCache.getUserDisplay(manager, managerB.userId),
      );
      // Phase 0C: `status` is deliberately NOT part of this projection (see the type's own doc
      // comment) — locking this in as a regression-tested contract, not just a TypeScript-time fact.
      expect(resultA).not.toHaveProperty('status');
      expect(resultA?.organisationId).toBe(orgA.id);
      expect(resultB?.organisationId).toBe(orgB.id);
      expect(resultA?.id).not.toBe(resultB?.id); // no cross-manager collision

      // Mutate A's name directly, bypassing the service layer (this test only verifies the cache
      // mechanism's own contract, not ProfileService — that's covered by its own invalidation call
      // sites in profile.service.ts), then invalidate exactly as that service does, and confirm the
      // NEXT read reflects the change rather than the stale cached one.
      await adminDataSource.manager.update(User, managerA.userId, { firstName: 'ChangedByTest' });
      const staleRead = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getUserDisplay(manager, managerA.userId),
      );
      expect(staleRead?.firstName).not.toBe('ChangedByTest'); // proves it WAS cached (still serving the pre-mutation value)

      await entityCache.invalidate('user', managerA.userId);
      const freshRead = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getUserDisplay(manager, managerA.userId),
      );
      expect(freshRead?.firstName).toBe('ChangedByTest');

      // B's cache entry was never touched by A's invalidation.
      const bStillCached = await tenantContext.runInTenantContext({ organisationId: orgB.id, workspaceId: null, userId: managerB.userId, role: '' }, (manager) =>
        entityCache.getUserDisplay(manager, managerB.userId),
      );
      expect(bStillCached?.id).toBe(resultB?.id);
    });

    it('Organisation display: HIT/MISS and cross-organisation isolation', async () => {
      const orgA = await factory.createOrganisation('cache-org-a');
      const orgB = await factory.createOrganisation('cache-org-b');
      const managerA = await factory.createInternalManager(orgA, { label: 'cache-oa' });

      const first = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getOrganisationDisplay(manager, orgA.id),
      );
      expect(first?.id).toBe(orgA.id);
      expect(first?.name).toBe(orgA.name);

      const second = await tenantContext.runInTenantContext({ organisationId: orgB.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getOrganisationDisplay(manager, orgB.id),
      );
      expect(second?.id).toBe(orgB.id);
      expect(second?.name).not.toBe(first?.name);

      await adminDataSource.manager.update(Organisation, orgA.id, { name: 'Renamed-' + orgA.id });
      await entityCache.invalidate('organisation', orgA.id);
      const afterRename = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        entityCache.getOrganisationDisplay(manager, orgA.id),
      );
      expect(afterRename?.name).toBe('Renamed-' + orgA.id);
    });

    it('ManagerWorkspace display (by owner): HIT/MISS and rename invalidation', async () => {
      const org = await factory.createOrganisation('cache-mws');
      const manager = await factory.createInternalManager(org, { label: 'cache-mws-owner' });

      const first = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        entityCache.getManagerWorkspaceByOwner(m, manager.userId),
      );
      expect(first?.ownerUserId).toBe(manager.userId);

      await adminDataSource.manager.update(ManagerWorkspace, { ownerUserId: manager.userId }, { name: 'Renamed Workspace' });
      const stale = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        entityCache.getManagerWorkspaceByOwner(m, manager.userId),
      );
      expect(stale?.name).not.toBe('Renamed Workspace');

      await entityCache.invalidate('manager_workspace_by_owner', manager.userId);
      const fresh = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        entityCache.getManagerWorkspaceByOwner(m, manager.userId),
      );
      expect(fresh?.name).toBe('Renamed Workspace');
    });

    it('Venue summary: HIT/MISS and name-change invalidation', async () => {
      const org = await factory.createOrganisation('cache-venue');
      const manager = await factory.createInternalManager(org, { label: 'cache-venue-owner' });
      // venue_tenant's RLS requires BOTH organisation_id AND workspace_id to match the bound
      // context — a venue with no workspace_id can never be seen under RLS regardless of context.
      const workspaceId = manager.workspaceId!;
      const venueId = await adminDataSource.manager
        .insert(Venue, { organisationId: org.id, workspaceId, name: 'Original Venue Name', createdBy: manager.userId })
        .then((r) => r.identifiers[0]!.id as string);

      const first = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId, userId: manager.userId, role: '' }, (m) =>
        entityCache.getVenueSummary(m, venueId),
      );
      expect(first?.name).toBe('Original Venue Name');

      await adminDataSource.manager.update(Venue, venueId, { name: 'Renamed Venue' });
      const stale = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId, userId: manager.userId, role: '' }, (m) =>
        entityCache.getVenueSummary(m, venueId),
      );
      expect(stale?.name).toBe('Original Venue Name'); // still cached

      await entityCache.invalidate('venue', venueId);
      const fresh = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId, userId: manager.userId, role: '' }, (m) =>
        entityCache.getVenueSummary(m, venueId),
      );
      expect(fresh?.name).toBe('Renamed Venue');
    });
  });

  describe('cache-on vs cache-off response equivalence', () => {
    it('getUserDisplay returns byte-identical shape and values whether the cache is a cold MISS or a warm HIT', async () => {
      const org = await factory.createOrganisation('cache-equiv');
      const manager = await factory.createInternalManager(org, { label: 'cache-equiv-u' });

      const cold = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        entityCache.getUserDisplay(m, manager.userId),
      );
      const warm = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        entityCache.getUserDisplay(m, manager.userId),
      );
      expect(warm).toEqual(cold);
    });
  });

  describe('concurrency', () => {
    it('10 concurrent cold reads for the same id all resolve to the same value and never corrupt each other', async () => {
      const org = await factory.createOrganisation('cache-concurrent');
      const manager = await factory.createInternalManager(org, { label: 'cache-concurrent-u' });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
            entityCache.getUserDisplay(m, manager.userId),
          ),
        ),
      );
      for (const r of results) expect(r).toEqual(results[0]);
    });

    it('concurrent writers invalidating the same id in a tight loop never leave the cache permanently stuck on an old value', async () => {
      const id = randomUUID();
      let version = 0;
      const fetch = async () => ({ version });

      await entityCache.getOrFetch('venue', id, fetch); // seed

      await Promise.all(
        Array.from({ length: 20 }, async (_v, i) => {
          version = i + 1;
          await entityCache.invalidate('venue', id);
        }),
      );

      // Whatever the final state, a fresh read must reflect a value `fetch` would currently return,
      // never a value from a since-invalidated epoch.
      const final = await entityCache.getOrFetch('venue', id, fetch);
      expect(final).toEqual({ version });
    });
  });
});
