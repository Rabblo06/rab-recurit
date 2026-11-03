'use strict';
/**
 * Docker hardening H5: native PDF render smoke test, run INSIDE the exact gated Worker image (bind-mounted read-only by
 * image_gate.py `pdf`; never shipped in an image). Synthetic data only; no database, no Redis, no network.
 *
 *   node pdf-render-smoke.cjs plan     The Worker bundle launcher's own jobs-child plan (start-worker-bundle.cjs makePlan),
 *                                      fed synthetic connection strings that are never used; prints the child's uid/gid
 *                                      and its non-secret runtime environment (HOME, TMPDIR, XDG_*, PATH, CHROMIUM_*).
 *   node pdf-render-smoke.cjs render   As that child (uid/gid/env applied by the caller): renders the real pre-shift report
 *                                      template (compiled rab-server) through the production renderer (compiled rab-worker
 *                                      render-pdf.util: JavaScript off, offline, every non-data: request aborted) and
 *                                      prints JSON with the PDF (base64), render time and runtime facts.
 *
 * The synthetic staff names include markup (`<script>`, `<img src=http://…>`): the template's escaping must turn them into
 * literal text, which image_gate.py then finds in the PDF's extracted text. Nothing here relaxes a renderer flag.
 */
const os = require('node:os');
const path = require('node:path');

const APP = '/app';
const MARKER = 'H5 NATIVE PDF GATE';

function plan() {
  const launcher = require('/opt/crewflow-bundle/start-worker-bundle.cjs');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    // Synthetic, never connected: makePlan only validates their shape and login names.
    PG_DATABASE_URL: 'postgres://crewflow_app@db.invalid:5432/crewflow_h5_smoke',
    REDIS_URL: 'redis://redis.invalid:6379',
    CREWFLOW_PROVISIONER_ENABLED: 'false',
  };
  const plans = launcher.makePlan(env);
  const jobs = plans.find((p) => p.name === 'jobs');
  if (!jobs) throw new Error('launcher plan has no jobs child');
  const keep = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PATH', 'CHROMIUM_EXECUTABLE_PATH',
    'CHROMIUM_NO_SANDBOX', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
  const childEnv = {};
  for (const k of keep) if (jobs.env[k] !== undefined) childEnv[k] = jobs.env[k];
  process.stdout.write(JSON.stringify({ uid: jobs.uid, gid: jobs.gid, cwd: jobs.cwd, env: childEnv }));
}

async function render() {
  const { renderHtmlToPdf } = require(path.join(APP, 'packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js'));
  const { renderPreShiftReportHtml } = require(
    path.join(APP, 'packages/rab-server/dist/modules/attendance/templates/pre-shift-report.html.js'));
  const { documentFooterTemplate } = require(
    path.join(APP, 'packages/rab-server/dist/modules/attendance/templates/adolphus-document.js'));
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
  const html = renderPreShiftReportHtml(data);
  const started = process.hrtime.bigint();
  // The same options the shift-report scheduler passes (footer template, landscape).
  const pdf = await renderHtmlToPdf(html, { footerTemplate: documentFooterTemplate(data), landscape: true });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(JSON.stringify({
    marker: MARKER,
    render_ms: Math.round(ms),
    bytes: pdf.length,
    node: process.versions.node,
    arch: process.arch,
    machine: typeof os.machine === 'function' ? os.machine() : null,
    uid: process.getuid(),
    gid: process.getgid(),
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
    pdf_b64: pdf.toString('base64'),
  }));
}

const mode = process.argv[2];
(mode === 'plan' ? Promise.resolve().then(plan) : mode === 'render' ? render() : Promise.reject(new Error('mode?')))
  .catch((err) => {
    process.stderr.write(`pdf-render-smoke: FATAL ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
