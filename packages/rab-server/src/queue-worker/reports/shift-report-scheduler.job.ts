import { EmailOutboxJobType } from '@rab/shared';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { StorageService } from '../../engine/core-modules/storage/storage.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { QrImageService } from '../../modules/attendance/services/qr-image.service';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { renderPreShiftReportHtml } from '../../modules/attendance/templates/pre-shift-report.html';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { withAdvisoryLock } from '../shared/advisory-lock';
import { renderHtmlToPdf } from './render-pdf.util';
import { beginRlsDiscovery } from '../shared/discovery-lock';

const logger = new Logger('ShiftReportSchedulerJob');

/**
 * Pre-shift roster+QR report (Parts 10, 38-41). Same two-phase shape as
 * `shift-monitor.job.ts` — an owner-connection scan finds candidates, each
 * candidate is then re-loaded and processed under its own `rab_app`-scoped
 * transaction via `runScopedForOrg`... except this job's actual work
 * (Playwright render + email enqueue) needs its OWN transaction boundary
 * separate from the read that finds the assignments/venue, since a long
 * Playwright render should not hold a Postgres transaction open. The scoped
 * read/write here is therefore split into two short `runInTenantContext`
 * calls per candidate (load data, then persist result) rather than one
 * long one wrapping the render — deliberate, not an oversight.
 *
 * Idempotency / multi-worker safety: the scan condition (`sr.id IS NULL OR
 * sr.status = 'pending' OR sr.pre_shift_pdf_generated_at < s.updated_at`)
 * makes a handled candidate stop matching, and the scan's
 * `pg_advisory_xact_lock` only serialises DISCOVERY (it is released when the
 * scan transaction commits). Processing itself is guarded per shift by a
 * session-level advisory lock (`withAdvisoryLock`), the need is re-verified
 * after the lock is taken, and the row-locked persist transaction re-checks
 * it again before enqueueing any email — so two workers produce one PDF and
 * one set of emails.
 */

const FORCED_SCAN_TABLES = ['shift', 'shift_report'];

interface ScanCandidate {
  shift_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export interface ShiftReportSchedulerResult {
  generated: number;
  /** Another worker held this shift's lock — it is generating it, so this worker correctly did nothing. */
  skippedLocked: number;
  failed: number;
}

export async function runShiftReportSchedulerCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  attendanceQr: AttendanceQrService,
  qrImage: QrImageService,
  emailOutbox: EmailOutboxService,
  storage: StorageService,
  reportAvailableBeforeMinutes: number,
  options: { organisationId?: string } = {},
): Promise<ShiftReportSchedulerResult> {
  const candidates = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_shift_report_scheduler'))`);
    await beginRlsDiscovery(manager); // bounded wait for the table locks below — see discovery-lock.ts
    for (const table of FORCED_SCAN_TABLES) {
      await manager.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
    }
    try {
      return await manager.query<ScanCandidate[]>(
        `
        SELECT s.id AS shift_id, s.organisation_id, s.workspace_id
        FROM core.shift s
        LEFT JOIN core.shift_report sr ON sr.shift_id = s.id
        WHERE s.status NOT IN ('cancelled', 'completed', 'draft')
          AND s.starts_at <= now() + interval '${reportAvailableBeforeMinutes} minutes'
          AND s.ends_at > now()
          AND ($1::uuid IS NULL OR s.organisation_id = $1::uuid)
          AND (
            sr.id IS NULL
            OR sr.status = 'pending'
            OR sr.pre_shift_pdf_generated_at < s.updated_at
          )
        ORDER BY s.starts_at ASC
        LIMIT 200
      `,
        [options.organisationId ?? null],
      );
    } finally {
      for (const table of FORCED_SCAN_TABLES) {
        await manager.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      }
    }
  });

  let generated = 0;
  let skippedLocked = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // One failing shift (bad data, renderer down) must not block every shift behind it.
    try {
      const outcome = await withAdvisoryLock(ownerDataSource, `shift_report:${candidate.shift_id}`, () =>
        generatePreShiftReport(candidate, tenantContext, attendanceQr, qrImage, emailOutbox, storage),
      );
      if (!outcome.acquired) skippedLocked += 1;
      else if (outcome.value) generated += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`pre-shift report for shift ${candidate.shift_id} failed, will retry next tick: ${(error as Error).message}`);
    }
  }

  return { generated, skippedLocked, failed };
}

/** Mirrors the scan predicate: never generated, still pending, or the shift changed after the last generation. */
function reportNeedsGeneration(report: ShiftReport | null, shift: Shift): boolean {
  if (!report || report.status === 'pending') return true;
  return !!report.preShiftPdfGeneratedAt && report.preShiftPdfGeneratedAt.getTime() < shift.updatedAt.getTime();
}

