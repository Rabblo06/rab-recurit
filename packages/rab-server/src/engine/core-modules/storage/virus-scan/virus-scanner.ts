import { Injectable, Logger } from '@nestjs/common';
import { Socket, connect } from 'node:net';

import { EnvironmentService } from '../../environment/environment.service';

/**
 * Virus-scan verdict for one uploaded buffer. `clean` and `infected` come ONLY from a real scanner engine and carry its
 * name; anything else — no scanner configured, the daemon down, a timeout, a garbled reply — is `unavailable`, which the
 * caller must treat as "not scanned" (the file stays hidden). Nothing in this module can produce `clean` without the
 * scanner having said so.
 */
export type VirusScanVerdict =
  | { status: 'clean'; engine: string }
  | { status: 'infected'; engine: string; signature: string }
  | {
      status: 'unavailable';
      reason:
        'not_configured' | 'unreachable' | 'timeout' | 'protocol' | 'too_large';
    };

/** The pluggable hook. Register another implementation by replacing the VirusScanner provider; never stub `clean`. */
export interface VirusScannerPort {
  /** Engine name when a real scanner is configured, else null. */
  readonly engine: string | null;
  scan(buffer: Buffer): Promise<VirusScanVerdict>;
}

/** No scanner configured: every file is `unavailable` (stays not_scanned and hidden). */
export class NoVirusScanner implements VirusScannerPort {
  readonly engine = null;
  async scan(): Promise<VirusScanVerdict> {
    return { status: 'unavailable', reason: 'not_configured' };
  }
}

/**
 * ClamAV `clamd` over TCP, INSTREAM command (zero-terminated `zINSTREAM\0`, then <uint32 big-endian length><bytes> chunks,
 * ended by a zero-length chunk). Replies: `stream: OK` = clean, `stream: <signature> FOUND` = infected, anything else
 * (`... ERROR`, e.g. "INSTREAM size limit exceeded") = unavailable. Re-implemented from the clamd(8) protocol; no
 * third-party client.
 */
export class ClamavVirusScanner implements VirusScannerPort {
  readonly engine = 'clamav';
  private static readonly CHUNK = 64 * 1024;
  private static readonly MAX_REPLY = 4096;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
    private readonly connectFn: (port: number, host: string) => Socket = (
      port,
      host,
    ) => connect(port, host),
  ) {}

  scan(buffer: Buffer): Promise<VirusScanVerdict> {
    return new Promise((resolve) => {
      let settled = false;
      let reply = Buffer.alloc(0);
      const socket = this.connectFn(this.port, this.host);
      const finish = (verdict: VirusScanVerdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(verdict);
      };
      const timer = setTimeout(
        () => finish({ status: 'unavailable', reason: 'timeout' }),
        this.timeoutMs,
      );
      socket.once('error', () =>
        finish({ status: 'unavailable', reason: 'unreachable' }),
      );
      socket.on('data', (chunk: Buffer) => {
        reply = Buffer.concat([reply, chunk]);
        if (reply.length > ClamavVirusScanner.MAX_REPLY)
          finish({ status: 'unavailable', reason: 'protocol' });
        if (reply.includes(0))
          finish(
            this.parse(reply.subarray(0, reply.indexOf(0)).toString('utf8')),
          );
      });
      socket.once('end', () =>
        finish(this.parse(reply.toString('utf8').replace(/\0+$/, ''))),
      );
      socket.once('connect', () => {
        socket.write('zINSTREAM\0');
        for (
          let offset = 0;
          offset < buffer.length;
          offset += ClamavVirusScanner.CHUNK
        ) {
          const part = buffer.subarray(
            offset,
            offset + ClamavVirusScanner.CHUNK,
          );
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length, 0);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
      });
    });
  }

  /** Exact reply grammar only; anything unexpected is `protocol` (unavailable), never clean. */
  parse(line: string): VirusScanVerdict {
    const text = line.trim();
    if (text === 'stream: OK') return { status: 'clean', engine: this.engine };
    const found = /^stream: (.{1,200}) FOUND$/.exec(text);
    if (found)
      return { status: 'infected', engine: this.engine, signature: found[1]! };
    if (/size limit exceeded/i.test(text))
      return { status: 'unavailable', reason: 'too_large' };
    return { status: 'unavailable', reason: 'protocol' };
  }
}

/**
 * The injectable scanner: ClamAV when CLAMAV_HOST is set, otherwise NoVirusScanner. Logs verdict categories only (never
 * file names, ids or bytes).
 */
@Injectable()
export class VirusScanner implements VirusScannerPort {
  private readonly logger = new Logger(VirusScanner.name);
  private readonly impl: VirusScannerPort;

  constructor(env: EnvironmentService) {
    const host = env.get('CLAMAV_HOST');
    this.impl = host
      ? new ClamavVirusScanner(
          host,
          env.get('CLAMAV_PORT'),
          env.get('CLAMAV_TIMEOUT_MS'),
        )
      : new NoVirusScanner();
  }

  get engine(): string | null {
    return this.impl.engine;
  }

  async scan(buffer: Buffer): Promise<VirusScanVerdict> {
    let verdict: VirusScanVerdict;
    try {
      verdict = await this.impl.scan(buffer);
    } catch {
      verdict = { status: 'unavailable', reason: 'protocol' };
    }
    this.logger.log(
      JSON.stringify({
        operation: 'virus_scan',
        engine: this.impl.engine,
        status: verdict.status,
        reason: 'reason' in verdict ? verdict.reason : undefined,
      }),
    );
    return verdict;
  }
}
