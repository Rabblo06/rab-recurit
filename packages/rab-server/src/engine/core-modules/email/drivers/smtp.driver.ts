import { Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import type { NetworkInterfaceInfo } from 'node:os';

import { EmailSendOptions } from '../interfaces/email-send-options.interface';
import { EmailDriverInterface, EmailSendResult } from './interfaces/email-driver.interface';

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
  readonly name = 'SMTP';
  /**
   * false, deliberately: plain SMTP has no server-side deduplication of any
   * kind. The deterministic Message-ID built in `send()` below aids
   * downstream tracing/correlation only — it does NOT make a retried send
   * after an ambiguous outcome safe to assume the recipient's mail system
   * will collapse into one message. Never claim otherwise (see this
   * project's own rule against writing "exactly once delivery" comments
   * while SMTP remains a supported driver).
   */
  readonly ambiguousDeliverySafeToRetry = false;
  private readonly transport: Transporter;
  private readonly logger = new Logger(SmtpDriver.name);

  constructor(options: SmtpDriverOptions) {
    disableSmtpIpv6Resolution(this.logger);
    // nodemailer's own defaults are 2 minutes to establish a connection and
    // 30 seconds for the server greeting — reasonable for a human waiting on
    // a desktop mail client, not for an HTTP request a console user is
    // watching spin. A legitimate SMTP handshake completes in well under a
    // second; a network path that's actually blocked (e.g. a PaaS host
    // silently dropping outbound port 587, as opposed to an active refusal
    // or unreachable-host error, which fail fast on their own) should fail
    // in ~15s, not leave `sendAccountInvite` — and the request that called
    // it — hanging for two minutes before the caller's own prepare()/
    // commit() gating even finds out delivery didn't happen.
    this.transport = nodemailer.createTransport({ ...options, connectionTimeout: 15_000, greetingTimeout: 15_000 });
  }

  /**
   * Awaits the send and does not catch — a failure rejects this promise so
   * the caller (EmailService, and beyond it whoever called EmailService)
   * knows delivery failed, rather than it being silently swallowed here.
   *
   * `messageId` is a deterministic RFC Message-ID derived from the stable
   * `idempotencyKey` (`<email-outbox-{uuid}@{fromDomain}>`) — the SAME value
   * on every attempt of the same logical email, for tracing/correlation
   * only (see `ambiguousDeliverySafeToRetry`'s doc comment: this is NOT a
   * delivery-dedup mechanism).
   */
  async send(options: EmailSendOptions): Promise<EmailSendResult> {
    const fromDomain = (options.from ?? '').split('@')[1] ?? 'localhost';
    const messageId = `<email-outbox-${options.idempotencyKey.replace(/[^a-zA-Z0-9:-]/g, '')}@${fromDomain}>`;
    const info = await this.transport.sendMail({
      to: options.to,
      from: options.from,
      replyTo: options.replyTo,
      subject: options.subject,
      html: options.html,
      text: options.text,
      attachments: options.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      messageId,
    });
    return { provider: this.name, providerMessageId: info.messageId ?? messageId };
  }
}
