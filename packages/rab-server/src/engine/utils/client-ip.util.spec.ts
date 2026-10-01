import { resolveClientIp } from './client-ip.util';

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
