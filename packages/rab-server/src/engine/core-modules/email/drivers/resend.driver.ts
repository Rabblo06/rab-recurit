import { CreateEmailOptions, Resend } from 'resend';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface, EmailSendResult } from './interfaces/email-driver.interface';
import { EmailProviderError, parseRetryAfterMs } from './email-provider-error';

/**
 * D5: Resend error names (the SDK's RESEND_ERROR_CODE_KEY) that a retry of the SAME request can never fix — bad input,
 * bad credentials, a disallowed sender. Everything else (rate limits, 5xx, network failures reported as
 * `application_error` with no status, concurrent idempotent requests, quota and any new name) stays retryable.
 */
const RESEND_PERMANENT_ERRORS = new Set([
  'validation_error',
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'not_found',
  'method_not_allowed',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_access',
  'invalid_parameter',
  'invalid_region',
  'missing_required_field',
  'security_error',
]);

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
 *
 * `ambiguousDeliverySafeToRetry = true`: the installed SDK's
 * `emails.send(payload, options)` takes a second `options` argument
 * (`CreateEmailRequestOptions extends IdempotentRequest`, confirmed by
 * reading `node_modules/resend/dist/index.d.cts` — not assumed) whose
 * `idempotencyKey` is sent as a real `Idempotency-Key` HTTP header the
 * Resend API deduplicates on. A retried send with the SAME key after an
 * ambiguous prior outcome cannot create a second logical email.
 */
export class ResendDriver implements EmailDriverInterface {
  readonly name = 'RESEND';
  readonly ambiguousDeliverySafeToRetry = true;
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
  async send(options: EmailSendOptions): Promise<EmailSendResult> {
    if (!options.from) {
      throw Object.assign(new Error('ResendDriver requires a from address (EMAIL_FROM_ADDRESS).'), { code: 'ECONFIG' });
    }
    if (!options.html && !options.text) {
      throw Object.assign(new Error('ResendDriver requires at least one of html or text content.'), { code: 'ECONFIG' });
    }

    const replyTo = options.replyTo ?? this.defaultReplyTo;

    // `CreateEmailOptions` is a union requiring at least one of
    // react/html/text (`RequireAtLeastOne`) — the guard just above is what
    // actually guarantees that, which the object literal's own shape can't
    // express on its own since `html`/`text` are independently optional on
    // `EmailSendOptions`. The assertion is narrow and backed by that check,
    // not a blanket escape hatch.
    const { data, error, headers } = await this.client.emails.send(
      {
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        ...(replyTo ? { replyTo } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
      } as CreateEmailOptions,
      { idempotencyKey: options.idempotencyKey },
    );

    if (error) {
      const details = {
        provider: this.name,
        code: String(error.name),
        statusCode: typeof error.statusCode === 'number' ? error.statusCode : null,
        retryable: !RESEND_PERMANENT_ERRORS.has(String(error.name)),
        retryAfterMs: parseRetryAfterMs(headers?.['retry-after'] ?? headers?.['Retry-After']),
      };
      if (error.name === 'invalid_from_address') {
        throw new EmailProviderError(
          `Resend rejected the from address "${options.from}": its domain isn't verified in Resend. ` +
            'Verify the sending domain (SPF/DKIM records) in the Resend dashboard, or set EMAIL_FROM_ADDRESS ' +
            'to an address on a domain that already is verified.',
          details,
        );
      }
      throw new EmailProviderError(`Resend rejected the email (${error.name}): ${error.message}`, details);
    }
    return { provider: this.name, providerMessageId: data?.id };
  }
}
