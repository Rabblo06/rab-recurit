const sendMock = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { EmailProviderError } from './email-provider-error';
import { ResendDriver } from './resend.driver';

/**
 * D5 (D0-C §4.6/§4.8): Resend failures carry their own verdict so the processor never guesses from message text, and a
 * reported throttle (429 + `retry-after`) is honoured. Mocked SDK; no network.
 */
const mail = { to: 'staff@example.test', from: 'no-reply@rab.example', subject: 'S', text: 'T', idempotencyKey: 'email-outbox:1' };

async function failureFor(error: Record<string, unknown>, headers: Record<string, string> | null = null): Promise<EmailProviderError> {
  sendMock.mockResolvedValueOnce({ data: null, error, headers });
  const caught = await new ResendDriver({ apiKey: 're_test' }).send(mail).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(EmailProviderError);
  return caught as EmailProviderError;
}

describe('ResendDriver failure classification', () => {
  beforeEach(() => sendMock.mockReset());

  it('rate_limit_exceeded is retryable and carries the reported retry-after (seconds → ms)', async () => {
    const e = await failureFor({ name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 }, { 'retry-after': '2' });
    expect(e).toMatchObject({ provider: 'RESEND', code: 'rate_limit_exceeded', statusCode: 429, retryable: true, retryAfterMs: 2_000 });
    expect(e.message).toMatch(/rate_limit_exceeded.*Too many requests/);
  });

  it('a 429 without retry-after is retryable with no delay hint', async () => {
    const e = await failureFor({ name: 'rate_limit_exceeded', message: 'x', statusCode: 429 });
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBeUndefined();
  });

  it.each(['validation_error', 'invalid_api_key', 'restricted_api_key', 'missing_api_key', 'missing_required_field', 'invalid_attachment', 'invalid_parameter', 'security_error'])(
    '%s is permanent',
    async (name) => {
      expect((await failureFor({ name, message: 'x', statusCode: 422 })).retryable).toBe(false);
    },
  );

  it('invalid_from_address keeps its actionable message and is permanent', async () => {
    const e = await failureFor({ name: 'invalid_from_address', message: 'x', statusCode: 403 });
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/domain isn't verified in Resend/);
  });

  it.each([
    ['internal_server_error', 500],
    ['application_error', null],
    ['concurrent_idempotent_requests', 409],
    ['something_new', 418],
  ])('%s (%p) is retryable', async (name, statusCode) => {
    expect((await failureFor({ name, message: 'x', statusCode })).retryable).toBe(true);
  });

  it('driver configuration errors are permanent (code ECONFIG), not provider errors', async () => {
    const noFrom = await new ResendDriver({ apiKey: 're_test' }).send({ ...mail, from: undefined }).catch((e: unknown) => e);
    expect(noFrom).toMatchObject({ code: 'ECONFIG' });
  });
});
