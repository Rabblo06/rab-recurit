import { Injectable, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

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
@Injectable()
export class SessionValidityService {
  async assertActive(manager: EntityManager, params: { userId: string; organisationId: string | null; sid: string }): Promise<void> {
    if (!params.sid) {
      throw new UnauthorizedException('Please sign in again.');
    }
    const rows = await manager.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM core.refresh_token
          WHERE family_id = $1
            AND user_id = $2
            AND organisation_id = $3
            AND revoked_at IS NULL
            AND family_expires_at > now()
       ) AS exists`,
      [params.sid, params.userId, params.organisationId],
    );
    if (!rows[0]?.exists) {
      throw new UnauthorizedException('Please sign in again.');
    }
  }
}
