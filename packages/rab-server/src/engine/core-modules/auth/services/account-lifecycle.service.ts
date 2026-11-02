import { EmailOutboxJobType, PasswordResetTokenPurpose } from '@rab/shared';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailOutboxService } from '../../email/email-outbox.service';
import { EmailQueueService } from '../../email/email-queue.service';
import { renderAccountActivationEmail, renderAccountSuspendedEmail, renderPasswordResetEmail } from '../../email/templates';
import { AuthContext } from '../../tenant/auth-context.interface';
import { AccountInviteService } from './account-invite.service';
import { PasswordResetTokenService } from '../token/services/password-reset-token.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { SecurityVersionService } from './security-version.service';

/**
 * Shared by every place a Staff/Internal Manager/Venue Manager account gets
 * created or has its password reset by an admin (`staff.service.ts`,
 * `manager.service.ts`) — one implementation of "issue a setup/reset
 * token, force a password change, notify the user, audit it" rather than
 * three near-identical copies.
 *
 * Every email this service triggers now goes through the durable outbox
 * (`EmailOutboxService.enqueue`, written inside the SAME transaction as the
 * token/business state it accompanies) rather than an inline `await
 * emailService.send()` — see `email-outbox.entity.ts`'s doc comment for why.
 * The actual SMTP/Resend/Logger send happens later, in the worker process
 * (`email-send.processor.ts`), never inside this request.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly accountInviteService: AccountInviteService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
    private readonly securityVersion: SecurityVersionService,
  ) {}

  /**
   * Whether a Staff/Manager account invite may be QUEUED at creation — called by StaffService/ManagerService.create()
   * before deciding whether to call sendAccountInvite() at all.
   *
   * Owner decision (Phase D-Q plan §12.1, decision 3, 2026-11-02): "always queue". The invite is written to the durable
   * outbox in the creating transaction whenever email delivery is CONFIGURED on, regardless of whether a Worker is
   * running right now; if the Worker is down, stalled, or Redis lost its heartbeat key, the row waits in PostgreSQL and
   * is delivered when the Worker returns (the dispatcher re-publishes it). Before this decision the queue choice also
   * read the Worker heartbeat key from Redis and silently skipped the invite (`emailQueued:false`, manual "Resend")
   * whenever that key was missing or stale — so a Redis wipe decided whether a durable row was written.
   *
   * What still stops a queued invite from going out late with a dead or unwanted link is the Worker's pre-delivery
   * revalidation (email-send.processor.ts `revalidate`): a revoked, accepted, superseded (resent) or EXPIRED invite is
   * cancelled, never sent; a deleted target user is cancelled too.
   *
   * ASSUMPTION (flagged for the owner, unchanged behaviour): `EMAIL_DELIVERY_ENABLED=false` still means "do not queue
   * an invite" — that is operator configuration (a deliberate kill switch), not Worker health. Purely synchronous and
   * Redis-free: it can neither fail nor slow the caller's request.
   */
  isEmailDeliveryEnabled(): boolean {
    return this.env.get('EMAIL_DELIVERY_ENABLED') === true;
  }

  /** Publishes to BullMQ right after the caller's transaction commits — see `EmailOutboxService.tryFastPublish`'s own doc comment for why this is best-effort only. */
  private schedulePublish(row: { id: string; organisationId: string }): void {
    void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
  }

  /**
   * The invitation-based activation flow's send/resend. Called once at
   * `ManagerService`/`StaffService.create()` (attempt 1) and again from
   * each service's `resendInvite()` (attempts 2 and 3) — "send" and
   * "resend" are the same operation from `AccountInviteService`'s point of
   * view.
   *
   * `prepare()` computes the token/sendNumber; `commit()` now runs
   * unconditionally (the token must be durable before the worker is ever
   * allowed to send it — A8) — attempt-fairness moved from "gate commit()
   * on a synchronous send" to "gate `sendNumber`'s count on a
   * worker-confirmed SENT outcome" (see both methods' own doc comments in
   * `account-invite.service.ts`). The caller/UI sees `queued: true` — this
   * method no longer knows, synchronously, whether delivery will succeed.
   */
  async sendAccountInvite(
    manager: EntityManager,
    ctx: AuthContext,
    params: { userId: string; email: string; createdBy: string | null },
    opts: {
      /**
       * P2.9 — Super Admin bootstrap/CEO/Initial Manager invitations each want their own subject
       * line (see templates.ts's own doc comment) while reusing every byte of this method's
       * plumbing. Defaults to the original generic Staff/Manager/Venue-Manager template.
       */
      templateRenderer?: (params: { recipientEmail: string; activationUrl: string }) => ReturnType<typeof renderAccountActivationEmail>;
      /**
       * Overrides the audit/outbox actor entirely — `null` for a genuinely system-driven send (the
       * Super Admin bootstrap command has no authenticated human actor), same convention
       * `AuditService.record`'s own `actorUserId` already documents. Omit for every ordinary
       * request-driven call, which keeps `ctx.userId` as the actor, unchanged.
       */
      actorUserId?: string | null;
    } = {},
  ): Promise<{ queued: boolean; sendNumber: number; expiresAt: Date }> {
    // P2.8 — a suspended organisation starts no new onboarding (owner's requirement 5). This is
    // the one choke point every invite-based creation/resend already funnels through (Staff,
    // Internal Manager, Venue Manager today; CEO/Initial Manager invites, once built, inherit this
    // for free if they reuse this same method, per this file's own "shared by every place..." doc
    // comment above). Existing PENDING invites and their normal expiry are untouched — this only
    // blocks a NEW token from being minted.
    const [org] = await manager.query<Array<{ suspended_at: string | null }>>(
      `SELECT suspended_at FROM core.organisation WHERE id = $1`,
      [ctx.organisationId],
    );
    if (org?.suspended_at) {
      throw new ForbiddenException('This organisation has been suspended. New invitations cannot be sent.');
    }

    const prepared = await this.accountInviteService.prepare(manager, params.userId);

    const activationUrl = `${this.env.get('ACCOUNTS_URL')}/activate-account?token=${prepared.token}`;
    const renderTemplate = opts.templateRenderer ?? renderAccountActivationEmail;
    const rendered = renderTemplate({ recipientEmail: params.email, activationUrl });

    const invite = await this.accountInviteService.commit(manager, {
      organisationId: ctx.organisationId!,
      userId: params.userId,
      createdBy: params.createdBy,
      tokenHash: prepared.tokenHash,
      sendNumber: prepared.sendNumber,
      expiresAt: prepared.expiresAt,
      cleanupAt: prepared.cleanupAt,
    });

    const actorUserId = opts.actorUserId !== undefined ? opts.actorUserId : ctx.userId;
    const outboxRow = await this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.ACCOUNT_INVITATION,
      recipientEmail: params.email,
      targetUserId: params.userId,
      accountInviteId: invite.id,
      rendered,
      createdBy: actorUserId ?? undefined,
    });
    this.schedulePublish(outboxRow);

    await this.auditService.record(manager, ctx, AuditAction.INVITE_EMAIL_QUEUED, {
      targetUserId: params.userId,
      metadata: { sendNumber: prepared.sendNumber, emailOutboxId: outboxRow.id },
      actorUserId: opts.actorUserId,
    });

    return { queued: true, sendNumber: prepared.sendNumber, expiresAt: prepared.expiresAt };
  }

  /**
   * Admin-triggered reset: forces the target back through the same
   * set-password gate a brand-new account goes through. The admin never
   * sees or sets the user's actual new password — only a fresh setup link
   * goes out.
   */
  async adminResetPassword(
    manager: EntityManager,
    ctx: AuthContext,
    params: { targetUserId: string; targetEmail: string; targetFirstName: string; organisationName: string },
  ): Promise<void> {
    await manager.update(User, params.targetUserId, { mustResetPassword: true });
    await this.securityVersion.bumpUser(manager, params.targetUserId);
    await this.refreshTokenService.revokeAllForUser(manager, params.targetUserId, 'admin_password_reset');

    const { token, id: tokenId } = await this.passwordResetTokenService.issue(manager, {
      organisationId: ctx.organisationId!,
      userId: params.targetUserId,
      purpose: PasswordResetTokenPurpose.ADMIN_RESET,
    });

    const resetUrl = `${this.env.get('ACCOUNTS_URL')}/reset-password?token=${token}`;
    const rendered = renderPasswordResetEmail({ firstName: params.targetFirstName, resetUrl, selfRequested: false });

    const outboxRow = await this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.PASSWORD_RESET,
      recipientEmail: params.targetEmail,
      targetUserId: params.targetUserId,
      passwordResetTokenId: tokenId,
      rendered,
      createdBy: ctx.userId,
    });
    this.schedulePublish(outboxRow);

    await this.auditService.record(manager, ctx, AuditAction.ADMIN_PASSWORD_RESET, { targetUserId: params.targetUserId });
  }

  /**
   * Called from `StaffService.deactivate()` — an access-affecting action
   * the account owner should always be told about directly, not discover
   * only by a failed login attempt next time they try to sign in.
   */
  async sendSuspensionNotice(
    manager: EntityManager,
    ctx: AuthContext,
    params: { userId: string; email: string; firstName: string; organisationName: string },
  ): Promise<void> {
    const rendered = renderAccountSuspendedEmail({ firstName: params.firstName, organisationName: params.organisationName });

    const outboxRow = await this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.ACCOUNT_SUSPENDED,
      recipientEmail: params.email,
      targetUserId: params.userId,
      rendered,
      createdBy: ctx.userId,
    });
    this.schedulePublish(outboxRow);

    await this.auditService.record(manager, ctx, AuditAction.STAFF_SUSPENSION_NOTICE_SENT, { targetUserId: params.userId });
  }
}
