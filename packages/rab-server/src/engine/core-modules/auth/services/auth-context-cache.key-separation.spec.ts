import { createHmac } from 'node:crypto';

import { EnvironmentService } from '../../environment/environment.service';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';
import { AuthContextCacheService, CachedSnapshotData } from './auth-context-cache.service';

const APP_SECRET = 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA';
const DEDICATED = 'p9Qw2Er7Ty1Ui8Op3As6Df0Gh5Jk4LzX';
const DATA: CachedSnapshotData = {
  accountStatus: 'ACTIVE' as CachedSnapshotData['accountStatus'],
  mustResetPassword: false,
  roles: ['manager'],
  isPlatformAdmin: false,
  maintenanceModeEnabled: false,
  organisationSuspended: false,
  effectivePermissions: [],
};

function build(dedicated?: string) {
  const store = new Map<string, string>();
  const values: Record<string, unknown> = { APP_SECRET, APP_AUTH_CACHE_HMAC_KEY: dedicated, AUTH_CONTEXT_CACHE_ENABLED: true, NODE_ENV: 'test' };
  const env = { get: (k: string) => values[k] } as unknown as EnvironmentService;
  const redis = { client: { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v) } } as unknown as AuthCacheRedisClientProvider;
  return { service: new AuthContextCacheService(env, redis), store };
}

describe('AuthContextCacheService — wave 2 lane A2 MAC key separation', () => {
  it('round-trips an entry under its own purpose key and records the key id', async () => {
    const { service, store } = build();
    await service.set('k', DATA);
    expect(JSON.parse(store.get('k')!).k).toBe('derived-v1');
    expect(await service.get('k')).toEqual(DATA);
  });

  it('an entry MACed with the pre-wave-2 key (HMAC of APP_SECRET) is not trusted — a quiet miss', async () => {
    const { service, store } = build();
    const oldKey = createHmac('sha256', APP_SECRET).update('crewflow:authctx-cache:v1').digest();
    const d = JSON.stringify({ ...DATA, isPlatformAdmin: true });
    store.set('k', JSON.stringify({ d, m: createHmac('sha256', oldKey).update('k').update('\n').update(d).digest('hex') }));
    expect(await service.get('k')).toBeNull();
  });

  it('a forged entry claiming the current key id but without the key fails integrity (miss, never trusted)', async () => {
    const { service, store } = build();
    const d = JSON.stringify({ ...DATA, isPlatformAdmin: true });
    store.set('k', JSON.stringify({ d, m: createHmac('sha256', APP_SECRET).update('k').update('\n').update(d).digest('hex'), k: 'derived-v1' }));
    expect(await service.get('k')).toBeNull();
  });

  it('rotating to a dedicated APP_AUTH_CACHE_HMAC_KEY turns old entries into misses; the new key does not depend on APP_SECRET', async () => {
    const before = build();
    await before.service.set('k', DATA);
    const after = build(DEDICATED);
    after.store.set('k', before.store.get('k')!);
    expect(await after.service.get('k')).toBeNull();
    await after.service.set('k', DATA);
    expect(JSON.parse(after.store.get('k')!).k).toMatch(/^d-[0-9a-f]{12}$/);
    expect(await after.service.get('k')).toEqual(DATA);
  });
});
