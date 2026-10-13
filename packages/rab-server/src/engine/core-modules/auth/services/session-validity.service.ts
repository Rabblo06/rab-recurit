import { Injectable, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EnvironmentService } from '../../environment/environment.service';
import { idleSessionTimeoutMsByTarget } from '../session-policy';

/**
 * PHASE 10 / AUTH-02 — a cryptographically valid, unexpired access JWT
 * previously proved nothing about whether the SESSION it was minted from is
 * still alive: logout, family revocation (reuse detection, password
 * reset/change), and the absolute session deadline all only ever touched
 * `core.refresh_token` rows — nothing re-checked that at request time, so an
 * already-issued access token kept authorizing requests for the rest of its
 * own (up to 15-minute) lifetime regardless of any of those events.
 *
 * ONE canonical query, called from `JwtAuthGuard` on every authenticated
 * request: the JWT's `sid` claim is the refresh-token family id it was
 * minted alongside (see `AuthService.login`/`refresh`, which always pass
 * `sid: familyId`) — a session is "active" iff that family currently has at
 * least one non-revoked member whose absolute deadline (`family_expires_at`,
 * shared by every row in the family) has not passed. Never trusts `sid`
 * alone: `userId`/`organisationId` are also required to match, so a
 * (cryptographically impossible under a sound HS256 signature, but checked
 * anyway as cheap defense-in-depth) forged claim combination can't slip
 * through.
 *
 * `family_expires_at > now()` uses PostgreSQL's own clock — never
 * `Date.now()` — so a client/device clock can never influence this decision
 * (CLAUDE.md's own "DB time is authoritative" rule, and Phase 10 §15).
 *
 * Fails closed on ambiguity: if the query itself cannot be answered (a
 * thrown error, not merely "zero rows"), the caller must treat that as
 * "session not proven active" — this service never resolves `true` from a
 * catch block. Distinguishing a security denial from a transient outage is
 * the CALLER's job (logged separately), per Phase 10 §22 — this service
 * only ever answers "still authoritatively active", never "probably fine".
 */
/**
 * P1B: bounded `last_seen_at` activity threshold. A session seen more recently than this is
 * never re-written — only a session that's gone genuinely stale gets a fresh timestamp. This is
 * what keeps "last active" meaningful (real request activity, not just refresh-rotation time —
 * see UserSession's own doc comment for the gap this closes) WITHOUT writing the database on
 * every single authenticated request, which every request already passes through this exact
 * method. 5 minutes is a deliberate, documented operational choice: frequent enough that a
 * device/session list never looks stale to a human glancing at it, coarse enough that even a
 * busy client polling every few seconds causes at most one extra UPDATE per session per window.
 */
const LAST_SEEN_BUMP_THRESHOLD = '5 minutes';

@Injectable()
export class SessionValidityService {
  constructor(private readonly environment: EnvironmentService) {}

