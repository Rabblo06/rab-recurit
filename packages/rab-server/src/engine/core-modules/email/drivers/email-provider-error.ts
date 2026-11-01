/**
 * D5: a provider failure that states its own retry verdict, so the Worker's email processor never guesses from message
 * text (email-send.processor.ts `classifyEmailSendError` honours `retryable` and `retryAfterMs` as given).
 * Driver-authored text never carries credentials or the recipient address. A provider's own error message is appended
 * unchanged, exactly as before D5 (e.g. Resend's `error.message`), so it can contain whatever the provider wrote.
 */
export class EmailProviderError extends Error {
  readonly provider: string;
  readonly code: string;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  /** Provider-reported throttling (e.g. an HTTP `retry-after`), in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, details: { provider: string; code: string; statusCode: number | null; retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'EmailProviderError';
    this.provider = details.provider;
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.retryable = details.retryable;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

/** `retry-after` as delta-seconds or an HTTP date → milliseconds from now; undefined when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
