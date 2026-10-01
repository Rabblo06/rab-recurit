import { ApplicationTarget } from '../../application-access';
import { absoluteSessionTtlMsFor } from '../../session-policy';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueRefreshTokenParams {
  applicationTarget?: ApplicationTarget;
  organisationId: string;
  userId: string;
  familyId?: string;
  deviceId?: string;
  userAgent?: string;
  ip?: string;
  /** Omit only when this is a genuinely new family (first login) — every rotation must pass the existing row's own value through unchanged. */
  familyExpiresAt?: Date;
  /** Required alongside `applicationTarget` for a genuinely new family — `absoluteSessionTtlMsFor` needs both to resolve the session's SECURITY CLASS independently of which target was merely ALLOWED. Unused (and safely omittable) on a rotation, which always inherits `familyExpiresAt` unchanged. */
  roles?: readonly string[];
}

export interface IssuedRefreshToken {
  id: string;
  token: string;
  familyId: string;
  expiresAt: Date;
  familyExpiresAt: Date;
}

/**
 * Opaque, hashed at rest — the raw token is returned to the caller once and
 * never stored. `familyId` links every token minted from one login through
 * every rotation; presenting an already-rotated-away token revokes the
 * whole family (rab-workforce-architecture.md §5.1).
 */
@Injectable()
export class RefreshTokenService {
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
    // New family (first login): starts the per-application-target absolute
    // clock now (Phase 10 — 24h manager_web, 90d staff_app/venue_manager_app;
    // see session-policy.ts, the one place these durations are defined).
    // Rotation: the caller passes the EXISTING row's familyExpiresAt
    // through unchanged — this is what makes the ceiling absolute rather
    // than sliding. Every issued row's own expiresAt is then clamped to
    // whichever is sooner, so a row can never outlive its family.
    if (!params.familyExpiresAt && (!params.applicationTarget || !params.roles)) {
      // Fail closed (Phase 10 §2): a new family with no known application
      // target AND roles has no defined session policy — never fall back to
      // a default (which could silently resolve to the most permissive one).
      throw new UnauthorizedException('Please sign in again.');
    }
    const familyExpiresAt = params.familyExpiresAt ?? new Date(Date.now() + absoluteSessionTtlMsFor(params.roles!, params.applicationTarget!));
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

    return { id: result.identifiers[0]!.id as string, token, familyId, expiresAt, familyExpiresAt };
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

  async revokeFamily(manager: EntityManager, familyId: string): Promise<void> {
    await manager.update(RefreshToken, { familyId }, { revokedAt: new Date() });
  }

  /**
   * Every active session for a user, across every device/family — used
   * when a password changes (self-service or admin-triggered): the old
   * password shouldn't keep a session alive anywhere once it's no longer
   * valid.
   */
  async revokeAllForUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.update(RefreshToken, { userId }, { revokedAt: new Date() });
  }

  /** Logout: revoke the presented token's whole family. Idempotent — an already-invalid token is a no-op, not an error. */
  async revokeByToken(manager: EntityManager, presentedToken: string): Promise<void> {
    const existing = await manager.findOne(RefreshToken, { where: { tokenHash: this.hash(presentedToken) } });
    if (existing) {
      await this.revokeFamily(manager, existing.familyId);
    }
  }
}
