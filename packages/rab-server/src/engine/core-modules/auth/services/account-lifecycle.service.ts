import { PasswordResetTokenPurpose } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailService } from '../../email/email.service';
import {
  renderAccountActivationEmail,
  renderAccountInviteEmail,
  renderAccountSuspendedEmail,
  renderPasswordResetEmail,
} from '../../email/templates';
import { AuthContext } from '../../tenant/auth-context.interface';
import { AccountInviteService } from './account-invite.service';
import { PasswordResetTokenService } from '../token/services/password-reset-token.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';

/**
 * Shared by every place a Staff/Internal Manager/Venue Manager account gets
 * created or has its password reset by an admin (`staff.service.ts`,
 * `manager.service.ts`) — one implementation of "issue a setup/reset
 * token, force a password change, notify the user, audit it" rather than
 * three near-identical copies.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly accountInviteService: AccountInviteService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
  ) {}

  /**
   * Called right after a new User row is inserted — the row itself is
   * already created with `mustResetPassword: true` by the caller (that's
   * still the caller's INSERT, this only issues the link and sends the
   * email that goes with it).
   */
  async sendInvite(
    manager: EntityManager,
    ctx: AuthContext,
    params: { userId: string; email: string; firstName: string; organisationName: string },
  ): Promise<void> {
    const { token } = await this.passwordResetTokenService.issue(manager, {
      organisationId: ctx.organisationId!,
      userId: params.userId,
      purpose: PasswordResetTokenPurpose.INITIAL_SETUP,
    });

    const setupUrl = `${this.env.get('APP_URL')}/reset-password?token=${token}`;
    const { subject, html, text } = renderAccountInviteEmail({
      firstName: params.firstName,
      organisationName: params.organisationName,
      setupUrl,
    });
    // Caught, not propagated: a flaky SMTP server must not roll back the
    // account row this runs alongside, in the same transaction.
    try {
      await this.emailService.send({ to: params.email, subject, html, text });
    } catch (error) {
      this.logger.error(`Invite email failed to send to ${params.email}`, error as Error);
    }

    await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, { targetUserId: params.userId });
    // Records that the app attempted the send, not that it was delivered —
    // the audit row is unconditional even when the try/catch above logged a
    // failure just now.
    await this.auditService.record(manager, ctx, AuditAction.INVITE_EMAIL_SENT, { targetUserId: params.userId });
  }

  /**
   * The invitation-based activation flow's send/resend — distinct from
   * `sendInvite` above (that one is the older admin-sets-a-temporary-
   * password flow, kept working, unused by the caller of this method).
   * Called once at `ManagerService`/`StaffService.create()` (attempt 1) and
   * again from each service's `resendInvite()` (attempts 2 and 3) — the
   * exact same method either way, since "send" and "resend" are the same
   * operation from `AccountInviteService.issue()`'s point of view.
   *
   * The `delivered` flag in the return value lets the caller (and, through
   * it, the admin-facing UI) distinguish "invited" from "created but the
   * email didn't go out" without a second round trip. Attempt accounting is
   * deliberately delivery-gated, not issue-gated: `AccountInviteService.
   * prepare()` computes the token/sendNumber without writing anything, the
   * email is attempted, and only a SUCCESSFUL send calls `commit()` to
   * actually persist it (revoking whatever was active before). A flaky
   * provider or an outage therefore never burns one of the 3 attempts on a
   * message nobody could have received — the next resend (or retry) still
   * gets the same `sendNumber` this one would have used, and whatever token
   * was already valid before this attempt (if any) is untouched.
   */
  async sendAccountInvite(
    manager: EntityManager,
    ctx: AuthContext,
    params: { userId: string; email: string; createdBy: string | null },
  ): Promise<{ delivered: boolean; sendNumber: number; expiresAt: Date }> {
    const prepared = await this.accountInviteService.prepare(manager, params.userId);

    const activationUrl = `${this.env.get('APP_URL')}/activate-account?token=${prepared.token}`;
    const { subject, html, text } = renderAccountActivationEmail({ recipientEmail: params.email, activationUrl });

    let delivered = true;
    try {
      await this.emailService.send({ to: params.email, subject, html, text });
    } catch (error) {
      delivered = false;
      this.logger.error(`Activation email failed to send to ${params.email} (attempt ${prepared.sendNumber}, not consumed)`, error as Error);
    }

    if (delivered) {
      await this.accountInviteService.commit(manager, {
        organisationId: ctx.organisationId!,
        userId: params.userId,
        createdBy: params.createdBy,
        tokenHash: prepared.tokenHash,
        sendNumber: prepared.sendNumber,
        expiresAt: prepared.expiresAt,
        cleanupAt: prepared.cleanupAt,
      });
    }

    await this.auditService.record(manager, ctx, delivered ? AuditAction.INVITE_EMAIL_SENT : AuditAction.INVITE_EMAIL_FAILED, {
      targetUserId: params.userId,
      metadata: { sendNumber: prepared.sendNumber, consumed: delivered },
    });

    return { delivered, sendNumber: prepared.sendNumber, expiresAt: prepared.expiresAt };
  }

  /**
   * Admin-triggered reset: forces the target back through the same
   * set-password gate a brand-new account goes through. The admin never
   * sees or sets the user's actual new password — only a fresh setup link
   * goes out, same as `sendInvite`.
   */
  async adminResetPassword(
    manager: EntityManager,
    ctx: AuthContext,
    params: { targetUserId: string; targetEmail: string; targetFirstName: string; organisationName: string },
  ): Promise<void> {
    await manager.update(User, params.targetUserId, { mustResetPassword: true });
    await this.refreshTokenService.revokeAllForUser(manager, params.targetUserId);

    const { token } = await this.passwordResetTokenService.issue(manager, {
      organisationId: ctx.organisationId!,
      userId: params.targetUserId,
      purpose: PasswordResetTokenPurpose.ADMIN_RESET,
    });

    const resetUrl = `${this.env.get('APP_URL')}/reset-password?token=${token}`;
    const { subject, html, text } = renderPasswordResetEmail({
      firstName: params.targetFirstName,
      resetUrl,
      selfRequested: false,
    });
    try {
      await this.emailService.send({ to: params.targetEmail, subject, html, text });
    } catch (error) {
      this.logger.error(`Admin-reset email failed to send to ${params.targetEmail}`, error as Error);
    }

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
    const { subject, html, text } = renderAccountSuspendedEmail({
      firstName: params.firstName,
      organisationName: params.organisationName,
    });
    // Caught, not propagated — same reasoning as sendInvite: a flaky SMTP
    // server must not roll back the deactivation this runs alongside.
    try {
      await this.emailService.send({ to: params.email, subject, html, text });
    } catch (error) {
      this.logger.error(`Suspension notice failed to send to ${params.email}`, error as Error);
    }

    await this.auditService.record(manager, ctx, AuditAction.STAFF_SUSPENSION_NOTICE_SENT, { targetUserId: params.userId });
  }
}
