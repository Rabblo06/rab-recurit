import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';

import { Logger } from '@nestjs/common';

import { checkAgainstInput } from './checker';
import { expectationFor } from './documents';
import { compact, PdfExtraction } from './extract';
import { buildFixtures, FixtureDocument, fixtureIds } from './fixtures';
import { extractFixture, outDir, saveArtifact } from './harness';
import { loadGlyphTransform } from './glyph-transform';
import { F_PDF_1, F_PDF_1_FIXTURES, F_PDF_1_PRESENT, F_PDF_1_SHAPES, fixedColumnProblems } from './known-findings';
import { nativeExpectation } from './native-reference';
import { renderGuarded } from './network-guard';
import { NATIVE_ONLY } from './mode';
import { chromiumRenderer, loadNativeRenderer, NativeNotConvertedError, Renderer } from './renderers';

/**
 * HOSTILE TEXT (the brief + P0 plan §8 P3). Every document of the `hostile` and `unbroken-token` scenarios, whose string
 * fields carry markup, local-network URLs, `javascript:`, entities, template and PDF syntax, NUL / C0 / C1 controls, a
 * lone surrogate, bidi overrides / isolates and zero-width characters. For each renderer:
 *
 *   - markup is printed literally and never interpreted: every business value (hostile strings included) is found in
 *     the extracted text, the `<style>*{display:none}</style>` role and the `<script>` venue are printed as text;
 *   - no network: a local HTTP listener that every hostile URL points at receives ZERO requests; the Node-side network
 *     guard records zero outbound attempts (Chromium: record mode — the browser is a separate process on a pipe, and the
 *     renderer's own blocked-request counter must stay at zero, i.e. nothing even tried to load; native: DENY mode, so
 *     any socket / DNS / fetch / http(s) call in this process fails the render);
 *   - the PDF has no active content (/JavaScript, /JS, /OpenAction, /Launch, /URI, /EmbeddedFile, /AA, /AcroForm);
 *   - native only: no text outside the page (the 1,000-character token wraps), no text drawn over other text.
 *
 * PDF_EQUALITY_MODE=native-only (P5) runs the native half only; the Chromium half needs Chromium in the tree.
 *
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-hostile-text
 */
jest.setTimeout(10 * 60_000);

const SCENARIOS = ['hostile', 'unbroken-token'];
const OUT = outDir('hostile');
const native = loadNativeRenderer();

let server: Server;
let base = '';
const hits: string[] = [];
/** TCP connections accepted by the listener (a request needs one; a connection without a request still counts). */
let connections = 0;
const sockets = new Set<Socket>();
let fixtures: Map<string, FixtureDocument>;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('HOSTILE-REMOTE-MARKER');
  });
  server.on('connection', (s) => {
    connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixtures = new Map((await buildFixtures({ hostileBase: base, scenarios: SCENARIOS })).map((f) => [f.id, f]));
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits.length = 0;
  connections = 0;
});

const IDS = fixtureIds({ hostileBase: 'http://127.0.0.1:9' }).filter((id) => SCENARIOS.some((s) => id.startsWith(`${s}/`)));

/** Renders under the network guard and asserts the security properties: no request, no network attempt, no active content. */
async function renderSafely(renderer: Renderer, f: FixtureDocument, mode: 'record' | 'deny'): Promise<PdfExtraction> {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let rendered: Awaited<ReturnType<typeof renderGuarded>>;
  try {
    rendered = await renderGuarded(mode, () => renderer.render(f.doc));
  } finally {
    warn.mockRestore();
  }
  const blocked = warn.mock.calls.map((c) => String(c[0])).filter((m) => /blocked \d+/.test(m));
  saveArtifact(OUT, f.id, `${renderer.name}.pdf`, rendered.pdf);
  const x = extractFixture(f, rendered.pdf);

  expect(hits).toEqual([]);
  expect(connections).toBe(0);
  expect(rendered.attempts).toEqual([]);
  expect(blocked).toEqual([]);
  expect(x.activeContentKeys).toEqual([]);
  expect(compact(x.text)).not.toContain('HOSTILE-REMOTE-MARKER');
  return x;
}

