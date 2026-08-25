import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { EmailDriverFactory } from './email-driver.factory';
import { EmailSendOptions } from './interfaces/email-send-options.interface';

/**
 * Usage:
 *   await this.emailService.send({ to: 'jane@co.test', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
 *
 * Driver is selected by EMAIL_DRIVER=LOGGER|SMTP (.env) — LOGGER (default)
 * just logs, nothing sends. SMTP needs EMAIL_SMTP_HOST at minimum;
 * EMAIL_SMTP_PORT defaults to 587, EMAIL_SMTP_NO_TLS to false.
 *
 * send() does not catch — a delivery failure rejects the returned promise
 * so the caller knows. This is a deliberate, framework-wide choice: callers
 * decide for themselves whether an email failure should abort the request
 * (rethrow/let it propagate) or just be logged (wrap in try/catch and
 * continue) — see account-lifecycle.service.ts and auth.service.ts for the
 * latter, chosen there so a flaky SMTP server can't block account creation
 * or password-reset token issuance.
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly env: EnvironmentService,
    private readonly driverFactory: EmailDriverFactory,
  ) {}

  async send(options: EmailSendOptions): Promise<void> {
    const driver = this.driverFactory.getDriver();
    await driver.send({ ...options, from: options.from ?? this.env.get('EMAIL_FROM_ADDRESS') });
  }
}
