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
      NODE_ENV: 'development',
    });
    expect(env.isTrustedOrigin('http://issac.localhost:5173')).toBe(true);
  });

  it('rejects a workspace-subdomain-shaped origin over http in production', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('http://issac.rab.com')).toBe(false);
  });

  it('trusts a shape-valid workspace subdomain origin over https in production', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://issac.rab.com')).toBe(true);
  });

  it('rejects an origin that is the bare base domain with no subdomain label', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://rab.com')).toBe(false);
  });

  it('rejects an origin whose label has an invalid subdomain shape (too short)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://ab.rab.com')).toBe(false);
  });

  it('rejects an origin whose label has an invalid subdomain shape (leading hyphen)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('https://-issac.rab.com')).toBe(false);
  });

  it('rejects a completely unrelated domain even when it ends in a similar string', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
      NODE_ENV: 'production',
    });
    // "evilrab.com" does NOT end in ".rab.com" — must not be confused with a subdomain of it.
    expect(env.isTrustedOrigin('https://evilrab.com')).toBe(false);
  });

  it('rejects a multi-level subdomain impersonation attempt (not a single valid label)', () => {
    const env = makeService({
      CORS_ORIGINS: 'https://app.rab.com',
      WORKSPACE_BASE_DOMAIN: 'rab.com',
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
      NODE_ENV: 'production',
    });
    expect(env.isTrustedOrigin('not-a-url')).toBe(false);
  });
});
