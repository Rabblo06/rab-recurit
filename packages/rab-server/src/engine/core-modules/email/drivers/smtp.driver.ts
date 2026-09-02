import nodemailer, { Transporter } from 'nodemailer';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface } from './interfaces/email-driver.interface';

export interface SmtpDriverOptions {
  host: string;
  port: number;
  secure?: boolean;
  ignoreTLS?: boolean;
  auth?: { user: string; pass: string };
}

export class SmtpDriver implements EmailDriverInterface {
  private readonly transport: Transporter;

  constructor(options: SmtpDriverOptions) {
    this.transport = nodemailer.createTransport(options);
  }

  /**
   * Awaits the send and does not catch — a failure rejects this promise so
   * the caller (EmailService, and beyond it whoever called EmailService)
   * knows delivery failed, rather than it being silently swallowed here.
   */
  async send(options: EmailSendOptions): Promise<void> {
    await this.transport.sendMail({
      to: options.to,
      from: options.from,
      replyTo: options.replyTo,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }
}
