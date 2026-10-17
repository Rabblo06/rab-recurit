import express from 'express';
import request from 'supertest';

import { describeClientIp, resolveClientIp } from './client-ip.util';
import { buildTrustProxyPredicate } from './trusted-proxy.util';

const TRUSTED = ['10.0.0.0/8'];

function req(opts: {
  remoteAddress?: string;
  ip?: string;
  cfConnectingIp?: string;
}) {
  return {
    headers: opts.cfConnectingIp ? { 'cf-connecting-ip': opts.cfConnectingIp } : {},
    ip: opts.ip,
    socket: { remoteAddress: opts.remoteAddress },
  };
}

describe('resolveClientIp — PHASE 11 / EDGE-01', () => {
  describe('untrusted direct client (no TRUSTED_PROXY_CIDRS configured)', () => {
    it('a direct request with no forwarding headers uses the raw socket address', () => {
      expect(resolveClientIp(req({ remoteAddress: '203.0.113.5' }), [])).toBe('203.0.113.5');
    });

    it('a fake CF-Connecting-IP from an untrusted peer is ignored — the socket address wins', () => {
      expect(
        resolveClientIp(req({ remoteAddress: '198.51.100.10', cfConnectingIp: '203.0.113.77' }), []),
      ).toBe('198.51.100.10');
    });

    it('an untrusted peer with express-resolved req.ip already equal to the spoofed value still falls back to the socket address, never the header', () => {
      // Simulates a misconfigured/absent `trust proxy` upstream: even if
      // `req.ip` somehow reflected a forwarded value, an untrusted peer
      // must never have its CF-Connecting-IP honoured.
      expect(
        resolveClientIp(req({ remoteAddress: '198.51.100.10', ip: '203.0.113.99', cfConnectingIp: '203.0.113.77' }), []),
      ).toBe('198.51.100.10');
    });
  });

  describe('trusted proxy peer', () => {
    it('honours CF-Connecting-IP when the immediate peer is trusted', () => {
      expect(
        resolveClientIp(req({ remoteAddress: '10.0.0.5', cfConnectingIp: '203.0.113.77' }), TRUSTED),
      ).toBe('203.0.113.77');
    });

    it('falls back to req.ip when CF-Connecting-IP is absent but the peer is trusted', () => {
      expect(resolveClientIp(req({ remoteAddress: '10.0.0.5', ip: '203.0.113.42' }), TRUSTED)).toBe(
        '203.0.113.42',
      );
    });

    it('a malformed CF-Connecting-IP value falls back to req.ip rather than being used verbatim', () => {
      expect(
        resolveClientIp(req({ remoteAddress: '10.0.0.5', ip: '203.0.113.42', cfConnectingIp: '<script>' }), TRUSTED),
      ).toBe('203.0.113.42');
    });
  });

  describe('conflicting/ambiguous input', () => {
    it('two different CF-Connecting-IP values behind an untrusted peer both resolve to the SAME (real) socket address, never a client-chosen bucket', () => {
      const a = resolveClientIp(req({ remoteAddress: '198.51.100.10', cfConnectingIp: '203.0.113.1' }), []);
      const b = resolveClientIp(req({ remoteAddress: '198.51.100.10', cfConnectingIp: '203.0.113.2' }), []);
      expect(a).toBe(b);
      expect(a).toBe('198.51.100.10');
    });

    it('two different real clients through a trusted proxy resolve to distinct addresses', () => {
      const a = resolveClientIp(req({ remoteAddress: '10.0.0.5', cfConnectingIp: '203.0.113.1' }), TRUSTED);
      const b = resolveClientIp(req({ remoteAddress: '10.0.0.5', cfConnectingIp: '203.0.113.2' }), TRUSTED);
      expect(a).not.toBe(b);
    });
  });
});

describe('CF-45 — a forwarded value must be a real IP address, not merely IP-looking characters', () => {
  it.each(['::::', '1.2', '999.1.1.1', 'abc', ':'])('%s from a trusted peer is rejected; req.ip wins', (bogus) => {
    expect(resolveClientIp(req({ remoteAddress: '10.0.0.5', ip: '198.51.100.4', cfConnectingIp: bogus }), TRUSTED)).toBe('198.51.100.4');
  });

  it('a real IPv6 value from a trusted peer is honoured', () => {
    expect(resolveClientIp(req({ remoteAddress: '10.0.0.5', cfConnectingIp: '2001:db8::7' }), TRUSTED)).toBe('2001:db8::7');
  });
});

describe('describeClientIp — display only, the stored address is never rewritten', () => {
  it.each([
    ['::ffff:172.18.0.1', { display: '172.18.0.1', scope: 'private' }], // the local Docker bridge gateway
    ['::ffff:127.0.0.1', { display: '127.0.0.1', scope: 'private' }],
    ['::1', { display: '::1', scope: 'private' }],
    ['192.168.1.20', { display: '192.168.1.20', scope: 'private' }],
    ['8.8.8.8', { display: '8.8.8.8', scope: 'public' }],
    ['2001:4860:4860::8888', { display: '2001:4860:4860::8888', scope: 'public' }],
  ])('%s', (raw, expected) => {
    expect(describeClientIp(raw)).toEqual(expected);
  });

  it('returns null for a missing or non-IP value (never an invented address)', () => {
    expect(describeClientIp(null)).toBeNull();
    expect(describeClientIp('unknown')).toBeNull();
  });
});

describe('X-Forwarded-For through real Express trust-proxy (the same predicate main.ts installs)', () => {
  function appTrusting(cidrs: string[]) {
    const app = express();
    app.set('trust proxy', buildTrustProxyPredicate(cidrs));
    app.get('/', (r, res) => res.json({ ip: resolveClientIp(r, cidrs) }));
    return app;
  }

  it('multiple trusted hops: the first untrusted address from the right is the client', async () => {
    const res = await request(appTrusting(['127.0.0.1/32', '10.0.0.0/8'])).get('/').set('X-Forwarded-For', '198.51.100.9, 10.1.2.3');
    expect(res.body.ip).toBe('198.51.100.9');
  });

  it('a client-forged left-most entry is ignored: only the address the trusted proxy itself saw counts', async () => {
    const res = await request(appTrusting(['127.0.0.1/32'])).get('/').set('X-Forwarded-For', '1.2.3.4, 198.51.100.9');
    expect(res.body.ip).toBe('198.51.100.9');
  });

  it('no trusted proxy configured: every forwarded header is ignored and the socket address is used', async () => {
    const res = await request(appTrusting([])).get('/').set('X-Forwarded-For', '1.2.3.4').set('CF-Connecting-IP', '1.2.3.4');
    expect(res.body.ip).not.toBe('1.2.3.4');
    expect(describeClientIp(res.body.ip)?.scope).toBe('private');
  });
});
