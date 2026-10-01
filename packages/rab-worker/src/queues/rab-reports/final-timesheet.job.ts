import { effectiveAssignmentTime, effectiveAssignmentBreakMinutes } from '@rab/server/modules/scheduling/utils/assignment-time';
import { isReportReady } from '@rab/server/modules/attendance/services/report-readiness';
import { EmailOutboxJobType } from '@rab/shared';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { FileKind } from '@rab/server/engine/core-modules/storage/file-kinds';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { ShiftReport } from '@rab/server/modules/attendance/entities/shift-report.entity';
import { renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { withAdvisoryLock } from '../../core/locking/advisory-lock';
import { renderHtmlToPdf } from './render-pdf.util';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { claimWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';

const logger = new Logger('FinalTimesheetJob');

/**
 * The existing final-timesheet renderer owns both versions: an immutable unsigned
 * attendance snapshot, then the Venue Manager-finalised PDF and its existing email.
 * StoredFile/FileService and the report policy serve both versions across containers.
 * The pre-shift roster remains a separate report and is never labelled original.
 */



interface ScanCandidate {
  report_id: string | null;
  shift_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export interface FinalTimesheetResult {
  sent: number;
  /** Another worker held this report's lock — it is delivering it, so this worker correctly did nothing. */
  skippedLocked: number;
  failed: number;
}

export async function runFinalTimesheetCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  emailOutbox: EmailOutboxService,
  files: FileService,
  options: { organisationId?: string; audit?: AuditService } = {},
): Promise<FinalTimesheetResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, manager => manager.query<ScanCandidate[]>(`
    SELECT sr.id AS report_id, s.id AS shift_id, s.organisation_id, s.workspace_id
    FROM core.shift s LEFT JOIN core.shift_report sr ON sr.shift_id = s.id
    WHERE (sr.status = 'finalised' AND sr.final_pdf_sent_at IS NULL)
      OR (s.status <> 'cancelled' AND sr.original_file_id IS NULL
        AND EXISTS (SELECT 1 FROM core.shift_assignment sa WHERE sa.shift_id=s.id AND sa.status IN ('confirmed','completed','no_show'))
        AND NOT EXISTS (SELECT 1 FROM core.shift_assignment sa LEFT JOIN core.attendance a ON a.shift_assignment_id=sa.id
          WHERE sa.shift_id=s.id AND sa.status IN ('confirmed','completed','no_show')
          AND (a.status IN ('clocked_in','on_break') OR (sa.status <> 'no_show' AND a.clock_out_at IS NULL))))
    ORDER BY s.ends_at, s.id LIMIT 200
  `), options.organisationId);

  let sent = 0;
  let skippedLocked = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // One failing report (bad data, renderer down) must not block every report behind it.
    try {
      const outcome = await withAdvisoryLock(ownerDataSource, `final_timesheet:${candidate.shift_id}`, () =>
        deliverFinalTimesheet(candidate, tenantContext, emailOutbox, files, options.audit),
      );
      if (!outcome.acquired) skippedLocked += 1;
      else if (outcome.value) sent += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`final timesheet for report ${candidate.report_id} failed, will retry next tick: ${(error as Error).message}`);
    }
  }

  return { sent, skippedLocked, failed };
}

