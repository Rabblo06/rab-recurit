import { assertTransition, NotificationType, PAYROLL_RECORD_TRANSITIONS, PayrollRecordStatus, PermissionFlag } from '@rab/shared';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { payrollAudience } from '../../../engine/core-modules/realtime/realtime-recipients';
import { NotificationService } from '../../notification/services/notification.service';
import { FieldPolicy, FieldPolicyService } from '../../identity/member-access/field-policy.service';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { activePeriods, allocateRecords, PeriodRef, periodsById } from './payroll-allocation';

type Flag = typeof PermissionFlag.PAYROLL_VIEW | typeof PermissionFlag.PAYROLL_CALCULATE | typeof PermissionFlag.PAYROLL_APPROVE | typeof PermissionFlag.PAYROLL_MARK_PAID;

/** Official payslip status per staff member and period (owner decision 2026-10-21). `paid` only after explicit confirmation. */
export type PayslipStatus = 'upcoming' | 'processing' | 'available' | 'paid';

export interface PayslipDocumentRef { fileId: string; filename: string | null; version: number; uploadedAt: string }

export interface RunStaffRow {
  staffProfileId: string; staffName: string; staffRef: string | null;
  records: number; minutes: number; grossPence: number; lateCount: number;
  payslip: { id: string; status: PayslipStatus; version: number; document: PayslipDocumentRef | null; netPence: number | null; netSource: 'provider_document' | null; paidAt: string | null; paymentReference: string | null } | null;
}

export interface RunView {
  id: string; status: 'prepared' | 'finalised'; period: PeriodRef | null;
  preparedAt: string; preparedByName: string | null; finalisedAt: string | null; finalisedByName: string | null;
  totals: { records: number; staff: number; minutes: number; grossPence: number; lateCount: number };
  staff: RunStaffRow[];
}

export interface PeriodRunSummary {
  period: PeriodRef;
  run: { id: string; status: 'prepared' | 'finalised'; records: number; grossPence: number } | null;
}

/** `GET /rest/v1/payroll/me/payslips` entry (staff app). */
export interface StaffPayslipEntry {
  payslipId: string | null;
  runId: string | null;
  period: { id: string; start: string; end: string };
  payday: string;
  status: PayslipStatus;
  shiftCount: number;
  grossPence: number;
  netPence: number | null;
  netSource: 'provider_document' | null;
  document: PayslipDocumentRef | null;
  paidAt: string | null;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/**
 * One CSV cell: quoted when needed, and spreadsheet formula injection neutralised (a staff name such as
 * `=HYPERLINK(...)` is exported as text, never evaluated). Wave 5.
 */
export function csvCell(value: string): string {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface RunCsvColumn {
  header: string;
  /** FieldPolicy 'payroll_record' field this column belongs to; omitted ⇒ always present. */
  field?: string;
  value: (s: RunStaffRow, v: RunView) => string;
}

const RUN_CSV_COLUMNS: readonly RunCsvColumn[] = [
  { header: 'Staff reference', value: (s) => s.staffRef ?? '' },
  { header: 'Staff name', value: (s) => s.staffName },
  { header: 'Period start', value: (_s, v) => v.period?.start ?? '' },
  { header: 'Period end', value: (_s, v) => v.period?.end ?? '' },
  { header: 'Payday', value: (_s, v) => v.period?.payday ?? '' },
  { header: 'Shifts', value: (s) => String(s.records) },
  { header: 'Hours', field: 'workedTime', value: (s) => (s.minutes / 60).toFixed(2) },
  { header: 'Gross (GBP)', field: 'amount', value: (s) => (s.grossPence / 100).toFixed(2) },
  { header: 'Late approvals', value: (s) => String(s.lateCount) },
  { header: 'Run status', value: (_s, v) => v.status },
];

/**
 * The payroll-provider CSV, built ONLY from the columns the caller's field policy leaves visible (layer 2): a field
 * hidden by FieldPolicyService ('payroll_record') is absent from the header and from every row — never an empty column.
 */
export function buildPayrollRunCsv(v: RunView, policy: FieldPolicy): string {
  const columns = RUN_CSV_COLUMNS.filter((c) => !c.field || !policy.hiddenFields.has(c.field));
  const rows = v.staff.map((s) => columns.map((c) => csvCell(c.value(s, v))).join(','));
  return [columns.map((c) => csvCell(c.header)).join(','), ...rows].join('\n');
}

/**
 * Payroll runs per (workspace, calendar period) and official provider payslips. Flags (each re-checked here, Venue
 * Managers always refused): prepare / payslip upload / net = `payroll.calculate` (payroll administration);
 * finalise = `payroll.approve` (locking pay is an approval decision); mark paid = `payroll.mark_paid`; read/export =
 * `payroll.view`. Every query is pinned to the session's organisation AND workspace; RLS (tenant + non-venue manager
 * for writes, staff-own for reads) and the line/payslip INSERT predicates are the DB backstop.
 */
@Injectable()
export class PayrollRunService {
  /** C1b realtime outbox — property-injected so the constructor signature is unchanged. */
  @Inject(RealtimeEventService)
  private readonly realtimeEvents!: RealtimeEventService;

  @Inject(FieldPolicyService)
  private readonly fieldPolicy!: FieldPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly audit: AuditService,
    private readonly files: FileService,
    private readonly notifications: NotificationService,
  ) {}

  private async assertFlag(m: EntityManager, ctx: AuthContext, flag: Flag): Promise<void> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
    if ((await this.resourceScope.resolveTx(m, ctx)).kind === 'venue') throw new ForbiddenException('Permission required.');
  }