/**
 * Every business value (hostile strings included) printed literally; markup printed as text, never interpreted. The
 * native side is held to owner decision F1 (each unprintable character printed as □, from the runtime's GlyphCoverage)
 * and may draw react-pdf's forced-break hyphen at the end of a line (checker.ts `countValue`).
 */
async function assertPrintedLiterally(renderer: Renderer, f: FixtureDocument, x: PdfExtraction): Promise<void> {
  let expectation = expectationFor(f.doc);
  if (renderer.name === 'native') {
    const glyphs = await loadGlyphTransform();
    if ('unavailable' in glyphs) throw new Error(`native renderer present but its F1 glyph transform is not: ${glyphs.unavailable}`);
    expectation = await nativeExpectation(expectation, glyphs.transform);
  }
  const failing = checkAgainstInput(expectation, x, renderer.name, { boundsStrict: ['native'], forcedBreakHyphens: ['native'] }).filter((r) => !r.ok && !r.info);
  expect(failing.map((r) => `${r.check}: ${r.detail}`)).toEqual([]);
  if (f.scenario === 'hostile') {
    const text = compact(x.text);
    for (const literal of ["<script>document.title='pwned'</script>Venue <b>Bold</b>", '<style>*{display:none}</style>Bar']) {
      expect(text).toContain(compact(literal));
    }
  }
}

async function check(renderer: Renderer, id: string, mode: 'record' | 'deny'): Promise<void> {
  const f = fixtures.get(id)!;
  await assertPrintedLiterally(renderer, f, await renderSafely(renderer, f, mode));
}

(NATIVE_ONLY ? describe.skip : describe)('hostile text — Chromium (compare mode only: P5 removes Chromium)', () => {
  it.each(IDS.filter((id) => !(id in F_PDF_1_FIXTURES)))('%s: printed literally, no request, no active content', async (id) => {
    await check(chromiumRenderer, id, 'record');
  });

  // KNOWN FINDING F-PDF-1 (known-findings.ts; its exact shape is pinned in pdf-equality.selftest.spec.ts): the security
  // assertions stay plain tests; only "printed literally" is `test.failing`, and turns RED once the template is fixed.
  const findingRenders = new Map<string, PdfExtraction>();
  const findingIds = IDS.filter((id) => id in F_PDF_1_FIXTURES);
  // Empty once the template is fixed (known-findings.ts F_PDF_1_PRESENT): the plain test above then covers them.
  if (!F_PDF_1_PRESENT) {
    // F-PDF-1 fixed in this tree's template: the hostile unbroken token keeps every column, the sign-off and the total.
    it.each(Object.entries(F_PDF_1_SHAPES))(`%s: ${F_PDF_1} is fixed — every column printed, inside the page`, async (id, shape) => {
      const f = fixtures.get(id)!;
      expect(fixedColumnProblems(f.doc, await renderSafely(chromiumRenderer, f, 'record'), 'chromium', shape.droppedHeading)).toEqual([]);
    });
  }
  if (findingIds.length) {
    it.each(findingIds)('%s: no request, no active content', async (id) => {
      findingRenders.set(id, await renderSafely(chromiumRenderer, fixtures.get(id)!, 'record'));
    });
    test.failing.each(findingIds)(`%s: printed literally — KNOWN FINDING ${F_PDF_1}`, async (id) => {
      const x = findingRenders.get(id);
      if (!x) throw new Error(`${id}: not rendered (see the test above)`);
      await assertPrintedLiterally(chromiumRenderer, fixtures.get(id)!, x);
    });
  }
});

if ('unavailable' in native) {
  describe.skip(`hostile text — native (unavailable: ${native.unavailable})`, () => {
    it('skipped', () => undefined);
  });
} else {
  describe('hostile text — native (network DENIED in this process)', () => {
    it.each(IDS)('%s: printed literally, no network, no active content, inside the page', async (id) => {
      try {
        await check(native, id, 'deny');
      } catch (e) {
        if (e instanceof NativeNotConvertedError && process.env.PDF_EQUALITY_REQUIRE_NATIVE !== '1') return;
        throw e;
      }
    });
  });
}
