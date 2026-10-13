/**
 * Minimal payload — a generic alert plus an event identifier, never the full
 * business content (Stage 6 §6: "send a minimal event identifier and generic
 * alert, then retrieve full details through Crewflow's authenticated API").
 * The caller (`PushDeliveryService`/the send processor) is responsible for
 * keeping `data` free of staff/banking/payroll/authentication content —
 * drivers never inspect or sanitize it themselves.
 */
export interface PushSendOptions {
  /** The raw (decrypted) device push token — never logged by any driver. */
  token: string;
  title: string;
  body: string;
  /** String values only (FCM's own `data` payload constraint) — ids/types, never free text content. */
  data?: Record<string, string>;
}

/** What actually happened at the provider, as far as we can durably know it. `providerMessageId` is advisory/observability-only. */
export interface PushSendResult {
  provider: string;
  providerMessageId?: string;
}

/**
 * Thrown by a driver's `send()` on any failure. `retryable` drives the
 * PENDING/RETRY-vs-FAILED classification in `push-send.processor.ts`, exactly
 * mirroring `email-send.processor.ts`'s own `isRetryable()`. `invalidToken`
 * is a SEPARATE, narrower signal — a permanently dead registration (the OS
 * uninstalled the app, the token was rotated) that should deactivate the
 * `push_device` row outright rather than merely stop retrying this one
 * delivery (Stage 6 §6: "invalid-device cleanup").
 */
export class PushSendError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly invalidToken: boolean = false,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PushSendError';
  }
}

export interface PushDriverInterface {
  /** For persisting to `push_delivery.provider` and for recovery classification. */
  readonly name: string;

  /**
   * Whether a delivery whose outcome is unknown (we called `send()`, then
   * crashed or lost the DB write before recording the result) is SAFE to
   * simply retry using the same logical delivery, without risking a
   * duplicate real push to the device. FCM's HTTP v1 API has no
   * server-side idempotency-key mechanism (unlike Resend's email API) — a
   * second `send()` for the same message is a genuinely new, separate push.
   * false for both the real FCM driver and the fake driver (the fake driver
   * deliberately mirrors the real one's honesty here rather than claiming a
   * safety property FCM doesn't actually provide).
   */
  readonly ambiguousDeliverySafeToRetry: boolean;

  send(options: PushSendOptions): Promise<PushSendResult>;
}
