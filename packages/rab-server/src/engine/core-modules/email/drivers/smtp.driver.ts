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
    // Some hosts (e.g. Render) have no outbound IPv6 route, but Node's default
    // DNS resolution can still hand back an IPv6 address for a dual-stack name
    // like smtp.gmail.com, causing ENETUNREACH. Forcing IPv4 here is safe
    // (every mainstream SMTP provider serves plain IPv4 too) and keeps the
    // fix scoped to email delivery rather than changing Node's global DNS
    // resolution order for the whole process.
    const transportOptions = { ...options, family: 4 };
    this.transport = nodemailer.createTransport(transportOptions);
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
