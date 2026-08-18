import { PasswordResetTokenPurposeType } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { PasswordResetToken } from '../../../../../modules/identity/entities';

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48h — matches the offer-expiry convention elsewhere in this app

export interface IssuedPasswordResetToken {
  token: string;
  expiresAt: Date;
}

/**
 * Opaque, hashed at rest — same convention as `RefreshTokenService`
 * (SHA-256 of the raw token; the raw token is returned once to the caller,
 * who is responsible for putting it in an email link, and is never stored
 * itself). Backs the initial-setup, forgot-password, and admin-reset flows
 * off one mechanism — `purpose` is audit metadata, not a different
 * validation path.
 */
@Injectable()
export class PasswordResetTokenService {
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(
    manager: EntityManager,
    params: { organisationId: string; userId: string; purpose: PasswordResetTokenPurposeType; ttlMs?: number },
  ): Promise<IssuedPasswordResetToken> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS));

    await manager.insert(PasswordResetToken, {
      organisationId: params.organisationId,
      userId: params.userId,
      tokenHash: this.hash(token),
      purpose: params.purpose,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /**
   * Looks the token up by hash and marks it used atomically (an UPDATE ...
   * WHERE used_at IS NULL, so a concurrent double-consume can't both
   * succeed) — returns null for an unknown, expired, or already-used
   * token rather than distinguishing which, so callers can't use response
   * differences to probe token validity.
   */
  async consume(manager: EntityManager, presentedToken: string): Promise<PasswordResetToken | null> {
    const tokenHash = this.hash(presentedToken);
    const existing = await manager.findOne(PasswordResetToken, { where: { tokenHash } });
    if (!existing) return null;
    if (existing.usedAt) return null;
    if (existing.expiresAt.getTime() < Date.now()) return null;

    const result = await manager
      .createQueryBuilder()
      .update(PasswordResetToken)
      .set({ usedAt: new Date() })
      .where('id = :id AND used_at IS NULL', { id: existing.id })
      .execute();
    if (!result.affected) return null;

    return existing;
  }
}
