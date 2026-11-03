import { readdirSync, readFileSync } from 'fs';

import { renderHtmlToPdf } from '../../queues/rab-reports/render-pdf.util';
import { inspectPdf } from '../helpers/pdf-inspect';

/**
 * Owner decision 2026-11-03 ("require the Chromium OS sandbox"): a REAL render must run its renderer processes inside
 * Chromium's namespace sandbox. Proof read from the kernel while Chromium runs (/proc/<pid>/status is world-readable):
 *   - NSpid lists MORE pid levels than this test process → the renderer is in its own (nested) PID namespace;
 *   - Seccomp_filters is GREATER than this process's → Chromium installed its seccomp-BPF policy on top.
 * Before the change every renderer had the same NSpid depth and filter count as its parent (`--no-sandbox`).
 * Linux only. The Worker image's own proof (Alpine Chromium under the Worker seccomp profile) is the image gate's PDF
 * render and the H6 runtime matrix.
 */
jest.setTimeout(180_000);

const onLinux = process.platform === 'linux';

interface Renderer {
  pid: number;
  nspidLevels: number;
  seccomp: number;
  filters: number;
}

function statusOf(pid: number | 'self'): { nspidLevels: number; seccomp: number; filters: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(s) || [])[1]?.trim() ?? '';
    return { nspidLevels: field('NSpid').split(/\s+/).filter(Boolean).length, seccomp: Number(field('Seccomp') || 0), filters: Number(field('Seccomp_filters') || 0) };
  } catch {
    return null;
  }
}

function scanRenderers(into: Map<number, Renderer>): void {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!/--type=renderer/.test(cmd)) continue;
    const st = statusOf(pid);
    if (st) into.set(pid, { pid, ...st });
  }
}

(onLinux ? describe : describe.skip)('render-pdf: renderers run inside the Chromium OS sandbox (required)', () => {
  it('a real render: every renderer has its own PID namespace and Chromium seccomp-BPF filters; the PDF is correct', async () => {
    const self = statusOf('self');
    expect(self).not.toBeNull();
    const seen = new Map<number, Renderer>();
    const timer = setInterval(() => scanRenderers(seen), 10);
    let pdf: Buffer;
    try {
      pdf = await renderHtmlToPdf('<h1>Sandboxed render</h1><p>static content</p>');
    } finally {
      clearInterval(timer);
    }
    expect(inspectPdf(pdf).text).toContain('Sandboxed render');
    const renderers = [...seen.values()];
    expect(renderers.length).toBeGreaterThan(0);
    for (const r of renderers) {
      expect(r.nspidLevels).toBeGreaterThan(self!.nspidLevels);
      expect(r.seccomp).toBe(2);
      expect(r.filters).toBeGreaterThan(self!.filters);
    }
  });
});
