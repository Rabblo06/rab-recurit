import { EmailOutboxJobType } from '@rab/shared';
import { DataSource } from 'typeorm';

import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { StorageService } from '../../engine/core-modules/storage/storage.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { renderFinalTimesheetHtml } from '../../modules/attendance/templates/final-timesheet.html';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { renderHtmlToPdf } from './render-pdf.util';

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
}

export async function runFinalTimesheetCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  emailOutbox: EmailOutboxService,
  storage: StorageService,
): Promise<FinalTimesheetResult> {
  const candidates = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_final_timesheet'))`);
    for (const table of FORCED_SCAN_TABLES) {
      await manager.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
    }
    try {
      return await manager.query<ScanCandidate[]>(`
        SELECT id AS report_id, shift_id, organisation_id, workspace_id
        FROM core.shift_report
        WHERE status = 'finalised' AND final_pdf_sent_at IS NULL
        ORDER BY finalised_at ASC
        LIMIT 200
      `);
    } finally {
      for (const table of FORCED_SCAN_TABLES) {
        await manager.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      }
    }
  });

  let sent = 0;

  for (const candidate of candidates) {
    const prepared = await tenantContext.runInTenantContext(
      { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
      async (manager) => {
        const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id } });
        const report = await manager.findOne(ShiftReport, { where: { id: candidate.report_id } });
        if (!shift || !report || report.status !== 'finalised') return null;

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
          `SELECT DISTINCT u.email
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

        return { html, recipientEmails: managerRows.map((r: { email: string }) => r.email) as string[], venueName };
      },
    );

    if (!prepared) continue;

    const pdfBuffer = await renderHtmlToPdf(prepared.html);
    const key = `org/${candidate.organisation_id}/reports/${candidate.shift_id}/final-timesheet.pdf`;
    await storage.storePdf(key, pdfBuffer);

    await tenantContext.runInTenantContext(
      { organisationId: candidate.organisation_id, workspaceId: candidate.workspace_id, userId: '', role: '' },
      async (manager) => {
        for (const email of prepared.recipientEmails) {
          await emailOutbox.enqueue(manager, {
            organisationId: candidate.organisation_id,
            jobType: EmailOutboxJobType.NOTIFICATION,
            recipientEmail: email,
            rendered: {
              subject: `Final Timesheet — ${prepared.venueName}`,
              text: `Your finalised timesheet for ${prepared.venueName} is attached.`,
              html: `<p>Your finalised timesheet for ${prepared.venueName} is attached.</p>`,
            },
            attachment: { key, filename: 'final-timesheet.pdf' },
          });
        }
        await manager.update(ShiftReport, candidate.report_id, { finalPdfSentAt: new Date() });
      },
    );

    sent += 1;
  }

  return { sent };
}
