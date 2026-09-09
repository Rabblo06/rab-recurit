import { EmailOutboxJobType, PasswordResetTokenPurpose } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailOutboxService } from '../../email/email-outbox.service';
import { EmailQueueService } from '../../email/email-queue.service';
import { renderAccountActivationEmail, renderAccountSuspendedEmail, renderPasswordResetEmail } from '../../email/templates';
import { ThrottlerRedisClientProvider } from '../../throttler/throttler-redis-client.provider';
import { AuthContext } from '../../tenant/auth-context.interface';
import { AccountInviteService } from './account-invite.service';
import { PasswordResetTokenService } from '../token/services/password-reset-token.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '../../../../queue-worker/heartbeat.constants';

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
    private readonly redisClient: ThrottlerRedisClientProvider,
  ) {}

  /**
   * Synchronous "can an invite/welcome email actually be delivered right
   * now" check — called by StaffService/ManagerService.create() before
   * deciding whether to call sendAccountInvite() at all. Deliberately reuses
   * ONLY the worker-heartbeat-read pattern AdminPanelService.checkWorker()
   * already uses (a plain Redis GET + age-vs-TTL compare) — never
   * AdminPanelService.checkEmail()'s live SMTP `transport.verify()` round
   * trip, which has a real, recently-fixed hang history in this codebase
   * (see git history: "Fail fast on a blocked SMTP path instead of hanging
   * for 2 minutes"). Any Redis error fails closed to `false` — this only
   * ever causes a send to be skipped, never fails the caller's request.
   */
  async isEmailDeliveryAvailable(): Promise<boolean> {
    if (!this.env.get('EMAIL_DELIVERY_ENABLED')) return false;
    try {
      const value = await this.redisClient.client.get(WORKER_HEARTBEAT_KEY);
      if (!value) return false;
      const ageSeconds = (Date.now() - Number(value)) / 1000;
      return ageSeconds <= WORKER_HEARTBEAT_TTL_SECONDS;
    } catch {
      return false;
    }
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
  ): Promise<{ queued: boolean; sendNumber: number; expiresAt: Date }> {
    const prepared = await this.accountInviteService.prepare(manager, params.userId);

    const activationUrl = `${this.env.get('APP_URL')}/activate-account?token=${prepared.token}`;
    const rendered = renderAccountActivationEmail({ recipientEmail: params.email, activationUrl });

    const invite = await this.accountInviteService.commit(manager, {
      organisationId: ctx.organisationId!,
      userId: params.userId,
      createdBy: params.createdBy,
      tokenHash: prepared.tokenHash,
      sendNumber: prepared.sendNumber,
      expiresAt: prepared.expiresAt,
      cleanupAt: prepared.cleanupAt,
    });

    const outboxRow = await this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.ACCOUNT_INVITATION,
      recipientEmail: params.email,
      targetUserId: params.userId,
      accountInviteId: invite.id,
      rendered,
      createdBy: ctx.userId,
    });
    this.schedulePublish(outboxRow);

    await this.auditService.record(manager, ctx, AuditAction.INVITE_EMAIL_QUEUED, {
      targetUserId: params.userId,
      metadata: { sendNumber: prepared.sendNumber, emailOutboxId: outboxRow.id },
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
    await this.refreshTokenService.revokeAllForUser(manager, params.targetUserId);

    const { token, id: tokenId } = await this.passwordResetTokenService.issue(manager, {
      organisationId: ctx.organisationId!,
      userId: params.targetUserId,
      purpose: PasswordResetTokenPurpose.ADMIN_RESET,
    });

    const resetUrl = `${this.env.get('APP_URL')}/reset-password?token=${token}`;
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
