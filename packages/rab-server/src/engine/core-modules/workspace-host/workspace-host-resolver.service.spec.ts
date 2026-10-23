import { CoreEntityCacheService } from '../entity-cache/core-entity-cache.service';
import { EnvironmentService } from '../environment/environment.service';
import { EnvironmentVariables } from '../environment/environment-variables';
import { WorkspaceOriginTrustRegistry } from '../environment/workspace-origin-trust.registry';
import { WorkspaceHostLookupService } from './workspace-host-lookup.service';
import { WorkspaceHostResolverService } from './workspace-host-resolver.service';
import { HostLabelResolution } from './workspace-host.types';
import { WorkspaceOriginTrustService } from './workspace-origin-trust.service';

/** An in-memory stand-in for the ioredis client CoreEntityCacheService uses (GET / SET EX / INCR). */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttl = new Map<string, number>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _ex: 'EX', seconds: number) {
    this.store.set(key, value);
    this.ttl.set(key, seconds);
    return 'OK';
  }
  async incr(key: string) {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }
}

const WS_A = { workspaceId: '00000000-0000-4000-8000-00000000000a', organisationId: '00000000-0000-4000-8000-0000000000a1' };
const WS_B = { workspaceId: '00000000-0000-4000-8000-00000000000b', organisationId: '00000000-0000-4000-8000-0000000000b1' };

function setup(opts: { cache: boolean; vars?: Partial<EnvironmentVariables> }) {
  const vars: Partial<EnvironmentVariables> = {
    NODE_ENV: 'production',
    APP_URL: 'https://app.example.com',
    ACCOUNTS_URL: 'https://accounts.example.com',
    CORS_ORIGINS: 'https://app.example.com',
    TRUSTED_PROXY_CIDRS: '10.0.0.5/32',
    WORKSPACE_BASE_DOMAIN: 'workspaces.example.com',
    WORKSPACE_HOST_ROUTING_ENABLED: true,
    WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
    CORE_ENTITY_CACHE_ENABLED: opts.cache,
    ...opts.vars,
  };
  const registry = new WorkspaceOriginTrustRegistry();
  const env = new EnvironmentService({ get: (key: keyof EnvironmentVariables) => (vars as any)[key] } as any, registry);
  const redis = new FakeRedis();
  const cache = new CoreEntityCacheService(env, { client: redis } as any);
  // The "database": label -> answer, mutable to simulate rename / READY / suspension.
  const registryRows = new Map<string, HostLabelResolution>([
    ['acme', { kind: 'workspace', ...WS_A, canonicalLabel: 'acme', displayName: null }],
    ['bravo', { kind: 'workspace', ...WS_B, canonicalLabel: 'bravo', displayName: null }],
  ]);
  const lookup = { lookup: jest.fn(async (label: string) => registryRows.get(label) ?? { kind: 'unknown' as const }) };
  const tenantContext = { runInTenantContext: jest.fn() };
  const resolver = new WorkspaceHostResolverService(env, lookup as unknown as WorkspaceHostLookupService, cache, registry, tenantContext as any);
  const originTrust = new WorkspaceOriginTrustService(env, resolver, registry);
  return { env, resolver, originTrust, lookup, registryRows, redis, registry, tenantContext };
}

const req = (headers: Record<string, string | string[]>, peer = '203.0.113.9') => ({ headers, socket: { remoteAddress: peer } });

