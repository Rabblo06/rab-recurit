import { EnvironmentService } from './environment.service';
import { EnvironmentVariables } from './environment-variables';
import { WORKSPACE_ORIGIN_TRUST_TTL_MS, WorkspaceOriginTrustRegistry } from './workspace-origin-trust.registry';

function makeService(vars: Partial<EnvironmentVariables>, registry?: WorkspaceOriginTrustRegistry): EnvironmentService {
  const configService = { get: (key: keyof EnvironmentVariables) => (vars as any)[key] };
  return new EnvironmentService(configService as any, registry);
}

/** A registry that already holds a POSITIVE answer for each origin, as WorkspaceOriginTrustService.ensure() would record. */
function registryTrusting(...origins: string[]): WorkspaceOriginTrustRegistry {
  const registry = new WorkspaceOriginTrustRegistry();
  for (const origin of origins) registry.record(origin, true);
  return registry;
}

describe('EnvironmentService.isTrustedOrigin', () => {
  it('trusts an exact corsOrigins match (unchanged pre-existing behaviour)', () => {
    const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production' });
    expect(env.isTrustedOrigin('https://app.rab.com')).toBe(true);
  });

  it('rejects an origin absent from corsOrigins when no WORKSPACE_BASE_DOMAIN is configured', () => {
    const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production' }, registryTrusting('https://issac.rab.com'));
    expect(env.isTrustedOrigin('https://issac.rab.com')).toBe(false);
  });

  it('rejects a null/undefined/empty/malformed origin', () => {
    const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true, NODE_ENV: 'production' });
    expect(env.isTrustedOrigin(undefined)).toBe(false);
    expect(env.isTrustedOrigin(null as any)).toBe(false);
    expect(env.isTrustedOrigin('')).toBe(false);
    expect(env.isTrustedOrigin('not-a-url')).toBe(false);
  });

  // ------------------------------------------------------------------ wave 1 lane A (D-C1) + wave 3 lane H (registry)
  describe('workspace-origin trust: opt-in, registry-backed, never reserved', () => {
    const prodVars = { CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', NODE_ENV: 'production' } as const;
    const on = { WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true } as const;

    it('flag unset (the default): even a registry-confirmed workspace origin is NOT trusted; exact CORS_ORIGINS still is', () => {
      const env = makeService(prodVars, registryTrusting('https://acme.rab.com'));
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
      expect(env.isTrustedOrigin('https://app.rab.com')).toBe(true);
    });

    it('flag on, no registry answer: a shape-valid but unregistered label is NOT trusted (wave 3: shape is no longer enough)', () => {
      expect(makeService({ ...prodVars, ...on }, new WorkspaceOriginTrustRegistry()).isTrustedOrigin('https://unknown-label.rab.com')).toBe(false);
      // A bare service with no registry wired at all fails closed too.
      expect(makeService({ ...prodVars, ...on }).isTrustedOrigin('https://unknown-label.rab.com')).toBe(false);
    });

    it('flag on, registry says canonical READY workspace: trusted', () => {
      expect(makeService({ ...prodVars, ...on }, registryTrusting('https://acme.rab.com')).isTrustedOrigin('https://acme.rab.com')).toBe(true);
    });

    it('a negative answer replaces a positive one at once (rename, suspension), and a positive answer expires', () => {
      const registry = registryTrusting('https://acme.rab.com');
      const env = makeService({ ...prodVars, ...on }, registry);
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(true);
      registry.record('https://acme.rab.com', false);
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
      registry.record('https://acme.rab.com', true, Date.now() - WORKSPACE_ORIGIN_TRUST_TTL_MS - 1);
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
    });

    it.each(['api', 'admin', 'mail', 'www', 'auth', 'login', 'support', 'smtp', 'cdn', 'workspace', 'graphql', 'rest', 'status', 'accounts', 'api-eu', 'www-old'])(
      'flag on: reserved label "%s" is never trusted, even if a registry entry somehow existed',
      (label) => {
        const origin = `https://${label}.rab.com`;
        expect(makeService({ ...prodVars, ...on }, registryTrusting(origin)).isTrustedOrigin(origin)).toBe(false);
      },
    );

    it('flag on: an IDN/punycode label is never trusted', () => {
      const origin = 'https://xn--pple-43d.rab.com';
      expect(makeService({ ...prodVars, ...on }, registryTrusting(origin)).isTrustedOrigin(origin)).toBe(false);
    });

    it('flag on, production: http is refused (no scheme downgrade) even when the https origin is trusted', () => {
      const env = makeService({ ...prodVars, ...on }, registryTrusting('https://acme.rab.com', 'http://acme.rab.com'));
      expect(env.isTrustedOrigin('http://acme.rab.com')).toBe(false);
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(true);
    });

    it('flag on, development: only APP_URL\'s scheme is canonical; other schemes and ports are refused', () => {
      const dev = makeService(
        { CORS_ORIGINS: 'http://localhost:5173', WORKSPACE_BASE_DOMAIN: 'localhost:5173', APP_URL: 'http://localhost:5173', NODE_ENV: 'development', ...on },
        registryTrusting('http://acme.localhost:5173', 'https://acme.localhost:5173', 'ws://acme.localhost:5173', 'http://acme.localhost:5174', 'http://acme.localhost'),
      );
      expect(dev.isTrustedOrigin('http://acme.localhost:5173')).toBe(true);
      expect(dev.isTrustedOrigin('https://acme.localhost:5173')).toBe(false);
      expect(dev.isTrustedOrigin('ws://acme.localhost:5173')).toBe(false);
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
      ['other port', 'https://acme.rab.com:8443'],
      ['too-short label', 'https://ab.rab.com'],
      ['leading hyphen', 'https://-issac.rab.com'],
    ])('flag on: malicious Origin (%s) is refused even if a registry entry for that exact string existed', (_name, origin) => {
      expect(makeService({ ...prodVars, ...on }, registryTrusting(origin)).isTrustedOrigin(origin)).toBe(false);
    });

    it('flag on but WORKSPACE_BASE_DOMAIN unset: nothing beyond CORS_ORIGINS is trusted (fail closed)', () => {
      const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', NODE_ENV: 'production', ...on }, registryTrusting('https://acme.rab.com'));
      expect(env.isTrustedOrigin('https://acme.rab.com')).toBe(false);
    });
  });

  describe('workspaceOriginLabel (what WorkspaceOriginTrustService looks up)', () => {
    it('returns the label only for a structural candidate', () => {
      const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', NODE_ENV: 'production', WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true });
      expect(env.workspaceOriginLabel('https://acme.rab.com')).toBe('acme');
      expect(env.workspaceOriginLabel('https://api.rab.com')).toBeNull();
      expect(env.workspaceOriginLabel('http://acme.rab.com')).toBeNull();
      expect(env.workspaceOriginLabel('https://rab.com')).toBeNull();
    });

    it('is null whenever the flag is off', () => {
      const env = makeService({ CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', NODE_ENV: 'production' });
      expect(env.workspaceOriginLabel('https://acme.rab.com')).toBeNull();
    });
  });
});
