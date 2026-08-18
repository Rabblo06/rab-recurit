import { AccountInviteEmail, PasswordResetEmail } from '@rab/emails';
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

import { EnvironmentService } from '../environment/environment.service';

/**
 * Thin wrapper around Resend. `RESEND_API_KEY` is optional (see
 * environment-variables.ts) — when it's unset this logs and returns
 * instead of throwing, so account creation / password-reset flows stay
 * fully exercisable (tokens issued, `mustResetPassword` set, audit logged)
 * without live credentials. It never fakes a successful send — the caller
 * gets back whether the send actually happened.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private client: Resend | null = null;

  constructor(private readonly env: EnvironmentService) {
    const apiKey = this.env.get('RESEND_API_KEY');
    if (apiKey) this.client = new Resend(apiKey);
  }

  async sendAccountInvite(params: {
    to: string;
    firstName: string;
    organisationName: string;
    setupToken: string;
  }): Promise<boolean> {
    // Pre-auth setup — consumed by /reset-password (which posts to
    // /auth/reset-password with the token). /set-password is a different,
    // authenticated-only screen for the forced first-login flow and takes
    // no token, so it must never appear here.
    const setupUrl = `${this.env.get('APP_URL')}/reset-password?token=${params.setupToken}`;
    return this.send({
      to: params.to,
      subject: 'Your account has been created',
      react: AccountInviteEmail({
        firstName: params.firstName,
        organisationName: params.organisationName,
        setupUrl,
      }),
    });
  }

  async sendPasswordReset(params: {
    to: string;
    firstName: string;
    resetToken: string;
    selfRequested: boolean;
  }): Promise<boolean> {
    const resetUrl = `${this.env.get('APP_URL')}/reset-password?token=${params.resetToken}`;
    return this.send({
      to: params.to,
      subject: 'Reset your rab password',
      react: PasswordResetEmail({
        firstName: params.firstName,
        resetUrl,
        selfRequested: params.selfRequested,
      }),
    });
  }

  private async send(params: { to: string; subject: string; react: React.ReactElement }): Promise<boolean> {
    if (!this.client) {
      this.logger.warn(`RESEND_API_KEY not set — skipping email send ("${params.subject}" to ${params.to})`);
      return false;
    }
    try {
      const result = await this.client.emails.send({
        from: this.env.get('EMAIL_FROM'),
        to: params.to,
        subject: params.subject,
        react: params.react,
      });
      if (result.error) {
        this.logger.error(`Email send failed ("${params.subject}" to ${params.to}): ${result.error.message}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Email send threw ("${params.subject}" to ${params.to})`, error as Error);
      return false;
    }
  }
}
