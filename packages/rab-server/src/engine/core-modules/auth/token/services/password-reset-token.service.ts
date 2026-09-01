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

  /** Exposed so `AuthService.resetPassword()` can resolve a presented token's owning org via `core.auth_find_password_reset_token_org` before any tenant context exists — see PreAuthLookupFunctions1786667400000. */
  hashToken(token: string): string {
    return this.hash(token);
  }

  /**
   * Invalidates every unused token this user already holds (any purpose —
   * a stale initial-setup or forgot-password link is just as much a live
   * credential as the one being issued now) before inserting the new one,
   * so only ever one reset token is valid for a given user at a time. Runs
   * on the same `manager` the insert below uses, so it's atomic with it
   * under whatever transaction the caller (always `runInTenantContext`)
   * already opened — no separate transaction needed here.
   */
  async issue(
    manager: EntityManager,
    params: { organisationId: string; userId: string; purpose: PasswordResetTokenPurposeType; ttlMs?: number },
  ): Promise<IssuedPasswordResetToken> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS));

    await manager
      .createQueryBuilder()
      .update(PasswordResetToken)
      .set({ usedAt: () => 'now()' })
      .where('user_id = :userId AND used_at IS NULL', { userId: params.userId })
      .execute();

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
