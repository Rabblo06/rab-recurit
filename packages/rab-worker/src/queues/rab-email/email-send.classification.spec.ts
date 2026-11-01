import { StorageError, StorageErrorCode } from '@rab/server/engine/core-modules/storage/storage.errors';
import { WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';

import { classifyEmailSendError, throttleDelayMs } from './email-send.processor';

/**
 * D5 (D0-C §4.6): the retry classification was inverted for SMTP — any `responseCode >= 500` (550 user unknown, 554
 * rejected) and any message containing a 5xx number were RETRIED, while a transient 4xx (421/450/451) with no matching
 * text and every unrecognised error were treated as PERMANENT. Rules now (nodemailer 10 shapes: `code`, `responseCode`,
 * `permanent`; Resend: EmailProviderError with `retryable`/`retryAfterMs`):
 *   5xx (except 503) permanent · 4xx/503 retryable · network/timeout retryable · local config/validation permanent ·
 *   unknown retryable · StorageError keeps its own verdict · EMPTY_BODY permanent.
 */
const smtp = (responseCode: number, code = 'EENVELOPE') =>
  Object.assign(new Error(`Can't send mail - all recipients were rejected: ${responseCode} x`), {
    code,
    responseCode,
    permanent: responseCode >= 500 && responseCode < 600 && responseCode !== 503,
  });

describe('classifyEmailSendError', () => {
  it.each([550, 551, 552, 553, 554])('SMTP %i is permanent', (rc) => {
    expect(classifyEmailSendError(smtp(rc)).retryable).toBe(false);
  });

  it('SMTP 535 authentication failure is permanent', () => {
    expect(classifyEmailSendError(smtp(535, 'EAUTH')).retryable).toBe(false);
  });

  it.each([421, 450, 451, 452, 503])('SMTP %i is retryable (transient), even with no recognisable text', (rc) => {
    const error = Object.assign(new Error('Message failed: busy'), { code: 'EMESSAGE', responseCode: rc, permanent: false });
    expect(classifyEmailSendError(error).retryable).toBe(true);
  });

  it('a 5xx number in the MESSAGE text of an otherwise unknown error does not make it retryable or permanent by itself (unknown = retryable)', () => {
    expect(classifyEmailSendError(new Error('upstream said 550 somewhere')).retryable).toBe(true);
  });

  it.each(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN', 'ETLS', 'EPROTOCOL'])(
    'network/transport code %s is retryable',
    (code) => {
      expect(classifyEmailSendError(Object.assign(new Error('x'), { code })).retryable).toBe(true);
    },
  );

  it('an unrecognised error is retryable (fails safe toward trying again)', () => {
    expect(classifyEmailSendError(new Error('something new')).retryable).toBe(true);
    expect(classifyEmailSendError('not even an Error').retryable).toBe(true);
  });

  it.each(['EMPTY_BODY', 'ECONFIG', 'ENOAUTH', 'EMAXRECIPIENTS', 'EREQUIRETLS'])('local configuration/validation code %s is permanent', (code) => {
    expect(classifyEmailSendError(Object.assign(new Error('x'), { code })).retryable).toBe(false);
  });

  it('local envelope/auth/message validation errors with no server reply are permanent (bad address, missing credentials, too large)', () => {
    for (const code of ['EENVELOPE', 'EAUTH', 'EMESSAGE']) {
      expect(classifyEmailSendError(Object.assign(new Error('Invalid recipient'), { code, command: 'API' })).retryable).toBe(false);
    }
  });

  it('a workspace routing refusal stays permanent (fail closed, unchanged)', () => {
    expect(classifyEmailSendError(new WorkspaceRoutingError('not-ready')).retryable).toBe(false);
  });

  it('StorageError keeps its own verdict', () => {
    expect(classifyEmailSendError(new StorageError(StorageErrorCode.INTEGRITY_FAILED, 'x', false)).retryable).toBe(false);
    expect(classifyEmailSendError(new StorageError(StorageErrorCode.TEMPORARILY_UNAVAILABLE, 'x', true)).retryable).toBe(true);
  });

  it('a provider error that states its own retryability (Resend) is honoured, with its Retry-After', () => {
    const throttled = Object.assign(new Error('Resend rejected the email (rate_limit_exceeded): Too many requests'), {
      name: 'EmailProviderError',
      code: 'rate_limit_exceeded',
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(classifyEmailSendError(throttled)).toEqual({ retryable: true, retryAfterMs: 2_000 });
    const invalidKey = Object.assign(new Error('Resend rejected the email (invalid_api_key): x'), { name: 'EmailProviderError', code: 'invalid_api_key', retryable: false });
    expect(classifyEmailSendError(invalidKey).retryable).toBe(false);
  });
});

describe('throttleDelayMs (provider-reported throttling)', () => {
  it('honours a reported Retry-After, clamped to 1 s .. 120 s; nothing reported = normal jittered backoff', () => {
    expect(throttleDelayMs({ retryable: true, retryAfterMs: 2_500 })).toBe(2_500);
    expect(throttleDelayMs({ retryable: true, retryAfterMs: 10 })).toBe(1_000);
    expect(throttleDelayMs({ retryable: true, retryAfterMs: 3_600_000 })).toBe(120_000);
    expect(throttleDelayMs({ retryable: true })).toBeNull();
    expect(throttleDelayMs({ retryable: false, retryAfterMs: 2_000 })).toBeNull();
  });
});
