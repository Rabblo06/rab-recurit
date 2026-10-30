/**
 * INTERIM (security review H-1, 2026-10-29): known production databases that do NOT carry a bound deployment identity
 * marker yet. REMOVE THIS LIST (and its two call sites) ONCE PRODUCTION CARRIES A BOUND DEPLOYMENT MARKER — in the release
 * that runs `db:bind-identity` against production.
 *
 * Why it exists: Phase B / B3 replaced the Neon endpoint pin (main's EXPECTED_PRODUCTION_IDENTITY) with the protected
 * deployment identity marker. Until production is bound, a production database is indistinguishable from an unmarked
 * development database by the marker alone, so a non-production API / Worker / Provisioner or a DB_TARGET=local|test
 * command handed today's production URL (INCIDENT-2026-10-05's misrouting class) would no longer be refused. This list
 * keeps the old pin's refusal for exactly those endpoints, on the NON-production paths only:
 *   - runtime-database-guard.ts resolveRuntimeDatabase (non-production branch): every configured endpoint of the process;
 *   - database-target.ts resolveDbTarget (local / test branch): the primary and elevated endpoints.
 * Both run before any connection is opened.
 *
 * Matching is on the factory's canonical parse of the URL (pg-url-policy.ts describePgTarget), exactly as the old pin was:
 * the Neon endpoint key `neon:<endpoint id>`, which is the same for the direct host and its `-pooler` host in any region
 * (and a Neon `options=endpoint=<id>` token must already name the host's own endpoint, or the URL policy refuses it). The
 * endpoint is matched whatever the database name: any database on today's production compute is production data (stricter
 * than main's runtime pin, which also required database neondb; the same as main's command pin).
 *
 * Provider-neutral shape: an entry may name a Neon endpoint key or a plain `host:port` endpoint key.
 */
import { describePgTarget, PgEndpoint, ResolvedPgEnvironment } from '../postgres';

export interface UnmarkedProductionEndpoint {
  /** describePgTarget(...).endpointKey of the production endpoint. */
  endpointKey: string;
  /** The production database on it (informational: every database on the endpoint is refused). */
  database: string;
  /** Loggable description (no URL, user or password). */
  description: string;
}

export const UNMARKED_PRODUCTION_ENDPOINTS: readonly UnmarkedProductionEndpoint[] = Object.freeze([
  {
    endpointKey: 'neon:ep-round-rain-aess0njf',
    database: 'neondb',
    description: 'the current production Neon endpoint (primary branch `production`), which carries no bound deployment marker yet',
  },
]);

/**
 * The deny-list entry a parsed endpoint names, or null. Pure; never connects. Security review N-1: both the host's own
 * endpoint key AND the Neon endpoint the URL routes to (an `options` endpoint token or Neon password routing,
 * `endpoint=<id>$<password>`) are checked. The URL policy already refuses a routed endpoint that differs from the host's,
 * so the second key is defence in depth, not the only line. The host was normalised by the URL policy (lower-case, one
 * trailing dot removed), so `...neon.tech.` matches too.
 */
export function matchUnmarkedProductionEndpoint(endpoint: PgEndpoint): UnmarkedProductionEndpoint | null {
  const keys = [describePgTarget(endpoint.target).endpointKey.toLowerCase()];
  const routed = endpoint.target.routedNeonEndpoint;
  if (routed) keys.push(`neon:${routed.toLowerCase()}`);
  return UNMARKED_PRODUCTION_ENDPOINTS.find((entry) => keys.includes(entry.endpointKey)) ?? null;
}

/**
 * Every endpoint the process could connect to (primary, session-lock, elevated, replica) checked against the deny list.
 * Returns a refusal message naming the variable, the endpoint key and the database only — never a URL or credential —
 * without the trailing "Refusing" (the caller adds its own), or null when none matches.
 */
export function unmarkedProductionRefusal(pg: ResolvedPgEnvironment, processLabel: string): string | null {
  const endpoints = [pg.primary, pg.lock, pg.elevated, pg.replica].filter((e): e is PgEndpoint => e !== null);
  for (const endpoint of endpoints) {
    const hit = matchUnmarkedProductionEndpoint(endpoint);
    if (hit) {
      const identity = describePgTarget(endpoint.target);
      return (
        `${endpoint.source} names ${hit.description} (${identity.endpointKey}, database ${identity.database}). ` +
        `A non-production ${processLabel} must never connect to it. Point ${endpoint.source} at a local, test or ` +
        'development database. (Interim deny list: removed once production carries a bound deployment marker.)'
      );
    }
  }
  return null;
}
