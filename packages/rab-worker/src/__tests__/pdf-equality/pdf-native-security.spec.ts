import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

import { checkAgainstInput } from './checker';
import { expectationFor, ReportDocument } from './documents';
import { compact } from './extract';
import { buildFixtures, FixtureDocument } from './fixtures';
import { loadGlyphTransform } from './glyph-transform';
import { extractFixture, outDir, saveArtifact } from './harness';
import { NATIVE_ONLY } from './mode';
import { nativeExpectation } from './native-reference';
import { chromiumUnavailable, loadNativeRenderer, Renderer } from './renderers';

/**
 * NATIVE RENDERER SECURITY AND CORRECTNESS — the native equivalents of the Chromium-only specs that P5 deletes
 * (`queues/rab-reports/render-pdf.util.spec.ts`, `__tests__/integration/render-pdf-hardening`, `-sandbox-footer`,
 * `-browser-env` and `final-timesheet-renderer-parity`). The assertion-by-assertion mapping is in
 * `scratchpad/final/REPORT-agentB.md` (task 5) and in each test's name.
 *
 * Every case renders REAL documents (the harness fixtures, hostile ones included) through the PRODUCTION seam:
 * `renderReportPdf(doc, { PDF_RENDERER: 'native' })` → `renderNativePdf` (view-model built in the jobs process) →
 * `renderInPool`. That last call is routed (jest.spyOn) to a `NativeRenderPool` of the same class, with the production
 * document registry and the production thread entry, created here with `allowProbe: true` so its thread can report what
 * it saw: its environment, the modules and globals its guard refused, and the network builtins it loaded. Production
 * threads never answer a probe; nothing else differs.
 *
 * Skips without the native renderer (origin/main); PDF_EQUALITY_REQUIRE_NATIVE=1 turns that into a failure.
 *
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-native-security
 */
jest.setTimeout(10 * 60_000);

const OUT = outDir('native-security');
const REQUIRE = process.env.PDF_EQUALITY_REQUIRE_NATIVE === '1';
const native = loadNativeRenderer();

const RUNTIME = join(__dirname, '..', '..', 'queues', 'rab-reports', 'native', 'runtime');
interface ProbeReport {
  envKeys: string[];
  blockedModules: string[];
  blockedGlobals: string[];
  networkBuiltinsLoaded: string[];
}
interface PoolLike {
  render(request: unknown): Promise<Buffer>;
  probe(): Promise<ProbeReport>;
  destroy(): Promise<void>;
  stats(): { live: number };
}
interface PoolModule {
  NativeRenderPool: new (options: Record<string, unknown>) => PoolLike;
  renderInPool: (request: unknown) => Promise<Buffer>;
}

/** 1×1 PNG: no document image has this size, so "a 1×1 image is embedded" means it was loaded. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const quiet = { log: () => undefined, warn: () => undefined };

/** Credential-shaped values in this process's environment while the pool starts its threads (as in the jobs process). */
const MARK = 'NATIVEENVMARKER';
const CREDENTIALS: Record<string, string> = {
  PG_DATABASE_URL: `postgres://crewflow_app:${MARK}-pg@db:5432/rab`,
  REDIS_URL: `redis://:${MARK}-redis@redis:6379`,
  APP_SECRET: `${MARK}-app`,
  S3_SECRET_ACCESS_KEY: `${MARK}-s3`,
  EMAIL_SMTP_PASSWORD: `${MARK}-smtp`,
  SENTRY_DSN: `https://${MARK}@sentry.invalid/1`,
};

/** Clone with one change: a test mutation of render INPUT (free text only), never a recomputation. */
function mutate(doc: ReportDocument, change: (d: ReportDocument) => void): ReportDocument {
  const copy = { ...doc, data: structuredClone(doc.data) } as ReportDocument;
  change(copy);
  return copy;
}

/** pdfkit's date form of `generatedAt` (D7: the PDF creation date is the document's generatedAt, never the wall clock). */
function pdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

