import { ForbiddenException } from '@nestjs/common';
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
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function assertTrustedOriginForCookieRequest(request: Request, corsOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (!origin || !corsOrigins.includes(origin)) {
    throw new ForbiddenException('Untrusted origin.');
  }
}
