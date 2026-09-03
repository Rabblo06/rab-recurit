import { Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import type { NetworkInterfaceInfo } from 'node:os';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface } from './interfaces/email-driver.interface';

export interface SmtpDriverOptions {
  host: string;
  port: number;
  secure?: boolean;
  ignoreTLS?: boolean;
  auth?: { user: string; pass: string };
}

/**
 * nodemailer (9.x) has no `family`/IPv4-only transport option — its own
 * `lib/shared` resolver always looks up both A and AAAA records and picks a
 * RANDOM address from the combined list (confirmed by reading
 * node_modules/nodemailer/lib/shared/index.js: `formatDNSValue` does
 * `addresses[Math.floor(Math.random() * addresses.length)]`). On a host with
 * no real outbound IPv6 route (Render's containers) but a network interface
 * that still self-reports an IPv6 family (common — a non-routable
 * link-local/overlay address, not marked `internal` by Node), that resolver
 * happily includes AAAA results and connects to them ~50% of the time,
 * producing exactly the intermittent `ENETUNREACH` seen in production.
 *
 * There is no supported way to disable this from transport options — the
 * only lever is `lib/shared`'s own exported, mutable `networkInterfaces`
 * snapshot, which its `isFamilySupported(6, ...)` check reads directly. We
 * patch it once, process-wide, to drop every IPv6-family entry so
 * `isFamilySupported(6)` always reports false and AAAA lookups never even
 * run. This reaches into an undocumented nodemailer internal (not its
 * public API) — if a future nodemailer version changes this shape, the
 * `catch` below fails open (logged, not silent) rather than crashing email
 * delivery entirely.
 */
let ipv6ResolutionPatched = false;
function disableSmtpIpv6Resolution(logger: Logger): void {
  if (ipv6ResolutionPatched) return;
  ipv6ResolutionPatched = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailerShared = require('nodemailer/lib/shared') as {
      networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
    };
    const real = nodemailerShared.networkInterfaces;
    if (!real) return;
    const ipv4Only: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
    for (const [name, addresses] of Object.entries(real)) {
      ipv4Only[name] = (addresses ?? []).filter((addr) => addr.family !== 'IPv6');
    }
    nodemailerShared.networkInterfaces = ipv4Only;
  } catch (error) {
    logger.error('Could not disable IPv6 SMTP resolution — nodemailer internals may have changed; ENETUNREACH risk remains.', error as Error);
  }
}

export class SmtpDriver implements EmailDriverInterface {
  private readonly transport: Transporter;
  private readonly logger = new Logger(SmtpDriver.name);

  constructor(options: SmtpDriverOptions) {
    disableSmtpIpv6Resolution(this.logger);
    this.transport = nodemailer.createTransport(options);
  }

  /**
   * Awaits the send and does not catch — a failure rejects this promise so
   * the caller (EmailService, and beyond it whoever called EmailService)
   * knows delivery failed, rather than it being silently swallowed here.
   */
  async send(options: EmailSendOptions): Promise<void> {
    await this.transport.sendMail({
      to: options.to,
      from: options.from,
      replyTo: options.replyTo,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }
}
