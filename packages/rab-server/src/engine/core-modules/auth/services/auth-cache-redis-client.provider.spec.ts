import { EnvironmentService } from '../../environment/environment.service';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

/**
 * Shutdown of the auth-cache Redis client. With `enableOfflineQueue: false`, `quit()` is refused while Redis is
 * unreachable; the provider must then disconnect, or the client's reconnect timer keeps the process alive forever.
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
const UNREACHABLE = 'redis://127.0.0.1:1';

const envFor = (url: string) => ({ get: (key: string) => (key === 'REDIS_URL' ? url : undefined) }) as unknown as EnvironmentService;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ioredis keeps the pending reconnect timer here; null means nothing is scheduled. */
const reconnectTimerOf = (provider: AuthCacheRedisClientProvider) => (provider.client as unknown as { reconnectTimeout: NodeJS.Timeout | null }).reconnectTimeout;
/** Bounded wait for a client status (a refused connect can take ~2 s to fail on Windows). */
const statusWithin = async (provider: AuthCacheRedisClientProvider, wanted: string, ms: number) => {
  for (let waited = 0; provider.client.status !== wanted && waited < ms; waited += 20) await sleep(20);
  return provider.client.status;
};

describe('AuthCacheRedisClientProvider shutdown', () => {
  jest.setTimeout(20_000);

  it('Redis unavailable: quit() is refused, so the client is disconnected and never reconnects again', async () => {
    const provider = new AuthCacheRedisClientProvider(envFor(UNREACHABLE));
    // The outage state: the first connect has failed and a reconnect is scheduled.
    expect(await statusWithin(provider, 'reconnecting', 5_000)).toBe('reconnecting');
    expect(reconnectTimerOf(provider)).not.toBeNull();
    const disconnect = jest.spyOn(provider.client, 'disconnect');
    let attemptsAfterShutdown = 0;
    provider.client.on('reconnecting', () => attemptsAfterShutdown++);
    provider.client.on('connect', () => attemptsAfterShutdown++);

    await provider.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(reconnectTimerOf(provider)).toBeNull();
    // Longer than the 2 s retry cap: a leaked client would have tried again by now. (ioredis leaves the status at
    // 'reconnecting' when disconnected with no socket open; what matters is that nothing is scheduled any more.)
    await sleep(2_500);
    expect(attemptsAfterShutdown).toBe(0);
    expect(reconnectTimerOf(provider)).toBeNull();
  });

  (REDIS_URL ? it : it.skip)('Redis available: a graceful quit() closes the client without the disconnect fallback', async () => {
    const provider = new AuthCacheRedisClientProvider(envFor(REDIS_URL!));
    expect(await statusWithin(provider, 'ready', 5_000)).toBe('ready');
    const disconnect = jest.spyOn(provider.client, 'disconnect');

    await provider.onModuleDestroy();

    expect(disconnect).not.toHaveBeenCalled();
    expect(await statusWithin(provider, 'end', 1_000)).toBe('end');
    expect(reconnectTimerOf(provider)).toBeNull();
  });
});
