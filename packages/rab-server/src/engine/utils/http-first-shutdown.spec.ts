import { createServer, request as httpRequest, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { installHttpFirstShutdown, stopHttpListener, trackInFlightResponses } from './http-first-shutdown';

/**
 * XR-09: the API stops its HTTP listener and drains in-flight requests BEFORE the Nest application (and with it the
 * throttler / auth-cache Redis clients and the BullMQ producers) closes. Before, Nest's enableShutdownHooks() quit Redis
 * first and closed HTTP last, so requests made during the stop window got 503 RATE_LIMIT_UNAVAILABLE from the throttler.
 *
 * These tests use a plain node:http server and a fake "Redis" that, once quit, answers 503 exactly as the throttler guard
 * does when its client is gone. The AppModule version is __tests__/integration/api-shutdown-order.integration.spec.ts.
 */
type Handler = (path: string, response: ServerResponse) => void;

interface Harness {
  server: Server;
  port: number;
  events: string[];
  redisUp: () => boolean;
  app: { getHttpServer(): Server; close: jest.Mock<Promise<void>, []> };
}

async function startHarness(handler?: Handler): Promise<Harness> {
  const events: string[] = [];
  let redis = true;
  const server = createServer((req, res) => {
    // The throttler guard: no Redis → 503 RATE_LIMIT_UNAVAILABLE.
    if (!redis) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"code":"RATE_LIMIT_UNAVAILABLE"}');
      return;
    }
    if (handler) return handler(req.url ?? '/', res);
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = {
    getHttpServer: () => server,
    // Nest's app.close(): onModuleDestroy quits the Redis clients, then dispose() closes HTTP (already closed: resolves).
    close: jest.fn(async () => {
      events.push('app.close: redis quit');
      redis = false;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  };
  return { server, port: (server.address() as AddressInfo).port, events, redisUp: () => redis, app };
}

function get(port: number, path = '/', agent?: import('node:http').Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const noReraise = () => undefined;

describe('HTTP-first API shutdown (XR-09)', () => {
  it('a request made after shutdown starts gets a connection refusal, never a 503 from the throttler', async () => {
    const h = await startHarness();
    const reraise = jest.fn();
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise, log: () => undefined, drainMs: 2_000 });

    const done = shutdown('SIGTERM'); // the listener is closed synchronously, before the first await
    await expect(get(h.port, '/rest/v1/auth/login')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(h.redisUp()).toBe(true); // the refusal came from the closed listener, while Redis was still up

    await done;
    expect(h.app.close).toHaveBeenCalledTimes(1);
    expect(reraise).toHaveBeenCalledWith('SIGTERM');
  });

  it('a request already in flight finishes with its real answer before the Redis clients quit', async () => {
    let release!: () => void;
    const h = await startHarness((path, res) => {
      if (path === '/slow') {
        h.events.push('request received');
        release = () => {
          res.writeHead(204).end();
          h.events.push('response sent');
        };
        return;
      }
      res.writeHead(200).end('ok');
    });
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise: noReraise, log: () => undefined, drainMs: 5_000 });

    const inFlight = get(h.port, '/slow');
    await waitFor(() => h.events.includes('request received'));
    const done = shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.app.close).not.toHaveBeenCalled(); // still draining: Redis is untouched
    release();

    await expect(inFlight).resolves.toEqual({ status: 204, body: '' });
    await done;
    expect(h.events).toEqual(['request received', 'response sent', 'app.close: redis quit']);
  });

  it('a request on a kept-alive connection during the drain is still answered normally (Redis is up), not 503', async () => {
    let release!: () => void;
    const { Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const h = await startHarness((path, res) => {
      if (path === '/slow') {
        release = () => res.writeHead(200).end('slow');
        return;
      }
      res.writeHead(200).end('fast');
    });
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise: noReraise, log: () => undefined, drainMs: 5_000 });
    try {
      // A second client keeps a request running, so the drain is still in progress when the kept-alive request arrives.
      const slow = get(h.port, '/slow');
      await waitFor(() => typeof release === 'function');
      expect(await get(h.port, '/warm', agent)).toEqual({ status: 200, body: 'fast' }); // the socket is now idle, kept alive
      const done = shutdown('SIGTERM');
      // Node closes idle keep-alive sockets on server.close(), so a reused socket is refused or reset — never a 503.
      const reused = await get(h.port, '/after', agent).then(
        (res) => ({ status: res.status }),
        (error: NodeJS.ErrnoException) => ({ code: error.code }),
      );
      expect(reused).not.toEqual({ status: 503 });
      expect(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', undefined]).toContain((reused as { code?: string }).code);
      if ('status' in reused) expect(reused.status).toBe(200);
      release();
      await slow;
      await done;
    } finally {
      agent.destroy();
    }
  });

  it('an open server-sent-event stream does not hold the shutdown: it is closed, then the app closes', async () => {
    const h = await startHarness((path, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hello\n\n'); // never ends on its own
    });
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise: noReraise, log: () => undefined, drainMs: 10_000 });
    let streaming = false;
    const streamClosed = new Promise<void>((resolve) => {
      httpRequest({ host: '127.0.0.1', port: h.port, path: '/rest/v1/realtime/stream' }, (res) => {
        res.on('data', () => (streaming = true));
        res.on('close', () => resolve());
        res.on('error', () => resolve());
      })
        .on('error', () => resolve())
        .end();
    });
    await waitFor(() => streaming);

    const t0 = Date.now();
    await shutdown('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(2_000); // not the 10 s drain budget
    await streamClosed;
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('a request still running at the drain deadline is cut, and the app still closes', async () => {
    const h = await startHarness(() => undefined); // never answers
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise: noReraise, log: () => undefined, drainMs: 300 });
    const hung = get(h.port, '/hang').catch((error: NodeJS.ErrnoException) => error.code);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const t0 = Date.now();
    await shutdown('SIGTERM');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await hung).toBe('ECONNRESET');
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('a second signal during the shutdown is ignored (one close, one re-raise)', async () => {
    const h = await startHarness();
    const reraise = jest.fn();
    const { shutdown } = installHttpFirstShutdown(h.app, { listen: false, reraise, log: () => undefined });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(h.app.close).toHaveBeenCalledTimes(1);
    expect(reraise).toHaveBeenCalledTimes(1);
    expect(reraise).toHaveBeenCalledWith('SIGTERM');
  });

  it('a failing app.close exits 1 instead of re-raising', async () => {
    const h = await startHarness();
    h.app.close.mockRejectedValueOnce(new Error('boom'));
    const reraise = jest.fn();
    const exit = jest.fn();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await installHttpFirstShutdown(h.app, { listen: false, reraise, exit, log: () => undefined }).shutdown('SIGTERM');
    } finally {
      errorSpy.mockRestore();
      h.server.close();
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(reraise).not.toHaveBeenCalled();
  });

  it('installs SIGTERM and SIGINT handlers only when asked to listen', () => {
    const server = createServer();
    const signals = ['SIGTERM', 'SIGINT'] as const;
    const before = signals.map((signal) => process.listeners(signal));
    installHttpFirstShutdown({ getHttpServer: () => server, close: async () => undefined }, { listen: false });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before.map((list) => list.length));
    installHttpFirstShutdown({ getHttpServer: () => server, close: async () => undefined });
    const added = signals.map((signal, i) => process.listeners(signal).filter((listener) => !before[i]!.includes(listener)));
    expect(added.map((list) => list.length)).toEqual([1, 1]);
    signals.forEach((signal, i) => added[i]!.forEach((listener) => process.removeListener(signal, listener as () => void)));
  });

  it('stopHttpListener on an already-closed server resolves at once (nothing to drain)', async () => {
    const server = createServer();
    const inFlight = trackInFlightResponses(server);
    await expect(stopHttpListener(server, inFlight, 1_000)).resolves.toEqual({ drained: true, closedOpen: 0 });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
