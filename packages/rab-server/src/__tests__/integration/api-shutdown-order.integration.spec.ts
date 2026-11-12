import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { HttpFirstShutdown, installHttpFirstShutdown } from '../../engine/utils/http-first-shutdown';

/**
 * XR-09 (Phase X2.5), the real application: on SIGTERM the HTTP listener stops and in-flight requests finish BEFORE the
 * throttler and auth-cache Redis clients quit. Before the fix Nest's enableShutdownHooks() quit them first, so a
 * credential request during the stop window got 503 RATE_LIMIT_UNAVAILABLE from the throttler instead of a clean refusal.
 *
 * The real throttler is enforced for this file (RAB_DISABLE_RATE_LIMIT=false), so every request below really goes through
 * the Redis-backed @RateLimitRequired guard.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

interface Reply {
  status: number;
  body: string;
}

function postJson(port: number, path: string, body: unknown): Promise<Reply> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false, // a fresh connection per request: the refusal below must be the listener's, not a pooled socket's
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describeIfDb('XR-09 API shutdown order: HTTP stops before the Redis clients quit (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let server: Server;
  let port: number;
  let handle: HttpFirstShutdown;
  let closed = false;
  const events: string[] = [];
  const reraise = jest.fn();
  const exit = jest.fn();
  const originalFlag = process.env.RAB_DISABLE_RATE_LIMIT;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Exactly as main.ts: installed before listen(), so the in-flight tracker sees every request.
    handle = installHttpFirstShutdown(app, { listen: false, reraise, exit, log: () => undefined, drainMs: 10_000 });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
    port = (server.address() as AddressInfo).port;

    for (const [label, provider] of [
      ['throttler redis quit', moduleRef.get(ThrottlerRedisClientProvider)],
      ['auth-cache redis quit', moduleRef.get(AuthCacheRedisClientProvider)],
    ] as const) {
      const original = provider.onModuleDestroy.bind(provider);
      jest.spyOn(provider, 'onModuleDestroy').mockImplementation(async () => {
        events.push(label);
        await original();
      });
    }
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
  });

  afterAll(async () => {
    process.env.RAB_DISABLE_RATE_LIMIT = originalFlag;
    if (!closed) await app?.close();
  });

  it('a request made during shutdown is refused at the socket, never answered 503 by the throttler; an in-flight one finishes first', async () => {
    // Before the shutdown: the real, Redis-backed throttler admits a credential-recovery request (204, no enumeration).
    const warm = await postJson(port, '/rest/v1/auth/forgot-password', { email: 'xr09-before@example.test' });
    expect(warm.status).toBe(204);

    // A request already in flight when SIGTERM arrives (forgot-password holds a 150 ms response floor).
    const received = new Promise<void>((resolve) => server.once('request', () => resolve()));
    const inFlight = postJson(port, '/rest/v1/auth/forgot-password', { email: 'xr09-in-flight@example.test' }).then((reply) => {
      events.push(`in-flight response ${reply.status}`);
      return reply;
    });
    await received;

    const done = handle.shutdown('SIGTERM');

    // A NEW request during the shutdown: the listener is already closed, so the client gets a connection refusal it can
    // retry against another replica. Never a 503 from a throttler whose Redis client is gone.
    const during = await postJson(port, '/rest/v1/auth/forgot-password', { email: 'xr09-during@example.test' }).then(
      (reply) => ({ status: reply.status, body: reply.body }),
      (error: NodeJS.ErrnoException) => ({ code: error.code }),
    );
    expect(during).toEqual({ code: 'ECONNREFUSED' });

    expect(await inFlight).toEqual({ status: 204, body: '' });
    await done;
    closed = true;

    // The order: the in-flight request got its real answer, and only then did the Redis clients quit.
    expect(events[0]).toBe('in-flight response 204');
    expect(events.slice(1).sort()).toEqual(['auth-cache redis quit', 'throttler redis quit']);
    expect(events).not.toContain('in-flight response 503');
    expect(reraise).toHaveBeenCalledWith('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
  });
});
