import { AddressInfo, createServer, Server, Socket } from 'node:net';

import { SMTP_TIMEOUTS, SmtpDriver } from './smtp.driver';

/**
 * D5 (D0-C §4.5): nodemailer's socketTimeout defaulted to 10 minutes — equal to the email PROCESSING lease — so a stalled
 * DATA phase raced lease recovery. Every SMTP wait is now bounded well below the lease, and the whole send has a hard
 * deadline. A LOCAL fake SMTP server (net) stands in for the provider; nothing leaves the machine.
 */
type Mode = 'ok' | 'no-greeting' | 'stall-after-data' | 'reject-rcpt' | 'busy-rcpt';

async function fakeSmtp(mode: Mode): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    if (mode === 'no-greeting') return;
    socket.write('220 fake.test ESMTP\r\n');
    let inData = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (mode === 'stall-after-data') return; // accepted the bytes, never answers
            socket.write('250 2.0.0 queued as fake\r\n');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 fake.test\r\n');
        else if (verb === 'MAIL') socket.write('250 2.1.0 ok\r\n');
        else if (verb === 'RCPT') {
          if (mode === 'reject-rcpt') socket.write('550 5.1.1 user unknown\r\n');
          else if (mode === 'busy-rcpt') socket.write('451 4.7.1 try again later\r\n');
          else socket.write('250 2.1.5 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else if (verb === 'RSET') socket.write('250 ok\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const mail = { to: 'staff@example.test', from: 'no-reply@example.test', subject: 'S', text: 'T', idempotencyKey: 'email-outbox:11111111-1111-4111-8111-111111111111' };
const short = { connectionTimeoutMs: 300, greetingTimeoutMs: 300, socketTimeoutMs: 300, sendDeadlineMs: 600 };

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; error: unknown }> {
  const started = Date.now();
  try {
    await fn();
    return { ms: Date.now() - started, error: null };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

describe('SmtpDriver timeouts (D5)', () => {
  it('every SMTP wait and the whole send are bounded well below the email PROCESSING lease (and the 30 s D4 target)', () => {
    expect(SMTP_TIMEOUTS).toEqual({ connectionTimeoutMs: 10_000, greetingTimeoutMs: 10_000, socketTimeoutMs: 20_000, sendDeadlineMs: 25_000 });
    expect(SMTP_TIMEOUTS.sendDeadlineMs).toBeLessThan(30_000);
    const options = (new SmtpDriver({ host: '127.0.0.1', port: 2525 }) as unknown as { transport: { options: Record<string, unknown> } }).transport.options;
    expect(options).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  });

  it('a server that never greets fails the send (retryable network-class error), it does not hang', async () => {
    const smtp = await fakeSmtp('no-greeting');
    try {
      const { ms, error } = await timed(() => new SmtpDriver({ host: '127.0.0.1', port: smtp.port, ignoreTLS: true }, short).send(mail));
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toMatch(/ETIMEDOUT|ECONNECTION|ESOCKET/);
      expect(ms).toBeLessThan(3_000);
    } finally {
      await smtp.close();
    }
  });

  it('a server that stalls after DATA hits the send deadline (code ETIMEDOUT) instead of the old 10-minute socket timeout', async () => {
    const smtp = await fakeSmtp('stall-after-data');
    try {
      const { ms, error } = await timed(() => new SmtpDriver({ host: '127.0.0.1', port: smtp.port, ignoreTLS: true }, short).send(mail));
      expect((error as { code?: string }).code).toBe('ETIMEDOUT');
      expect(ms).toBeLessThan(3_000);
    } finally {
      await smtp.close();
    }
  });

  it('nodemailer 10 error shapes reach the classifier: 550 permanent, 451 transient', async () => {
    for (const [mode, code, permanent] of [['reject-rcpt', 550, true], ['busy-rcpt', 451, false]] as const) {
      const smtp = await fakeSmtp(mode);
      try {
        const { error } = await timed(() => new SmtpDriver({ host: '127.0.0.1', port: smtp.port, ignoreTLS: true }, short).send(mail));
        expect(error).toMatchObject({ code: 'EENVELOPE', responseCode: code, permanent });
      } finally {
        await smtp.close();
      }
    }
  });

  it('a healthy server still delivers', async () => {
    const smtp = await fakeSmtp('ok');
    try {
      await expect(new SmtpDriver({ host: '127.0.0.1', port: smtp.port, ignoreTLS: true }, short).send(mail)).resolves.toMatchObject({ provider: 'SMTP' });
    } finally {
      await smtp.close();
    }
  });
});
