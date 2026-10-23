import { execFileSync } from 'node:child_process';

import { COMPOSE_PROJECT } from './env';

export interface LoggedEmail {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  links: string[];
}

/**
 * Reads the emails the worker "sent" through EMAIL_DRIVER=LOGGER on the disposable stack (the worker's own container log —
 * the same place an operator would look). Never reads any other container.
 */
export function readWorkerEmails(): LoggedEmail[] {
  const raw = execFileSync('docker', ['logs', `${COMPOSE_PROJECT}-worker-1`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // docker logs writes stdout and stderr separately; the email lines are on stdout.
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const parts = text.split('Email not sent (EMAIL_DRIVER=LOGGER) — ').slice(1);
  return parts.map((p) => {
    const head = p.split('\n')[0] ?? '';
    const key = head.match(/idempotencyKey: ([^,]+)/)?.[1] ?? '';
    const to = head.match(/to: ([^,]+)/)?.[1]?.trim() ?? '';
    const subject = head.match(/subject: (.*)$/)?.[1]?.trim() ?? '';
    const body = p.split('\nhtml:')[0] ?? p;
    const links = [...new Set(body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
    return { idempotencyKey: key, to: to.toLowerCase(), subject, text: body, links };
  });
}

export function emailsTo(address: string): LoggedEmail[] {
  return readWorkerEmails().filter((e) => e.to === address.toLowerCase());
}

/** Waits for an email to `address` whose link matches `linkPattern`, returns the newest such link. */
export async function waitForLink(address: string, linkPattern: RegExp, timeoutMs = 90_000, notBefore = 0): Promise<{ link: string; email: LoggedEmail }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mails = emailsTo(address).slice(notBefore);
    for (let i = mails.length - 1; i >= 0; i--) {
      const link = mails[i]!.links.find((l) => linkPattern.test(l));
      if (link) return { link, email: mails[i]! };
    }
    if (Date.now() > deadline) throw new Error(`no email to ${address} with a link matching ${linkPattern} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export function tokenFrom(link: string): string {
  const u = new URL(link);
  const t = u.searchParams.get('token') ?? new URLSearchParams(u.hash.replace(/^#/, '')).get('token');
  if (!t) throw new Error(`no token in ${link}`);
  return t;
}
