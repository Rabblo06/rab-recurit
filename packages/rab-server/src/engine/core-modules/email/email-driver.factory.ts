import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { EmailDriverInterface } from './drivers/interfaces/email-driver.interface';
import { LoggerDriver } from './drivers/logger.driver';
import { SmtpDriver } from './drivers/smtp.driver';
import { EmailDriver } from './enums/email-driver.enum';

/**
 * Resolved fresh per send() call — cheap (a switch), and env vars are
 * validated once at boot via class-validator, so there's no need for a
 * config-hash caching layer (that pattern only earns its keep when config
 * is DB-editable at runtime, which ours isn't).
 */
@Injectable()
export class EmailDriverFactory {
  constructor(private readonly env: EnvironmentService) {}

  getDriver(): EmailDriverInterface {
    const driver = this.env.get('EMAIL_DRIVER');

    switch (driver) {
      case EmailDriver.LOGGER:
        return new LoggerDriver();
      case EmailDriver.SMTP: {
        const host = this.env.get('EMAIL_SMTP_HOST');
        if (!host) {
          throw new Error('SMTP driver requires EMAIL_SMTP_HOST to be set.');
        }
        const user = this.env.get('EMAIL_SMTP_USER');
        const pass = this.env.get('EMAIL_SMTP_PASSWORD');
        const noTls = this.env.get('EMAIL_SMTP_NO_TLS');
        return new SmtpDriver({
          host,
          port: this.env.get('EMAIL_SMTP_PORT'),
          secure: !noTls && this.env.get('EMAIL_SMTP_PORT') === 465,
          ignoreTLS: noTls,
          auth: user && pass ? { user, pass } : undefined,
        });
      }
      default:
        throw new Error(`Invalid EMAIL_DRIVER: "${driver}". Expected LOGGER or SMTP.`);
    }
  }
}
