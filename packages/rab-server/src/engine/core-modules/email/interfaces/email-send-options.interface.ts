export interface EmailSendOptions {
  to: string;
  /** Defaults to EMAIL_FROM_ADDRESS when omitted — see EmailService.send(). */
  from?: string;
  /** Defaults to EMAIL_REPLY_TO when omitted — see EmailService.send(). */
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  /**
   * Stable identity for this LOGICAL delivery (one `email_outbox` row) — the
   * same string across every retry, worker restart, and dispatcher
   * recovery. Passed to Resend as its own `Idempotency-Key`; used by the SMTP
   * driver to build a deterministic RFC Message-ID. This is a database/
   * outbox-level idempotency key, distinct from the BullMQ job id (which
   * DOES change across a recovery republish — see
   * `EmailQueueService.republish`'s doc comment).
   */
  idempotencyKey: string;
}
