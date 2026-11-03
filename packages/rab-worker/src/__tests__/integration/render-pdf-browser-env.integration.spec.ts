import { readdirSync, readFileSync } from 'fs';

import { renderHtmlToPdf } from '../../queues/rab-reports/render-pdf.util';
import { inspectPdf } from '../helpers/pdf-inspect';

/**
 * Docker hardening H6 — the browser process never holds the Worker's credentials.
 *
 * Renders a REAL PDF with credential-shaped markers in this process's environment (as the jobs child has PG_DATABASE_URL,
 * REDIS_URL, APP_SECRET, S3 and SMTP secrets) and, while Chromium runs, reads /proc/<pid>/environ of every Chromium process
 * (same uid, so readable). Before H6 the browser process inherited all of them (Playwright's default env = process.env).
 * Linux only (/proc); other platforms skip.
 */
jest.setTimeout(180_000);

const MARK = 'H6BROWSERENVMARKER';
const CREDENTIALS: Record<string, string> = {
  PG_DATABASE_URL: `postgres://crewflow_app:${MARK}-pg@db:5432/rab`,
  REDIS_URL: `redis://:${MARK}-redis@redis:6379`,
  APP_SECRET: `${MARK}-app`,
  S3_SECRET_ACCESS_KEY: `${MARK}-s3`,
  EMAIL_SMTP_PASSWORD: `${MARK}-smtp`,
  SENTRY_DSN: `https://${MARK}@sentry.invalid/1`,
};
const onLinux = process.platform === 'linux';

interface Seen {
  type: string;
  markers: string[];
}

function scanChromium(into: Map<number, Seen>): void {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmd: string;
    let env: string;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/chrom|headless_shell/i.test(cmd)) continue;
      env = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue; // gone, or not ours
    }
    const type = /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser';
    const markers = env.split('\0').filter((kv) => kv.includes(MARK)).map((kv) => kv.split('=')[0]);
    into.set(pid, { type, markers });
  }
}

(onLinux ? describe : describe.skip)('render-pdf: the browser process environment (H6)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(CREDENTIALS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a real render: no Chromium process carries any credential from the parent environment', async () => {
    const seen = new Map<number, Seen>();
    const timer = setInterval(() => scanChromium(seen), 10);
    let pdf: Buffer;
    try {
      pdf = await renderHtmlToPdf('<h1>H6 browser env</h1><p>static content</p>');
    } finally {
      clearInterval(timer);
    }
    expect(inspectPdf(pdf).text).toContain('H6 browser env');
    const processes = [...seen.values()];
    // The scan must have seen the browser itself, or the assertion below would prove nothing.
    expect(processes.some((p) => p.type === 'browser')).toBe(true);
    expect(processes.filter((p) => p.markers.length > 0)).toEqual([]);
  });
});
