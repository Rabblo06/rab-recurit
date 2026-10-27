import { ConfigService } from '@nestjs/config';
import { Injectable, Optional } from '@nestjs/common';
import { classifyWorkspaceHost, parseHostAuthority } from '@rab/shared';

import { LegacyAiEnvFacts, legacyAiEnvFacts } from '../ai/ai-readiness';
import { EnvironmentVariables } from './environment-variables';
import { WorkspaceOriginTrustRegistry } from './workspace-origin-trust.registry';

/**
 * Typed accessor over validated env vars. Nothing outside this module
 * should call `process.env` or the raw `ConfigService` directly.
 */
@Injectable()
export class EnvironmentService {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
    // Optional so a bare `new EnvironmentService(config)` (unit tests, CLI scripts) still works — with no registry the
    // workspace-origin case of isTrustedOrigin is simply never true (fail closed).
    @Optional() private readonly originRegistry?: WorkspaceOriginTrustRegistry,
  ) {}

  get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return this.configService.get(key, { infer: true });
  }

  /**
   * AI Phase 1 "real models only" (§5): the RETIRED AI names (AI_PROVIDER, AI_MODEL, AI_PROVIDER_API_KEY) are no longer
   * schema properties, so they are read from the raw configuration — and only the verdicts leave (set / mock stand-in /
   * alias present). Never a value.
   */
  legacyAiEnv(): LegacyAiEnvFacts {
    return legacyAiEnvFacts((name) => this.configService.get(name as never));
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
   * The scheme every canonical workspace origin uses: always https in production (never let an Origin downgrade to http),
   * otherwise APP_URL's own scheme (local dev serves `http://<label>.localhost:5173`).
   */
  get canonicalWorkspaceScheme(): 'http' | 'https' {
    if (this.isProduction) return 'https';
    try {
      return new URL(this.get('APP_URL')).protocol === 'https:' ? 'https' : 'http';
    } catch {
      return 'https';
    }
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
   *   2. ONLY when `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true` (default false — wave 1 lane A, finding D-C1):
   *      the origin is EXACTLY the canonical origin of a registered, READY, active workspace in an organisation that is
   *      not suspended (wave 3 lane H, registry-backed). Cheap structural pre-checks run first (shape, reserved labels,
   *      `xn--`, exact serialisation, exact base-domain port, https in production); the registry answer itself comes
   *      from `WorkspaceOriginTrustRegistry`, filled by `WorkspaceOriginTrustService.ensure()` (middleware + CORS
   *      callback) from `core.resolve_workspace_by_host_label`. A label that is unknown, reserved, CREATING/FAILED,
   *      suspended, or released into rename quarantine is never trusted; neither is the canonical host with another
   *      scheme or port.
   *
   * Case 2 is skipped entirely when the flag is off, `WORKSPACE_BASE_DOMAIN` isn't configured, or no registry is wired
   * (a bare `new EnvironmentService(config)` in a unit test) — fail closed.
   */
  isTrustedOrigin(origin: string | undefined | null): boolean {
    if (!origin) return false;
    if (this.corsOrigins.includes(origin)) return true;
    const label = this.workspaceOriginLabel(origin);
    if (label === null) return false;
    return this.originRegistry?.isTrusted(origin) === true;
  }

  /**
   * The workspace label of `origin` when it is STRUCTURALLY a candidate for case 2 of `isTrustedOrigin` (flag on, base
   * domain set, exact serialisation, one non-reserved label of valid shape, exact port, canonical scheme) — else null.
   * Never consults the registry; `WorkspaceOriginTrustService` uses it to decide what to look up.
   */
  workspaceOriginLabel(origin: string | undefined | null): string | null {
    if (!origin) return null;
    if (this.get('WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED') !== true) return null;
    const baseDomain = this.get('WORKSPACE_BASE_DOMAIN');
    if (!baseDomain) return null;

    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return null;
    }
    // A browser's Origin is always the bare serialised origin. Anything else (a path, userinfo, a trailing slash, upper
    // case) is not a browser-sent Origin and is never trusted.
    if (url.origin !== origin) return null;
    if (url.protocol !== `${this.canonicalWorkspaceScheme}:`) return null;
    const authority = parseHostAuthority(url.host);
    if (!authority) return null;
    const classified = classifyWorkspaceHost(authority, baseDomain);
    if (classified.kind !== 'label' || classified.reserved) return null;
    return classified.label;
  }
}
