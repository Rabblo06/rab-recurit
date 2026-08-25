import { PasswordResetTokenPurpose } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailService } from '../../email/email.service';
import { renderAccountInviteEmail, renderPasswordResetEmail } from '../../email/templates';
import { AuthContext } from '../../tenant/auth-context.interface';
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
}
