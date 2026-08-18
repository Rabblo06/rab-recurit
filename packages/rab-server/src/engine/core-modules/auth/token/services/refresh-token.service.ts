import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueRefreshTokenParams {
  organisationId: string;
  userId: string;
  familyId?: string;
  deviceId?: string;
  userAgent?: string;
  ip?: string;
}

export interface IssuedRefreshToken {
  id: string;
  token: string;
  familyId: string;
  expiresAt: Date;
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

  async issue(manager: EntityManager, params: IssueRefreshTokenParams): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString('hex');
    const familyId = params.familyId ?? randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    const result = await manager.insert(RefreshToken, {
      organisationId: params.organisationId,
      userId: params.userId,
      tokenHash: this.hash(token),
      familyId,
      deviceId: params.deviceId,
      userAgent: params.userAgent,
      ip: params.ip,
      expiresAt,
    });

    return { id: result.identifiers[0]!.id as string, token, familyId, expiresAt };
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
  ): Promise<{ issued: IssuedRefreshToken; userId: string; organisationId: string }> {
    const tokenHash = this.hash(presentedToken);
    const existing = await manager.findOne(RefreshToken, { where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt || existing.replacedBy) {
      await manager.update(RefreshToken, { familyId: existing.familyId }, { revokedAt: new Date() });
      throw new RefreshTokenReuseError(existing.familyId);
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const issued = await this.issue(manager, {
      organisationId: existing.organisationId,
      userId: existing.userId,
      familyId: existing.familyId,
      deviceId: context.deviceId ?? existing.deviceId,
      userAgent: context.userAgent ?? existing.userAgent,
      ip: context.ip,
    });

    await manager.update(RefreshToken, existing.id, {
      revokedAt: new Date(),
      replacedBy: issued.id,
    });

    return { issued, userId: existing.userId, organisationId: existing.organisationId };
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
