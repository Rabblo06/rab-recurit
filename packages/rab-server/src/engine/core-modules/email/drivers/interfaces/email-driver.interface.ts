import { EmailSendOptions } from '../../interfaces/email-send-options.interface';

/**
 * What actually happened at the provider, as far as we can durably know it.
 * `providerMessageId` is advisory/observability-only — never treated as a
 * dedup mechanism by our own code (that's what `idempotencyKey` is for).
 */
export interface EmailSendResult {
  provider: string;
  providerMessageId?: string;
}

export interface EmailDriverInterface {
  /** For persisting to `email_outbox.provider` and for `email-dispatch.job.ts`'s recovery classification. */
  readonly name: string;

  /**
   * Whether a delivery whose outcome is unknown (we called `send()`, then
   * crashed or lost the DB write before recording the result) is SAFE to
   * simply retry using the SAME `idempotencyKey`, without risking a second
   * real delivery to the recipient.
   *
   * true for RESEND: the installed SDK (verified against its shipped
   * `.d.cts`, not assumed) sends `idempotencyKey` as a real `Idempotency-Key`
   * request header the API deduplicates on server-side.
   * true for LOGGER: there is no real external send to duplicate.
   * false for SMTP: nodemailer/plain SMTP has no dedup mechanism at all — a
   * deterministic Message-ID (built from the same key) aids downstream
   * tracing, but does NOT make a second real SMTP send safe to assume
   * deduplicated by the recipient's mail system. Never claim otherwise.
   */
  readonly ambiguousDeliverySafeToRetry: boolean;

  send(options: EmailSendOptions): Promise<EmailSendResult>;
}
