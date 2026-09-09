import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { EmailOutboxStatus, EmailOutboxStatusType, UserStatus, UserStatusType } from '@rab/shared';
import { AccountInvite, EmailOutbox } from '../../../../modules/identity/entities';

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
export type InvitationLifecycleStatus = 'pending' | 'cancelled' | 'expired' | 'queued' | 'sending' | 'delivery_failed';

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
   * Latest invite row PLUS its linked outbox job's current status — the
   * queued/sending/delivery_failed UI states (A14) need to know not just
   * "does a live token exist" but "did the worker ever actually get it out
   * the door." One query, not two, to avoid a second round trip per profile
   * fetched.
   */
  async getLatestWithOutboxStatus(manager: EntityManager, userId: string): Promise<{ invite: AccountInvite | null; outboxStatus: EmailOutboxStatusType | null }> {
    const row = await manager
      .createQueryBuilder(AccountInvite, 'ai')
      .leftJoin(EmailOutbox, 'eo', 'eo.account_invite_id = ai.id')
      .where('ai.user_id = :userId', { userId })
      .orderBy('ai.created_at', 'DESC')
      .select(['ai', 'eo.status AS outbox_status'])
      .getRawAndEntities();
    const invite = row.entities[0] ?? null;
    const outboxStatus = (row.raw[0]?.outbox_status as EmailOutboxStatusType | undefined) ?? null;
    return { invite, outboxStatus };
  }

  /** Batched equivalent of `getLatestWithOutboxStatus` — avoids an N+1 across `list()`. */
  async getLatestManyWithOutboxStatus(
    manager: EntityManager,
    userIds: string[],
  ): Promise<Map<string, { invite: AccountInvite; outboxStatus: EmailOutboxStatusType | null }>> {
    if (userIds.length === 0) return new Map();
    const rows = await manager
      .createQueryBuilder(AccountInvite, 'ai')
      .leftJoin(EmailOutbox, 'eo', 'eo.account_invite_id = ai.id')
      .where('ai.user_id IN (:...userIds)', { userIds })
      .orderBy('ai.user_id', 'ASC')
      .addOrderBy('ai.created_at', 'DESC')
      .select(['ai', 'eo.status AS outbox_status'])
      .getRawAndEntities();

    const result = new Map<string, { invite: AccountInvite; outboxStatus: EmailOutboxStatusType | null }>();
    rows.entities.forEach((invite, i) => {
      if (!result.has(invite.userId)) {
        result.set(invite.userId, { invite, outboxStatus: (rows.raw[i]?.outbox_status as EmailOutboxStatusType | undefined) ?? null });
      }
    });
    return result;
  }

  /**
   * Computes the next attempt's token/sendNumber/expiry WITHOUT writing
   * anything — no row inserted, nothing revoked yet.
   *
   * Under the durable-outbox architecture, `sendNumber` counts only
   * attempts whose linked `email_outbox` row actually reached SENT (a
   * worker-confirmed delivery) — never merely "queued" or "committed".
   * `commit()` now runs unconditionally and synchronously (the token must
   * exist durably before the worker is ever allowed to send it — see
   * `email-outbox.entity.ts`'s doc comment), so committing a row is no
   * longer the same signal "an attempt was consumed" it used to be when
   * `commit()` only ran after a synchronous send succeeded. A worker-side
   * infrastructure failure (ETIMEDOUT, a 5xx, etc.) leaves the row FAILED,
   * which this count skips — the next resend gets the same `sendNumber`
   * that attempt would have used, matching the pre-outbox behaviour exactly
   * from the user-visible side, even though internally a row now always
   * gets committed either way.
   */
  async prepare(manager: EntityManager, userId: string): Promise<{ token: string; tokenHash: string; sendNumber: number; expiresAt: Date; cleanupAt?: Date }> {
    const sentCount = await manager
      .createQueryBuilder(AccountInvite, 'ai')
      .innerJoin(EmailOutbox, 'eo', 'eo.account_invite_id = ai.id')
      .where('ai.user_id = :userId AND eo.status = :sent', { userId, sent: EmailOutboxStatus.SENT })
      .getCount();
    const sendNumber = sentCount + 1;
    if (sendNumber > MAX_SEND_ATTEMPTS) {
      throw new ConflictException('Maximum invitation attempts reached.');
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const cleanupAt = sendNumber === MAX_SEND_ATTEMPTS ? new Date(expiresAt.getTime() + GRACE_PERIOD_MS) : undefined;

    return { token, tokenHash: this.hash(token), sendNumber, expiresAt, cleanupAt };
  }

  /**
   * Revokes whatever was active (and cancels its outbox job, if any — a
   * superseded attempt must never still go out; see A9/A10), then persists
   * the prepared attempt. Runs unconditionally and synchronously now — the
   * token must be durable BEFORE it's handed to the worker, not after a
   * synchronous send succeeds (that gate moved to `sendNumber` counting
   * only SENT outcomes, see `prepare()`'s own doc comment). Returns the
   * inserted row so the caller can link the outbox row to it.
   */
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
  ): Promise<AccountInvite> {
    await manager
      .createQueryBuilder()
      .update(AccountInvite)
      .set({ revokedAt: () => 'now()' })
      .where('user_id = :userId AND accepted_at IS NULL AND revoked_at IS NULL', { userId: params.userId })
      .execute();

    // The row(s) just revoked above may still have a live outbox job
    // (PENDING/QUEUED/PROCESSING/RETRY) — a re-invite or cancel must not
    // leave a stale send in flight for a token that's no longer current.
    // The worker independently re-validates too (defense in depth), but
    // cancelling here means the common case never even reaches a network
    // call for a token nobody will ever be able to use again.
    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()' })
      .where(
        `account_invite_id IN (SELECT id FROM core.account_invite WHERE user_id = :userId) AND status IN (:...open)`,
        { userId: params.userId, open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.PROCESSING, EmailOutboxStatus.RETRY] },
      )
      .execute();

    const inserted = manager.create(AccountInvite, {
      organisationId: params.organisationId,
      userId: params.userId,
      tokenHash: params.tokenHash,
      sendNumber: params.sendNumber,
      expiresAt: params.expiresAt,
      cleanupAt: params.cleanupAt,
      createdBy: params.createdBy ?? undefined,
    });
    return manager.save(inserted);
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
   *
   * `outboxStatus` distinguishes "a token exists" from "did it actually go
   * out" (A14) — PENDING/QUEUED reads as `queued` (accepted, not yet
   * attempted), PROCESSING/RETRY as `sending` (an attempt is genuinely in
   * flight right now), FAILED as `delivery_failed` (every worker attempt
   * exhausted or hit a permanent error) — never silently shown as the same
   * "Pending Invite" a confirmed-delivered SENT row gets.
   */
  deriveInvitationStatus(userStatus: UserStatusType, invite: AccountInvite | null, outboxStatus?: EmailOutboxStatusType | null): InvitationLifecycleStatus | null {
    if (userStatus === UserStatus.INVITE_EXPIRED) return 'expired';
    if (userStatus !== UserStatus.INVITED || !invite || invite.acceptedAt) return null;
    if (invite.revokedAt) return 'cancelled';
    if (outboxStatus === EmailOutboxStatus.PENDING || outboxStatus === EmailOutboxStatus.QUEUED) return 'queued';
    if (outboxStatus === EmailOutboxStatus.PROCESSING || outboxStatus === EmailOutboxStatus.RETRY) return 'sending';
    if (outboxStatus === EmailOutboxStatus.FAILED) return 'delivery_failed';
    if (invite.expiresAt.getTime() < Date.now()) return 'expired';
    return 'pending';
  }

  /** Used by change-pending-email and cancel — every currently-active row (and its outbox job, if still in flight) for this user becomes unusable immediately. */
  async revokeActive(manager: EntityManager, userId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(AccountInvite)
      .set({ revokedAt: () => 'now()' })
      .where('user_id = :userId AND accepted_at IS NULL AND revoked_at IS NULL', { userId })
      .execute();

    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()' })
      .where(
        `account_invite_id IN (SELECT id FROM core.account_invite WHERE user_id = :userId) AND status IN (:...open)`,
        { userId, open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.PROCESSING, EmailOutboxStatus.RETRY] },
      )
      .execute();
  }
}
