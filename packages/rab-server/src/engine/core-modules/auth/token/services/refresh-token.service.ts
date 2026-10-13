import { ApplicationTarget } from '../../application-access';
import { absoluteSessionTtlMsFor, idleSessionTimeoutMsFor, isPrivilegedIdleClass } from '../../session-policy';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { WEB_SESSION_TOKEN_PREFIX } from '../../constants/web-session-cookie.constants';
import { RefreshToken, UserSession } from '../../../../../modules/identity/entities';
import { PlatformAdminService } from '../../../platform-admin/platform-admin.service';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueRefreshTokenParams {
  applicationTarget?: ApplicationTarget;
  organisationId: string;
  userId: string;
  familyId?: string;
  /** P1B — a session SNAPSHOT only (never authority); threaded through to `core.user_session.workspace_id` for a genuinely new family. Unused on rotation (no new session row is created then). */
  workspaceId?: string | null;
  deviceId?: string;
  userAgent?: string;
  ip?: string;
  /** Omit only when this is a genuinely new family (first login) — every rotation must pass the existing row's own value through unchanged. */
  familyExpiresAt?: Date;
  /** Required alongside `applicationTarget` for a genuinely new family — `absoluteSessionTtlMsFor` needs both to resolve the session's SECURITY CLASS independently of which target was merely ALLOWED. Unused (and safely omittable) on a rotation, which always inherits `familyExpiresAt` unchanged. */
  roles?: readonly string[];
  /**
   * P1C.1B — which credential authenticated this login: 'password' | 'google' | 'microsoft'.
   * Only meaningful (and only ever written) for a genuinely new family; a rotation never
   * supplies it (the column is immutable after creation — see
   * WebSessionCredentialAndAuthProvider1786680000000 — so passing a value on rotation would be a
   * silent no-op at best). Deliberately NOT optional-with-a-default: every call site that creates
   * a new session must say which provider authenticated it, rather than leaving the column NULL
   * by omission.
   */
  authProvider?: 'password' | 'google' | 'microsoft';
  /**
   * P0.3 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.2): passed through to
   * `absoluteSessionTtlMsFor` alongside `roles` for a genuinely new family. A
   * platform admin is always capped at the 24h policy regardless of target —
   * see that function's own doc comment. Unused on a rotation, same as `roles`.
   */
  isPlatformAdmin?: boolean;
}

export interface IssuedRefreshToken {
  id: string;
  token: string;
  familyId: string;
  expiresAt: Date;
  familyExpiresAt: Date;
  /**
   * P1C.1C — the RAW Twenty-style opaque web session credential, returned exactly once (never
   * stored) so the caller can set it as the `crewflow_session` HttpOnly cookie. Only ever present
   * for a genuinely NEW `manager_web` family (never on rotation — the column is immutable after
   * creation, WebSessionCredentialAndAuthProvider1786680000000 — and never for mobile targets,
   * which stay NULL by design). `undefined` for every other case; callers must not set a cookie
   * when this is absent.
   */
  webSessionToken?: string;
}

/**
 * Opaque, hashed at rest — the raw token is returned to the caller once and
 * never stored. `familyId` links every token minted from one login through
 * every rotation; presenting an already-rotated-away token revokes the
 * whole family (rab-workforce-architecture.md §5.1).
 */
@Injectable()
export class RefreshTokenService {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Exposed so `AuthService.refresh()` can resolve a presented token's owning org via `core.auth_find_refresh_token_org` before any tenant context exists — see PreAuthLookupFunctions1786667400000. */
  hashToken(token: string): string {
    return this.hash(token);
  }

