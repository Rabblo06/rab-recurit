import { Logger } from '@nestjs/common';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface, EmailSendResult } from './interfaces/email-driver.interface';

/** Dev-default driver — logs instead of sending, so nothing goes out by accident locally. */
export class LoggerDriver implements EmailDriverInterface {
  readonly name = 'LOGGER';
  // No real external send happens, so there is nothing a retry could duplicate.
  readonly ambiguousDeliverySafeToRetry = true;
  private readonly logger = new Logger(LoggerDriver.name);

  async send(options: EmailSendOptions): Promise<EmailSendResult> {
    const replyToLine = options.replyTo ? `, replyTo: ${options.replyTo}` : '';
    const attachmentsLine = options.attachments?.length
      ? `\nattachments: ${options.attachments.map((a) => `${a.filename} (${a.content.length}b)`).join(', ')}`
      : '';
    this.logger.log(
      `Email not sent (EMAIL_DRIVER=LOGGER) — idempotencyKey: ${options.idempotencyKey}, to: ${options.to}, from: ${options.from}${replyToLine}, subject: ${options.subject}\ntext: ${options.text}\nhtml: ${options.html}${attachmentsLine}`,
    );
    return { provider: this.name };
  }
}
