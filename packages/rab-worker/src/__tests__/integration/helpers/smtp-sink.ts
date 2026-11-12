import { createServer, Server, Socket } from 'node:net';

export interface CapturedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  raw: string;
  attachments: CapturedAttachment[];
}

/**
 * A minimal but REAL SMTP server (RFC 5321 dialogue: EHLO/MAIL/RCPT/DATA/QUIT)
 * listening on loopback. It lets the application's real `SmtpDriver`
 * (nodemailer) hand a message to a real SMTP endpoint so tests can inspect the
 * exact MIME that goes over the wire — recipients, subject, attachment
 * filename, content type and bytes.
 *
 * This is a LOCAL SINK, not an external provider: it proves the application's
 * side of SMTP delivery (queue -> worker -> attachment loaded from storage ->
 * MIME -> SMTP handoff), and nothing about how a real provider treats it.
 */
/**
 * Per-recipient fault modes (email-twenty fault injection; default = accept, the original behaviour):
 *   tempfail         451 at RCPT, the reply echoing the mailbox as real servers do (transient)
 *   permfail         550 at RCPT, the reply echoing the mailbox (permanent)
 *   drop_after_data  receive the COMPLETE message, then destroy the socket with no reply
 *   hang_after_data  receive the COMPLETE message, then never reply (the client's own timeout ends it)
 * `n` = how many sessions get the fault before the recipient is accepted again (omitted = every session).
 */
export type SmtpFaultMode = 'tempfail' | 'permfail' | 'drop_after_data' | 'hang_after_data';

/** One complete message the sink received (the final "."), whatever it then answered: a real provider may have delivered it. */
export interface SmtpTransmission {
  to: string[];
  outcome: 'accepted' | 'dropped' | 'hung';
}

export class SmtpSink {
  readonly mails: CapturedMail[] = [];
  /** Every complete message received, accepted or not — two for one recipient is a duplicate email. */
  readonly transmissions: SmtpTransmission[] = [];
  /** RCPT replies the sink refused (recipient in lower case). */
  readonly rejections: Array<{ to: string; code: number }> = [];
  private readonly faults = new Map<string, { mode: SmtpFaultMode; n?: number; used: number }>();
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  port = 0;

  setFault(recipient: string, mode: SmtpFaultMode, n?: number): void {
    this.faults.set(recipient.toLowerCase(), { mode, n, used: 0 });
  }

  clearFault(recipient: string): void {
    this.faults.delete(recipient.toLowerCase());
  }

  transmissionsTo(recipient: string): SmtpTransmission[] {
    return this.transmissions.filter((t) => t.to.some((x) => x.toLowerCase() === recipient.toLowerCase()));
  }

  private faultFor(recipient: string): SmtpFaultMode | null {
    const fault = this.faults.get(recipient.toLowerCase());
    if (!fault || (fault.n !== undefined && fault.used >= fault.n)) return null;
    return fault.mode;
  }

  private consumeFault(recipient: string): void {
    const fault = this.faults.get(recipient.toLowerCase());
    if (fault) fault.used += 1;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  mailsTo(recipient: string): CapturedMail[] {
    return this.mails.filter((m) => m.to.some((t) => t.toLowerCase() === recipient.toLowerCase()));
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    let hung = false;
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 rab-smtp-sink ESMTP ready');

    socket.on('data', (chunk) => {
      if (hung) return; // hang_after_data: nothing this session sends is ever answered
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) {
            // keep accumulating; never grow unbounded
            if (buffer.length > 30 * 1024 * 1024) socket.destroy();
            return;
          }
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const afterData = to.map((r) => this.faultFor(r)).find((m) => m === 'drop_after_data' || m === 'hang_after_data');
          if (afterData) {
            for (const r of to) this.consumeFault(r);
            this.transmissions.push({ to: [...to], outcome: afterData === 'drop_after_data' ? 'dropped' : 'hung' });
            if (afterData === 'drop_after_data') socket.destroy();
            else hung = true;
            buffer = '';
            return; // hung: this session is never answered again
          }
          this.transmissions.push({ to: [...to], outcome: 'accepted' });
          this.mails.push(this.parse(from, to, data));
          from = '';
          to = [];
          send('250 2.0.0 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-rab-smtp-sink\r\n250-8BITMIME\r\n250 SIZE 31457280\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          send('250 2.1.0 ok');
        } else if (upper.startsWith('RCPT TO')) {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? '';
          const fault = this.faultFor(rcpt);
          if (fault === 'tempfail' || fault === 'permfail') {
            this.consumeFault(rcpt);
            const code = fault === 'tempfail' ? 451 : 550;
            this.rejections.push({ to: rcpt.toLowerCase(), code });
            send(code === 451 ? `451 4.7.1 <${rcpt}>: Recipient address rejected: try again later` : `550 5.1.1 <${rcpt}>: Recipient address rejected: User unknown`);
          } else {
            to.push(rcpt);
            send('250 2.1.5 ok');
          }
        } else if (upper === 'DATA') {
          inData = true;
          send('354 end data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          send('221 bye');
          socket.end();
          return;
        } else if (upper === 'RSET' || upper === 'NOOP') {
          send('250 ok');
        } else {
          send('250 ok');
        }
      }
    });
  }

  private parse(from: string, to: string[], raw: string): CapturedMail {
    // Un-stuff leading dots (RFC 5321 §4.5.2).
    const text = raw.replace(/\r\n\.\./g, '\r\n.');
    const headerEnd = text.indexOf('\r\n\r\n');
    const headers = text.slice(0, headerEnd).replace(/\r\n[ \t]+/g, ' ');
    const subject = /^Subject:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? '';
    const decodedSubject = decodeMimeWords(subject);
    const attachments: CapturedAttachment[] = [];
    const boundaries = [...text.matchAll(/boundary="?([^"\r\n;]+)"?/gi)].map((m) => m[1]!);
    for (const boundary of boundaries) {
      for (const part of text.split(`--${boundary}`)) {
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd === -1) continue;
        const partHeaders = part.slice(0, partHeaderEnd).replace(/\r\n[ \t]+/g, ' ');
        const disposition = /Content-Disposition:\s*attachment;[^\r\n]*filename="?([^";\r\n]+)"?/i.exec(partHeaders);
        if (!disposition) continue;
        const contentType = /Content-Type:\s*([^;\r\n]+)/i.exec(partHeaders)?.[1]?.trim() ?? '';
        const encoding = /Content-Transfer-Encoding:\s*(\S+)/i.exec(partHeaders)?.[1]?.toLowerCase() ?? '7bit';
        const body = part.slice(partHeaderEnd + 4).replace(/\r\n$/, '');
        const content = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'latin1');
        attachments.push({ filename: disposition[1]!, contentType, content });
      }
    }
    return { from, to, subject: decodedSubject, raw: text, attachments };
  }
}

/** RFC 2047 encoded-words (`=?utf-8?B?…?=` and `=?utf-8?Q?…?=`), adjacent words joined without the folding space. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, kind: string, enc: string) => {
      if (kind.toLowerCase() === 'b') return Buffer.from(enc, 'base64').toString('utf8');
      const bytes: number[] = [];
      const text = enc.replace(/_/g, ' ');
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(text.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    });
}
