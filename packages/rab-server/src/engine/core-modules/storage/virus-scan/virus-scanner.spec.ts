import { AddressInfo, createServer, Server, Socket } from 'node:net';

import {
  ClamavVirusScanner,
  NoVirusScanner,
  VirusScanner,
} from './virus-scanner';

/** A fake clamd that parses INSTREAM exactly and answers with `reply(bytes)` — proves framing, not ClamAV itself. */
function fakeClamd(
  reply: (received: Buffer) => string | null,
): Promise<{
  server: Server;
  port: number;
  received: () => Buffer;
  command: () => string;
}> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    let command = '';
    const server = createServer((socket: Socket) => {
      let buf = Buffer.alloc(0);
      let headerDone = false;
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!headerDone) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          command = buf.subarray(0, nul).toString();
          buf = buf.subarray(nul + 1);
          headerDone = true;
        }
        for (;;) {
          if (buf.length < 4) return;
          const size = buf.readUInt32BE(0);
          if (size === 0) {
            const answer = reply(received);
            if (answer !== null) socket.end(`${answer}\0`);
            return;
          }
          if (buf.length < 4 + size) return;
          received = Buffer.concat([received, buf.subarray(4, 4 + size)]);
          buf = buf.subarray(4 + size);
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        received: () => received,
        command: () => command,
      }),
    );
  });
}

describe('virus scanning (pluggable; never clean without a real scan)', () => {
  it('no scanner configured: every file is unavailable, never clean', async () => {
    await expect(new NoVirusScanner().scan()).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_configured',
    });
    const env = { get: (k: string) => (k === 'CLAMAV_HOST' ? undefined : 0) };
    const scanner = new VirusScanner(env as never);
    expect(scanner.engine).toBeNull();
    await expect(scanner.scan(Buffer.from('%PDF-1.4'))).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_configured',
    });
  });

  it('ClamAV INSTREAM: streams every byte in framed chunks and maps "stream: OK" to clean', async () => {
    const fake = await fakeClamd(() => 'stream: OK');
    const bytes = Buffer.alloc(150 * 1024, 7); // > 2 chunks
    try {
      await expect(
        new ClamavVirusScanner('127.0.0.1', fake.port, 5000).scan(bytes),
      ).resolves.toEqual({ status: 'clean', engine: 'clamav' });
      expect(fake.command()).toBe('zINSTREAM');
      expect(fake.received().equals(bytes)).toBe(true);
    } finally {
      fake.server.close();
    }
  });

  it('maps "<sig> FOUND" to infected with the signature', async () => {
    const fake = await fakeClamd(() => 'stream: Eicar-Signature FOUND');
    try {
      await expect(
        new ClamavVirusScanner('127.0.0.1', fake.port, 5000).scan(
          Buffer.from('X5O!P%@AP'),
        ),
      ).resolves.toEqual({
        status: 'infected',
        engine: 'clamav',
        signature: 'Eicar-Signature',
      });
    } finally {
      fake.server.close();
    }
  });

  it('an ERROR reply, a garbled reply, a dead daemon and a silent daemon are all unavailable — never clean', async () => {
    const error = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    const garbled = await fakeClamd(() => 'stream: OKAY');
    const silent = await fakeClamd(() => null);
    try {
      await expect(
        new ClamavVirusScanner('127.0.0.1', error.port, 5000).scan(
          Buffer.from('a'),
        ),
      ).resolves.toEqual({ status: 'unavailable', reason: 'too_large' });
      await expect(
        new ClamavVirusScanner('127.0.0.1', garbled.port, 5000).scan(
          Buffer.from('a'),
        ),
      ).resolves.toEqual({ status: 'unavailable', reason: 'protocol' });
      await expect(
        new ClamavVirusScanner('127.0.0.1', silent.port, 300).scan(
          Buffer.from('a'),
        ),
      ).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
    } finally {
      error.server.close();
      garbled.server.close();
      silent.server.close();
    }
    const closed = await fakeClamd(() => 'stream: OK');
    const port = closed.port;
    await new Promise((r) => closed.server.close(r));
    await expect(
      new ClamavVirusScanner('127.0.0.1', port, 2000).scan(Buffer.from('a')),
    ).resolves.toEqual({ status: 'unavailable', reason: 'unreachable' });
  });

  it('parse accepts only the exact grammar', () => {
    const s = new ClamavVirusScanner('h', 1, 1);
    expect(s.parse('stream: OK').status).toBe('clean');
    expect(s.parse('OK').status).toBe('unavailable');
    expect(s.parse('stream: OK FOUND').status).toBe('infected');
    expect(s.parse('').status).toBe('unavailable');
  });
});
