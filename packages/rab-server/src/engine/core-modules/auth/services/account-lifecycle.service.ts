import { PasswordResetTokenPurpose } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { User } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EmailService } from '../../email/email.service';
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
  constructor(
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
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

    const sent = await this.emailService.sendAccountInvite({
      to: params.email,
      firstName: params.firstName,
      organisationName: params.organisationName,
      setupToken: token,
    });

    await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, { targetUserId: params.userId });
    if (sent) {
      await this.auditService.record(manager, ctx, AuditAction.INVITE_EMAIL_SENT, { targetUserId: params.userId });
    }
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

    await this.emailService.sendPasswordReset({
      to: params.targetEmail,
      firstName: params.targetFirstName,
      resetToken: token,
      selfRequested: false,
    });

    await this.auditService.record(manager, ctx, AuditAction.ADMIN_PASSWORD_RESET, { targetUserId: params.targetUserId });
  }
}