describe('WorkspaceHostResolverService.resolveRequest', () => {
  it('routing off → none, and the registry is never consulted', async () => {
    const { resolver, lookup } = setup({ cache: false, vars: { WORKSPACE_HOST_ROUTING_ENABLED: false } });
    expect(await resolver.resolveRequest(req({ host: 'acme.workspaces.example.com' }))).toEqual({ kind: 'none' });
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('a READY workspace label (Host) resolves to that workspace with its canonical origin', async () => {
    const { resolver } = setup({ cache: false });
    expect(await resolver.resolveRequest(req({ host: 'acme.workspaces.example.com' }))).toEqual({
      kind: 'workspace',
      source: 'host',
      label: 'acme',
      ...WS_A,
      canonicalLabel: 'acme',
      canonicalOrigin: 'https://acme.workspaces.example.com',
      displayName: null,
    });
  });

  it('the fixed-API-host topology: Host is the API, the browser Origin names the workspace', async () => {
    const { resolver } = setup({ cache: false });
    const ctx = await resolver.resolveRequest(req({ host: 'api.example.com', origin: 'https://bravo.workspaces.example.com' }));
    expect(ctx).toMatchObject({ kind: 'workspace', source: 'origin', workspaceId: WS_B.workspaceId });
  });

  it('ABUSE: unknown label → explicit not-found, never a fallback to any workspace', async () => {
    const { resolver } = setup({ cache: false });
    expect(await resolver.resolveRequest(req({ host: 'ghost.workspaces.example.com' }))).toEqual({ kind: 'not-found', source: 'host', label: 'ghost' });
  });

  it('ABUSE: reserved label as Origin → not-found without a registry lookup; as Host → platform (none)', async () => {
    const { resolver, lookup } = setup({ cache: false });
    expect(await resolver.resolveRequest(req({ host: 'api.example.com', origin: 'https://admin.workspaces.example.com' }))).toEqual({ kind: 'not-found', source: 'origin', label: 'admin' });
    expect(await resolver.resolveRequest(req({ host: 'api.workspaces.example.com' }))).toEqual({ kind: 'none' });
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('ABUSE: released (quarantined) label → renamed with a canonical origin built from the DB label only', async () => {
    const { resolver, registryRows } = setup({ cache: false });
    registryRows.set('oldname', { kind: 'renamed', ...WS_A, canonicalLabel: 'acme', reservedUntil: '2027-01-21T00:00:00.000Z' });
    expect(await resolver.resolveRequest(req({ host: 'oldname.workspaces.example.com' }))).toEqual({
      kind: 'renamed',
      source: 'host',
      label: 'oldname',
      canonicalOrigin: 'https://acme.workspaces.example.com',
    });
  });

  it('ABUSE: spoofed X-Forwarded-Host from an untrusted peer is ignored', async () => {
    const { resolver } = setup({ cache: false });
    const ctx = await resolver.resolveRequest(req({ host: 'api.example.com', 'x-forwarded-host': 'acme.workspaces.example.com' }, '198.51.100.7'));
    expect(ctx).toEqual({ kind: 'none' });
  });

  it('X-Forwarded-Host from the trusted proxy is honoured', async () => {
    const { resolver } = setup({ cache: false });
    const ctx = await resolver.resolveRequest(req({ host: 'rab-api:3000', 'x-forwarded-host': 'acme.workspaces.example.com' }, '10.0.0.5'));
    expect(ctx).toMatchObject({ kind: 'workspace', source: 'host', workspaceId: WS_A.workspaceId });
  });

  it('ABUSE: Host and Origin naming different workspaces → not-found (conflict, fail closed)', async () => {
    const { resolver } = setup({ cache: false });
    const ctx = await resolver.resolveRequest(req({ host: 'acme.workspaces.example.com', origin: 'https://bravo.workspaces.example.com' }));
    expect(ctx).toEqual({ kind: 'not-found', source: 'host', label: 'acme' });
  });

  it.each(['a.acme.workspaces.example.com', 'acme.workspaces.example.com:8443', 'acme.workspaces.example.com.', 'acme..workspaces.example.com'])(
    'ABUSE: malformed host %s → not-found',
    async (host) => {
      const { resolver } = setup({ cache: false });
      expect((await resolver.resolveRequest(req({ host }))).kind).toBe('not-found');
    },
  );

  it('registry failure → unavailable (refused later), never a guess', async () => {
    const { resolver, lookup } = setup({ cache: false });
    lookup.lookup.mockRejectedValueOnce(new Error('db down'));
    expect(await resolver.resolveRequest(req({ host: 'acme.workspaces.example.com' }))).toEqual({ kind: 'unavailable', source: 'host', label: 'acme' });
  });
});

describe.each([true, false])('host-label cache (CORE_ENTITY_CACHE_ENABLED=%s)', (cacheOn) => {
  it('caches positive answers ≤60 s and negative answers ≤10 s (cache on), or always reads the DB (cache off)', async () => {
    const { resolver, lookup, redis } = setup({ cache: cacheOn });
    await resolver.resolveLabel('acme');
    await resolver.resolveLabel('acme');
    await resolver.resolveLabel('ghost');
    await resolver.resolveLabel('ghost');
    expect(lookup.lookup).toHaveBeenCalledTimes(cacheOn ? 2 : 4);
    if (cacheOn) {
      const ttls = [...redis.ttl.entries()];
      expect(ttls.find(([key]) => key.includes(':acme:'))?.[1]).toBe(60);
      expect(ttls.find(([key]) => key.includes(':ghost:'))?.[1]).toBe(10);
    }
  });

  it('ABUSE: stale cache after rename — the old label stops routing and stops being a trusted Origin at once', async () => {
    const { resolver, originTrust, env, registryRows } = setup({ cache: cacheOn });
    expect(await originTrust.isTrusted('https://acme.workspaces.example.com')).toBe(true);
    // Rename acme -> apex1 commits: the DB now quarantines `acme` and routes `apex1`.
    registryRows.set('acme', { kind: 'renamed', ...WS_A, canonicalLabel: 'apex1', reservedUntil: '2027-01-21T00:00:00.000Z' });
    registryRows.set('apex1', { kind: 'workspace', ...WS_A, canonicalLabel: 'apex1', displayName: null });
    await resolver.invalidateLabels('acme', 'apex1');
    // The synchronous predicate forgets the old answer immediately (in-process snapshot cleared)...
    expect(env.isTrustedOrigin('https://acme.workspaces.example.com')).toBe(false);
    // ...and a fresh resolution through the (invalidated) cache says renamed / untrusted.
    expect(await originTrust.isTrusted('https://acme.workspaces.example.com')).toBe(false);
    expect(await originTrust.isTrusted('https://apex1.workspaces.example.com')).toBe(true);
    expect(await resolver.resolveRequest(req({ host: 'acme.workspaces.example.com' }))).toMatchObject({ kind: 'renamed', canonicalOrigin: 'https://apex1.workspaces.example.com' });
  });

  if (cacheOn) {
    it('negative control: WITHOUT invalidation the cached answer would still be served (proves invalidation is load-bearing)', async () => {
      const { resolver, registryRows } = setup({ cache: true });
      expect((await resolver.resolveLabel('acme')).kind).toBe('workspace');
      registryRows.set('acme', { kind: 'unknown' });
      expect((await resolver.resolveLabel('acme')).kind).toBe('workspace');
      await resolver.invalidateLabels('acme');
      expect((await resolver.resolveLabel('acme')).kind).toBe('unknown');
    });
  }

  it('organisation suspension: invalidateAll drops every cached label at once', async () => {
    const { resolver, originTrust, registryRows } = setup({ cache: cacheOn });
    expect(await originTrust.isTrusted('https://bravo.workspaces.example.com')).toBe(true);
    registryRows.delete('bravo'); // the resolver excludes suspended organisations: 0 rows
    await resolver.invalidateAll();
    expect(await originTrust.isTrusted('https://bravo.workspaces.example.com')).toBe(false);
    expect((await resolver.resolveRequest(req({ host: 'bravo.workspaces.example.com' }))).kind).toBe('not-found');
  });
});

describe('WorkspaceOriginTrustService (registry-backed CORS / CSRF trust)', () => {
  it.each([
    ['unregistered label', 'https://ghost.workspaces.example.com'],
    ['reserved label', 'https://api.workspaces.example.com'],
    ['scheme downgrade', 'http://acme.workspaces.example.com'],
    ['other port', 'https://acme.workspaces.example.com:8443'],
    ['nested label', 'https://x.acme.workspaces.example.com'],
  ])('ABUSE: %s is never trusted', async (_name, origin) => {
    const { originTrust } = setup({ cache: false });
    expect(await originTrust.isTrusted(origin)).toBe(false);
  });

  it('ABUSE: a released (quarantined) label is never trusted', async () => {
    const { originTrust, registryRows } = setup({ cache: false });
    registryRows.set('oldname', { kind: 'renamed', ...WS_A, canonicalLabel: 'acme', reservedUntil: '2027-01-21T00:00:00.000Z' });
    expect(await originTrust.isTrusted('https://oldname.workspaces.example.com')).toBe(false);
  });

  it('the canonical origin of a READY workspace is trusted; configured CORS origins need no lookup', async () => {
    const { originTrust, lookup } = setup({ cache: false });
    expect(await originTrust.isTrusted('https://acme.workspaces.example.com')).toBe(true);
    expect(await originTrust.isTrusted('https://app.example.com')).toBe(true);
    expect(lookup.lookup).toHaveBeenCalledTimes(1);
  });

  it('master switch off: nothing but CORS_ORIGINS, and no lookup at all', async () => {
    const { originTrust, lookup } = setup({ cache: false, vars: { WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: false } });
    expect(await originTrust.isTrusted('https://acme.workspaces.example.com')).toBe(false);
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('a lookup failure records "untrusted" (fail closed)', async () => {
    const { originTrust, lookup } = setup({ cache: false });
    lookup.lookup.mockRejectedValueOnce(new Error('db down'));
    expect(await originTrust.isTrusted('https://acme.workspaces.example.com')).toBe(false);
  });
});

describe('canonical URLs (email links / wrong-host redirect target)', () => {
  it('routing off → APP_URL/login and no database read', async () => {
    const { resolver, tenantContext } = setup({ cache: false, vars: { WORKSPACE_HOST_ROUTING_ENABLED: false } });
    expect(await resolver.workspaceLoginUrl({ organisationId: WS_A.organisationId, workspaceId: WS_A.workspaceId, userId: '', role: '' })).toBe('https://app.example.com/login');
    expect(tenantContext.runInTenantContext).not.toHaveBeenCalled();
  });

  it('a routable workspace → its canonical host; the label comes from the DB row, confirmed by the registry', async () => {
    const { resolver, tenantContext } = setup({ cache: false });
    tenantContext.runInTenantContext.mockImplementation(async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn({ query: async () => [{ subdomain: 'acme' }] }));
    expect(await resolver.workspaceLoginUrl({ organisationId: WS_A.organisationId, workspaceId: WS_A.workspaceId, userId: '', role: '' })).toBe('https://acme.workspaces.example.com/login');
  });

  it('a label the registry maps to ANOTHER workspace (or not at all) → APP_URL fallback, never that host', async () => {
    const { resolver, tenantContext } = setup({ cache: false });
    tenantContext.runInTenantContext.mockImplementation(async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn({ query: async () => [{ subdomain: 'bravo' }] }));
    expect(await resolver.workspaceLoginUrl({ organisationId: WS_A.organisationId, workspaceId: WS_A.workspaceId, userId: '', role: '' })).toBe('https://app.example.com/login');
  });
});