  /** Every active calendar period with this workspace's run summary (or null). */
  async listPeriods(ctx: AuthContext): Promise<{ periods: PeriodRunSummary[] }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const periods = await activePeriods(m, ctx.organisationId!);
      const runs: Array<{ id: string; period_id: string; status: 'prepared' | 'finalised'; records: number; gross: string }> = await m.query(
        `SELECT r.id, r.period_id, r.status, count(l.id)::int AS records, COALESCE(sum(l.amount_pence), 0) AS gross
           FROM payroll_run r LEFT JOIN payroll_run_line l ON l.run_id = r.id
          WHERE r.organisation_id = $1 AND r.workspace_id = $2 GROUP BY r.id`, [ctx.organisationId, ctx.workspaceId]);
      const byPeriod = new Map(runs.map((r) => [r.period_id, r]));
      const extra = await periodsById(m, ctx.organisationId!, runs.filter((r) => !periods.some((p) => p.id === r.period_id)).map((r) => r.period_id));
      return {
        periods: [...periods, ...extra.values()].sort((a, b) => a.start.localeCompare(b.start)).map((period) => {
          const r = byPeriod.get(period.id);
          return { period, run: r ? { id: r.id, status: r.status, records: r.records, grossPence: Number(r.gross) } : null };
        }),
      };
    });
  }

  /**
   * Prepares (or tops up) the run of one period: appends an immutable line for every approved record of this workspace
   * that allocates to the period (its own period, or carried forward because its own period's run is finalised) and is
   * in no run yet. A finalised run is never touched (409). Late lines are audited with their original work date.
   */
  async prepare(ctx: AuthContext, periodId: string): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      const [period] = await m.query(`SELECT id FROM core.payroll_calendar_period WHERE id = $1 AND organisation_id = $2 AND active`, [periodId, ctx.organisationId]);
      if (!period) throw new NotFoundException('Payroll period not found.');
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_run:${ctx.workspaceId}`]);
      let [run] = await m.query(`SELECT id, status FROM payroll_run WHERE organisation_id = $1 AND workspace_id = $2 AND period_id = $3 FOR UPDATE`,
        [ctx.organisationId, ctx.workspaceId, periodId]);
      if (run?.status === 'finalised') throw new ConflictException('This payroll run is finalised and can no longer change.');
      if (!run) {
        await m.query(`INSERT INTO payroll_run (organisation_id, workspace_id, period_id, status, prepared_by) VALUES ($1, $2, $3, 'prepared', $4)`,
          [ctx.organisationId, ctx.workspaceId, periodId, ctx.userId]);
        [run] = await m.query(`SELECT id, status FROM payroll_run WHERE workspace_id = $1 AND period_id = $2`, [ctx.workspaceId, periodId]);
      }
      const candidates: Array<{ id: string; staff_profile_id: string; worked_minutes: number; pay_rate_pence: string; amount_pence: string; starts_at: Date }> = await m.query(
        `SELECT pr.id, pr.staff_profile_id, pr.worked_minutes, pr.pay_rate_pence, pr.amount_pence, ${assignmentTimeSql().start} AS starts_at
           FROM payroll_record pr JOIN attendance a ON a.id = pr.attendance_id JOIN shift_assignment sa ON sa.id = a.shift_assignment_id JOIN shift s ON s.id = pr.shift_id
          WHERE pr.organisation_id = $1 AND pr.workspace_id = $2 AND pr.status = 'approved'
            AND NOT EXISTS (SELECT 1 FROM payroll_run_line l WHERE l.payroll_record_id = pr.id)
          ORDER BY pr.id FOR UPDATE OF pr`, [ctx.organisationId, ctx.workspaceId]);
      const allocations = await allocateRecords(m, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! }, candidates.map((c) => ({ id: c.id, startsAt: c.starts_at })));
      let added = 0;
      let late = 0;
      for (const c of candidates) {
        const a = allocations.get(c.id)!;
        if (a.period?.id !== periodId || a.status === 'unallocated') continue;
        const isLate = a.status === 'carried_forward';
        await m.query(
          `INSERT INTO payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, original_period_id, late_approval, worked_minutes, pay_rate_pence, amount_pence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [ctx.organisationId, ctx.workspaceId, run.id, c.id, c.staff_profile_id, a.workDate, isLate ? a.originalPeriod!.id : null, isLate,
            Number(c.worked_minutes), Number(c.pay_rate_pence), Number(c.amount_pence)]);
        added += 1;
        if (isLate) {
          late += 1;
          await this.audit.record(m, ctx, AuditAction.PAYROLL_LATE_CARRIED_FORWARD, {
            entityType: 'payroll_record', entityId: c.id,
            metadata: { runId: run.id, periodId, originalPeriodId: a.originalPeriod!.id, workDate: a.workDate },
          });
        }
      }
      await this.audit.record(m, ctx, AuditAction.PAYROLL_RUN_PREPARED, { entityType: 'payroll_run', entityId: run.id, metadata: { periodId, linesAdded: added, lateLines: late } });
      return this.view(m, ctx, run.id);
    });
  }

  /** Locks the run: its records move approved → processing (state machine) and one payslip row per staff member is created. */
  async finalise(ctx: AuthContext, runId: string): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_APPROVE);
      const run = await this.lockRun(m, ctx, runId);
      if (run.status === 'finalised') throw new ConflictException('This payroll run is already finalised.');
      const lines: Array<{ payroll_record_id: string; staff_profile_id: string; status: string }> = await m.query(
        `SELECT l.payroll_record_id, l.staff_profile_id, pr.status FROM payroll_run_line l JOIN payroll_record pr ON pr.id = l.payroll_record_id
          WHERE l.run_id = $1 ORDER BY pr.id FOR UPDATE OF pr`, [runId]);
      if (!lines.length) throw new ConflictException('This payroll run has no records to finalise.');
      for (const l of lines) assertTransition(PAYROLL_RECORD_TRANSITIONS, l.status as never, PayrollRecordStatus.PROCESSING);
      const [, moved] = (await m.query(
        `UPDATE payroll_record SET status = 'processing', updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'approved' AND workspace_id = $2`,
        [lines.map((l) => l.payroll_record_id), ctx.workspaceId])) as [unknown, number];
      if (moved !== lines.length) throw new ConflictException('Payroll changed while the run was being finalised. Refresh and try again.');
      await m.query(`UPDATE payroll_run SET status = 'finalised', finalised_at = now(), finalised_by = $2, updated_at = now() WHERE id = $1`, [runId, ctx.userId]);
      for (const staffId of [...new Set(lines.map((l) => l.staff_profile_id))]) {
        await m.query(`INSERT INTO payslip (organisation_id, workspace_id, run_id, staff_profile_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [ctx.organisationId, ctx.workspaceId, runId, staffId]);
      }
      await this.audit.record(m, ctx, AuditAction.PAYROLL_RUN_FINALISED, { entityType: 'payroll_run', entityId: runId, metadata: { records: lines.length } });
      // C1b realtime (same transaction): records approved → processing. Payroll readers of this workspace only; ids only.
      await this.realtimeEvents.recordForRecipients(m, {
        organisationId: ctx.organisationId!, eventKey: `payroll.record_changed:${runId}:finalised`, eventType: RealtimeEventType.PAYROLL_RECORD_CHANGED, entityType: 'payroll_run', entityId: runId,
      }, (tx) => payrollAudience(tx, ctx.workspaceId!));
      return this.view(m, ctx, runId);
    });
  }

  async detail(ctx: AuthContext, runId: string): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      await this.lockRun(m, ctx, runId, false);
      const v = await this.view(m, ctx, runId);
      // Layer 2 field policy (wave 5): identical for every payroll.view holder today; a hidden field is absent.
      const policy = await this.fieldPolicy.resolveTx(m, ctx, 'payroll_record');
      return { ...v, totals: this.fieldPolicy.omit(policy, v.totals), staff: v.staff.map((s) => this.fieldPolicy.omit(policy, s)) };
    });
  }

  /** Per-staff summary for the payroll provider. Gross only, from the immutable line snapshot; never tax/NI/net. */
  async exportCsv(ctx: AuthContext, runId: string): Promise<{ filename: string; csv: string }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      await this.lockRun(m, ctx, runId, false);
      const v = await this.view(m, ctx, runId);
      const policy = await this.fieldPolicy.resolveTx(m, ctx, 'payroll_record');
      await this.audit.record(m, ctx, AuditAction.PAYROLL_RUN_EXPORTED, { entityType: 'payroll_run', entityId: runId, metadata: { staff: v.staff.length } });
      return {
        filename: `payroll-run-${v.period?.start ?? runId}.csv`,
        csv: buildPayrollRunCsv(v, policy),
      };
    });
  }

  /**
   * Stores the provider's official payslip PDF for one staff member of a FINALISED run. PDF only (magic bytes), size
   * limit, private storage. Replacing creates a new version (old kept, audited). Re-sending identical bytes is a no-op
   * (no new version, no second notification). The staff member is notified when a new version becomes available.
   */
  async uploadPayslip(ctx: AuthContext, runId: string, staffProfileId: string, buffer: Buffer): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      const run = await this.lockRun(m, ctx, runId);
      if (run.status !== 'finalised') throw new ConflictException('Payslips can be uploaded once the payroll run is finalised.');
      const slip = await this.lockPayslip(m, runId, staffProfileId);
      const sha = createHash('sha256').update(buffer).digest('hex');
      const [current] = await m.query(`SELECT sha256 FROM payslip_document WHERE payslip_id = $1 AND version = $2`, [slip.id, slip.version]);
      if (current?.sha256 === sha) return this.view(m, ctx, runId);
      const version = Number(slip.version) + 1;
      const file = await this.files.store(m, {
        kind: FileKind.PAYSLIP_PDF, organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, resourceType: 'payslip', resourceId: slip.id,
        buffer, filename: `payslip-${run.period_start}-v${version}.pdf`, createdBy: ctx.userId, version,
      });
      const [doc] = await m.query(
        `INSERT INTO payslip_document (organisation_id, workspace_id, payslip_id, version, file_id, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.organisationId, ctx.workspaceId, slip.id, version, file.id, sha, ctx.userId]);
      await m.query(`UPDATE payslip SET version = $2, updated_at = now() WHERE id = $1`, [slip.id, version]);
      await this.audit.record(m, ctx, AuditAction.PAYSLIP_UPLOADED, {
        entityType: 'payslip', entityId: slip.id, metadata: { runId, staffProfileId, version, fileId: file.id, sha256: sha, replacedVersion: version > 1 ? version - 1 : null },
      });
      await this.notifications.notify(m, {
        organisationId: ctx.organisationId!, userId: slip.staff_user_id, type: NotificationType.PAYSLIP_AVAILABLE,
        title: version === 1 ? 'Your payslip is available' : 'Your payslip was updated',
        message: `Payslip for ${run.period_start} – ${run.period_end} (payday ${run.payday}).`,
        relatedEntityType: 'payslip_document', relatedEntityId: doc.id,
      });
      return this.view(m, ctx, runId);
    });
  }

  /** Provider-supplied net pay, copied from the official document (or cleared). Never computed here. */
  async setNet(ctx: AuthContext, runId: string, staffProfileId: string, netPence: number | null): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      const run = await this.lockRun(m, ctx, runId);
      if (run.status !== 'finalised') throw new ConflictException('Net pay can be recorded once the payroll run is finalised.');
      const slip = await this.lockPayslip(m, runId, staffProfileId);
      if (netPence !== null && Number(slip.version) === 0) throw new ConflictException('Upload the provider payslip before recording its net pay.');
      await m.query(
        `UPDATE payslip SET net_pence = $2, net_source = $3, net_recorded_by = $4, net_recorded_at = $5, updated_at = now() WHERE id = $1`,
        netPence === null ? [slip.id, null, null, null, null] : [slip.id, netPence, 'provider_document', ctx.userId, new Date()]);
      await this.audit.record(m, ctx, AuditAction.PAYSLIP_NET_RECORDED, { entityType: 'payslip', entityId: slip.id, metadata: { runId, staffProfileId, netPence, source: netPence === null ? null : 'provider_document' } });
      return this.view(m, ctx, runId);
    });
  }

  /** The ONLY way a payslip becomes `paid`: explicit, authorised (`payroll.mark_paid`), audited; never automatic on payday. */
  async markPaid(ctx: AuthContext, runId: string, staffProfileId: string, paymentReference?: string): Promise<RunView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_MARK_PAID);
      const run = await this.lockRun(m, ctx, runId);
      if (run.status !== 'finalised') throw new ConflictException('A payslip can be marked paid once the payroll run is finalised.');
      const slip = await this.lockPayslip(m, runId, staffProfileId);
      if (slip.paid_at) throw new ConflictException('This payslip is already marked paid.');
      if (slip.staff_user_id === ctx.userId) throw new ForbiddenException('You cannot confirm payment of your own pay.');
      const records: Array<{ payroll_record_id: string; status: string }> = await m.query(
        `SELECT l.payroll_record_id, pr.status FROM payroll_run_line l JOIN payroll_record pr ON pr.id = l.payroll_record_id
          WHERE l.run_id = $1 AND l.staff_profile_id = $2 ORDER BY pr.id FOR UPDATE OF pr`, [runId, staffProfileId]);
      for (const r of records) assertTransition(PAYROLL_RECORD_TRANSITIONS, r.status as never, PayrollRecordStatus.PAID);
      await m.query(`UPDATE payroll_record SET status = 'paid', updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'processing'`, [records.map((r) => r.payroll_record_id)]);
      await m.query(`UPDATE payslip SET paid_at = now(), paid_by = $2, payment_reference = $3, updated_at = now() WHERE id = $1`, [slip.id, ctx.userId, paymentReference?.trim() || null]);
      await this.audit.record(m, ctx, AuditAction.PAYSLIP_MARKED_PAID, { entityType: 'payslip', entityId: slip.id, metadata: { runId, staffProfileId, records: records.length, paymentReference: paymentReference?.trim() || null } });
      // C1b realtime (same transaction): records processing → paid. Payroll readers of this workspace only; ids only (never the reference).
      await this.realtimeEvents.recordForRecipients(m, {
        organisationId: ctx.organisationId!, eventKey: `payroll.record_changed:${slip.id}:paid`, eventType: RealtimeEventType.PAYROLL_RECORD_CHANGED, entityType: 'payslip', entityId: slip.id,
      }, (tx) => payrollAudience(tx, ctx.workspaceId!));
      return this.view(m, ctx, runId);
    });
  }

  /** Staff app: the caller's own official payslip timeline (upcoming → processing → available → paid). */
  async listMine(ctx: AuthContext): Promise<{ data: StaffPayslipEntry[]; unallocated: { shiftCount: number; grossPence: number } }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.PAYSLIP_VIEW_OWN))) throw new ForbiddenException('Permission required.');
      const [profile] = await m.query(`SELECT id FROM staff_profile WHERE user_id = $1 AND workspace_id = $2`, [ctx.userId, ctx.workspaceId]);
      if (!profile) return { data: [], unallocated: { shiftCount: 0, grossPence: 0 } };
      const runRows: Array<{ run_id: string; period_id: string; run_status: string; shifts: number; gross: string }> = await m.query(
        `SELECT l.run_id, r.period_id, r.status AS run_status, count(*)::int AS shifts, sum(l.amount_pence) AS gross
           FROM payroll_run_line l JOIN payroll_run r ON r.id = l.run_id
          WHERE l.staff_profile_id = $1 AND l.workspace_id = $2 GROUP BY l.run_id, r.period_id, r.status`, [profile.id, ctx.workspaceId]);
      const slips: Array<Record<string, unknown>> = await m.query(
        `SELECT ps.id, ps.run_id, ps.version, ps.net_pence, ps.net_source, ps.paid_at, d.file_id, d.uploaded_at,
                (SELECT f.original_filename FROM core.stored_file f WHERE f.id = d.file_id AND f.status = 'AVAILABLE') AS filename
           FROM payslip ps LEFT JOIN payslip_document d ON d.payslip_id = ps.id AND d.version = ps.version
          WHERE ps.staff_profile_id = $1 AND ps.workspace_id = $2`, [profile.id, ctx.workspaceId]);
      const slipByRun = new Map(slips.map((s) => [s.run_id as string, s]));
      const pending: Array<{ id: string; amount_pence: string; starts_at: Date }> = await m.query(
        `SELECT pr.id, pr.amount_pence, ${assignmentTimeSql().start} AS starts_at
           FROM payroll_record pr JOIN attendance a ON a.id = pr.attendance_id JOIN shift_assignment sa ON sa.id = a.shift_assignment_id JOIN shift s ON s.id = pr.shift_id
          WHERE pr.staff_profile_id = $1 AND pr.workspace_id = $2 AND pr.status IN ('approved','processing','paid')
            AND NOT EXISTS (SELECT 1 FROM payroll_run_line l WHERE l.payroll_record_id = pr.id)`, [profile.id, ctx.workspaceId]);
      const alloc = await allocateRecords(m, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! }, pending.map((p) => ({ id: p.id, startsAt: p.starts_at })));
      const periods = await periodsById(m, ctx.organisationId!, runRows.map((r) => r.period_id));
      const entries: StaffPayslipEntry[] = [];
      for (const r of runRows) {
        const p = periods.get(r.period_id);
        if (!p) continue;
        const s = slipByRun.get(r.run_id);
        const document = s?.file_id ? { fileId: s.file_id as string, filename: (s.filename as string) ?? null, version: Number(s.version), uploadedAt: iso(s.uploaded_at)! } : null;
        entries.push({
          payslipId: (s?.id as string) ?? null, runId: r.run_id, period: { id: p.id, start: p.start, end: p.end }, payday: p.payday,
          status: s?.paid_at ? 'paid' : document ? 'available' : 'processing', shiftCount: r.shifts, grossPence: Number(r.gross),
          netPence: s?.net_pence == null ? null : Number(s.net_pence), netSource: (s?.net_source as 'provider_document') ?? null, document, paidAt: iso(s?.paid_at),
        });
      }
      const upcoming = new Map<string, StaffPayslipEntry>();
      let unallocatedShifts = 0;
      let unallocatedGross = 0;
      for (const p of pending) {
        const a = alloc.get(p.id)!;
        if (!a.period) { unallocatedShifts += 1; unallocatedGross += Number(p.amount_pence); continue; }
        const e = upcoming.get(a.period.id) ?? { payslipId: null, runId: a.runId, period: { id: a.period.id, start: a.period.start, end: a.period.end }, payday: a.period.payday,
          status: 'upcoming' as PayslipStatus, shiftCount: 0, grossPence: 0, netPence: null, netSource: null, document: null, paidAt: null };
        e.shiftCount += 1;
        e.grossPence += Number(p.amount_pence);
        upcoming.set(a.period.id, e);
      }
      for (const e of upcoming.values()) {
        const merged = entries.find((x) => x.period.id === e.period.id);
        if (merged) { merged.shiftCount += e.shiftCount; merged.grossPence += e.grossPence; } else entries.push(e);
      }
      entries.sort((a, b) => b.payday.localeCompare(a.payday));
      return { data: entries, unallocated: { shiftCount: unallocatedShifts, grossPence: unallocatedGross } };
    });
  }

  private async lockRun(m: EntityManager, ctx: AuthContext, runId: string, forUpdate = true): Promise<{ id: string; status: string; period_start: string; period_end: string; payday: string }> {
    const [run] = await m.query(
      `SELECT r.id, r.status, to_char(p.period_start, 'YYYY-MM-DD') AS period_start, to_char(p.period_end, 'YYYY-MM-DD') AS period_end, to_char(p.payday, 'YYYY-MM-DD') AS payday
         FROM payroll_run r JOIN core.payroll_calendar_period p ON p.id = r.period_id
        WHERE r.id = $1 AND r.organisation_id = $2 AND r.workspace_id = $3 ${forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [runId, ctx.organisationId, ctx.workspaceId]);
    if (!run) throw new NotFoundException('Payroll run not found.');
    return run;
  }

  private async lockPayslip(m: EntityManager, runId: string, staffProfileId: string): Promise<{ id: string; version: number; paid_at: Date | null; staff_user_id: string }> {
    const [slip] = await m.query(
      `SELECT ps.id, ps.version, ps.paid_at, sp.user_id AS staff_user_id FROM payslip ps JOIN staff_profile sp ON sp.id = ps.staff_profile_id
        WHERE ps.run_id = $1 AND ps.staff_profile_id = $2 FOR UPDATE OF ps`, [runId, staffProfileId]);
    if (!slip) throw new NotFoundException('Payslip not found.');
    return slip;
  }

  private async view(m: EntityManager, ctx: AuthContext, runId: string): Promise<RunView> {
    const [run] = await m.query(
      `SELECT r.id, r.status, r.period_id, r.prepared_at, r.finalised_at,
              (SELECT u.first_name || ' ' || u.last_name FROM core."user" u WHERE u.id = r.prepared_by) AS prepared_by_name,
              (SELECT u.first_name || ' ' || u.last_name FROM core."user" u WHERE u.id = r.finalised_by) AS finalised_by_name
         FROM payroll_run r WHERE r.id = $1 AND r.workspace_id = $2`, [runId, ctx.workspaceId]);
    const period = (await periodsById(m, ctx.organisationId!, [run.period_id])).get(run.period_id) ?? null;
    const staff: Array<Record<string, unknown>> = await m.query(
      `SELECT l.staff_profile_id, u.first_name, u.last_name, sp.staff_ref, count(*)::int AS records, sum(l.worked_minutes)::int AS minutes,
              sum(l.amount_pence) AS gross, count(*) FILTER (WHERE l.late_approval)::int AS late,
              ps.id AS payslip_id, ps.version, ps.net_pence, ps.net_source, ps.paid_at, ps.payment_reference, d.file_id, d.uploaded_at,
              (SELECT f.original_filename FROM core.stored_file f WHERE f.id = d.file_id) AS filename
         FROM payroll_run_line l JOIN staff_profile sp ON sp.id = l.staff_profile_id JOIN core."user" u ON u.id = sp.user_id
         LEFT JOIN payslip ps ON ps.run_id = l.run_id AND ps.staff_profile_id = l.staff_profile_id
         LEFT JOIN payslip_document d ON d.payslip_id = ps.id AND d.version = ps.version
        WHERE l.run_id = $1
        GROUP BY l.staff_profile_id, u.first_name, u.last_name, sp.staff_ref, ps.id, d.file_id, d.uploaded_at
        ORDER BY u.first_name, u.last_name`, [runId]);
    const rows: RunStaffRow[] = staff.map((s) => {
      const document = s.file_id ? { fileId: s.file_id as string, filename: (s.filename as string) ?? null, version: Number(s.version), uploadedAt: iso(s.uploaded_at)! } : null;
      return {
        staffProfileId: s.staff_profile_id as string, staffName: `${s.first_name} ${s.last_name}`, staffRef: (s.staff_ref as string) ?? null,
        records: Number(s.records), minutes: Number(s.minutes), grossPence: Number(s.gross), lateCount: Number(s.late),
        payslip: s.payslip_id ? {
          id: s.payslip_id as string, status: s.paid_at ? 'paid' : document ? 'available' : 'processing', version: Number(s.version), document,
          netPence: s.net_pence == null ? null : Number(s.net_pence), netSource: (s.net_source as 'provider_document') ?? null,
          paidAt: iso(s.paid_at), paymentReference: (s.payment_reference as string) ?? null,
        } : null,
      };
    });
    return {
      id: run.id, status: run.status, period, preparedAt: iso(run.prepared_at)!, preparedByName: run.prepared_by_name ?? null,
      finalisedAt: iso(run.finalised_at), finalisedByName: run.finalised_by_name ?? null,
      totals: {
        records: rows.reduce((n, r) => n + r.records, 0), staff: rows.length, minutes: rows.reduce((n, r) => n + r.minutes, 0),
        grossPence: rows.reduce((n, r) => n + r.grossPence, 0), lateCount: rows.reduce((n, r) => n + r.lateCount, 0),
      },
      staff: rows,
    };
  }
}
