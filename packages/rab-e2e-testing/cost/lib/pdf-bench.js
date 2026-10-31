// PDF render cost with the application's REAL renderer: rab-worker's renderHtmlToPdf (render-pdf.util; one Chromium
// launch per render, exactly as the worker jobs call it) fed by the real templates (pre-shift roster with a real
// QrImageService PNG, and the final timesheet). Runs inside a container from the WORKER image under test, started by
// run.sh with --cpus=1 --memory=1g as uid 1000 (the jobs child's identity); the script arrives on stdin (no bind mount).
// Per render: cgroup CPU delta (node + Chromium children, the whole container), wall time, peak container memory, bytes.
const fs = require('fs');
const { renderHtmlToPdf } = require('/app/packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js');
const T = '/app/packages/rab-server/dist/modules/attendance/templates/';
const { renderPreShiftReportHtml } = require(T + 'pre-shift-report.html.js');
const { renderFinalTimesheetHtml } = require(T + 'final-timesheet.html.js');
const { documentFooterTemplate } = require(T + 'adolphus-document.js');
const { QrImageService } = require('/app/packages/rab-server/dist/modules/attendance/services/qr-image.service.js');
const N = Number(process.env.N || 10);
const STAFF = Number(process.env.STAFF || 5);

const cgCpu = () => Number(/usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))[1]);
const cgMem = () => Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
const cgMax = () => fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();

(async () => {
  const startsAt = '2026-10-28T08:00:00.000Z', endsAt = '2026-10-28T16:00:00.000Z';
  const info = { venueName: 'Venue 01-1', venueAddress: '1 Example Street, London E1 1AA', roleName: 'Bartender', startsAt, endsAt, shiftReference: 'SH-20261028-0001', workspaceName: 'CostAudit Workspace 01', timezone: 'Europe/London', generatedAt: '2026-10-28T05:00:00.000Z' };
  const qr = await new QrImageService().generatePng('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'x'.repeat(300) + '.sig');
  const rosterStaff = Array.from({ length: STAFF }, (_, i) => ({ name: `Sam Staff01${i}`, staffRef: `CA01-00${i}`, roleName: 'Bartender', scheduledStart: startsAt, scheduledEnd: endsAt, breakMinutes: 30 }));
  const docs = {
    roster: { html: renderPreShiftReportHtml({ ...info, staff: rosterStaff, qrPngBase64: qr.toString('base64') }), opts: { footerTemplate: documentFooterTemplate(info), landscape: true } },
    finalTimesheet: { html: renderFinalTimesheetHtml({ ...info, staff: rosterStaff.map((s) => ({ ...s, clockInAt: startsAt, clockOutAt: endsAt, workedMinutes: 450, status: 'approved', corrected: false })), unsigned: true, finalisedByName: 'Morgan Manager011', finalisedAt: '2026-10-28T17:00:00.000Z' }), opts: { footerTemplate: documentFooterTemplate(info), landscape: true } },
  };
  const out = { renderer: 'rab-worker dist/queues/rab-reports/render-pdf.util.js renderHtmlToPdf (launch per render)', cpuMax: cgMax(), staffRows: STAFF, n: N, docs: {} };
  for (const [name, d] of Object.entries(docs)) {
    const rows = [];
    for (let i = 0; i < N + 1; i++) { // the first render is a warm-up (page cache), excluded
      let peak = cgMem();
      const poll = setInterval(() => { try { peak = Math.max(peak, cgMem()); } catch { /* ignore */ } }, 25);
      const c0 = cgCpu(); const t = performance.now();
      const pdf = await renderHtmlToPdf(d.html, d.opts);
      const wallMs = performance.now() - t; const cpuMs = (cgCpu() - c0) / 1000;
      clearInterval(poll);
      if (i > 0) rows.push({ wallMs: +wallMs.toFixed(1), cpuMs: +cpuMs.toFixed(1), peakContainerMemMiB: +(peak / 1048576).toFixed(1), pdfBytes: pdf.length });
    }
    const med = (k) => { const v = rows.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const mean = (k) => +(rows.reduce((s, x) => s + x[k], 0) / rows.length).toFixed(1);
    out.docs[name] = { htmlBytes: Buffer.byteLength(d.html), renders: rows, summary: { cpuSecondsMedian: +(med('cpuMs') / 1000).toFixed(3), cpuSecondsMean: +(mean('cpuMs') / 1000).toFixed(3), wallMsMedian: med('wallMs'), peakContainerMemMiBMax: Math.max(...rows.map((r) => r.peakContainerMemMiB)), pdfBytesMedian: med('pdfBytes') } };
  }
  try { out.containerMemoryPeakBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8')); } catch { out.containerMemoryPeakBytes = null; }
  console.log('RESULT ' + JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
