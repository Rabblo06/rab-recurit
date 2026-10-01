import { buildTrustProxyPredicate, isTrustedProxyPeer } from './trusted-proxy.util';

describe('isTrustedProxyPeer', () => {
  it('fails closed when no trusted CIDRs are configured, regardless of the peer', () => {
    expect(isTrustedProxyPeer('203.0.113.5', [])).toBe(false);
    expect(isTrustedProxyPeer('127.0.0.1', [])).toBe(false);
  });

  it('fails closed for an undefined/empty remote address even with CIDRs configured', () => {
    expect(isTrustedProxyPeer(undefined, ['10.0.0.0/8'])).toBe(false);
    expect(isTrustedProxyPeer('', ['10.0.0.0/8'])).toBe(false);
  });

  it('trusts a peer inside a configured IPv4 CIDR', () => {
    expect(isTrustedProxyPeer('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  it('does not trust a peer outside every configured IPv4 CIDR', () => {
    expect(isTrustedProxyPeer('203.0.113.5', ['10.0.0.0/8', '172.16.0.0/12'])).toBe(false);
  });

  it('trusts an exact single-address CIDR match (/32)', () => {
    expect(isTrustedProxyPeer('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(isTrustedProxyPeer('127.0.0.2', ['127.0.0.1/32'])).toBe(false);
  });

  it('trusts an IPv6 peer inside a configured IPv6 CIDR', () => {
    expect(isTrustedProxyPeer('::1', ['::1/128'])).toBe(true);
    expect(isTrustedProxyPeer('fe80::1', ['::1/128'])).toBe(false);
  });

  it('normalises an IPv4-mapped IPv6 address (::ffff:127.0.0.1) against a plain IPv4 CIDR', () => {
    expect(isTrustedProxyPeer('::ffff:127.0.0.1', ['127.0.0.1/32'])).toBe(true);
  });

  it('never lets a v4 peer match a v6-only range or vice versa', () => {
    expect(isTrustedProxyPeer('10.0.0.1', ['::/0'])).toBe(false);
    expect(isTrustedProxyPeer('::1', ['0.0.0.0/0'])).toBe(false);
  });

  it('a malformed CIDR entry never matches and never throws, even alongside valid entries', () => {
    expect(() => isTrustedProxyPeer('10.0.0.1', ['not-a-cidr', '10.0.0.0/8'])).not.toThrow();
    expect(isTrustedProxyPeer('10.0.0.1', ['not-a-cidr', '10.0.0.0/8'])).toBe(true);
    expect(isTrustedProxyPeer('203.0.113.1', ['not-a-cidr'])).toBe(false);
  });

  it('a malformed remote address never matches and never throws', () => {
    expect(() => isTrustedProxyPeer('<script>alert(1)</script>', ['10.0.0.0/8'])).not.toThrow();
    expect(isTrustedProxyPeer('<script>alert(1)</script>', ['10.0.0.0/8'])).toBe(false);
  });
});

describe('buildTrustProxyPredicate', () => {
  it('builds a predicate usable as Express\'s function-form trust proxy setting', () => {
    const predicate = buildTrustProxyPredicate(['10.0.0.0/8']);
    expect(predicate('10.1.1.1')).toBe(true);
    expect(predicate('203.0.113.1')).toBe(false);
  });
});
