const sendMock = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

import { Resend } from 'resend';

import { ResendDriver } from './resend.driver';

const KEY = 'email-outbox:11111111-1111-1111-1111-111111111111';

describe('ResendDriver', () => {
  beforeEach(() => {
    sendMock.mockReset();
    (Resend as unknown as jest.Mock).mockClear();
  });

  it('constructs the Resend client with the given API key', () => {
    new ResendDriver({ apiKey: 're_test_key' });
    expect(Resend).toHaveBeenCalledWith('re_test_key');
  });

  it('sends with from/to/subject/html/text and no replyTo when none is configured, and reports the driver name + provider message id', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const driver = new ResendDriver({ apiKey: 're_test_key' });

    const result = await driver.send({
      to: 'staff@example.test',
      from: 'RAB Recruitment <no-reply@rab.example>',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
      idempotencyKey: KEY,
    });

    expect(sendMock).toHaveBeenCalledWith(
      {
        from: 'RAB Recruitment <no-reply@rab.example>',
        to: 'staff@example.test',
        subject: 'Hello',
        html: '<p>Hi</p>',
        text: 'Hi',
      },
      { idempotencyKey: KEY },
    );
    expect(result).toEqual({ provider: 'RESEND', providerMessageId: 'email_123' });
  });

  it('passes the SAME idempotencyKey on a retried send of the same logical email', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const driver = new ResendDriver({ apiKey: 're_test_key' });
    const options = { to: 'staff@example.test', from: 'no-reply@rab.example', subject: 'Hello', text: 'Hi', idempotencyKey: KEY };

    await driver.send(options);
    await driver.send(options); // simulates a recovery republish of the same outbox row

    expect(sendMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: 'staff@example.test' }), { idempotencyKey: KEY });
    expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: 'staff@example.test' }), { idempotencyKey: KEY });
  });

  it('falls back to the driver-level replyTo when the send call does not specify one', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const driver = new ResendDriver({ apiKey: 're_test_key', replyTo: 'owner@gmail.example' });

    await driver.send({ to: 'staff@example.test', from: 'no-reply@rab.example', subject: 'Hello', text: 'Hi', idempotencyKey: KEY });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'owner@gmail.example' }), { idempotencyKey: KEY });
  });

  it('prefers a per-send replyTo over the driver-level default', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const driver = new ResendDriver({ apiKey: 're_test_key', replyTo: 'owner@gmail.example' });

    await driver.send({
      to: 'staff@example.test',
      from: 'no-reply@rab.example',
      replyTo: 'someone-else@example.test',
      subject: 'Hello',
      text: 'Hi',
      idempotencyKey: KEY,
    });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'someone-else@example.test' }), { idempotencyKey: KEY });
  });

  it('rejects when the from address is missing, without calling Resend at all', async () => {
    const driver = new ResendDriver({ apiKey: 're_test_key' });
    await expect(driver.send({ to: 'staff@example.test', subject: 'Hello', text: 'Hi', idempotencyKey: KEY })).rejects.toThrow(/from address/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects when neither html nor text content is given, without calling Resend at all', async () => {
    const driver = new ResendDriver({ apiKey: 're_test_key' });
    await expect(driver.send({ to: 'staff@example.test', from: 'no-reply@rab.example', subject: 'Hello', idempotencyKey: KEY })).rejects.toThrow(
      /html or text/i,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('surfaces an unverified-domain from address with a clear, actionable message', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'invalid_from_address', message: 'invalid `from` field', statusCode: 403 },
    });
    const driver = new ResendDriver({ apiKey: 're_test_key' });

    await expect(
      driver.send({ to: 'staff@example.test', from: 'issac90474@gmail.com', subject: 'Hello', text: 'Hi', idempotencyKey: KEY }),
    ).rejects.toThrow(/domain isn't verified in Resend/);
  });

  it('surfaces other Resend API errors with their name and message', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 },
    });
    const driver = new ResendDriver({ apiKey: 're_test_key' });

    await expect(
      driver.send({ to: 'staff@example.test', from: 'no-reply@rab.example', subject: 'Hello', text: 'Hi', idempotencyKey: KEY }),
    ).rejects.toThrow(/rate_limit_exceeded.*Too many requests/);
  });
});
