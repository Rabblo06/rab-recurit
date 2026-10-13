import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidSubdomainShape } from '@rab/shared';

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
   * (cookie-csrf.util.ts), and the /auth/refresh-specific duplicate check
   * (auth.controller.ts). Previously each of those three did its own exact
   * match against `corsOrigins`, which would have had to be repeated three
   * times (and could drift) once workspace subdomains needed to be trusted
   * too.
   *
   * Trusted if EITHER:
   *   1. Exact match against `corsOrigins` (unchanged behaviour), OR
   *   2. The origin is `scheme://<label>.<WORKSPACE_BASE_DOMAIN>` for some
   *      label with a valid subdomain SHAPE (3-63 chars,
   *      `isValidSubdomainShape`). Only the shape is checked here — whether
   *      `<label>` is an actual, READY workspace is the job of the separate
   *      hostname-to-workspace resolution layer, not CORS/CSRF. An origin
   *      being "trusted" at this layer only means "this origin may talk to
   *      the API with its cookies," never "this origin corresponds to a
   *      real workspace."
   *
   * Case 2 is skipped entirely when `WORKSPACE_BASE_DOMAIN` isn't configured
   * (fail closed — no base domain means no subdomain can ever be trusted).
   */
  isTrustedOrigin(origin: string | undefined | null): boolean {
    if (!origin) return false;
    if (this.corsOrigins.includes(origin)) return true;

    const baseDomain = this.get('WORKSPACE_BASE_DOMAIN');
    if (!baseDomain) return false;

    let originHost: string;
    let originScheme: string;
    try {
      const url = new URL(origin);
      originHost = url.host;
      originScheme = url.protocol.replace(':', '');
    } catch {
      return false;
    }

    const suffix = `.${baseDomain}`;
    if (!originHost.toLowerCase().endsWith(suffix.toLowerCase())) return false;

    const label = originHost.slice(0, originHost.length - suffix.length);
    if (!label || !isValidSubdomainShape(label)) return false;

    // Workspace subdomains are only ever trusted at https in production — never
    // let an origin downgrade to http to sneak past this check. Non-production
    // (local dev, test) also allows http, since WORKSPACE_BASE_DOMAIN there is
    // typically a bare `localhost:PORT` served without TLS.
    if (this.isProduction) return originScheme === 'https';
    return originScheme === 'http' || originScheme === 'https';
  }
}
