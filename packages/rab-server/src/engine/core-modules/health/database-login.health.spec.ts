import { Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import {
  DATABASE_LOGIN_DOWN_MESSAGE,
  DATABASE_LOGIN_PROBE_CACHE_MS,
  DATABASE_LOGIN_PROBE_DEADLINE_MS,
  DatabaseLoginHealthIndicator,
  DatabaseLoginProbeClient,
} from './database-login.health';

/**
 * Owner decision 2026-11-13: /healthz must go DOWN when the API cannot open a NEW database connection (observed live: the
 * runtime login's password changed, the pooled ping kept answering, the container stayed green). The indicator is a fresh
 * dedicated login, bounded (single flight, 5 s cache, 3 s deadline) and fixed-text (no driver message, login or SQLSTATE in
 * the response). The real-database proof is __tests__/integration/healthz-database-login.integration.spec.ts.
 */
type Script = { connect?: () => Promise<unknown>; query?: () => Promise<unknown> };

type FakeClient = DatabaseLoginProbeClient & { ended: boolean; errorListeners: number; connect: jest.Mock; query: jest.Mock };

function harness(script: Script = {}) {
  const clients: FakeClient[] = [];
  const factory = jest.fn((): FakeClient => {
    const client: FakeClient = {
      ended: false,
      errorListeners: 0,
      connect: jest.fn(script.connect ?? (async () => undefined)),
      query: jest.fn(script.query ?? (async () => ({ rows: [{ '?column?': 1 }] }))),
      end: jest.fn(async () => {
        client.ended = true;
      }),
      on: jest.fn((event: string): unknown => {
        if (event === 'error') client.errorListeners++;
        return client;
      }),
    };
    clients.push(client);
    return client;
  });
  const indicator = new DatabaseLoginHealthIndicator(new HealthIndicatorService(), factory);
  return { indicator, factory, clients };
}

const DRIVER_ERROR = Object.assign(new Error('password authentication failed for user "crewflow_owner"'), { code: '28P01' });

describe('DatabaseLoginHealthIndicator (/healthz databaseLogin)', () => {
  let errorLog: jest.SpyInstance;
  let infoLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    infoLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('up: a NEW dedicated client logs in, runs SELECT 1 and is closed (never a pool checkout)', async () => {
    const h = harness();
    await expect(h.indicator.isHealthy()).resolves.toEqual({ databaseLogin: { status: 'up' } });
    expect(h.factory).toHaveBeenCalledTimes(1);
    const [client] = h.clients;
    expect(client!.connect).toHaveBeenCalledTimes(1);
    expect(client!.query).toHaveBeenCalledWith('SELECT 1');
    expect(client!.ended).toBe(true);
    expect(client!.errorListeners).toBe(1); // a late socket error can never be an uncaught 'error' event
  });

  it('down when the login is refused (28P01): fixed text only — no driver message, login name or SQLSTATE in the response', async () => {
    const h = harness({ connect: async () => Promise.reject(DRIVER_ERROR) });
    const result = await h.indicator.isHealthy();
    expect(result).toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
    const body = JSON.stringify(result);
    for (const secretish of ['crewflow_owner', '28P01', 'password', 'authentication', 'postgres', '@']) expect(body).not.toContain(secretish);
    expect(h.clients[0]!.ended).toBe(true);
  });

  it('down when the query fails after a successful connect', async () => {
    const h = harness({ query: async () => Promise.reject(Object.assign(new Error('permission denied for database'), { code: '42501' })) });
    await expect(h.indicator.isHealthy()).resolves.toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
  });

  it('down when the factory itself throws (configuration refused): fails closed, never throws out of /healthz', async () => {
    const indicator = new DatabaseLoginHealthIndicator(new HealthIndicatorService(), () => {
      throw new Error('PG_DATABASE_URL refused (value not shown)');
    });
    await expect(indicator.isHealthy()).resolves.toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
  });

  it(`deadline: a login that never answers is reported down after ${DATABASE_LOGIN_PROBE_DEADLINE_MS} ms and its client is closed`, async () => {
    jest.useFakeTimers();
    const h = harness({ connect: () => new Promise(() => undefined) });
    const pending = h.indicator.isHealthy();
    await jest.advanceTimersByTimeAsync(DATABASE_LOGIN_PROBE_DEADLINE_MS - 1);
    expect(h.clients[0]!.ended).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
    expect(h.clients[0]!.ended).toBe(true);
    expect(errorLog.mock.calls[0]![0]).toContain('(timeout)');
  });

  it('bounded: concurrent requests share ONE login (single flight)', async () => {
    let release!: () => void;
    const h = harness({ connect: () => new Promise<void>((r) => (release = r)) });
    const results = Array.from({ length: 25 }, () => h.indicator.isHealthy());
    await Promise.resolve();
    release();
    const all = await Promise.all(results);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(all.every((r) => r.databaseLogin!.status === 'up')).toBe(true);
  });

  it(`bounded: a result (up or down) is reused for ${DATABASE_LOGIN_PROBE_CACHE_MS} ms, then a fresh login decides`, async () => {
    let now = 1_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    let refuse = false;
    const h = harness({ connect: async () => (refuse ? Promise.reject(DRIVER_ERROR) : undefined) });
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('up');
    refuse = true; // the password changes now
    now += DATABASE_LOGIN_PROBE_CACHE_MS - 1;
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('up'); // cached
    expect(h.factory).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('down'); // fresh login sees it
    expect(h.factory).toHaveBeenCalledTimes(2);
    refuse = false; // restored
    now += DATABASE_LOGIN_PROBE_CACHE_MS - 1;
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('down'); // a down reading is cached too
    now += 1;
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('up');
    expect(h.factory).toHaveBeenCalledTimes(3);
  });

  it('the cache age is monotonic: a wall clock stepped back an hour cannot keep a cached "up" alive', async () => {
    let mono = 50_000;
    let wall = Date.UTC(2026, 10, 13, 12, 0, 0);
    jest.spyOn(performance, 'now').mockImplementation(() => mono);
    jest.spyOn(Date, 'now').mockImplementation(() => wall);
    let refuse = false;
    const h = harness({ connect: async () => (refuse ? Promise.reject(DRIVER_ERROR) : undefined) });
    expect((await h.indicator.isHealthy()).databaseLogin!.status).toBe('up');
    refuse = true; // the login breaks ...
    wall -= 3_600_000; // ... and the wall clock is stepped back an hour (NTP / VM resume)
    mono += DATABASE_LOGIN_PROBE_CACHE_MS; // real time still moves forward
    expect((await h.indicator.isHealthy()).databaseLogin).toEqual({ status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE });
    expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it('logs once per change of state, with the SQLSTATE only — never the driver message', async () => {
    let now = 5_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    let refuse = true;
    const h = harness({ connect: async () => (refuse ? Promise.reject(DRIVER_ERROR) : undefined) });
    for (let i = 0; i < 3; i++) {
      await h.indicator.isHealthy();
      now += DATABASE_LOGIN_PROBE_CACHE_MS;
    }
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = String(errorLog.mock.calls[0]![0]);
    expect(line).toContain('28P01');
    expect(line).not.toContain('crewflow_owner');
    expect(line).not.toContain('password');
    refuse = false;
    await h.indicator.isHealthy();
    now += DATABASE_LOGIN_PROBE_CACHE_MS;
    await h.indicator.isHealthy();
    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
