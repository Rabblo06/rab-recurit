import { generateKeyPairSync } from 'node:crypto';
import * as http2 from 'node:http2';
import { AddressInfo } from 'node:net';

import { ApnsDriver, APNS_PROVIDER_TOKEN_TTL_MS } from './apns.driver';
import { PushSendError } from './interfaces/push-driver.interface';

/**
 * D5 (D0-C §4.2–4.4): APNs transport against a LOCAL cleartext HTTP/2 server (no Apple endpoint, no credential).
 * Before: a new HTTP/2 session per push, no timeouts, no session 'error' listener, provider JWT re-signed on every send
 * (new driver per send). After: one reused session per driver, reconnect on GOAWAY/close/error, bounded request time,
 * idle close, JWT cached and re-signed only before its TTL (≤ 50 min).
 */
type Behaviour = 'ok' | 'hang' | 'goaway-after' | 'destroy-after' | 'unregistered';

interface Server {
  origin: string;
  sessions: http2.ServerHttp2Session[];
  authHeaders: string[];
  behaviour: Behaviour;
  close(): Promise<void>;
}

async function startServer(): Promise<Server> {
  const server = http2.createServer();
  const state: Server = { origin: '', sessions: [], authHeaders: [], behaviour: 'ok', close: async () => undefined };
  server.on('session', (session) => {
    state.sessions.push(session);
    session.on('error', () => undefined);
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => undefined);
    state.authHeaders.push(String(headers.authorization));
    const behaviour = state.behaviour;
    if (behaviour === 'hang') return; // never answers
    if (behaviour === 'unregistered') {
      stream.respond({ ':status': 410 });
      stream.end(JSON.stringify({ reason: 'Unregistered' }));
      return;
    }
    const session = stream.session; // captured now: a finished stream is detached from its session
    stream.respond({ ':status': 200, 'apns-id': `id-${state.authHeaders.length}` });
    stream.end();
    if (behaviour === 'goaway-after') setImmediate(() => session?.goaway());
    if (behaviour === 'destroy-after') setImmediate(() => session?.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of state.sessions) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const msg = { token: 'abc123', title: 'T', body: 'B', data: { notificationId: 'n1' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function driver(origin: string, over: { requestTimeoutMs?: number; idleTimeoutMs?: number; now?: () => number } = {}): ApnsDriver {
  return new ApnsDriver(
    { authKeyP8: key, keyId: 'KEY123', teamId: 'TEAM123', bundleId: 'com.rab.rab_staff', environment: 'sandbox' },
    { origin, requestTimeoutMs: over.requestTimeoutMs ?? 2_000, idleTimeoutMs: over.idleTimeoutMs ?? 60_000, now: over.now },
  );
}

describe('ApnsDriver transport (local HTTP/2 server)', () => {
  let server: Server;
  let d: ApnsDriver | null = null;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    d?.close();
    d = null;
    await server.close();
  });

  it('reuses ONE HTTP/2 session for sequential and concurrent sends (bounded: never one per push)', async () => {
    d = driver(server.origin);
    for (let i = 0; i < 5; i += 1) await expect(d.send(msg)).resolves.toMatchObject({ provider: 'apns' });
    await Promise.all(Array.from({ length: 20 }, () => d!.send(msg)));
    expect(server.sessions.length).toBe(1);
    expect(server.authHeaders).toHaveLength(25);
  });

  it('signs the provider JWT once and reuses it (not per push); re-signs before the TTL, which is at most 50 minutes', async () => {
    expect(APNS_PROVIDER_TOKEN_TTL_MS).toBeLessThanOrEqual(50 * 60 * 1000);
    expect(APNS_PROVIDER_TOKEN_TTL_MS).toBeGreaterThanOrEqual(20 * 60 * 1000); // Apple: no more than one refresh per 20 min
    let now = Date.UTC(2026, 9, 31, 12, 0, 0);
    d = driver(server.origin, { now: () => now });
    await d.send(msg);
    now += 20 * 60 * 1000;
    await d.send(msg);
    expect(new Set(server.authHeaders).size).toBe(1);
    now += APNS_PROVIDER_TOKEN_TTL_MS; // past the TTL
    await d.send(msg);
    expect(new Set(server.authHeaders).size).toBe(2);
  });

  it('reconnects after the server sends GOAWAY', async () => {
    d = driver(server.origin);
    server.behaviour = 'goaway-after';
    await d.send(msg);
    await sleep(50);
    server.behaviour = 'ok';
    await expect(d.send(msg)).resolves.toMatchObject({ provider: 'apns' });
    expect(server.sessions.length).toBe(2);
  });

  it('reconnects after the connection is closed under it, without an uncaught session error', async () => {
    d = driver(server.origin);
    server.behaviour = 'destroy-after';
    await d.send(msg);
    await sleep(50);
    server.behaviour = 'ok';
    await expect(d.send(msg)).resolves.toMatchObject({ provider: 'apns' });
    expect(server.sessions.length).toBe(2);
  });

  it('a request that gets no answer times out as a retryable PushSendError (well inside the lease), and the session stays usable', async () => {
    d = driver(server.origin, { requestTimeoutMs: 200 });
    server.behaviour = 'hang';
    const started = Date.now();
    const error = await d.send(msg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushSendError);
    expect(error).toMatchObject({ retryable: true, invalidToken: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    server.behaviour = 'ok';
    await expect(d.send(msg)).resolves.toBeDefined();
  });

  it('a refused connection is a retryable PushSendError (session error handled, no crash) and the next send reconnects', async () => {
    const origin = server.origin;
    await server.close();
    d = driver(origin, { requestTimeoutMs: 1_000 });
    const error = await d.send(msg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushSendError);
    expect((error as PushSendError).retryable).toBe(true);
    server = await startServer();
    d.close();
    d = driver(server.origin);
    await expect(d.send(msg)).resolves.toBeDefined();
  });

  it('closes an idle session and opens a fresh one on the next send', async () => {
    d = driver(server.origin, { idleTimeoutMs: 100 });
    await d.send(msg);
    await sleep(400);
    expect(server.sessions[0]!.closed || server.sessions[0]!.destroyed).toBe(true);
    await expect(d.send(msg)).resolves.toBeDefined();
    expect(server.sessions.length).toBe(2);
  });

  it('status classification still applies over the reused session (410 Unregistered = invalid token)', async () => {
    d = driver(server.origin);
    server.behaviour = 'unregistered';
    await expect(d.send(msg)).rejects.toMatchObject({ retryable: false, invalidToken: true });
  });
});
