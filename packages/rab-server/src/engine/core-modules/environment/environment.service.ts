import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidSubdomainShape, RESERVED_SUBDOMAINS } from '@rab/shared';

import { EnvironmentVariables } from './environment-variables';

/**
 * Typed accessor over validated env vars. Nothing outside this module
 * should call `process.env` or the raw `ConfigService` directly.
 */
@Injectable()
export class EnvironmentService {
  constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {}

  get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return this.configService.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  /** PHASE 11 / EDGE-01 — see TRUSTED_PROXY_CIDRS's own doc comment. Empty by default (fail closed). */
  get trustedProxyCidrs(): string[] {
    return this.get('TRUSTED_PROXY_CIDRS')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean);
  }

  /**
   * Single source of truth for "is this Origin allowed to make a credentialed
   * request to this API" — used by CORS (main.ts), the cookie-auth CSRF check
   * (cookie-csrf.util.ts), login/refresh provenance
   * (credential-request-provenance.guard.ts), the /auth/refresh-specific
   * duplicate check (auth.controller.ts) and the OAuth handoff controller.
   *
   * Trusted if EITHER:
   *   1. Exact match against `corsOrigins` (unchanged behaviour), OR
   *   2. ONLY when `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true` (default
   *      false — wave 1 lane A, finding D-C1): the origin is
   *      `scheme://<label>.<WORKSPACE_BASE_DOMAIN>` where `<label>` has a valid
   *      subdomain SHAPE (3-63 chars, `isValidSubdomainShape`), is NOT a
   *      reserved name (`RESERVED_SUBDOMAINS` — `api`, `admin`, `mail`, ...: hosts
   *      that are never a workspace and may run third-party or operational
   *      code), and is NOT an IDN/punycode label (`xn--`, homograph risk).
   *      Still shape-only: whether `<label>` is a registered READY workspace is
   *      wave 3 (registry-backed trust), which is why this case is off by
   *      default — nothing legitimate is served from a workspace subdomain yet.
   *
   * Case 2 is skipped entirely when the flag is off or `WORKSPACE_BASE_DOMAIN`
   * isn't configured (fail closed).
   */
  isTrustedOrigin(origin: string | undefined | null): boolean {
    if (!origin) return false;
    if (this.corsOrigins.includes(origin)) return true;

    if (this.get('WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED') !== true) return false;
    const baseDomain = this.get('WORKSPACE_BASE_DOMAIN');
    if (!baseDomain) return false;

    let originHost: string;
    let originScheme: string;
    try {
      const url = new URL(origin);
      // A browser's Origin is always the bare serialised origin. Anything else (a path, userinfo, a
      // trailing slash, upper case) is not a browser-sent Origin and is never trusted.
      if (url.origin !== origin) return false;
      originHost = url.host;
      originScheme = url.protocol.replace(':', '');
    } catch {
      return false;
    }

    const suffix = `.${baseDomain.toLowerCase()}`;
    if (!originHost.endsWith(suffix)) return false;

    const label = originHost.slice(0, originHost.length - suffix.length);
    if (!label || !isValidSubdomainShape(label)) return false;
    if (RESERVED_SUBDOMAINS.has(label) || label.startsWith('xn--')) return false;

    // Workspace subdomains are only ever trusted at https in production — never
    // let an origin downgrade to http to sneak past this check. Non-production
    // (local dev, test) also allows http, since WORKSPACE_BASE_DOMAIN there is
    // typically a bare `localhost:PORT` served without TLS.
    if (this.isProduction) return originScheme === 'https';
    return originScheme === 'http' || originScheme === 'https';
  }
}