async function generatePreShiftReport(
  candidate: ScanCandidate,
  tenantContext: TenantContextService,
  attendanceQr: AttendanceQrService,
  qrImage: QrImageService,
  emailOutbox: EmailOutboxService,
  storage: StorageService,
): Promise<boolean> {
  const prepared = await tenantContext.runInTenantContext(
    { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
    async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id } });
      if (!shift) return null;
      // Re-verified AFTER taking the shift's lock: another worker may have generated it since this worker's scan.
      const existing = await manager.findOne(ShiftReport, { where: { shiftId: candidate.shift_id } });
      if (!reportNeedsGeneration(existing, shift)) return null;

      const venueRows = await manager.query(`SELECT name, address::text AS address_json FROM core.venue WHERE id = $1`, [shift.venueId]);
      const roleRows = await manager.query(`SELECT name FROM core.job_role WHERE id = $1`, [shift.jobRoleId]);
      const venueName = venueRows[0]?.name ?? 'Venue';
      const roleName = roleRows[0]?.name ?? 'Role';

      const staffRows = await manager.query(
        `SELECT u.first_name, u.last_name
           FROM core.shift_assignment sa
           JOIN core.staff_profile sp ON sp.id = sa.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
          WHERE sa.shift_id = $1 AND sa.status = 'confirmed'`,
        [shift.id],
      );

      const managerRows = await manager.query(
        `SELECT DISTINCT u.id, u.email
           FROM core.manager_venue mv
           JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
           JOIN core."user" u ON u.id = mp.user_id
          WHERE mv.venue_id = $1`,
        [shift.venueId],
      );

      const qrToken = attendanceQr.sign(shift);
      const qrPng = await qrImage.generatePng(qrToken);

      const html = renderPreShiftReportHtml({
        venueName,
        venueAddress: shift.address ?? undefined,
        roleName,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        staff: staffRows.map((r: { first_name: string; last_name: string }) => ({ name: `${r.first_name} ${r.last_name}`, roleName })),
        qrPngBase64: qrPng.toString('base64'),
      });

      return {
        shift,
        html,
        recipients: managerRows.map((r: { id: string; email: string }) => ({ userId: r.id, email: r.email })),
        venueName,
      };
    },
  );

  if (!prepared) return false;

  const pdfBuffer = await renderHtmlToPdf(prepared.html);
  const key = `org/${candidate.organisation_id}/reports/${candidate.shift_id}/pre-shift-${Date.now()}.pdf`;
  await storage.storePdf(key, pdfBuffer);

  return tenantContext.runInTenantContext(
    { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
    async (manager) => {
      // Row-locked re-check inside the writing transaction: the emails below are enqueued at most once per generation.
      let report = await manager.findOne(ShiftReport, { where: { shiftId: candidate.shift_id }, lock: { mode: 'pessimistic_write' } });
      const current = await manager.findOne(Shift, { where: { id: candidate.shift_id } });
      if (!current || !reportNeedsGeneration(report, current)) return false;
      if (!report) {
        report = manager.create(ShiftReport, {
          organisationId: candidate.organisation_id,
          workspaceId: candidate.workspace_id ?? undefined,
          shiftId: candidate.shift_id,
        });
      }
      report.status = 'ready';
      report.preShiftPdfGeneratedAt = new Date();
      await manager.save(ShiftReport, report);

      // Not calling emailOutbox.tryFastPublish here — this worker process
      // already runs email-dispatch.job.ts's own 2s poll loop, which will
      // pick up this newly-PENDING row on its very next tick regardless;
      // tryFastPublish exists for request-time latency (a human waiting
      // on an HTTP response), which doesn't apply inside a background job.
      for (const recipient of prepared.recipients) {
        await emailOutbox.enqueue(manager, {
          organisationId: candidate.organisation_id,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: recipient.email,
          // Required: the send processor treats a missing target as "account deleted before delivery" and CANCELS the row.
          targetUserId: recipient.userId,
          rendered: {
            subject: `Shift roster & QR — ${prepared.venueName}`,
            text: `Your pre-shift roster and Shift QR for ${prepared.venueName} is attached.`,
            html: `<p>Your pre-shift roster and Shift QR for ${prepared.venueName} is attached.</p>`,
          },
          attachment: { key, filename: 'shift-roster.pdf' },
        });
      }
      report.preShiftPdfSentAt = prepared.recipients.length > 0 ? new Date() : report.preShiftPdfSentAt;
      await manager.save(ShiftReport, report);
      return true;
    },
  );
}
