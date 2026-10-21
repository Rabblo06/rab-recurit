import { formatPence, NotificationType } from '@rab/shared';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { FileKind } from '@rab/server/engine/core-modules/storage/file-kinds';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { assignmentTimeSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { SHIFT_STATEMENT_MAX_ATTEMPTS, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import {
  ApprovedShiftStatementData,
  breakPaidFromFigures,
  renderApprovedShiftStatementHtml,
  shiftStatementReference,
} from '@rab/server/modules/payroll/templates/approved-shift-statement.html';
import { allocateRecords, paydayLabel, periodLabel } from '@rab/server/modules/payroll/services/payroll-allocation';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { claimWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { renderHtmlToPdf } from './render-pdf.util';

const logger = new Logger('ShiftStatementJob');

/** A queued/processing claim older than this is presumed lost (dead worker, lost BullMQ job, Redis outage) and re-queued. */
export const SHIFT_STATEMENT_LEASE_MINUTES = 10;
/** Back-off before a failed attempt is retried: attempts × this. */
export const SHIFT_STATEMENT_RETRY_BACKOFF_MINUTES = 1;

const APPROVEDISH = `status IN ('approved','processing','paid')`;
/** The one eligibility rule, shared by discovery and the claim (re-evaluated under the row lock). */
const DUE_SQL = `${APPROVEDISH} AND statement_file_id IS NULL AND (
    statement_status IN ('none','pending')
    OR (statement_status IN ('queued','processing') AND COALESCE(statement_processing_at, statement_queued_at, updated_at) < now() - interval '${SHIFT_STATEMENT_LEASE_MINUTES} minutes')
    OR (statement_status = 'failed' AND statement_attempts < ${SHIFT_STATEMENT_MAX_ATTEMPTS}
        AND updated_at < now() - (interval '${SHIFT_STATEMENT_RETRY_BACKOFF_MINUTES} minute' * statement_attempts)))`;

interface Candidate { id: string; organisation_id: string; workspace_id: string; statement_status: string }

export interface ShiftStatementDispatchResult {
  claimed: number;
  published: number;
  /** Approved records that had no statement requested (e.g. approved before this pipeline) now queued. */
  reconciledMissing: number;
  /** Stale queued/processing or retryable failed rows re-queued. */
  requeued: number;
  publishFailed: number;
}

const workerCtx = (organisationId: string, workspaceId: string) => ({ organisationId, workspaceId, userId: '', role: '', actorType: 'worker' as const });

/**
 * DISPATCHER (outbox → BullMQ), every few seconds. The durable event is the committed `statement_status = 'pending'`
 * written by the approval transaction itself. Each due row is claimed in its own short transaction (`queued`,
 * generation + 1) and only AFTER that commits is the BullMQ job published (jobId carries the generation). If Redis is
 * down the claim stays `queued` and the lease expiry re-queues it with a new generation: a statement is delayed, never
 * lost, and an old job can never act on a newer claim. This same scan is the reconciliation path for approved records
 * that are missing a statement.
 */
export async function runShiftStatementDispatchCycle(
  discoveryDataSource: DataSource,
  tenantContext: TenantContextService,
  publish: (data: ShiftStatementJobData) => Promise<void>,
  options: { organisationId?: string } = {},
): Promise<ShiftStatementDispatchResult> {
  const result: ShiftStatementDispatchResult = { claimed: 0, published: 0, reconciledMissing: 0, requeued: 0, publishFailed: 0 };
  const candidates = await discoverInWorkspaces(discoveryDataSource, tenantContext, (m) =>
    m.query<Candidate[]>(`SELECT id, organisation_id, workspace_id, statement_status FROM payroll_record WHERE ${DUE_SQL} ORDER BY approved_at, id LIMIT 200`),
  options.organisationId);

  for (const c of candidates) {
    const generation = await tenantContext.runInTenantContext(workerCtx(c.organisation_id, c.workspace_id), async (m) => {
      const [rows] = (await m.query(
        `UPDATE payroll_record SET statement_status = 'queued', statement_dispatch_generation = statement_dispatch_generation + 1,
                statement_queued_at = now(), statement_processing_at = NULL, updated_at = now()
          WHERE id = $1 AND ${DUE_SQL}
          RETURNING statement_dispatch_generation AS generation`,
        [c.id],
      )) as [Array<{ generation: number }>, number];
      return rows[0]?.generation ?? null;
    });
    if (generation === null) continue; // another dispatcher claimed it, or it is no longer due
    result.claimed += 1;
    if (c.statement_status === 'none') result.reconciledMissing += 1;
    else if (c.statement_status !== 'pending') result.requeued += 1;
    try {
      await publish({ payrollRecordId: c.id, organisationId: c.organisation_id, workspaceId: c.workspace_id, generation });
      result.published += 1;
    } catch (error) {
      // The claim is committed: the lease expiry re-queues it once the queue is reachable again.
      result.publishFailed += 1;
      logger.warn(`shift statement ${c.id}: publish failed, will be re-queued after the lease: ${(error as Error).name}`);
    }
  }
  return result;
}

export interface ShiftStatementProcessorDeps {
  tenantContext: TenantContextService;
  files: FileService;
  notifications: NotificationService;
  audit?: AuditService;
  /** Test seam: replaces the Playwright renderer. Production never passes it. */
  render?: (html: string) => Promise<Buffer>;
}

export type ShiftStatementOutcome = 'generated' | 'stale' | 'failed';

/**
 * BullMQ CONSUMER: one job = one record at one dispatch generation. Steps: (1) row lock + generation check → mark
 * `processing`; (2) render + upload outside any transaction; (3) one transaction: row lock, re-check (same generation,
 * still no file, still approved), claim UNIQUE worker event `shift-statement:<id>`, register the file, mark `generated`,
 * notify the staff member, set `statement_notified_at` only if the in-app row really exists, audit. Any failure rolls
 * that transaction back, drops the uploaded object and records `failed` (safe code) for the dispatcher to retry.
 * Never throws for a business failure, so BullMQ does not retry on its own: retries are the dispatcher's, counted.
 */
export async function processShiftStatementJob(data: ShiftStatementJobData, deps: ShiftStatementProcessorDeps): Promise<ShiftStatementOutcome> {
  const ctx = workerCtx(data.organisationId, data.workspaceId);
  let uploaded: Awaited<ReturnType<FileService['putObject']>> | null = null;
  try {
    const prepared = await deps.tenantContext.runInTenantContext(ctx, async (m) => {
      const [locked] = await m.query(
        `SELECT statement_status, statement_dispatch_generation, statement_file_id, status FROM payroll_record WHERE id = $1 FOR UPDATE`, [data.payrollRecordId]);
      if (!locked || locked.statement_file_id || locked.statement_dispatch_generation !== data.generation
        || !['queued', 'processing'].includes(locked.statement_status) || !['approved', 'processing', 'paid'].includes(locked.status)) return null;
      await m.query(`UPDATE payroll_record SET statement_status = 'processing', statement_processing_at = now(), updated_at = now() WHERE id = $1`, [data.payrollRecordId]);
      return loadStatementData(m, data.payrollRecordId);
    });
    if (!prepared) return 'stale';

    const html = renderApprovedShiftStatementHtml(prepared.data);
    const buffer = deps.render ? await deps.render(html) : await renderHtmlToPdf(html);
    uploaded = await deps.files.putObject({
      kind: FileKind.APPROVED_SHIFT_STATEMENT_PDF, organisationId: data.organisationId, workspaceId: data.workspaceId,
      resourceType: 'payroll_record', resourceId: data.payrollRecordId, buffer,
      filename: `approved-shift-statement-${prepared.data.statementReference}.pdf`,
    });
    const upload = uploaded;

    const done = await deps.tenantContext.runInTenantContext(ctx, async (m) => {
      const [locked] = await m.query(
        `SELECT statement_status, statement_dispatch_generation, statement_file_id, status FROM payroll_record WHERE id = $1 FOR UPDATE`, [data.payrollRecordId]);
      if (!locked || locked.statement_file_id || locked.statement_dispatch_generation !== data.generation || locked.statement_status !== 'processing'
        || !['approved', 'processing', 'paid'].includes(locked.status)) return false;
      const eventId = await claimWorkerEvent(m, { organisationId: data.organisationId, workspaceId: data.workspaceId,
        eventKey: `shift-statement:${data.payrollRecordId}`, eventType: 'shift-statement', entityType: 'payroll_record', entityId: data.payrollRecordId });
      if (!eventId) return false;
      const file = await deps.files.registerAvailable(m, upload);
      await m.query(
        `UPDATE payroll_record SET statement_status = 'generated', statement_file_id = $2, statement_generated_at = now(), statement_error = NULL, updated_at = now() WHERE id = $1`,
        [data.payrollRecordId, file.id]);
      const notified = await notifyStaff(m, deps.notifications, data, prepared.staffUserId, prepared.data);
      if (notified) await m.query(`UPDATE payroll_record SET statement_notified_at = now() WHERE id = $1`, [data.payrollRecordId]);
      if (deps.audit) {
        await deps.audit.record(m, { organisationId: data.organisationId, userId: '' }, AuditAction.SHIFT_STATEMENT_GENERATED, {
          entityType: 'payroll_record', entityId: data.payrollRecordId, actorUserId: null,
          metadata: { fileId: file.id, sizeBytes: file.sizeBytes, sha256: file.sha256, notified, generation: data.generation },
        });
      }
      await completeWorkerEvent(m, eventId);
      return true;
    });
    if (!done) { await deps.files.discardUnregistered(upload); return 'stale'; }
    return 'generated';
  } catch (error) {
    if (uploaded) await deps.files.discardUnregistered(uploaded).catch(() => undefined);
    logger.warn(`shift statement ${data.payrollRecordId} generation ${data.generation} failed: ${(error as Error).name}`);
    await recordFailure(data, deps, error).catch(() => undefined);
    return 'failed';
  }
}

async function loadStatementData(m: EntityManager, recordId: string): Promise<{ data: ApprovedShiftStatementData; staffUserId: string }> {
  const [r] = await m.query(
    `SELECT pr.id, pr.organisation_id, pr.workspace_id, pr.worked_minutes, pr.pay_rate_pence, pr.amount_pence, pr.approved_at,
            a.clock_in_at, a.clock_out_at, COALESCE(a.break_minutes, sa.break_minutes, s.break_minutes) AS break_minutes,
            sp.staff_ref, sp.user_id AS staff_user_id, u.first_name, u.last_name, v.name AS venue_name, jr.name AS role_name,
            ${assignmentTimeSql().start} AS starts_at, ${assignmentTimeSql().end} AS ends_at,
            (SELECT au.first_name || ' ' || au.last_name FROM core."user" au WHERE au.id = pr.approved_by) AS approved_by_name,
            o.name AS org_name, o.timezone, mw.name AS workspace_name
       FROM payroll_record pr
       JOIN attendance a ON a.id = pr.attendance_id
       JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
       JOIN shift s ON s.id = pr.shift_id
       JOIN venue v ON v.id = s.venue_id
       JOIN job_role jr ON jr.id = s.job_role_id
       JOIN staff_profile sp ON sp.id = pr.staff_profile_id
       JOIN core."user" u ON u.id = sp.user_id
       JOIN core.organisation o ON o.id = pr.organisation_id
       LEFT JOIN core.manager_workspace mw ON mw.id = pr.workspace_id
      WHERE pr.id = $1`,
    [recordId],
  );
  const timezone = (r.timezone as string | null) || 'Europe/London';
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const startsAt = iso(r.starts_at)!;
  const payableMinutes = Number(r.worked_minutes);
  const breakMinutes = r.break_minutes == null ? null : Number(r.break_minutes);
  // Agency calendar allocation of the scheduled start date (Europe/London); unallocated → "To be confirmed".
  const allocation = (await allocateRecords(m, { organisationId: r.organisation_id, workspaceId: r.workspace_id }, [{ id: r.id, startsAt }])).get(r.id);
  const period = allocation?.period ?? null;
  const late = allocation?.status === 'carried_forward' && allocation.originalPeriod ? ` (late approval — work date in ${periodLabel(allocation.originalPeriod)})` : '';
  return {
    staffUserId: r.staff_user_id,
    data: {
      statementReference: shiftStatementReference(r.id, startsAt, timezone),
      employerName: r.org_name,
      workspaceName: r.workspace_name ?? null,
      staffName: `${r.first_name} ${r.last_name}`,
      staffRef: r.staff_ref ?? null,
      venueName: r.venue_name,
      roleName: r.role_name,
      scheduledStart: startsAt,
      scheduledEnd: iso(r.ends_at)!,
      clockInAt: iso(r.clock_in_at),
      clockOutAt: iso(r.clock_out_at),
      breakMinutes,
      breakPaid: breakPaidFromFigures(iso(r.clock_in_at), iso(r.clock_out_at), breakMinutes, payableMinutes),
      payableMinutes,
      payRatePence: Number(r.pay_rate_pence),
      amountPence: Number(r.amount_pence),
      approvedAt: iso(r.approved_at)!,
      approvedByName: r.approved_by_name ?? null,
      payrollPeriodLabel: period ? `${periodLabel(period)}${late}` : null,
      paydayLabel: period ? paydayLabel(period.payday) : null,
      timezone,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** Creates the staff notification (preference-gated, org-suspension aware) and reports whether an in-app row now exists. */
async function notifyStaff(m: EntityManager, notifications: NotificationService, job: ShiftStatementJobData, staffUserId: string, d: ApprovedShiftStatementData): Promise<boolean> {
  await notifications.notify(m, {
    organisationId: job.organisationId,
    userId: staffUserId,
    type: NotificationType.SHIFT_STATEMENT_READY,
    title: 'Approved Shift Statement available',
    message: `${d.venueName} · ${new Intl.DateTimeFormat('en-GB', { timeZone: d.timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d.scheduledStart))} · ${formatPence(d.amountPence)} approved gross`,
    relatedEntityType: 'payroll_record',
    relatedEntityId: job.payrollRecordId,
  });
  const rows = await m.query(`SELECT 1 FROM core.notification WHERE user_id = $1 AND type = $2 AND related_entity_id = $3 LIMIT 1`,
    [staffUserId, NotificationType.SHIFT_STATEMENT_READY, job.payrollRecordId]);
  return rows.length > 0;
}

async function recordFailure(job: ShiftStatementJobData, deps: ShiftStatementProcessorDeps, error: unknown): Promise<void> {
  const code = (error as { code?: string })?.code;
  const safe = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `error_${code}`.slice(0, 64) : 'generation_failed';
  await deps.tenantContext.runInTenantContext(workerCtx(job.organisationId, job.workspaceId), async (m) => {
    const [, n] = (await m.query(
      `UPDATE payroll_record SET statement_status = 'failed', statement_attempts = statement_attempts + 1, statement_error = $3, updated_at = now()
        WHERE id = $1 AND statement_dispatch_generation = $2 AND statement_file_id IS NULL AND statement_status IN ('queued','processing')`,
      [job.payrollRecordId, job.generation, safe],
    )) as [unknown, number];
    if (n && deps.audit) {
      await deps.audit.record(m, { organisationId: job.organisationId, userId: '' }, AuditAction.SHIFT_STATEMENT_FAILED, {
        entityType: 'payroll_record', entityId: job.payrollRecordId, actorUserId: null, metadata: { code: safe, generation: job.generation },
      });
    }
  });
}
