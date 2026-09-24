import { EmailOutboxJobType } from '@rab/shared';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../engine/core-modules/storage/file.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { renderFinalTimesheetHtml } from '../../modules/attendance/templates/final-timesheet.html';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { withAdvisoryLock } from '../shared/advisory-lock';
import { renderHtmlToPdf } from './render-pdf.util';
import { beginRlsDiscovery } from '../shared/discovery-lock';

const logger = new Logger('FinalTimesheetJob');

/**
 * Final Timesheet PDF + email (Parts 46-51) — a separate job file from
 * `shift-report-scheduler.job.ts` even though both live in `reports/`: the
 * query shape (`status='finalised' AND final_pdf_sent_at IS NULL`, not a
 * time-window scan) and the output (always exactly one attachment-carrying
 * email, not a roster to multiple managers) genuinely differ.
 *
 * This is the one PDF-delivery path in the whole feature with zero
 * cross-container storage-read risk: render, store, AND attach-to-outbox
 * all happen inside this same worker process — `rab-server` never needs to
 * read the file back (see `ShiftReport`'s own doc comment on why both PDFs
 * are email-only, not API-served).
 */

const FORCED_SCAN_TABLES = ['shift_report'];

interface ScanCandidate {
  report_id: string;
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
  const candidates = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_final_timesheet'))`);
    await beginRlsDiscovery(manager); // bounded wait for the table locks below — see discovery-lock.ts
    for (const table of FORCED_SCAN_TABLES) {
      await manager.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
    }
    try {
      return await manager.query<ScanCandidate[]>(
        `
        SELECT id AS report_id, shift_id, organisation_id, workspace_id
        FROM core.shift_report
        WHERE status = 'finalised' AND final_pdf_sent_at IS NULL
          AND ($1::uuid IS NULL OR organisation_id = $1::uuid)
        ORDER BY finalised_at ASC
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

  let sent = 0;
  let skippedLocked = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // One failing report (bad data, renderer down) must not block every report behind it.
    try {
      const outcome = await withAdvisoryLock(ownerDataSource, `final_timesheet:${candidate.report_id}`, () =>
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
      const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id } });
      const report = await manager.findOne(ShiftReport, { where: { id: candidate.report_id } });
      // Re-verified AFTER taking the report lock: another worker may have delivered between this worker's scan and now.
    if (!shift || !report || report.status !== 'finalised' || report.finalPdfSentAt) return null;

      const venueRows = await manager.query(`SELECT name FROM core.venue WHERE id = $1`, [shift.venueId]);
      const roleRows = await manager.query(`SELECT name FROM core.job_role WHERE id = $1`, [shift.jobRoleId]);
      const venueName = venueRows[0]?.name ?? 'Venue';
      const roleName = roleRows[0]?.name ?? 'Role';

      const rows = await manager.query(
        `SELECT u.first_name, u.last_name, a.clock_in_at, a.clock_out_at, a.break_minutes, a.worked_minutes, a.status,
                EXISTS (SELECT 1 FROM core.attendance_correction ac WHERE ac.attendance_id = a.id) AS corrected
           FROM core.shift_assignment sa
           JOIN core.staff_profile sp ON sp.id = sa.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
           LEFT JOIN core.attendance a ON a.shift_assignment_id = sa.id
          WHERE sa.shift_id = $1 AND sa.status IN ('confirmed', 'completed', 'no_show')`,
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

      let finalisedByName = 'Venue Manager';
      if (report.finalisedBy) {
        const finaliser = await manager.query(`SELECT first_name, last_name FROM core."user" WHERE id = $1`, [report.finalisedBy]);
        if (finaliser[0]) finalisedByName = `${finaliser[0].first_name} ${finaliser[0].last_name}`;
      }

      const html = renderFinalTimesheetHtml({
        venueName,
        venueAddress: shift.address ?? undefined,
        roleName,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        staff: rows.map(
          (r: {
            first_name: string;
            last_name: string;
            clock_in_at: Date | null;
            clock_out_at: Date | null;
            break_minutes: number | null;
            worked_minutes: number | null;
            status: string | null;
            corrected: boolean;
          }) => ({
            name: `${r.first_name} ${r.last_name}`,
            roleName,
            scheduledStart: shift.startsAt.toISOString(),
            scheduledEnd: shift.endsAt.toISOString(),
            clockInAt: r.clock_in_at ? new Date(r.clock_in_at).toISOString() : null,
            clockOutAt: r.clock_out_at ? new Date(r.clock_out_at).toISOString() : null,
            breakMinutes: r.break_minutes,
            workedMinutes: r.worked_minutes,
            status: r.status ?? 'absent',
            corrected: r.corrected,
          }),
        ),
        finalisedByName,
        finalisedAt: report.finalisedAt ? new Date(report.finalisedAt).toISOString() : new Date().toISOString(),
      });

      return { html, recipients: managerRows.map((r: { id: string; email: string }) => ({ userId: r.id, email: r.email })), venueName };
    },
  );

  if (!prepared) return false;

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
      const claimed = await manager.query(
        `UPDATE core.shift_report SET final_pdf_sent_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'finalised' AND final_pdf_sent_at IS NULL RETURNING id`,
        [candidate.report_id],
      );
      if (claimed.length === 0) {
        // Another worker won the claim: this attempt's object is unreferenced and ours alone — remove it.
        await files.discardUnregistered(uploaded);
        return false;
      }
      const file = await files.registerAvailable(manager, { ...uploaded, resourceId: candidate.report_id });
      await manager.query(`UPDATE core.shift_report SET final_file_id = $1 WHERE id = $2`, [file.id, candidate.report_id]);
      if (audit) {
        await audit.record(manager, { organisationId: candidate.organisation_id, userId: '', inspectedBy: undefined }, AuditAction.REPORT_STORED, {
          entityType: 'stored_file',
          entityId: file.id,
          metadata: { kind: file.kind, sizeBytes: file.sizeBytes, sha256: file.sha256, reportId: candidate.report_id },
          actorUserId: null,
        });
      }
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
