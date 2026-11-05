'use strict';
/**
 * Docker hardening H5 / PDF renderer migration P5: PDF render smoke test, run INSIDE the exact gated image (O1: the one
 * image that runs the API and the Worker; bind-mounted read-only by image_gate.py `pdf`; never shipped in an image). Synthetic data only; no database, no Redis,
 * no network. Since P5 the image has no browser: the render goes through the Worker's NATIVE renderer (pure JavaScript,
 * vendored fonts), selected explicitly, and the smoke refuses to run if the Chromium HTML renderer is still exported.
 *
 *   node pdf-render-smoke.cjs render   As the Worker (uid 1000 and its jobs environment, applied by image_gate.py from
 *                                      the production compose contract): renders the real pre-shift report
 *                                      (the same synthetic data as before P5) through the production data-in seam
 *                                      (compiled rab-worker render-pdf.util `renderReportPdf({ kind, data })`, owner
 *                                      decision D1) with PDF_RENDERER=native, and prints JSON with the PDF (base64),
 *                                      render time and runtime facts.
 *
 * The synthetic staff names include markup (`<script>`, `<img src=http://…>`): the native renderer draws plain text and
 * never interprets markup, so image_gate.py must find them as literal text in the PDF. The QR code is the embedded image.
 *
 * DEPENDS ON THE NATIVE RENDERER (P1/P2, other agents): `renderReportPdf` and the `pre-shift` kind follow the P1 seam
 * (pdf-native worktree, 2026-11-04). Re-check both when P2 lands. The smoke fails closed (exit 1) if the seam is missing or
 * the Chromium renderer is still exported; it never falls back to Chromium.
 */
const os = require('node:os');
const path = require('node:path');

const APP = '/app';
const MARKER = 'H5 NATIVE PDF GATE';

async function render() {
  // stdout carries exactly one JSON document, which the gate parses. The renderer logs through Nest's Logger, which
  // writes to stdout (the render pool's thread start-up line, F1 substitution counts), so for the render every other
  // stdout write goes to stderr and the result is written with the original writer.
  const writeResult = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
  const util = require(path.join(APP, 'packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js'));
  if (typeof util.renderHtmlToPdf === 'function') {
    throw new Error('render-pdf.util still exports the Chromium renderer (renderHtmlToPdf): P5 requires native-only');
  }
  if (typeof util.renderReportPdf !== 'function') {
    throw new Error('render-pdf.util exports no renderReportPdf (data-in seam, D1): the native renderer has not landed');
  }
  const { QrImageService } = require(path.join(APP, 'packages/rab-server/dist/modules/attendance/services/qr-image.service.js'));
  const qr = await new QrImageService().generatePng('H5-SMOKE-NOT-A-TOKEN', 300);
  const data = {
    venueName: `${MARKER} Venue`,
    venueAddress: '1 Synthetic Street, Testville',
    roleName: 'Bar Staff',
    department: 'Front of house',
    startsAt: '2026-11-03T17:00:00.000Z',
    endsAt: '2026-11-03T23:00:00.000Z',
    contactName: 'Synthetic Manager',
    contactPhone: '+44 0000 000000',
    shiftReference: 'H5-SMOKE-0001',
    workspaceName: 'H5 Smoke Workspace',
    notes: 'Synthetic data for the image release gate. <b>not bold</b>',
    timezone: 'Europe/London',
    generatedAt: '2026-11-03T12:00:00.000Z',
    qrPngBase64: qr.toString('base64'),
    staff: [
      { name: 'Alex Example', staffRef: 'S-001', roleName: 'Bar Staff', scheduledStart: '2026-11-03T17:00:00.000Z', scheduledEnd: '2026-11-03T23:00:00.000Z', breakMinutes: 30 },
      { name: '<script>alert(1)</script>', staffRef: 'S-002', roleName: 'Bar Staff', scheduledStart: '2026-11-03T17:00:00.000Z', scheduledEnd: '2026-11-03T22:00:00.000Z', breakMinutes: null },
      { name: '<img src="http://example.invalid/x.png">', staffRef: 'S-003', roleName: 'Runner', scheduledStart: '2026-11-03T18:00:00.000Z', scheduledEnd: '2026-11-03T23:00:00.000Z', breakMinutes: 15 },
    ],
  };
  const started = process.hrtime.bigint();
  // The same request the shift-report scheduler makes; PDF_RENDERER=native explicitly (a P1/P2 Worker still has the
  // switch; after D10 it accepts only native or is gone).
  const pdf = await util.renderReportPdf({ kind: 'pre-shift', data }, { ...process.env, PDF_RENDERER: 'native' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  writeResult(JSON.stringify({
    marker: MARKER,
    renderer: 'native',
    render_ms: Math.round(ms),
    bytes: pdf.length,
    node: process.versions.node,
    arch: process.arch,
    machine: typeof os.machine === 'function' ? os.machine() : null,
    uid: process.getuid(),
    gid: process.getgid(),
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
    pdf_b64: Buffer.from(pdf).toString('base64'),
  }));
}

const mode = process.argv[2];
(mode === 'render' ? render() : Promise.reject(new Error('usage: pdf-render-smoke.cjs render')))
  .catch((err) => {
    process.stderr.write(`pdf-render-smoke: FATAL ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