  async issue(manager: EntityManager, params: IssueRefreshTokenParams): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString('hex');
    const familyId = params.familyId ?? randomUUID();
    // P1B: this is the ONE authoritative "is this a genuinely new session" signal this method
    // has — never `!params.familyId` (AuthService.login() always pre-generates and passes an
    // explicit familyId even for a brand-new session, so familyId presence alone can't tell new
    // from rotated). A rotation always passes the existing row's own `familyExpiresAt` through
    // unchanged; only a first login omits it. `core.user_session` is created exactly once, here,
    // only in the new-family branch — never regenerated, never duplicated on rotation.
    const isNewFamily = !params.familyExpiresAt;
    // New family (first login): starts the per-application-target absolute
    // clock now (Phase 10 — 24h manager_web, 90d staff_app/venue_manager_app;
    // see session-policy.ts, the one place these durations are defined).
    // Rotation: the caller passes the EXISTING row's familyExpiresAt
    // through unchanged — this is what makes the ceiling absolute rather
    // than sliding. Every issued row's own expiresAt is then clamped to
    // whichever is sooner, so a row can never outlive its family.
    if (isNewFamily && (!params.applicationTarget || !params.roles)) {
      // Fail closed (Phase 10 §2): a new family with no known application
      // target AND roles has no defined session policy — never fall back to
      // a default (which could silently resolve to the most permissive one).
      throw new UnauthorizedException('Please sign in again.');
    }
    const familyExpiresAt =
      params.familyExpiresAt ?? new Date(Date.now() + absoluteSessionTtlMsFor(params.roles!, params.applicationTarget!, params.isPlatformAdmin));
    const expiresAt = new Date(Math.min(Date.now() + REFRESH_TOKEN_TTL_MS, familyExpiresAt.getTime()));

    const result = await manager.insert(RefreshToken, {
      organisationId: params.organisationId,
      userId: params.userId,
      tokenHash: this.hash(token),
      applicationTarget: params.applicationTarget,
      familyId,
      deviceId: params.deviceId,
      userAgent: params.userAgent,
      ip: params.ip,
      expiresAt,
      familyExpiresAt,
    });

    // P1C.1C: the opaque web session cookie credential — issued ONLY for a genuinely new
    // manager_web family. Never for a rotation (the column is immutable after creation) and never
    // for staff_app/venue_manager_app (mobile keeps its existing Bearer-JWT-only model unchanged;
    // their `core.user_session` rows stay NULL here, by construction, matching the exit gate's
    // own "mobile sessions have NULL web hash" requirement).
    const issueWebSessionCredential = isNewFamily && params.applicationTarget === 'manager_web';
    const webSessionToken = issueWebSessionCredential ? `${WEB_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` : undefined;
    const webSessionTokenHash = webSessionToken ? createHash('sha256').update(webSessionToken).digest('hex') : null;

