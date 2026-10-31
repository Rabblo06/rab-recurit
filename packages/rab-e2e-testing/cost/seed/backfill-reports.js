// Marks the synthetic HISTORY as already processed, the way a live system would have at each shift's end: one
// FINAL_TIMESHEET_PDF object + stored_file + shift_report per completed shift, and the attendance post-shift stamps.
// Without this the worker spends hours catching up on 20 days x 20 orgs of history, which is a seeding artefact, not
// idle cost. Differences from the 2026-10-26 audit version:
//   - the PDF is rendered here with the application's REAL renderer (rab-worker render-pdf.util + the real
//     final-timesheet template), not copied from a worker render, so the step does not depend on the worker running;
//   - object keys use FileService.buildObjectKey's exact layout with deterministic (fixed-seed) tails;
//   - it refuses to run unless the target is the crewflow-cost disposable cluster.
// Runs in a container from the server image (NODE_PATH=/app/node_modules; the image ships Chromium).
const crypto = require('crypto');
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { renderHtmlToPdf } = require('/app/packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js');
const { renderFinalTimesheetHtml } = require('/app/packages/rab-server/dist/modules/attendance/templates/final-timesheet.html.js');
const { documentFooterTemplate } = require('/app/packages/rab-server/dist/modules/attendance/templates/adolphus-document.js');

// Deterministic ids/keys derived from the shift id, so staged seeding (O=5, then O=20) never collides and every run
// produces the same keys.
function uuidFrom(name) {
  const b = [...crypto.createHash('sha256').update(name).digest().subarray(0, 16)];
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

(async () => {
  const c = new Client({ connectionString: process.env.SEED_URL });
  await c.connect();
  const marker = (await c.query(`SELECT shobj_description(oid, 'pg_database') AS d FROM pg_database WHERE datname = current_database()`)).rows[0]?.d;
  if (marker !== 'crewflow-cost disposable measurement database') throw new Error('refusing: not the crewflow-cost disposable cluster');
  const bucket = process.env.S3_BUCKET;
  const prefix = `${(process.env.STORAGE_KEY_PREFIX || '').replace(/\/+$/, '')}/`;
  const s3 = new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });

  // One representative final timesheet (5 staff), rendered by the real renderer.
  const startsAt = '2026-10-20T08:00:00.000Z', endsAt = '2026-10-20T16:00:00.000Z';
  const info = { venueName: 'Venue 01-1', venueAddress: '1 Example Street, London E1 1AA', roleName: 'Bartender', startsAt, endsAt, shiftReference: 'SH-20261020-0001', workspaceName: 'CostAudit Workspace 01', timezone: 'Europe/London', generatedAt: '2026-10-20T17:00:00.000Z' };
  const staff = Array.from({ length: 5 }, (_, i) => ({ name: `Sam Staff01${i}`, staffRef: `CA01-00${i}`, roleName: 'Bartender', scheduledStart: startsAt, scheduledEnd: endsAt, clockInAt: startsAt, clockOutAt: endsAt, breakMinutes: 30, workedMinutes: 450, status: 'approved', corrected: false }));
  const html = renderFinalTimesheetHtml({ ...info, staff, unsigned: true, finalisedByName: 'Morgan Manager011', finalisedAt: '2026-10-20T17:00:00.000Z' });
  const pdf = await renderHtmlToPdf(html, { footerTemplate: documentFooterTemplate(info), landscape: true });
  const sha = crypto.createHash('sha256').update(pdf).digest('hex');

  const shifts = (await c.query(`
    SELECT s.id, s.organisation_id, s.workspace_id, sr.id AS report_id FROM core.shift s LEFT JOIN core.shift_report sr ON sr.shift_id = s.id
     WHERE s.status = 'completed' AND s.ends_at < now() AND sr.original_file_id IS NULL ORDER BY s.ends_at, s.id`)).rows;
  const work = shifts.map((s) => ({ ...s, newReportId: uuidFrom(`report:${s.id}`), fileId: uuidFrom(`file:${s.id}`), tail: uuidFrom(`key:${s.id}`) }));
  let done = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    const db = new Client({ connectionString: process.env.SEED_URL });
    await db.connect();
    while (work.length) {
      const s = work.shift();
      await db.query('BEGIN');
      const reportId = s.report_id || (await db.query(`INSERT INTO core.shift_report (id, organisation_id, workspace_id, shift_id, status) VALUES ($1,$2,$3,$4,'ready') RETURNING id`, [s.newReportId, s.organisation_id, s.workspace_id, s.id])).rows[0].id;
      const key = `${prefix}organisations/${s.organisation_id}/workspaces/${s.workspace_id}/reports/${reportId}/${s.tail}.pdf`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdf, ContentType: 'application/pdf', ServerSideEncryption: 'AES256' }));
      await db.query(
        `INSERT INTO core.stored_file (id, organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key, original_filename, mime_type, size_bytes, sha256, status)
         VALUES ($1,$2,$3,'FINAL_TIMESHEET_PDF','shift_report',$4,'S3',$5,$6,'original-timesheet.pdf','application/pdf',$7,$8,'AVAILABLE')`,
        [s.fileId, s.organisation_id, s.workspace_id, reportId, bucket, key, pdf.length, sha]);
      await db.query(`UPDATE core.shift_report SET original_file_id = $1, updated_at = now() WHERE id = $2`, [s.fileId, reportId]);
      await db.query('COMMIT');
      done++;
    }
    await db.end();
  }));
  const a1 = await c.query(`UPDATE core.attendance SET post_shift_completed_at = clock_out_at + interval '1 hour', post_shift_expired_at = clock_out_at + interval '2 hours', updated_at = now()
                             WHERE clock_out_at IS NOT NULL AND clock_out_at <= now() - interval '2 hours' AND post_shift_expired_at IS NULL`);
  const a2 = await c.query(`UPDATE core.attendance SET post_shift_completed_at = clock_out_at + interval '1 hour', updated_at = now()
                             WHERE clock_out_at IS NOT NULL AND clock_out_at <= now() - interval '1 hour' AND post_shift_completed_at IS NULL`);
  console.log(JSON.stringify({ templatePdfBytes: pdf.length, shiftsBackfilled: done, attendanceStampedBoth: a1.rowCount, attendanceStampedCompletedOnly: a2.rowCount }));
  await c.end();
})().catch((e) => { console.error('BACKFILL FAILED', e); process.exit(1); });
