import { ApplicationTarget } from '../../application-access';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Absolute ceiling on a session, regardless of how often it's used/rotated
 * — the actual fix for the "session never expires" bug. Set once at first
 * login (`familyExpiresAt` param below is undefined), then copied forward
 * unchanged on every subsequent rotation, never recomputed from `now()`.
 */
export const ABSOLUTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
    // New family (first login): starts the 24h absolute clock now.
    // Rotation: the caller passes the EXISTING row's familyExpiresAt
    // through unchanged — this is what makes the ceiling absolute rather
    // than sliding. Every issued row's own expiresAt is then clamped to
    // whichever is sooner, so a row can never outlive its family.
    const familyExpiresAt = params.familyExpiresAt ?? new Date(Date.now() + ABSOLUTE_SESSION_TTL_MS);
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
   */
  async rotate(
    manager: EntityManager,
    presentedToken: string,
    context: { deviceId?: string; userAgent?: string; ip?: string },
  ): Promise<{ issued: IssuedRefreshToken; userId: string; organisationId: string; applicationTarget?: ApplicationTarget }> {
    const tokenHash = this.hash(presentedToken);
    const existing = await manager.findOne(RefreshToken, { where: { tokenHash } });

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
    // min(now+30d, familyExpiresAt), so once the family's 24h deadline has
    // passed, the most-recently-issued row's own expiresAt already equals
    // that deadline and trips this exact same check — no separate
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

    await manager.update(RefreshToken, existing.id, {
      revokedAt: new Date(),
      replacedBy: issued.id,
    });

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