    if (isNewFamily) {
      // id = familyId = the JWT sid this family's access tokens carry — see UserSession's own
      // doc comment for the full canonical-identity chain. `ON CONFLICT DO NOTHING` is pure
      // defense-in-depth (a UUID collision on a cryptographically random v4 id is not a
      // realistic concern); this INSERT is reached exactly once per family by construction.
      // The web credential hash is written in this SAME INSERT, the SAME transaction as the
      // RefreshToken row above — never a separate write, so a session can never exist with one
      // but not the other (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9's own "never issue a browser
      // credential for a session that failed to persist" requirement, satisfied by construction:
      // if this INSERT doesn't commit, the caller never receives `webSessionToken` either, since
      // the whole call is already inside `completeLogin`'s own `runInTenantContext` transaction).
      // idle_expires_at: P2.2 — see session-policy.ts's idleSessionTimeoutMsFor doc comment. This
      // initial value is only the starting point; SessionValidityService re-evaluates the
      // privileged override (platform-admin/manager-tier -> always the strict manager_web policy,
      // regardless of target) from CURRENT role data on every later bump, not this snapshot — so a
      // role granted or revoked after login still takes effect on idle policy immediately, unlike
      // the absolute deadline below, which genuinely is frozen at creation by design. Clamped to
      // familyExpiresAt the same way expiresAt is above: an idle allowance must never let a
      // session outlive its own absolute ceiling.
      const idleExpiresAt = new Date(
        Math.min(Date.now() + idleSessionTimeoutMsFor(params.applicationTarget!, isPrivilegedIdleClass(params.roles ?? [], params.isPlatformAdmin)), familyExpiresAt.getTime()),
      );
      await manager.query(
        `INSERT INTO core.user_session
           (id, organisation_id, user_id, workspace_id, application_target, device_id, user_agent, ip_address, created_at, last_seen_at, absolute_expires_at, idle_expires_at, auth_provider, web_session_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, now(), now(), $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [familyId, params.organisationId, params.userId, params.workspaceId ?? null, params.applicationTarget, params.deviceId ?? null, params.userAgent ?? null, params.ip ?? null, familyExpiresAt, idleExpiresAt, params.authProvider ?? null, webSessionTokenHash],
      );
    }

    return { id: result.identifiers[0]!.id as string, token, familyId, expiresAt, familyExpiresAt, webSessionToken };
  }

  /**
   * Validates the presented token and mints its replacement in one step.
   * Throws `RefreshTokenReuseError` (family already revoked by the time it
   * returns — the caller only needs to audit it) if the token had already
   * been rotated away or explicitly revoked, and `UnauthorizedException`
   * for unknown or expired tokens.
   *
   * PHASE 10 / AUTH-01 FIX: the confirmed race was `read -> validate ->
   * insert successor -> update old row` with no serialization between two
   * concurrent callers presenting the SAME token — both could read it as
   * still valid before either wrote anything, each minting its own
   * successor. The fix is `SELECT ... FOR UPDATE` (`lock: 'pessimistic_write'`
   * below): a second transaction's lock acquisition on the SAME row BLOCKS
   * until the first transaction commits, then — this is the load-bearing
   * Postgres guarantee, not an assumption — re-reads the row's LATEST
   * committed state rather than whatever it looked like before the wait.
   * The loser therefore always observes `revokedAt`/`replacedBy` already set
   * by the winner and falls into the reuse-detected branch, never mints a
   * second successor. A CAS on the revoke write itself (`WHERE revoked_at
   * IS NULL AND replaced_by IS NULL`) is layered on top as a belt-and-braces
   * check — unreachable-as-a-no-op under correct locking, but turns any
   * future regression in that locking into a loud, typed failure instead of
   * a silent double-mint.
   *
   * PostgreSQL is the authoritative concurrency boundary here — no
   * in-process mutex or Redis lock would be safe across multiple API
   * instances, which is exactly the topology this runs under.
   */
  async rotate(
    manager: EntityManager,
    presentedToken: string,
    context: { deviceId?: string; userAgent?: string; ip?: string },
  ): Promise<{ issued: IssuedRefreshToken; userId: string; organisationId: string; applicationTarget?: ApplicationTarget }> {
    const tokenHash = this.hash(presentedToken);
    const existing = await manager.findOne(RefreshToken, { where: { tokenHash }, lock: { mode: 'pessimistic_write' } });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt || existing.replacedBy) {
      // Revocation deliberately does NOT happen here — see
      // RefreshTokenReuseError's doc comment for why persisting it requires
      // a transaction this error is guaranteed to unwind.
      throw new RefreshTokenReuseError(existing.familyId);
    }

    // P2/P3 overnight mandate fix — a REAL, confirmed bypass, not a hypothetical: nothing in this
    // method (or anywhere else in the refresh path) previously checked `core.user_session` at all.
    // `SessionValidityService.assertActive()` only runs when an ACCESS token is used — so an
    // idle-expired session (idle_expires_at passed, but the refresh_token row itself is neither
    // revoked nor past its own expiresAt) could refresh indefinitely, minting a fresh 15-minute
    // access token forever, as long as the client called /refresh before each one expired — which
    // a normal client does automatically, far more often than genuine idle-triggering inactivity.
    // That silently defeated the entire feature for exactly the client behaviour idle timeout
    // exists to bound. Checked here, inside the SAME pessimistic-write-locked row's family, so a
    // concurrent revocation/idle-expiry can't race past this read. revoked_at is checked too,
    // defense-in-depth alongside refresh_token's own revocation check above (today's only
    // revocation path always revokes both tables together, but this does not depend on that).
    const [session] = await manager.query<Array<{ revoked_at: string | null; idle_expired: boolean }>>(
      `SELECT revoked_at, (idle_expires_at IS NOT NULL AND idle_expires_at <= now()) AS idle_expired FROM core.user_session WHERE id = $1`,
      [existing.familyId],
    );
    if (session && (session.revoked_at || session.idle_expired)) {
      throw new UnauthorizedException('Please sign in again.');
    }

    // P2.8 — same organisation-suspension gate `AuthService.completeLogin()` applies at fresh
    // login, now enforced here too: a session minted BEFORE suspension must not be able to mint
    // itself an indefinite stream of fresh access tokens via refresh. Platform admin exempt, same
    // reasoning as login's own check.
    if (!(await this.platformAdmin.isPlatformAdmin({ userId: existing.userId }))) {
      const [org] = await manager.query<Array<{ suspended_at: string | null }>>(
        `SELECT suspended_at FROM core.organisation WHERE id = $1`,
        [existing.organisationId],
      );
      if (org?.suspended_at) {
        throw new UnauthorizedException('This organisation has been suspended. Contact your administrator.');
      }
    }

    // This one check enforces BOTH the per-token TTL and the absolute
    // session ceiling: issue() always clamps expiresAt to
    // min(now+30d, familyExpiresAt), so once the family's absolute deadline
    // has passed, the most-recently-issued row's own expiresAt already
    // equals that deadline and trips this exact same check — no separate
    // familyExpiresAt comparison needed here.
    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const issued = await this.issue(manager, {
      organisationId: existing.organisationId,
      userId: existing.userId,
      familyId: existing.familyId,
      applicationTarget: existing.applicationTarget,
      deviceId: context.deviceId ?? existing.deviceId,
      userAgent: context.userAgent ?? existing.userAgent,
      ip: context.ip,
      // Inherited, never recomputed — this is what keeps the ceiling
      // absolute instead of sliding back out on every rotation.
      familyExpiresAt: existing.familyExpiresAt,
    });

    const claim = await manager
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: () => 'now()', replacedBy: issued.id })
      .where('id = :id AND revoked_at IS NULL AND replaced_by IS NULL', { id: existing.id })
      .execute();
    if (!claim.affected) {
      // Unreachable under the row lock above in normal operation — fail
      // safe (never silently leave two live successors) if it ever isn't.
      throw new RefreshTokenReuseError(existing.familyId);
    }

    return { issued, userId: existing.userId, organisationId: existing.organisationId, applicationTarget: existing.applicationTarget };
  }

  /**
   * P1B: revokes the refresh-token family AND its stable `core.user_session` aggregate
   * together, in the same transaction — the one place either is revoked, so the two can never
   * observably disagree ("UserSession active, RefreshToken revoked" or vice versa, both
   * forbidden by the P1B brief). `WHERE revoked_at IS NULL` on the session update is a CAS: the
   * FIRST revocation's reason/timestamp wins and is never overwritten by a later, redundant
   * revoke call (e.g. logout racing reuse-detection).
   */
  async revokeFamily(manager: EntityManager, familyId: string, reason = 'unspecified'): Promise<void> {
    await manager.update(RefreshToken, { familyId }, { revokedAt: new Date() });
    await manager.query(
      `UPDATE core.user_session
          SET revoked_at = now(), revoked_reason = $2, security_version = security_version + 1
        WHERE id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
  }

  /**
   * Every active session for a user, across every device/family — used
   * when a password changes (self-service or admin-triggered): the old
   * password shouldn't keep a session alive anywhere once it's no longer
   * valid. P1B: the matching `core.user_session` rows are revoked in the same transaction,
   * same CAS-on-revoked_at-IS-NULL idiom as `revokeFamily`.
   */
  async revokeAllForUser(manager: EntityManager, userId: string, reason = 'unspecified'): Promise<void> {
    await manager.update(RefreshToken, { userId }, { revokedAt: new Date() });
    await manager.query(
      `UPDATE core.user_session
          SET revoked_at = now(), revoked_reason = $2, security_version = security_version + 1
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  }

  /**
   * P2.8 — every active session for every user in an organisation, in one go. The ONE place
   * "invalidate existing CEO, Manager, Staff and Venue Manager sessions" (owner's requirement 3)
   * actually revokes rather than merely blocks: `OrganisationSuspendedGuard`/the login/refresh
   * checks elsewhere in this file already stop a session from being USED while `suspended_at` is
   * set, but revocation here is what makes requirement 8 ("reactivation must restore account
   * eligibility without restoring revoked sessions") true — without this, a refresh token issued
   * before suspension would silently start working again the moment `suspended_at` is cleared,
   * since nothing else ever marked it `revoked_at`. `revoked_at` is permanent; reactivation never
   * clears it, only the suspension check that blocked it in the meantime.
   */
  async revokeAllForOrganisation(manager: EntityManager, organisationId: string, reason = 'organisation_suspended'): Promise<void> {
    await manager.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE organisation_id = $1 AND revoked_at IS NULL`, [organisationId]);
    await manager.query(
      `UPDATE core.user_session
          SET revoked_at = now(), revoked_reason = $2, security_version = security_version + 1
        WHERE organisation_id = $1 AND revoked_at IS NULL`,
      [organisationId, reason],
    );
  }

  /**
   * P2.2 — self-service "log out of all other devices," without ending the caller's own current
   * session. Same CAS-on-revoked_at-IS-NULL idiom as `revokeAllForUser`/`revokeFamily`, just with
   * one family excluded. Deliberately a separate, narrow method rather than an optional parameter
   * on `revokeAllForUser` — that method's every existing caller (password change/reset, account
   * suspension, account deletion) is an admin/system-driven path that WANTS every session gone,
   * including whichever one the actor is using to trigger it; conflating the two would risk a
   * future caller passing the wrong exclusion by mistake in a security-sensitive path.
   */
  async revokeAllForUserExcept(manager: EntityManager, userId: string, exceptFamilyId: string, reason = 'revoked_by_user'): Promise<void> {
    await manager.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE user_id = $1 AND family_id != $2`, [userId, exceptFamilyId]);
    await manager.query(
      `UPDATE core.user_session
          SET revoked_at = now(), revoked_reason = $3, security_version = security_version + 1
        WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL`,
      [userId, exceptFamilyId, reason],
    );
  }

  /**
   * Logout: revoke the presented token's whole family. Idempotent — an already-invalid token is
   * a no-op, not an error.
   *
   * P0.2 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.2): `callerUserId` is the Bearer-authenticated
   * caller's own `ctx.userId` (`JwtAuthGuard` already verified this is a real, live identity
   * before the controller ever runs). The presented token's resolved `userId` MUST match it —
   * without this check, any authenticated user who obtained (by any means) a DIFFERENT user's
   * raw refresh token could revoke that other user's entire session family by presenting it to
   * their OWN authenticated logout call. `refresh_token`'s RLS is organisation-scoped, not
   * user-scoped, so RLS alone does not close this; the ownership check must happen here, in the
   * one place that actually knows both identities. Returns 'revoked' | 'mismatch' | 'not-found' so
   * the caller can audit a mismatch as a security event rather than a normal logout — a mismatch
   * is itself a signal, not merely a failed no-op.
   */
  async revokeByToken(manager: EntityManager, presentedToken: string, callerUserId: string, reason = 'logout'): Promise<'revoked' | 'mismatch' | 'not-found'> {
    const existing = await manager.findOne(RefreshToken, { where: { tokenHash: this.hash(presentedToken) } });
    if (!existing) return 'not-found';
    if (existing.userId !== callerUserId) return 'mismatch';
    await this.revokeFamily(manager, existing.familyId, reason);
    return 'revoked';
  }
}
