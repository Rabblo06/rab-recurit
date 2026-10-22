import { EnvironmentService } from './environment.service';
import { EnvironmentVariables } from './environment-variables';

function makeService(vars: Partial<EnvironmentVariables>): EnvironmentService {
  const configService = { get: (key: keyof EnvironmentVariables) => (vars as any)[key] };
  return new EnvironmentService(configService as any);
}

describe('EnvironmentService.isTrustedOrigin', () => {
  it('trusts an exact corsOrigins match (unchanged pre-existing behaviour)', () => {
    const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production' });
    expect(env.isTrustedOrigin('https://app.rab.com')).toBe(true);
  });

  it('rejects an origin absent from corsOrigins when no WORKSPACE_BASE_DOMAIN is configured', () => {
    const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production' });
    expect(env.isTrustedOrigin('https://issac.rab.com')).toBe(false);
  });

  it('trusts a shape-valid workspace subdomain origin under WORKSPACE_BASE_DOMAIN (dev, http)', () => {
    const env = makeService({
      CORS_ORIGINS: 'http://localhost:5173',
      WORKSPACE_BASE_DOMAIN: 'localhost:5173',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'development',
    });
    expect(env.isTrustedOrigin('http://issac.localhost:5173')).toBe(true);
  });

  it('rejects a workspace-subdomain-shaped origin over http in production', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('http://issac.rab.com')).toBe(false);
  });

  it('trusts a shape-valid workspace subdomain origin over https in production', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://issac.rab.com')).toBe(true);
  });

  it('rejects an origin that is the bare base domain with no subdomain label', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://rab.com')).toBe(false);
  });

  it('rejects an origin whose label has an invalid subdomain shape (too short)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://ab.rab.com')).toBe(false);
  });

  it('rejects an origin whose label has an invalid subdomain shape (leading hyphen)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://-issac.rab.com')).toBe(false);
  });

  it('rejects a completely unrelated domain even when it ends in a similar string', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    // "evilrab.com" does NOT end in ".rab.com" — must not be confused with a subdomain of it.
    expect(env.isTrustedOrigin('https://evilrab.com')).toBe(false);
  });

  it('rejects a multi-level subdomain impersonation attempt (not a single valid label)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    // "issac.evil.rab.com" — label would be "issac.evil", which fails isValidSubdomainShape
    // (dots aren't a valid subdomain character), so this must be rejected.
    expect(env.isTrustedOrigin('https://issac.evil.rab.com')).toBe(false);
  });

  it('rejects a null/undefined/empty origin', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin(undefined)).toBe(false);
    expect(env.isTrustedOrigin(null as any)).toBe(false);
    expect(env.isTrustedOrigin('')).toBe(false);
  });

  it('rejects a malformed origin that is not a parseable URL', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true,
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('not-a-url')).toBe(false);
  });

  // ------------------------------------------------------------------ wave 1 lane A (finding D-C1)
  describe('wave 1: workspace-subdomain trust is opt-in and never covers reserved labels', () => {
    const prod = (extra: Partial<EnvironmentVariables> = {}) =>
      makeService({ CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', NODE_ENV: 'production', ...extra });
    const on = { WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true } as const;

    it('flag unset (the default): a shape-valid workspace subdomain is NOT trusted, exact CORS_ORIGINS still is', () => {
      const env = prod();
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
      expect(env.isTrustedOrigin('https://app.rab.com')).toBe(true);
    });

    it('flag explicitly false: still not trusted', () => {
      expect(prod({ WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: false }).isTrustedOrigin('https://acme.rab.com')).toBe(false);
    });

    it('flag on: an unknown (unregistered) shape-valid label is trusted — shape only until wave 3 registry trust', () => {
      expect(prod(on).isTrustedOrigin('https://unknown-label.rab.com')).toBe(true);
    });

    it.each(['api', 'admin', 'mail', 'www', 'auth', 'login', 'support', 'smtp', 'cdn', 'workspace', 'graphql', 'rest', 'status'])(
      'flag on: reserved label "%s" is never trusted',
      (label) => {
        expect(prod(on).isTrustedOrigin(`https://${label}.rab.com`)).toBe(false);
      },
    );

    it('flag on: an IDN/punycode label is never trusted', () => {
      expect(prod(on).isTrustedOrigin('https://xn--pple-43d.rab.com')).toBe(false);
    });

    it('flag on, production: http is refused (no scheme downgrade), https accepted', () => {
      expect(prod(on).isTrustedOrigin('http://acme.rab.com')).toBe(false);
      expect(prod(on).isTrustedOrigin('https://acme.rab.com')).toBe(true);
    });

    it('flag on: non-http(s) schemes are refused even outside production', () => {
      const dev = makeService({ CORS_ORIGINS: 'http://localhost:5173', WORKSPACE_BASE_DOMAIN: 'localhost:5173', NODE_ENV: 'development', ...on });
      expect(dev.isTrustedOrigin('ws://acme.localhost:5173')).toBe(false);
      expect(dev.isTrustedOrigin('ftp://acme.localhost:5173')).toBe(false);
      expect(dev.isTrustedOrigin('http://acme.localhost:5173')).toBe(true);
    });

    it('flag on: a different port from the base domain is refused', () => {
      expect(prod(on).isTrustedOrigin('https://acme.rab.com:8443')).toBe(false);
      const dev = makeService({ CORS_ORIGINS: 'http://localhost:5173', WORKSPACE_BASE_DOMAIN: 'localhost:5173', NODE_ENV: 'development', ...on });
      expect(dev.isTrustedOrigin('http://acme.localhost:5174')).toBe(false);
      expect(dev.isTrustedOrigin('http://acme.localhost')).toBe(false);
    });

    it.each([
      ['suffix confusion', 'https://acme.rab.com.evil.com'],
      ['lookalike apex', 'https://acme-rab.com'],
      ['userinfo trick', 'https://acme.rab.com@evil.com'],
      ['userinfo on a trusted host', 'https://user@acme.rab.com'],
      ['path appended', 'https://acme.rab.com/evil'],
      ['trailing slash', 'https://acme.rab.com/'],
      ['upper-case (not a browser-serialised origin)', 'https://ACME.rab.com'],
      ['opaque origin', 'null'],
      ['nested label', 'https://a.acme.rab.com'],
      ['bare base domain', 'https://rab.com'],
      ['javascript scheme', 'javascript://acme.rab.com'],
    ])('flag on: malicious Origin (%s) is refused', (_name, origin) => {
      expect(prod(on).isTrustedOrigin(origin)).toBe(false);
    });

    it('flag on but WORKSPACE_BASE_DOMAIN unset: nothing beyond CORS_ORIGINS is trusted (fail closed)', () => {
      const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production', ...on });
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
    });
  });
});