if ('unavailable' in native) {
  (REQUIRE ? describe : describe.skip)('native renderer security (renderer unavailable)', () => {
    it('native renderer is available', () => {
      throw new Error(native.unavailable);
    });
  });
} else {
  describe('native renderer: security and correctness through the production seam (replaces the Chromium-only specs)', () => {
    const renderer: Renderer = native;
    let poolModule: PoolModule;
    let pool: PoolLike;
    const saved: Record<string, string | undefined> = {};
    let server: Server;
    let base = '';
    let connections = 0;
    const requests: string[] = [];
    const sockets = new Set<Socket>();
    let dir: string;
    const fileUrl = (name: string) => pathToFileURL(join(dir, name)).href;
    let fixtures: Map<string, FixtureDocument>;

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      poolModule = require(join(RUNTIME, 'render-pool')) as PoolModule;
      for (const [k, v] of Object.entries(CREDENTIALS)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      pool = new poolModule.NativeRenderPool({ size: 2, allowProbe: true, logger: quiet });
      jest.spyOn(poolModule, 'renderInPool').mockImplementation((request) => pool.render(request));

      server = createServer((req, res) => {
        requests.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_1X1);
      });
      server.on('connection', (s) => {
        connections++;
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      dir = mkdtempSync(join(tmpdir(), 'rab-native-pdf-security-'));
      writeFileSync(join(dir, 'pixel.png'), PNG_1X1);
      writeFileSync(join(dir, 'local.css'), 'body::after { content: "LOCAL-FILE-CSS-MARKER"; }');
      writeFileSync(join(dir, 'local.html'), '<p>LOCAL-FILE-HTML-MARKER</p>');
      fixtures = new Map((await buildFixtures({ hostileBase: base, scenarios: ['hostile', 'one-row', 'rows-500'] })).map((f) => [f.id, f]));
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      await pool?.destroy();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /** Renders through the seam and checks the document is printed literally and completely (F1 expectation). */
    async function renderChecked(id: string, doc: ReportDocument): Promise<ReturnType<typeof extractFixture>> {
      const f = fixtures.get(id)!;
      const pdf = await renderer.render(doc);
      saveArtifact(OUT, `${id}--${doc === f.doc ? 'fixture' : 'variant'}`, 'pdf', pdf);
      const x = extractFixture(f, pdf);
      const glyphs = await loadGlyphTransform();
      if ('unavailable' in glyphs) throw new Error(glyphs.unavailable);
      const failing = checkAgainstInput(await nativeExpectation(expectationFor(doc), glyphs.transform), x, 'native', { boundsStrict: ['native'], forcedBreakHyphens: ['native'] }).filter(
        (c) => !c.ok && !c.info,
      );
      expect(failing.map((c) => `${c.check}: ${c.detail}`)).toEqual([]);
      return x;
    }

    // ─── replaces render-pdf.util.spec (H6 allowlist) and render-pdf-browser-env ───────────────────────────────────

    it('no credential reaches the renderer: the render thread environment is EMPTY although this process holds credential-shaped values', async () => {
      const x = await renderChecked('hostile/final-timesheet', fixtures.get('hostile/final-timesheet')!.doc);
      const report = await pool.probe();
      expect(report.envKeys).toEqual([]);
      expect(Object.keys(CREDENTIALS).every((k) => process.env[k]?.includes(MARK))).toBe(true); // the markers were really set
      expect(x.text).not.toContain(MARK);
    });

    // ─── replaces render-pdf-hardening (a) JavaScript, (b) network, (c) local files; sandbox-footer S-7 / S-9 ────────

    it('no JavaScript: script, inline handlers and javascript: URLs are printed as text, and the PDF has no script, action or form key', async () => {
      const doc = mutate(fixtures.get('one-row/final-timesheet')!.doc, (d) => {
        if (d.kind !== 'final-timesheet') return;
        d.data.notes = `<script>document.title='REWRITTEN-BY-SCRIPT'; for (let i = 0; i < 3; i++) document.body.append('SCRIPT-PAGE-' + i)</script>` +
          `<body onload="this.textContent='REWRITTEN-BY-ONLOAD'"> <iframe src="javascript:'JAVASCRIPT-URL-MARKER'"></iframe>`;
      });
      const x = await renderChecked('one-row/final-timesheet', doc);
      expect(compact(x.text)).toContain(compact(`<script>document.title='REWRITTEN-BY-SCRIPT';`));
      expect(x.activeContentKeys).toEqual([]);
      expect(x.pageCount).toBe(1); // the script, had it run, would have added content and pages
    });

    it('no network: every hostile URL (body, notes, footer workspace, meta refresh) points at a local listener that sees zero connections; the thread guard refused nothing and loaded no network module', async () => {
      connections = 0;
      requests.length = 0;
      const footerLiteral = `<img src="${base}/f.png">`;
      for (const id of ['hostile/final-timesheet-original', 'hostile/final-timesheet', 'hostile/pre-shift-report', 'hostile/approved-shift-statement']) {
        const f = fixtures.get(id)!;
        const doc =
          f.doc.kind === 'approved-shift-statement'
            ? f.doc
            : mutate(f.doc, (d) => {
                if (d.kind !== 'approved-shift-statement') d.data.workspaceName = footerLiteral; // S-9: references inside the FOOTER
              });
        const x = await renderChecked(id, doc);
        expect(x.activeContentKeys).toEqual([]);
        expect(x.images.every((i) => !(i.width === 1 && i.height === 1))).toBe(true);
        if (f.doc.kind !== 'approved-shift-statement') {
          for (const p of x.pages) expect(compact(p.footer ?? '')).toContain(compact(footerLiteral)); // printed literally on every page
        }
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(requests).toEqual([]);
      expect(connections).toBe(0);
      const report = await pool.probe();
      expect(report.blockedModules).toEqual([]);
      expect(report.networkBuiltinsLoaded).toEqual([]);
      expect(report.blockedGlobals.every((g) => g === 'fetch(data:)')).toBe(true); // only yoga's own embedded-wasm probe
    });

    it('no local file is read: file:// URLs and absolute paths in every free-text field print literally; no file content and no extra image appear (positive control: a 1×1 PNG passed as image bytes IS embedded)', async () => {
      const f = fixtures.get('one-row/pre-shift-report')!;
      const doc = mutate(f.doc, (d) => {
        if (d.kind !== 'pre-shift-report') return;
        d.data.venueName = `<img src="${fileUrl('pixel.png')}"> Venue`;
        d.data.notes = `<link rel="stylesheet" href="${fileUrl('local.css')}"> <iframe src="${fileUrl('local.html')}"></iframe> @import url(${fileUrl('local.css')});`;
        d.data.workspaceName = `<meta http-equiv="refresh" content="0;url=${fileUrl('local.html')}">`;
        d.data.staff[0]!.name = join(dir, 'local.html');
      });
      const x = await renderChecked('one-row/pre-shift-report', doc);
      expect(x.text).not.toMatch(/LOCAL-FILE-CSS-MARKER|LOCAL-FILE-HTML-MARKER/);
      expect(x.images.map((i) => `${i.width}x${i.height}`).sort()).toEqual(['166x70', `${x.images.find((i) => i.qrPayload)!.width}x${x.images.find((i) => i.qrPayload)!.height}`].sort());
      // Positive control: the image oracle does see a 1×1 image when one is really embedded (as bytes, the only way in).
      const control = mutate(f.doc, (d) => d.kind === 'pre-shift-report' && (d.data.qrPngBase64 = PNG_1X1.toString('base64')));
      const cx = extractFixture(f, await renderer.render(control));
      expect(cx.images.some((i) => i.width === 1 && i.height === 1)).toBe(true);
    });

    it('no PDF action or URI: URL-shaped and PDF-syntax text never becomes a link, action, attachment or form', async () => {
      const f = fixtures.get('hostile/pre-shift-report')!;
      const doc = mutate(f.doc, (d) => {
        if (d.kind !== 'pre-shift-report') return;
        d.data.notes = `https://example.invalid/x mailto:a@example.invalid file:///etc/passwd /URI (http://x) /Launch /OpenAction << /S /JavaScript /JS (app.alert(1)) >> /AA /AcroForm /EmbeddedFile`;
      });
      const x = await renderChecked('hostile/pre-shift-report', doc);
      expect(x.activeContentKeys).toEqual([]);
      expect(compact(x.text)).toContain(compact('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'));
    });

    // ─── replaces render-pdf-hardening (d) "renders unchanged / byte-identical apart from timestamps" ─────────────────

    it('deterministic (D7): the same data renders to the same bytes on different threads and later, dated generatedAt', async () => {
      const f = fixtures.get('one-row/approved-shift-statement')!;
      const [a, b] = await Promise.all([renderer.render(f.doc), renderer.render(f.doc)]);
      const c = await renderer.render(f.doc);
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(true);
      if (f.doc.kind !== 'approved-shift-statement') throw new Error('expected a statement');
      expect(a.toString('latin1')).toContain(`/CreationDate (${pdfDate(f.doc.data.generatedAt)}`);
    });

    // ─── replaces render-pdf-hardening (e) timeouts, and the bounded browser lifetime ─────────────────────────────────

    it('a real document that cannot finish within the deadline is terminated (PdfRenderTimeoutError, step native-render): no PDF; the pool then renders normally', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PdfRenderTimeoutError, PDF_RENDER_STEP_TIMEOUT_MS } = require(join(RUNTIME, 'render-timeout')) as { PdfRenderTimeoutError: new () => Error; PDF_RENDER_STEP_TIMEOUT_MS: number };
      expect(PDF_RENDER_STEP_TIMEOUT_MS).toBe(30_000);
      const bounded = new poolModule.NativeRenderPool({ size: 1, timeoutMs: 1_500, allowProbe: true, logger: quiet });
      try {
        const f = fixtures.get('rows-500/final-timesheet')!;
        const huge = mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.staff = Array.from({ length: 6 }, () => d.data.staff).flat()));
        const spy = jest.spyOn(poolModule, 'renderInPool').mockImplementation((request) => bounded.render(request));
        const err = await renderer.render(huge).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PdfRenderTimeoutError);
        expect((err as { step?: string }).step).toBe('native-render');
        const after = await renderer.render(fixtures.get('one-row/approved-shift-statement')!.doc);
        expect(after.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        spy.mockImplementation((request) => pool.render(request));
      } finally {
        await bounded.destroy();
      }
      expect(bounded.stats().live).toBe(0); // no render thread outlives its pool (the old "every browser closed")
    });

    it('a real document past a lowered heap cap kills only its own thread (out of memory): no PDF; a new thread renders normally', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PdfNativeThreadCrashError } = require(join(RUNTIME, 'render-protocol')) as { PdfNativeThreadCrashError: new () => Error };
      const capped = new poolModule.NativeRenderPool({ size: 1, maxOldGenerationSizeMb: 64, timeoutMs: 30_000, allowProbe: true, logger: quiet });
      try {
        const f = fixtures.get('rows-500/final-timesheet')!;
        const huge = mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.staff = Array.from({ length: 10 }, () => d.data.staff).flat()));
        const spy = jest.spyOn(poolModule, 'renderInPool').mockImplementation((request) => capped.render(request));
        const err = await renderer.render(huge).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PdfNativeThreadCrashError);
        expect((err as { code?: string }).code).toBe('error_PDF_NATIVE_OUT_OF_MEMORY');
        spy.mockImplementation((request) => pool.render(request));
        const after = await renderer.render(fixtures.get('one-row/approved-shift-statement')!.doc);
        expect(after.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      } finally {
        await capped.destroy();
      }
    });

    // ─── replaces render-pdf-sandbox-footer S-7 (browser sandbox flags): there is no browser process at all ──────────

    it('no browser: every kind renders natively, and on the native-only tree nothing the production seam imports is a browser package', async () => {
      for (const id of ['one-row/final-timesheet-original', 'one-row/pre-shift-report', 'one-row/approved-shift-statement']) {
        expect((await renderer.render(fixtures.get(id)!.doc)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
      // The static import closure of render-pdf.util.ts inside the Worker (relative imports followed; every bare package
      // recorded). Jest keeps its own module registry, so `require.cache` would prove nothing here.
      const root = join(__dirname, '..', '..');
      const seen = new Set<string>();
      const packages = new Set<string>();
      const walk = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|require\('([^']+)'\)/g)) {
          const spec = (m[1] ?? m[2])!;
          if (spec.startsWith('.')) {
            const target = [`${join(dirname(file), spec)}.ts`, join(dirname(file), spec, 'index.ts')].find((t) => existsSync(t));
            if (target) walk(target);
          } else packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
        }
      };
      walk(join(root, 'queues', 'rab-reports', 'render-pdf.util.ts'));
      expect(seen.size).toBeGreaterThan(5); // the native kit was really walked
      const browser = [...packages].filter((p) => /^(playwright|playwright-core|chromium-bidi|puppeteer)/.test(p));
      if (NATIVE_ONLY || chromiumUnavailable()) expect(browser).toEqual([]);
      else expect(browser).toContain('playwright'); // pre-removal: the Chromium path is still there (positive control)
    });
  });
}