async function deliverFinalTimesheet(
  candidate: ScanCandidate,
  tenantContext: TenantContextService,
  emailOutbox: EmailOutboxService,
  files: FileService,
  audit?: AuditService,
): Promise<boolean> {
  const prepared = await tenantContext.runInTenantContext(
    { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
    async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id }, lock: { mode: 'pessimistic_write' } });
      if (!shift) return null;
      let report = await manager.findOne(ShiftReport, { where: { shiftId: shift.id }, lock: { mode: 'pessimistic_write' } });
      if (!report) {
        if (shift.status === 'cancelled' || !(await readyNow(manager, shift.id))) return null;
        await manager.query(`INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status)
          VALUES ($1,$2,$3,'ready') ON CONFLICT (shift_id) DO NOTHING`,
          [candidate.organisation_id, candidate.workspace_id, shift.id]);
        report = await manager.findOne(ShiftReport, { where: { shiftId: shift.id }, lock: { mode: 'pessimistic_write' } });
      }
      if (!report || (shift.status === 'cancelled' && report.status !== 'finalised')) return null;
      candidate.report_id = report.id;
      // Re-verified AFTER taking the report lock: another worker may have delivered between this worker's scan and now.
      if (!shift || !report || (report.originalFileId && (report.status !== 'finalised' || report.finalPdfSentAt))) return null;

      const venueRows = await manager.query(`SELECT name FROM core.venue WHERE id = $1`, [shift.venueId]);
      const roleRows = await manager.query(`SELECT name FROM core.job_role WHERE id = $1`, [shift.jobRoleId]);
      const venueName = venueRows[0]?.name ?? 'Venue';
      const roleName = roleRows[0]?.name ?? 'Role';

      const rows = await manager.query(
        `SELECT sa.period, sa.break_minutes AS assignment_break_minutes, sa.status AS assignment_status, u.first_name, u.last_name, a.clock_in_at, a.clock_out_at, a.break_minutes, a.worked_minutes, a.status,
                EXISTS (SELECT 1 FROM core.attendance_correction ac WHERE ac.attendance_id = a.id) AS corrected
           FROM core.shift_assignment sa
           JOIN core.staff_profile sp ON sp.id = sa.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
           LEFT JOIN core.attendance a ON a.shift_assignment_id = sa.id
          WHERE sa.shift_id = $1 AND sa.status IN ('confirmed', 'completed', 'no_show')`,
        [shift.id],
      );

      if (report.status !== 'finalised' && !isReportReady(rows.map((r: any) => ({ assignmentStatus: r.assignment_status, clockOutAt: r.clock_out_at, attendanceStatus: r.status })))) return null;

      const managerRows = await manager.query(
        `SELECT DISTINCT u.id, u.email
           FROM core.manager_venue mv
           JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
           JOIN core."user" u ON u.id = mp.user_id
          WHERE mv.venue_id = $1`,
        [shift.venueId],
      );

      let finalisedByName = 'Venue Manager';
      if (report.finalisedBy) {
        const finaliser = await manager.query(`SELECT first_name, last_name FROM core."user" WHERE id = $1`, [report.finalisedBy]);
        if (finaliser[0]) finalisedByName = `${finaliser[0].first_name} ${finaliser[0].last_name}`;
      }

      const template = {
        venueName,
        venueAddress: shift.address ?? undefined,
        roleName,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        staff: rows.map(
          (r: {
            period: string;
            first_name: string;
            last_name: string;
            clock_in_at: Date | null;
            clock_out_at: Date | null;
            break_minutes: number | null;
            assignment_break_minutes: number | null;
            worked_minutes: number | null;
            status: string | null;
            corrected: boolean;
          }) => ({
            name: `${r.first_name} ${r.last_name}`,
            roleName,
            scheduledStart: effectiveAssignmentTime(r, shift).startsAt.toISOString(),
            scheduledEnd: effectiveAssignmentTime(r, shift).endsAt.toISOString(),
            clockInAt: r.clock_in_at ? new Date(r.clock_in_at).toISOString() : null,
            clockOutAt: r.clock_out_at ? new Date(r.clock_out_at).toISOString() : null,
            breakMinutes: r.break_minutes ?? effectiveAssignmentBreakMinutes({ breakMinutes: r.assignment_break_minutes }, shift),
            workedMinutes: r.worked_minutes,
            status: r.status ?? 'absent',
            corrected: r.corrected,
          }),
        ),
        finalisedByName,
        finalisedAt: report.finalisedAt ? new Date(report.finalisedAt).toISOString() : new Date().toISOString(),
      };

      return { html: renderFinalTimesheetHtml(template), originalHtml: renderFinalTimesheetHtml({ ...template, unsigned: true }), needsOriginal: !report.originalFileId, needsSigned: report.status === 'finalised' && !report.finalPdfSentAt, recipients: managerRows.map((r: { id: string; email: string }) => ({ userId: r.id, email: r.email })), venueName };
    },
  );

  if (!prepared || !candidate.report_id) return false;

  if (prepared.needsOriginal) {
    const originalBuffer = await renderHtmlToPdf(prepared.originalHtml);
    const originalUpload = await files.putObject({ kind: FileKind.FINAL_TIMESHEET_PDF, organisationId: candidate.organisation_id,
      workspaceId: candidate.workspace_id ?? null, resourceType: 'shift_report', resourceId: candidate.report_id!,
      buffer: originalBuffer, filename: 'original-timesheet.pdf' });
    try {
      await tenantContext.runInTenantContext({ organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' }, async manager => {
        const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id }, lock: { mode: 'pessimistic_write' } });
        const report = await manager.findOne(ShiftReport, { where: { id: candidate.report_id! }, lock: { mode: 'pessimistic_write' } });
        if (!shift || !report || report.shiftId !== shift.id || report.originalFileId ||
          (report.status !== 'finalised' && (shift.status === 'cancelled' || !(await readyNow(manager, shift.id))))) { await files.discardUnregistered(originalUpload); return; }
        const eventId = await claimWorkerEvent(manager, { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id,
          eventKey: `original-timesheet:${report.id}`, eventType: 'original-timesheet', entityType: 'shift_report', entityId: report.id });
        if (!eventId) { await files.discardUnregistered(originalUpload); return; }
        const file = await files.registerAvailable(manager, originalUpload);
        await manager.update(ShiftReport, report.id, { originalFileId: file.id });
        await completeWorkerEvent(manager, eventId);
        if (audit) await audit.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.REPORT_STORED,
          { entityType: 'stored_file', entityId: file.id, metadata: { reportId: report.id, version: 'original' }, actorUserId: null });
      });
    } catch (error) { await files.discardUnregistered(originalUpload); throw error; }
  }
  if (!prepared.needsSigned) return false;

  const pdfBuffer = await renderHtmlToPdf(prepared.html);
  // Bytes go to SHARED object storage (validated, SHA-256'd, HEAD-verified) before anything claims them. Each
  // attempt writes its own immutable object: a final report is never overwritten in place.
  const uploaded = await files.putObject({
    kind: FileKind.FINAL_TIMESHEET_PDF,
    organisationId: candidate.organisation_id,
    workspaceId: candidate.workspace_id ?? null,
    resourceType: 'shift_report',
    resourceId: candidate.shift_id,
    buffer: pdfBuffer,
    filename: 'final-timesheet.pdf',
  });

  // Compare-and-set the delivery marker FIRST, in the same transaction that enqueues the email: exactly one worker
  // can flip `final_pdf_sent_at` from NULL, so exactly one set of emails is ever enqueued; if enqueueing throws, the
  // whole transaction (marker included) rolls back and the report is retried on the next tick.
  try {
    return await tenantContext.runInTenantContext(
    { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
    async (manager) => {
      // PHASE 5 fix: manager.query() returns [rows, rowCount] for an UPDATE
      // statement, never the rows array directly (see replacement-request.
      // service.ts's approve()/reject() and shift-cancellation-followup.
      // job.ts for the same fix applied to the identical mistake) — the
      // previous `claimed.length === 0` read the outer tuple's length,
      // always 2 regardless of whether the UPDATE matched a row. In
      // practice the per-report `pg_try_advisory_lock` in `withAdvisoryLock`
      // already serialises every real caller down to one at a time, so this
      // branch was effectively unreachable rather than silently double-
      // sending — but it is still the wrong read, and the one other caller
      // of this exact claim (a lock implementation change, a future second
      // caller) would have silently relied on dead code.
      const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id }, lock: { mode: 'pessimistic_write' } });
      const report = await manager.findOne(ShiftReport, { where: { id: candidate.report_id! }, lock: { mode: 'pessimistic_write' } });
      if (!shift || !report || report.shiftId !== shift.id || report.status !== 'finalised' || report.finalPdfSentAt) {
        await files.discardUnregistered(uploaded); return false;
      }
      const eventId = await claimWorkerEvent(manager, { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id,
        eventKey: `final-timesheet:${report.id}`, eventType: 'final-timesheet', entityType: 'shift_report', entityId: report.id });
      if (!eventId) { await files.discardUnregistered(uploaded); return false; }
      const [claimedRows] = (await manager.query(
        `UPDATE core.shift_report SET final_pdf_sent_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'finalised' AND final_pdf_sent_at IS NULL RETURNING id`,
        [candidate.report_id],
      )) as [Array<{ id: string }>, number];
      if (claimedRows.length === 0) {
        // Another worker won the claim: this attempt's object is unreferenced and ours alone — remove it.
        await files.discardUnregistered(uploaded);
        return false;
      }
      const file = await files.registerAvailable(manager, { ...uploaded, resourceId: candidate.report_id! });
      await manager.query(`UPDATE core.shift_report SET final_file_id = $1 WHERE id = $2`, [file.id, candidate.report_id]);
      if (audit) {
        await audit.record(manager, { organisationId: candidate.organisation_id, userId: '', inspectedBy: undefined }, AuditAction.REPORT_STORED, {
          entityType: 'stored_file',
          entityId: file.id,
          metadata: { kind: file.kind, sizeBytes: file.sizeBytes, sha256: file.sha256, reportId: candidate.report_id },
          actorUserId: null,
        });
      }
      await completeWorkerEvent(manager, eventId);
      for (const recipient of prepared.recipients) {
        await emailOutbox.enqueue(manager, {
          organisationId: candidate.organisation_id,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: recipient.email,
          // Required: the send processor treats a missing target as "account deleted before delivery" and CANCELS the row.
          targetUserId: recipient.userId,
          workspaceId: candidate.workspace_id ?? null,
          rendered: {
            subject: `Final Timesheet — ${prepared.venueName}`,
            text: `Your finalised timesheet for ${prepared.venueName} is attached.`,
            html: `<p>Your finalised timesheet for ${prepared.venueName} is attached.</p>`,
          },
          attachment: { fileId: file.id, filename: 'final-timesheet.pdf' },
        });
      }
      return true;
    },
    );
  } catch (error) {
    // The transaction rolled back, so nothing references this object: drop it rather than leave an orphan.
    await files.discardUnregistered(uploaded);
    throw error;
  }
}

/** Recheck under the scoped shift lock; discovery never authorizes a write. */
async function readyNow(manager: EntityManager, shiftId: string): Promise<boolean> {
  const rows = await manager.query(`SELECT sa.status AS assignment_status, a.clock_out_at, a.status
    FROM core.shift_assignment sa LEFT JOIN core.attendance a ON a.shift_assignment_id=sa.id
    WHERE sa.shift_id=$1 AND sa.status IN ('confirmed','completed','no_show')`, [shiftId]);
  return isReportReady(rows.map((r: { assignment_status: string; clock_out_at: Date | null; status: string | null }) =>
    ({ assignmentStatus: r.assignment_status, clockOutAt: r.clock_out_at, attendanceStatus: r.status })));
}
