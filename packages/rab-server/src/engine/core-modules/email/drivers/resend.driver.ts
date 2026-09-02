import { CreateEmailOptions, Resend } from 'resend';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface } from './interfaces/email-driver.interface';

export interface ResendDriverOptions {
  apiKey: string;
  replyTo?: string;
}

/**
 * Production transport via Resend's HTTP API (`resend` npm SDK — verified
 * against its shipped `.d.cts`, not guessed: `emails.send()` takes
 * `{ from, to, subject, html, text, replyTo }` and resolves
 * `{ data, error }`, never throwing on a rejected send itself.
 *
 * Resend requires the `from` address to be on a domain verified in the
 * Resend dashboard (SPF/DKIM DNS records) — it cannot be an arbitrary
 * third-party mailbox (e.g. a Gmail address), since nothing here controls
 * that domain's DNS. A `from` on an unverified domain comes back as
 * `error.name === 'invalid_from_address'`, surfaced below with a message
 * that says so plainly instead of a generic API error.
 */
export class ResendDriver implements EmailDriverInterface {
  private readonly client: Resend;
  private readonly defaultReplyTo?: string;

  constructor(options: ResendDriverOptions) {
    this.client = new Resend(options.apiKey);
    this.defaultReplyTo = options.replyTo;
  }

  /**
   * Awaits the send and does not catch — a rejected/errored send throws so
   * the caller (EmailService, and beyond it whoever called EmailService)
   * knows delivery failed, matching SmtpDriver's contract.
   */
  async send(options: EmailSendOptions): Promise<void> {
    if (!options.from) {
      throw new Error('ResendDriver requires a from address (EMAIL_FROM_ADDRESS).');
    }
    if (!options.html && !options.text) {
      throw new Error('ResendDriver requires at least one of html or text content.');
    }

    const replyTo = options.replyTo ?? this.defaultReplyTo;

    // `CreateEmailOptions` is a union requiring at least one of
    // react/html/text (`RequireAtLeastOne`) — the guard just above is what
    // actually guarantees that, which the object literal's own shape can't
    // express on its own since `html`/`text` are independently optional on
    // `EmailSendOptions`. The assertion is narrow and backed by that check,
    // not a blanket escape hatch.
    const { error } = await this.client.emails.send({
      from: options.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      ...(replyTo ? { replyTo } : {}),
    } as CreateEmailOptions);

    if (error) {
      if (error.name === 'invalid_from_address') {
        throw new Error(
          `Resend rejected the from address "${options.from}": its domain isn't verified in Resend. ` +
            'Verify the sending domain (SPF/DKIM records) in the Resend dashboard, or set EMAIL_FROM_ADDRESS ' +
            'to an address on a domain that already is verified.',
        );
      }
      throw new Error(`Resend rejected the email (${error.name}): ${error.message}`);
    }
  }
}
