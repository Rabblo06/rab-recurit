import { ForbiddenException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Request } from 'express';

import { EnvironmentService } from '../../environment/environment.service';
import { EnvironmentVariables } from '../../environment/environment-variables';
import { WorkspaceOriginTrustRegistry } from '../../environment/workspace-origin-trust.registry';
import { assertCredentialIssuingRequestProvenance, assertTrustedOriginForCookieRequest, isUnsafeMethod } from './cookie-csrf.util';

/**
 * Wave 1 lane A (finding D-C1): the cookie CSRF checks delegate to the REAL `EnvironmentService.isTrustedOrigin`
 * (not a stub), so the reserved-label and opt-in rules are proven at the layer that actually refuses the request.
 */
function trust(vars: Partial<EnvironmentVariables>, registryConfirmed: string[] = []): (origin: string | undefined) => boolean {
  // Wave 3 lane H: workspace-origin trust is registry-backed — `registryConfirmed` stands in for origins that
  // WorkspaceOriginTrustService.ensure() confirmed as the canonical origin of a READY workspace.
  const registry = new WorkspaceOriginTrustRegistry();
  for (const origin of registryConfirmed) registry.record(origin, true);
  const env = new EnvironmentService({ get: (key: keyof EnvironmentVariables) => (vars as Record<string, unknown>)[key] } as never, registry);
  return (origin) => env.isTrustedOrigin(origin);
}

function req(headers: Record<string, string>, json = true): Request {
  return { headers, is: (type: string) => (json && type === 'application/json' ? type : false) } as unknown as Request;
}

const base = { CORS_ORIGINS: 'https://app.rab.com', WORKSPACE_BASE_DOMAIN: 'rab.com', NODE_ENV: 'production' as const };
const flagOff = trust(base);
const allConfirmed = ['https://acme.rab.com', 'https://api.rab.com', 'https://admin.rab.com', 'https://mail.rab.com', 'http://acme.rab.com', 'https://acme.rab.com:444', 'https://acme.rab.com.evil.com'];
const flagOn = trust({ ...base, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true }, allConfirmed);
const flagOnUnregistered = trust({ ...base, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true });

describe('cookie-csrf.util (wave 1 lane A)', () => {
  it('only POST/PUT/PATCH/DELETE are unsafe', () => {
    expect(['POST', 'put', 'PATCH', 'delete'].every(isUnsafeMethod)).toBe(true);
    expect(['GET', 'HEAD', 'OPTIONS'].some(isUnsafeMethod)).toBe(false);
  });

  describe('assertTrustedOriginForCookieRequest (every cookie-authenticated unsafe request)', () => {
    it('accepts an exact CORS_ORIGINS origin', () => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin: 'https://app.rab.com' }), flagOff)).not.toThrow();
    });

    it('refuses a missing Origin (a cookie request with no Origin is never trusted)', () => {
      expect(() => assertTrustedOriginForCookieRequest(req({}), flagOff)).toThrow(ForbiddenException);
    });

    it('refuses a workspace subdomain while the flag is off (default)', () => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin: 'https://acme.rab.com' }), flagOff)).toThrow(ForbiddenException);
    });

    it('accepts a registry-confirmed workspace origin with the flag on', () => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin: 'https://acme.rab.com' }), flagOn)).not.toThrow();
    });

    it('wave 3: refuses an unregistered (shape-valid) workspace origin even with the flag on', () => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin: 'https://acme.rab.com' }), flagOnUnregistered)).toThrow(ForbiddenException);
    });

    it.each(['https://api.rab.com', 'https://admin.rab.com', 'https://mail.rab.com'])('refuses reserved sibling host %s even with the flag on', (origin) => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin }), flagOn)).toThrow(ForbiddenException);
    });

    it.each(['http://acme.rab.com', 'https://acme.rab.com:444', 'https://acme.rab.com.evil.com', 'null'])('refuses %s with the flag on', (origin) => {
      expect(() => assertTrustedOriginForCookieRequest(req({ origin }), flagOn)).toThrow(ForbiddenException);
    });
  });

  describe('assertCredentialIssuingRequestProvenance (/auth/login, OAuth handoff)', () => {
    it('refuses non-JSON with 415 before looking at the Origin', () => {
      expect(() => assertCredentialIssuingRequestProvenance(req({ origin: 'https://app.rab.com' }, false), flagOff)).toThrow(UnsupportedMediaTypeException);
    });

    it('allows a JSON request with no Origin at all (native app / server-to-server — cannot be a browser CSRF)', () => {
      expect(() => assertCredentialIssuingRequestProvenance(req({}), flagOff)).not.toThrow();
    });

    it('refuses a reserved-label Origin with 403 even with the flag on', () => {
      expect(() => assertCredentialIssuingRequestProvenance(req({ origin: 'https://api.rab.com' }), flagOn)).toThrow(ForbiddenException);
    });

    it('refuses a workspace-subdomain Origin with the flag off', () => {
      expect(() => assertCredentialIssuingRequestProvenance(req({ origin: 'https://acme.rab.com' }), flagOff)).toThrow(ForbiddenException);
    });

    it('refuses the opaque "null" Origin', () => {
      expect(() => assertCredentialIssuingRequestProvenance(req({ origin: 'null' }), flagOn)).toThrow(ForbiddenException);
    });
  });
});
