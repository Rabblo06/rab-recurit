import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';

/**
 * Node-level network guard for a render: records (and in `deny` mode refuses) every outbound network attempt made by
 * THIS process — `net`/`tls` connects, `http(s).request/get`, DNS lookups and `fetch`. A pure-JS renderer runs in this
 * process, so "no network during rendering" is proven by zero attempts with `deny` on. Chromium is a separate process
 * driven over Playwright's pipe transport (no socket): for it this guard proves the Node side stays offline, and the
 * hostile-text suite's local counting server plus the renderer's own blocked-request counter prove the browser side.
 * Listening sockets (`server.listen`) are not outbound and are not intercepted. Test-only.
 */
export interface NetworkAttempt {
  api: string;
  target: string;
}

export interface NetworkGuard {
  attempts: NetworkAttempt[];
  restore(): void;
}

export class NetworkDeniedError extends Error {
  constructor(api: string, target: string) {
    super(`network denied during PDF render: ${api} ${target}`);
    this.name = 'NetworkDeniedError';
  }
}

function describeTarget(args: unknown[]): string {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return `port ${a}`;
  if (a instanceof URL) return a.href;
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    if (typeof o.href === 'string') return o.href;
    if (typeof o.url === 'string') return o.url;
    return `${o.protocol ?? ''}//${o.host ?? o.hostname ?? ''}${o.port ? `:${o.port}` : ''}${o.path ?? ''}${o.socketPath ? ` socket ${o.socketPath}` : ''}`;
  }
  return String(a);
}

export function guardNetwork(mode: 'record' | 'deny'): NetworkGuard {
  const attempts: NetworkAttempt[] = [];
  const restores: Array<() => void> = [];
  const patch = <T extends object>(obj: T, key: keyof T & string, api: string) => {
    const original = obj[key] as unknown as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const target = describeTarget(args);
      attempts.push({ api, target });
      if (mode === 'deny') throw new NetworkDeniedError(api, target);
      return original.apply(this, args);
    };
    (obj as Record<string, unknown>)[key] = wrapped;
    restores.push(() => {
      (obj as Record<string, unknown>)[key] = original;
    });
  };
  patch(net.Socket.prototype, 'connect', 'net.Socket.connect');
  patch(net, 'connect', 'net.connect');
  patch(net, 'createConnection', 'net.createConnection');
  patch(tls, 'connect', 'tls.connect');
  patch(http, 'request', 'http.request');
  patch(http, 'get', 'http.get');
  patch(https, 'request', 'https.request');
  patch(https, 'get', 'https.get');
  patch(dns, 'lookup', 'dns.lookup');
  patch(dns, 'resolve', 'dns.resolve');
  patch(dns.promises, 'lookup', 'dns.promises.lookup');
  if (typeof globalThis.fetch === 'function') patch(globalThis as { fetch: typeof fetch }, 'fetch', 'fetch');
  return {
    attempts,
    restore: () => {
      for (const r of restores.reverse()) r();
    },
  };
}

/** Renders under the guard and returns the PDF with every attempt the render made. */
export async function renderGuarded(mode: 'record' | 'deny', render: () => Promise<Buffer>): Promise<{ pdf: Buffer; attempts: NetworkAttempt[] }> {
  const guard = guardNetwork(mode);
  try {
    const pdf = await render();
    return { pdf, attempts: [...guard.attempts] };
  } finally {
    guard.restore();
  }
}