  /**
   * P1B.1 — the UserSession enforcement cutover (`USER_SESSION_ENFORCEMENT_CUTOVER`, see that
   * flag's own doc comment in `environment-variables.ts`):
   *
   * PRE-CUTOVER (default, false): `core.user_session` is consulted as an ADDITIONAL fail-closed
   * layer, never a replacement for the refresh_token family check (which remains the sole
   * PRIMARY authority, exactly as before P1B) — a pre-P1B session with no user_session row yet
   * (not backfilled in this environment) keeps working. ABSENCE of a row is not itself a denial;
   * only an EXPLICIT revocation on an EXISTING row is.
   *
   * POST-CUTOVER (true): `core.user_session` becomes mandatory authority alongside
   * `refresh_token` — a missing row is treated exactly like an explicit revocation and denies
   * the request. This must only ever be flipped after `user-session:backfill --verify` reports
   * zero missing families for every organisation in that deployment; it is never inferred or
   * auto-enabled by this service itself from backfill completion — an explicit, auditable
   * operator action is the only way this mode turns on, never a second competing authority.
   *
   * Both modes share one query (one round trip): the SAME bounded `last_seen_at` bump (see that
   * constant's own doc comment) always runs, guarded by the family's own liveness, so a
   * dead/foreign session is never bumped in either mode.
   */
  /**
   * `privileged`: owner correction (overnight P2/P3 mandate) — "A platform administrator must
   * receive the stricter 30-minute inactivity policy regardless of whether authentication
   * originated through a web or mobile application target. Do not allow mobile application-target
   * metadata to override verified privileged-role policy." Must be the CALLER's own freshly-resolved
   * `isPrivilegedIdleClass(roles, isPlatformAdmin)` for the CURRENT request — never a value cached
   * at session creation — so a role granted or revoked mid-session changes the idle policy on the
   * very next request, in either direction. Defaults to `false` only as a safe fallback for a
   * hypothetical caller that genuinely has no role data yet (none exists today — confirmed, the one
   * real caller, `AuthSecuritySnapshotService.build()`, always resolves roles before calling this);
   * `false` is the SAFE default specifically because it's the WIDER (not narrower) per-target
   * duration — never silently grants the stricter policy's absence as a loophole.
   */
  async assertActive(manager: EntityManager, params: { userId: string; organisationId: string | null; sid: string; privileged?: boolean }): Promise<void> {
    if (!params.sid) {
      throw new UnauthorizedException('Please sign in again.');
    }
    // P2.2 — idle timeout durations as literal intervals, keyed by application_target inside the
    // single query below, UNLESS `privileged` forces the manager_web value regardless of the row's
    // own stored target. Computed here, not hardcoded in SQL, so session-policy.ts stays the one
    // canonical source of every duration this file enforces.
    const idleMs = idleSessionTimeoutMsByTarget();
    const privilegedMs = idleMs.manager_web;
    const rows = await manager.query<Array<{ live: boolean; session_exists: boolean; session_revoked: boolean; idle_expired: boolean }>>(
      `WITH live AS (
         SELECT 1 FROM core.refresh_token
          WHERE family_id = $1
            AND user_id = $2
            AND organisation_id = $3
            AND revoked_at IS NULL
            AND family_expires_at > now()
          LIMIT 1
       ),
       session_row AS (
         SELECT 1 FROM core.user_session WHERE id = $1 LIMIT 1
       ),
       session_revoked AS (
         SELECT 1 FROM core.user_session WHERE id = $1 AND revoked_at IS NOT NULL LIMIT 1
       ),
       session_idle_expired AS (
         SELECT 1 FROM core.user_session WHERE id = $1 AND idle_expires_at IS NOT NULL AND idle_expires_at <= now() LIMIT 1
       ),
       bump AS (
         UPDATE core.user_session
            SET last_seen_at = now(),
                idle_expires_at = LEAST(
                  now() + (CASE WHEN $7::boolean THEN $8::interval ELSE (CASE application_target
                    WHEN 'manager_web' THEN $4::interval
                    WHEN 'staff_app' THEN $5::interval
                    WHEN 'venue_manager_app' THEN $6::interval
                  END) END),
                  absolute_expires_at
                )
          WHERE id = $1
            AND revoked_at IS NULL
            AND last_seen_at < now() - interval '${LAST_SEEN_BUMP_THRESHOLD}'
            AND EXISTS (SELECT 1 FROM live)
            AND NOT EXISTS (SELECT 1 FROM session_idle_expired)
         RETURNING 1
       )
       SELECT
         EXISTS (SELECT 1 FROM live) AS live,
         EXISTS (SELECT 1 FROM session_row) AS session_exists,
         EXISTS (SELECT 1 FROM session_revoked) AS session_revoked,
         EXISTS (SELECT 1 FROM session_idle_expired) AS idle_expired`,
      [
        params.sid,
        params.userId,
        params.organisationId,
        `${idleMs.manager_web} milliseconds`,
        `${idleMs.staff_app} milliseconds`,
        `${idleMs.venue_manager_app} milliseconds`,
        !!params.privileged,
        `${privilegedMs} milliseconds`,
      ],
    );
    const row = rows[0];
    const cutover = this.environment.get('USER_SESSION_ENFORCEMENT_CUTOVER');
    // idle_expired is enforced unconditionally, same as session_revoked above (both are explicit
    // signals on an EXISTING row — only the no-row-at-all case is cutover-gated, per this method's
    // own doc comment: "ABSENCE of a row is not itself a denial; only an EXPLICIT [state] is").
    const denied = !row?.live || row.session_revoked || row.idle_expired || (cutover && !row.session_exists);
    if (denied) {
      throw new UnauthorizedException('Please sign in again.');
    }
  }

  /**
   * Stage 3 real-time gateway — the SAME liveness/revocation/idle-expiry decision as
   * `assertActive` above, reusing its exact `live`/`session_revoked`/`session_idle_expired` CTEs
   * verbatim, but WITHOUT that method's `bump` CTE (the `last_seen_at`/`idle_expires_at` UPDATE).
   * An open SSE connection's own heartbeat must detect a session that has gone idle or passed its
   * absolute deadline while the stream stayed open — a security-version check alone only catches
   * an EXPLICIT revocation/role/permission/membership change, never silent time-based expiry — but
   * it must never itself be what KEEPS that session alive: an idle user who merely has a tab open
   * with no real activity must still time out on schedule, not be granted a rolling extension by
   * this background heartbeat. `idle_expires_at` already encodes the absolute deadline too (every
   * write clamps it with `LEAST(..., absolute_expires_at)` — see `assertActive`'s own comment), so
   * checking it alone is sufficient for both.
   */
  async assertActiveReadOnly(manager: EntityManager, params: { userId: string; organisationId: string | null; sid: string }): Promise<void> {
    if (!params.sid) {
      throw new UnauthorizedException('Please sign in again.');
    }
    const rows = await manager.query<Array<{ live: boolean; session_exists: boolean; session_revoked: boolean; idle_expired: boolean }>>(
      `WITH live AS (
         SELECT 1 FROM core.refresh_token
          WHERE family_id = $1 AND user_id = $2 AND organisation_id = $3
            AND revoked_at IS NULL AND family_expires_at > now()
          LIMIT 1
       ),
       session_row AS (SELECT 1 FROM core.user_session WHERE id = $1 LIMIT 1),
       session_revoked AS (SELECT 1 FROM core.user_session WHERE id = $1 AND revoked_at IS NOT NULL LIMIT 1),
       session_idle_expired AS (
         SELECT 1 FROM core.user_session WHERE id = $1 AND idle_expires_at IS NOT NULL AND idle_expires_at <= now() LIMIT 1
       )
       SELECT
         EXISTS (SELECT 1 FROM live) AS live,
         EXISTS (SELECT 1 FROM session_row) AS session_exists,
         EXISTS (SELECT 1 FROM session_revoked) AS session_revoked,
         EXISTS (SELECT 1 FROM session_idle_expired) AS idle_expired`,
      [params.sid, params.userId, params.organisationId],
    );
    const row = rows[0];
    const cutover = this.environment.get('USER_SESSION_ENFORCEMENT_CUTOVER');
    const denied = !row?.live || row.session_revoked || row.idle_expired || (cutover && !row.session_exists);
    if (denied) {
      throw new UnauthorizedException('Please sign in again.');
    }
  }
}
