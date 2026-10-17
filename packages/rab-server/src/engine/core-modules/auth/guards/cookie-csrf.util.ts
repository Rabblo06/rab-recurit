import { ForbiddenException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Request } from 'express';

/**
 * P1C.1C — Origin validation for cookie-authenticated unsafe requests, extracted so
 * `JwtAuthGuard` (every ordinary cookie-authenticated route, now) and `AuthController`'s own
 * pre-existing `/auth/refresh` check share ONE implementation rather than two copies that could
 * silently drift apart. Unchanged reasoning from the original `/auth/refresh`-only check
 * (`AuthController`'s own doc comment, preserved here): cookies are attached automatically by the
 * browser regardless of which site's JavaScript triggered the request (the actual CSRF threat);
 * `SameSite` alone is not trusted in production (`SameSite=None` is required there for the real
 * cross-site Vercel/Render topology, which offers no CSRF protection by itself). The `Origin`
 * header is set by the browser itself and cannot be overridden by page JavaScript on a
 * cross-origin request, so a forged request from an untrusted page either carries no Origin
 * (rejected) or an Origin this allowlist doesn't contain (also rejected).
 *
 * Never trusts `Referer` or any `X-Forwarded-*` value as provenance — `Origin` only, exactly as
 * the pre-existing check already did.
 *
 * Trust itself is delegated to `EnvironmentService.isTrustedOrigin` (takes a plain predicate
 * function rather than the `EnvironmentService` class itself, so this file doesn't need to import
 * Nest DI machinery) — exact `corsOrigins` match OR a shape-valid workspace-subdomain origin under
 * `WORKSPACE_BASE_DOMAIN`. See that method's own doc comment for the exact rule.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function assertTrustedOriginForCookieRequest(request: Request, isTrustedOrigin: (origin: string | undefined) => boolean): void {
  const origin = request.headers.origin;
  if (!isTrustedOrigin(origin)) {
    throw new ForbiddenException('Untrusted origin.');
  }
}

/**
 * CF-05 (login CSRF): provenance check for the routes that ISSUE a browser credential (`/auth/login`, `/auth/refresh`).
 *  - JSON only. HTML forms and other "simple" requests (urlencoded, multipart, text/plain) are the classic cross-site
 *    vector because a browser sends them without a CORS preflight; `application/json` from another site needs a
 *    preflight, which CORS refuses. Refused with 415 before any credential work.
 *  - If an `Origin` header is present it must be trusted. A browser always sends one on a cross-site POST (and `null` from
 *    sandboxed or opaque contexts, which is never trusted). A request with no Origin at all is not from a browser page
 *    (the native app, CLIs, server-to-server), so it cannot be a CSRF. Refused with 403, and no cookie is ever set.
 */
export function assertCredentialIssuingRequestProvenance(request: Request, isTrustedOrigin: (origin: string | undefined) => boolean): void {
  if (!request.is('application/json')) {
    throw new UnsupportedMediaTypeException({ code: 'JSON_REQUIRED', message: 'Send this request as application/json.' });
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !isTrustedOrigin(origin)) {
    throw new ForbiddenException('Untrusted origin.');
  }
}
