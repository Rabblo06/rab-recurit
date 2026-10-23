import { Injectable } from '@nestjs/common';

/** How long a POSITIVE registry answer may be reused by the synchronous predicate before it must be re-resolved. */
export const WORKSPACE_ORIGIN_TRUST_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

/**
 * Wave 3 lane H (C9 step 1) — the in-process snapshot behind `EnvironmentService.isTrustedOrigin`'s workspace case.
 *
 * `isTrustedOrigin` is synchronous (CORS callback, cookie CSRF util, login provenance guard, `/auth/refresh`, OAuth
 * handoff all call it inline), but "is this the canonical origin of a READY workspace" needs the database. So the
 * decision is split:
 *   1. `WorkspaceOriginTrustService.ensure(origin)` (async) resolves the Origin against the registry — through the
 *      Redis host-label cache, epoch-invalidated on rename/READY/suspension — and records the answer here. It runs in
 *      `WorkspaceHostMiddleware` for EVERY request before any guard, and in the CORS origin callback.
 *   2. The synchronous predicate only reads this map: an origin is trusted only while a fresh POSITIVE answer exists.
 *      Missing, expired or negative → untrusted (fail closed).
 * Because step 1 re-resolves on every request, an entry is at most one request old in practice; the TTL only bounds a
 * caller that consults the predicate without the middleware having run. `clear()` drops everything in this process
 * (rename, suspension); other processes re-resolve on their next request through the shared, already-invalidated cache.
 *
 * Holds no secrets and no tenant data: only origin strings this deployment has itself verified as canonical.
 */
@Injectable()
export class WorkspaceOriginTrustRegistry {
  private readonly trustedUntil = new Map<string, number>();

  record(origin: string, trusted: boolean, now: number = Date.now()): void {
    this.trustedUntil.delete(origin);
    if (!trusted) return;
    if (this.trustedUntil.size >= MAX_ENTRIES) {
      const oldest = this.trustedUntil.keys().next().value;
      if (oldest !== undefined) this.trustedUntil.delete(oldest);
    }
    this.trustedUntil.set(origin, now + WORKSPACE_ORIGIN_TRUST_TTL_MS);
  }

  isTrusted(origin: string, now: number = Date.now()): boolean {
    const until = this.trustedUntil.get(origin);
    if (until === undefined) return false;
    if (until <= now) {
      this.trustedUntil.delete(origin);
      return false;
    }
    return true;
  }

  forget(origin: string): void {
    this.trustedUntil.delete(origin);
  }

  clear(): void {
    this.trustedUntil.clear();
  }
}
