import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { UserStatus, UserStatusType } from '@rab/shared';
import { AccountInvite } from '../../../../modules/identity/entities';

const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — the spec's own default invite validity
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days after the final (3rd) attempt expires
const MAX_SEND_ATTEMPTS = 3; // initial send = 1, first resend = 2, second (final) resend = 3

/**
 * The invitation's own lifecycle — deliberately separate from `User.status`
 * (account state) and password state. A cancelled or expired invitation must
 * never be represented as SUSPENDED/DEACTIVATED; it's a property of the
 * latest `AccountInvite` row (plus the terminal `INVITE_EXPIRED` User.status
 * the cleanup job sets for a maxed-out 3rd attempt), read here, not stored
 * anywhere new.
 */
export type InvitationLifecycleStatus = 'pending' | 'cancelled' | 'expired';

/**
 * Backs the invitation-based account-activation flow. Distinct from
 * `PasswordResetTokenService` — this one additionally tracks a per-user
 * cumulative attempt count (max 3, ever, across the account's whole
 * pending lifetime) and a cleanup deadline, neither of which
 * `PasswordResetToken`'s shape has room for.
 *
 * `prepare()`+`commit()` together are both "send the initial invite"
 * (called once, from `ManagerService`/`StaffService.create()`) and "resend"
 * (called again by an admin action) — there is no separate resend method;
 * both are "create the next attempt, revoking whatever was active before,"
 * split into a no-write computation and a commit so
 * `AccountLifecycleService.sendAccountInvite` can gate the commit on the
 * email actually having been accepted by the provider (see its own doc
 * comment for why). The 3-attempt cap lives in `prepare()`, once, so every
 * caller gets it for free rather than re-checking it themselves.
 *
 * No admin-recovery path back from a maxed-out/expired invite is built —
 * the spec calls this optional and, if built at all, requires its own
 * explicit, audited action distinct from the normal resend path. Flagged as
 * not built, not silently assumed.
 */
@Injectable()
export class AccountInviteService {
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Exposed so `AuthService.activateAccount()` can resolve a presented token's owning org via `core.auth_find_account_invite_org` before any tenant context exists — see AccountInviteSchema1786670100000. */
  hashToken(token: string): string {
    return this.hash(token);
  }

  /** The most recent invite row ever issued to this user (any state) — used to compute the next `sendNumber` and to answer "attempt N of 3" for the UI. */
  async getLatest(manager: EntityManager, userId: string): Promise<AccountInvite | null> {
    return manager.findOne(AccountInvite, { where: { userId }, order: { createdAt: 'DESC' } });
  }

  /**
   * Computes the next attempt's token/sendNumber/expiry WITHOUT writing
   * anything — no row inserted, nothing revoked yet. Split from `commit()`
   * below so `AccountLifecycleService.sendAccountInvite` can attempt the
   * actual email send in between the two: an attempt is only ever consumed
   * (the old token revoked, the new one persisted) once the send is known
   * to have succeeded. A delivery failure — a flaky provider, an outage —
   * must never silently burn one of the 3 attempts, since the recipient
   * never received anything usable; `commit()` simply isn't called, the
   * previously-active token (if any) stays exactly as valid as it was
   * before this attempt was tried, and the next resend still gets the same
   * `sendNumber` this one would have used.
   */
  async prepare(manager: EntityManager, userId: string): Promise<{ token: string; tokenHash: string; sendNumber: number; expiresAt: Date; cleanupAt?: Date }> {
    const latest = await this.getLatest(manager, userId);
    const sendNumber = (latest?.sendNumber ?? 0) + 1;
    if (sendNumber > MAX_SEND_ATTEMPTS) {
      throw new ConflictException('Maximum invitation attempts reached.');
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const cleanupAt = sendNumber === MAX_SEND_ATTEMPTS ? new Date(expiresAt.getTime() + GRACE_PERIOD_MS) : undefined;

    return { token, tokenHash: this.hash(token), sendNumber, expiresAt, cleanupAt };
  }

  /** Revokes whatever was active, then persists the prepared attempt — called only after `prepare()`'s email has actually been accepted by the configured provider. */
  async commit(
    manager: EntityManager,
    params: {
      organisationId: string;
      userId: string;
      createdBy: string | null;
      tokenHash: string;
      sendNumber: number;
      expiresAt: Date;
      cleanupAt?: Date;
    },
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(AccountInvite)
      .set({ revokedAt: () => 'now()' })
      .where('user_id = :userId AND accepted_at IS NULL AND revoked_at IS NULL', { userId: params.userId })
      .execute();

    await manager.insert(AccountInvite, {
      organisationId: params.organisationId,
      userId: params.userId,
      tokenHash: params.tokenHash,
      sendNumber: params.sendNumber,
      expiresAt: params.expiresAt,
      cleanupAt: params.cleanupAt,
      createdBy: params.createdBy ?? undefined,
    });
  }

  /**
   * Atomic hash-lookup + single-use consume, same discipline as
   * `PasswordResetTokenService.consume` — an `UPDATE ... WHERE accepted_at
   * IS NULL` guard makes a concurrent double-activation race-safe (only one
   * caller's UPDATE affects a row); returns null uniformly for an unknown,
   * revoked, expired, or already-accepted token, never distinguishing which.
   */
  async consume(manager: EntityManager, presentedToken: string): Promise<AccountInvite | null> {
    const tokenHash = this.hash(presentedToken);
    const existing = await manager.findOne(AccountInvite, { where: { tokenHash } });
    if (!existing) return null;
    if (existing.acceptedAt || existing.revokedAt) return null;
    if (existing.expiresAt.getTime() < Date.now()) return null;

    const result = await manager
      .createQueryBuilder()
      .update(AccountInvite)
      .set({ acceptedAt: new Date() })
      .where('id = :id AND accepted_at IS NULL AND revoked_at IS NULL', { id: existing.id })
      .execute();
    if (!result.affected) return null;

    return existing;
  }

  /**
   * Single source of truth for "what state is this account's invitation
   * in," used by both `ManagerService`/`StaffService.toSummary()` so the
   * console never has to re-derive it (and never infers it from `User.status`
   * alone — see the CANCELLED/DEACTIVATED conflation bug this replaced).
   * Returns null once accepted, or when the account isn't in the
   * invited/invite_expired family at all (e.g. ACTIVE, SUSPENDED).
   */
  deriveInvitationStatus(userStatus: UserStatusType, invite: AccountInvite | null): InvitationLifecycleStatus | null {
    if (userStatus === UserStatus.INVITE_EXPIRED) return 'expired';
    if (userStatus !== UserStatus.INVITED || !invite || invite.acceptedAt) return null;
    if (invite.revokedAt) return 'cancelled';
    if (invite.expiresAt.getTime() < Date.now()) return 'expired';
    return 'pending';
  }

  /** Used by change-pending-email and cancel — every currently-active row for this user becomes unusable immediately. */
  async revokeActive(manager: EntityManager, userId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(AccountInvite)
      .set({ revokedAt: () => 'now()' })
      .where('user_id = :userId AND accepted_at IS NULL AND revoked_at IS NULL', { userId })
      .execute();
  }
}
