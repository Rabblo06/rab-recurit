import {
  assertTransition,
  payForMinutes,
  PAYROLL_RECORD_TRANSITIONS,
  PayrollRecordStatus,
  PayrollRecordStatusType,
  PermissionFlag,
} from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FieldPolicyService } from '../../identity/member-access/field-policy.service';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { payrollAudience, RealtimeRecipient } from '../../../engine/core-modules/realtime/realtime-recipients';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { ListPayrollRecordsDto } from '../dto/payroll-record.dto';
import { publicStatementState, ShiftStatementState } from '../constants/shift-statement';
import { Allocation, allocateRecords, AllocationStatus } from './payroll-allocation';

/** Statuses in which the gross pay counts as approved (staff History shows the shift; `payrollApprovedPence` is set). */
export const PAYROLL_APPROVED_STATUSES: readonly PayrollRecordStatusType[] = [
  PayrollRecordStatus.APPROVED,
  PayrollRecordStatus.PROCESSING,
  PayrollRecordStatus.PAID,
];

/**
 * The record's Approved Shift Statement as staff and managers see it — null until the record is approved. `processing`
 * covers every internal outbox state (requested, queued, generating, retrying); `available` means the PDF exists;
 * `failed` means every retry was used. Never inferred from the approval alone.
 */
export interface ShiftStatementRef {
  state: ShiftStatementState;
  /** stored_file id (download with GET /rest/v1/files/:fileId/download) — set only when `state` is `available`. */
  fileId: string | null;
  filename: string | null;
  generatedAt: string | null;
  /** When the staff member's in-app notification was created; null until it really exists. */
  notifiedAt: string | null;
}

/** One payroll record as the manager console sees it. Money is integer pence. */
export interface PayrollRecordView {
  id: string;
  status: PayrollRecordStatusType;
  attendanceId: string;
  shiftId: string;
  staffProfileId: string;
  staffName: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  workedMinutes: number;
  payRatePence: number;
  amountPence: number;
  approvedAt: string | null;
  approvedByName: string | null;
  rejectedAt: string | null;
  rejectedByName: string | null;
  rejectionReason: string | null;
  createdAt: string;
  /** The hours belong to the caller themselves: they can never approve this record (segregation of duties). */
  ownHours: boolean;
  statement: ShiftStatementRef | null;
}

export interface PayrollRecordList {
  data: PayrollRecordView[];
  total: number;
  /** Per-status totals for the whole workspace (tab badges), independent of the status filter and pagination. */
  counts: Partial<Record<PayrollRecordStatusType, number>>;
}

/** Why one id of a bulk approval was not approved. `not_found` covers unknown AND other-workspace ids alike (no disclosure). */
export type BulkBlockReason = 'not_found' | 'not_ready' | 'own_hours';

export interface BulkApproveResult {
  approved: PayrollRecordView[];
  blocked: Array<{ id: string; reason: BulkBlockReason; message: string }>;
}

/** Display stage of one attendance in the payroll period view. Derived from real rows only. */
export type PayrollStage = 'in_progress' | 'ready' | 'completed' | 'rejected';

export interface PayrollPeriodRow {
  attendanceId: string;
  /** Null until the shift's timesheet is finalised (no payroll record yet → nothing to approve). */
  payrollRecordId: string | null;
  payrollStatus: PayrollRecordStatusType | null;
  stage: PayrollStage;
  attendanceStatus: string;
  staffProfileId: string;
  staffName: string;
  staffRef: string | null;
  staffEmail: string | null;
  /** staff_profile.employment_status (active / inactive / …). */
  staffStatus: string;
  /** staff_profile.default_pay_rate_pence; null when not set (0). */
  defaultRatePence: number | null;
  roleName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  /** Verified figures from the payroll record ONLY; null while there is none (never the provisional clock figures). */
  workedMinutes: number | null;
  payRatePence: number | null;
  amountPence: number | null;
  ownHours: boolean;
  statement: ShiftStatementRef | null;
  /** Agency calendar allocation of the scheduled start date (Europe/London). See payroll-allocation.ts. */
  allocation: AllocationView;
}

/** Period + payday a record is (or will be) paid in. `unallocated` = no configured calendar period for the date. */
export interface AllocationView {
  status: AllocationStatus;
  payrollPeriod: { id: string; start: string; end: string } | null;
  payday: string | null;
  /** Late approval carried forward: the period of the work date. */
  originalPeriod: { id: string; start: string; end: string } | null;
  runId: string | null;
  runStatus: 'prepared' | 'finalised' | null;
}

export function toAllocationView(a: Allocation | undefined): AllocationView {
  if (!a) return { status: 'unallocated', payrollPeriod: null, payday: null, originalPeriod: null, runId: null, runStatus: null };
  const ref = (p: Allocation['period']) => (p ? { id: p.id, start: p.start, end: p.end } : null);
  return { status: a.status, payrollPeriod: ref(a.period), payday: a.period?.payday ?? null, originalPeriod: ref(a.originalPeriod), runId: a.runId, runStatus: a.runStatus };
}

export interface PayrollPeriod {
  month: string;
  timezone: string;
  rows: PayrollPeriodRow[];
}

/** One Approved Shift Statement entry as the staff app sees it (`GET /rest/v1/payroll/me/statements`). */
export interface StaffShiftStatement {
  payrollRecordId: string;
  status: PayrollRecordStatusType;
  attendanceId: string;
  shiftId: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  workedMinutes: number;
  payRatePence: number;
  amountPence: number;
  approvedAt: string;
  /** The calendar period this shift is paid in (null = no configured period: "Unallocated — no payroll calendar period"). */
  payrollPeriod: { id: string; start: string; end: string } | null;
  /** Official scheduled payday (YYYY-MM-DD) from the agency calendar; null when unallocated. Never computed. */
  payday: string | null;
  allocationStatus: AllocationStatus;
  statement: ShiftStatementRef;
}

const STATEMENT_SELECT = `pr.status AS statement_payroll_status, pr.statement_status, pr.statement_attempts, pr.statement_file_id, pr.statement_generated_at, pr.statement_notified_at,
    (SELECT f.original_filename FROM core.stored_file f WHERE f.id = pr.statement_file_id AND f.status = 'AVAILABLE') AS statement_filename`;

const VIEW_SELECT = `
  SELECT pr.id, pr.status, pr.attendance_id, pr.shift_id, pr.staff_profile_id, pr.worked_minutes, pr.pay_rate_pence,
    pr.amount_pence, pr.approved_at, pr.rejected_at, pr.rejection_reason, pr.created_at, ${STATEMENT_SELECT},
    ${assignmentTimeSql().start} AS starts_at, ${assignmentTimeSql().end} AS ends_at,
    a.clock_in_at, a.clock_out_at, v.name AS venue_name, jr.name AS role_name,
    u.first_name, u.last_name, (sp.user_id = $3) AS own_hours,
    (SELECT au.first_name || ' ' || au.last_name FROM core."user" au WHERE au.id = pr.approved_by) AS approved_by_name,
    (SELECT ru.first_name || ' ' || ru.last_name FROM core."user" ru WHERE ru.id = pr.rejected_by) AS rejected_by_name
  FROM payroll_record pr
  JOIN attendance a ON a.id = pr.attendance_id
  JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
  JOIN shift s ON s.id = pr.shift_id
  JOIN venue v ON v.id = s.venue_id
  JOIN job_role jr ON jr.id = s.job_role_id
  JOIN staff_profile sp ON sp.id = pr.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
  WHERE pr.organisation_id = $1 AND pr.workspace_id = $2`;

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toStatement(r: Record<string, unknown>): ShiftStatementRef | null {
  const state = publicStatementState(r.statement_payroll_status as string, r.statement_status as string, Number(r.statement_attempts ?? 0));
  if (!state) return null;
  const fileId = state === 'available' ? ((r.statement_file_id as string) ?? null) : null;
  return {
    state,
    fileId,
    filename: fileId ? ((r.statement_filename as string) ?? null) : null,
    generatedAt: iso(r.statement_generated_at),
    notifiedAt: iso(r.statement_notified_at),
  };
}

function toView(r: Record<string, unknown>): PayrollRecordView {
  return {
    id: r.id as string,
    status: r.status as PayrollRecordStatusType,
    attendanceId: r.attendance_id as string,
    shiftId: r.shift_id as string,
    staffProfileId: r.staff_profile_id as string,
    staffName: `${r.first_name} ${r.last_name}`,
    venueName: r.venue_name as string,
    roleName: r.role_name as string,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at)!,
    clockInAt: iso(r.clock_in_at),
    clockOutAt: iso(r.clock_out_at),
    workedMinutes: Number(r.worked_minutes),
    payRatePence: Number(r.pay_rate_pence),
    amountPence: Number(r.amount_pence),
    approvedAt: iso(r.approved_at),
    approvedByName: (r.approved_by_name as string) ?? null,
    rejectedAt: iso(r.rejected_at),
    rejectedByName: (r.rejected_by_name as string) ?? null,
    rejectionReason: (r.rejection_reason as string) ?? null,
    createdAt: iso(r.created_at)!,
    ownHours: Boolean(r.own_hours),
    statement: toStatement(r),
  };
}

export function payrollStage(status: string | null): PayrollStage {
  if (!status) return 'in_progress';
  if (status === PayrollRecordStatus.PENDING_APPROVAL) return 'ready';
  if ((PAYROLL_APPROVED_STATUSES as readonly string[]).includes(status)) return 'completed';
  if (status === PayrollRecordStatus.REJECTED) return 'rejected';
  return 'in_progress'; // draft / corrected: not approvable, not completed
}

interface LockedRecord {
  id: string;
  status: PayrollRecordStatusType;
  attendance_id: string;
  shift_id: string;
  staff_profile_id: string;
  worked_minutes: number;
  amount_pence: string;
  staff_user_id: string;
}

const NOT_READY_MESSAGE = 'This payroll record is not ready for approval.';
const OWN_HOURS_MESSAGE = 'You cannot approve payroll for your own hours.';
const NOT_FOUND_MESSAGE = 'Payroll can\'t be approved until verified hours and pay are available.';

/**
 * Payroll approval (owner rule 2026-10-20). Five layers on every decision:
 *  1. route: `PermissionGuard(payroll.approve)` + `RequireWorkspaceGuard` + `@ManagerApplication()` (no mobile session);
 *  2. here: the permission is re-checked inside the transaction, Venue Managers are refused categorically (403), the
 *     workspace must be bound, and the approver can never be the worker whose hours these are;
 *  3. every query is pinned to `ctx.organisationId` AND `ctx.workspaceId` (records of another workspace are 404);
 *  4. `payroll_record` RLS (tenant, non-venue workspace manager);
 *  5. the tighter RLS predicates: INSERT mirrors an approved attendance exactly, UPDATE refuses own-hours approval and
 *     any human write of document/notification state, and the runtime role can only UPDATE the decision and statement
 *     columns (the money snapshot is immutable).
 * Every status change goes through `assertTransition(PAYROLL_RECORD_TRANSITIONS, …)` (409 on anything not listed).
 * Approving also REQUESTS the Approved Shift Statement: `statement_status = 'pending'` is committed in the SAME transaction
 * as the approval (the durable outbox event); the worker dispatches it to BullMQ, generates the PDF and notifies the staff
 * member (`shift-statement.job.ts`). History visibility depends only on the committed approval, never on the PDF.
 */
@Injectable()
export class PayrollService {
  /** Wave 5: layer-2 field policy on payroll read DTOs (FieldPolicyService 'payroll_record'). */
  /** C1b realtime outbox — property-injected so the constructor signature is unchanged. */
  @Inject(RealtimeEventService)
  private readonly realtimeEvents!: RealtimeEventService;

  /**
   * C1b realtime (inside the caller's transaction): payroll.record_changed → ONLY workspace members who may read payroll
   * (`payrollAudience`: payroll.view, never a venue manager). Ids only — never minutes, rates or amounts.
   */
  private async emitPayrollChanged(
    manager: EntityManager,
    ctx: AuthContext,
    workspaceId: string,
    entityType: string,
    entityId: string,
    occurrence: string,
    audience: (m: EntityManager) => Promise<RealtimeRecipient[]> = (m) => payrollAudience(m, workspaceId),
  ): Promise<void> {
    await this.realtimeEvents.recordForRecipients(manager, {
      organisationId: ctx.organisationId!, eventKey: `payroll.record_changed:${entityId}:${occurrence}`, eventType: RealtimeEventType.PAYROLL_RECORD_CHANGED, entityType, entityId,
    }, audience);
  }

  @Inject(FieldPolicyService)
  private readonly fieldPolicy!: FieldPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Called by `ShiftReportService.finalise` INSIDE its transaction, after every attendance of the shift moved to
   * `approved`: one `pending_approval` record per approved attendance. Idempotent (ON CONFLICT DO NOTHING on the unique
   * attendance_id). The figures are the attendance's own snapshot; the gross is re-derived with `payForMinutes` from the
   * assignment's confirmation-time rate snapshot and must equal the stored `earned_pence` — if they disagree the
   * finalisation is refused (fail closed) instead of creating a payroll figure nobody can explain.
   * Plain INSERT without RETURNING and with NO conflict target: either would require SELECT on the table, which makes
   * Postgres apply the SELECT policy to the new row — and the finalising Venue Manager may create the row but can never
   * read it (RLS). The only unique keys are the pkey and attendance_id, so a bare DO NOTHING is the same idempotency.
   */
  async createPendingForShift(manager: EntityManager, ctx: AuthContext, shiftId: string): Promise<number> {
    const rows: Array<{
      id: string; workspace_id: string; staff_profile_id: string; worked_minutes: number | null; earned_pence: string | null; rate: string;
    }> = await manager.query(
      `SELECT a.id, a.workspace_id, a.staff_profile_id, a.worked_minutes, a.earned_pence, sa.pay_rate_snapshot_pence AS rate
         FROM attendance a JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
        WHERE a.shift_id = $1 AND a.organisation_id = $2 AND a.status = 'approved'
        ORDER BY a.id`,
      [shiftId, ctx.organisationId],
    );
    for (const row of rows) {
      if (row.worked_minutes == null || row.earned_pence == null) {
        throw new ConflictException('An approved attendance has no recorded hours or pay, so payroll cannot be prepared. Contact support.');
      }
      const workedMinutes = Number(row.worked_minutes);
      const ratePence = Number(row.rate);
      const amountPence = payForMinutes(ratePence, workedMinutes);
      if (amountPence !== Number(row.earned_pence)) {
        throw new ConflictException('The recorded pay for a staff member does not match their rate and hours, so payroll cannot be prepared. Contact support.');
      }
      await manager.query(
        `INSERT INTO payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [ctx.organisationId, row.workspace_id, row.id, shiftId, row.staff_profile_id, PayrollRecordStatus.PENDING_APPROVAL, workedMinutes, ratePence, amountPence],
      );
    }
    // C1b realtime: new pending records for this shift (no RETURNING here by design, so the shift is the entity).
    if (rows.length) await this.emitPayrollChanged(manager, ctx, rows[0]!.workspace_id, 'shift', shiftId, 'created');
    return rows.length;
  }

  async list(ctx: AuthContext, dto: ListPayrollRecordsDto = {}): Promise<PayrollRecordList> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_VIEW);
      const params: unknown[] = [ctx.organisationId, ctx.workspaceId, ctx.userId];
      let where = '';
      if (dto.status) {
        params.push(dto.status);
        where = ` AND pr.status = $${params.length}`;
      }
      const { skip, take } = paginationSkipTake({ page: dto.page, limit: dto.limit ?? 50 });
      params.push(take, skip);
      const rows = await manager.query(
        `${VIEW_SELECT}${where}
         ORDER BY (pr.status = 'pending_approval') DESC, s.starts_at DESC, pr.id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const [{ total }] = await manager.query(
        `SELECT count(*)::int AS total FROM payroll_record pr WHERE pr.organisation_id = $1 AND pr.workspace_id = $2${dto.status ? ' AND pr.status = $3' : ''}`,
        dto.status ? [ctx.organisationId, ctx.workspaceId, dto.status] : [ctx.organisationId, ctx.workspaceId],
      );
      const countRows: Array<{ status: PayrollRecordStatusType; n: number }> = await manager.query(
        `SELECT status, count(*)::int AS n FROM payroll_record WHERE organisation_id = $1 AND workspace_id = $2 GROUP BY status`,
        [ctx.organisationId, ctx.workspaceId],
      );
      const fields = await this.fieldPolicy.resolveTx(manager, ctx, 'payroll_record');
      return { data: rows.map((r: Record<string, unknown>) => this.fieldPolicy.omit(fields, toView(r))), total, counts: Object.fromEntries(countRows.map((c) => [c.status, c.n])) };
    });
  }

  /**
   * The Payroll page's read model for one calendar month (organisation timezone): every attendance of THIS workspace
   * whose (assignment) start falls in the month, joined with its payroll record when one exists. Hours and amount are
   * the payroll record's verified figures only; an attendance without a record (timesheet not finalised yet) carries
   * null figures and no record id, so there is nothing a client could submit for approval.
   */
  async period(ctx: AuthContext, month: string): Promise<PayrollPeriod> {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) throw new BadRequestException('month must be YYYY-MM.');
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_VIEW);
      const [org] = await manager.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [ctx.organisationId]);
      const timezone = (org?.timezone as string | undefined) || 'Europe/London';
      const start = `${assignmentTimeSql().start}`;
      const rows: Array<Record<string, unknown>> = await manager.query(
        `SELECT a.id AS attendance_id, a.status AS attendance_status, pr.id AS payroll_record_id, pr.status AS payroll_status,
                pr.worked_minutes, pr.pay_rate_pence, pr.amount_pence, ${STATEMENT_SELECT},
                sp.id AS staff_profile_id, sp.staff_ref, sp.employment_status, sp.default_pay_rate_pence, (sp.user_id = $3) AS own_hours,
                u.first_name, u.last_name, u.email, v.name AS venue_name, jr.name AS role_name,
                ${start} AS starts_at, ${assignmentTimeSql().end} AS ends_at
           FROM attendance a
           JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
           JOIN shift s ON s.id = a.shift_id
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
           JOIN staff_profile sp ON sp.id = a.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
           LEFT JOIN payroll_record pr ON pr.attendance_id = a.id AND pr.organisation_id = $1 AND pr.workspace_id = $2
          WHERE a.organisation_id = $1 AND a.workspace_id = $2
            AND ${start} >= (make_date($4::int, $5::int, 1)::timestamp AT TIME ZONE $6::text)
            AND ${start} < ((make_date($4::int, $5::int, 1) + interval '1 month')::timestamp AT TIME ZONE $6::text)
          ORDER BY ${start}, u.first_name, u.last_name, a.id`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId, Number(match[1]), Number(match[2]), timezone],
      );
      const alloc = await allocateRecords(manager, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! },
        rows.filter((r) => r.payroll_record_id).map((r) => ({ id: r.payroll_record_id as string, startsAt: r.starts_at as Date })));
      const unrecorded = await allocateRecords(manager, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! },
        rows.filter((r) => !r.payroll_record_id).map((r) => ({ id: r.attendance_id as string, startsAt: r.starts_at as Date })));
      const fields = await this.fieldPolicy.resolveTx(manager, ctx, 'payroll_record');
      return {
        month,
        timezone,
        rows: rows.map((r) => this.fieldPolicy.omit(fields, (() => {
          const recordId = (r.payroll_record_id as string) ?? null;
          const defaultRate = num(r.default_pay_rate_pence);
          return {
            attendanceId: r.attendance_id as string,
            payrollRecordId: recordId,
            payrollStatus: (r.payroll_status as PayrollRecordStatusType) ?? null,
            stage: payrollStage((r.payroll_status as string) ?? null),
            attendanceStatus: r.attendance_status as string,
            staffProfileId: r.staff_profile_id as string,
            staffName: `${r.first_name} ${r.last_name}`,
            staffRef: (r.staff_ref as string) ?? null,
            staffEmail: (r.email as string) ?? null,
            staffStatus: r.employment_status as string,
            defaultRatePence: defaultRate ? defaultRate : null,
            roleName: r.role_name as string,
            venueName: r.venue_name as string,
            startsAt: iso(r.starts_at)!,
            endsAt: iso(r.ends_at)!,
            workedMinutes: recordId ? num(r.worked_minutes) : null,
            payRatePence: recordId ? num(r.pay_rate_pence) : null,
            amountPence: recordId ? num(r.amount_pence) : null,
            ownHours: Boolean(r.own_hours),
            statement: recordId ? toStatement(r) : null,
            allocation: toAllocationView(recordId ? alloc.get(recordId) : unrecorded.get(r.attendance_id as string)),
          };
        })())),
      };
    });
  }

  /**
   * Staff app: the caller's OWN approved pay statements, newest approval first. The staff profile is resolved from the
   * verified session (never a client id); payroll_record RLS (staff-own predicate) backs it up.
   */
  async listMine(ctx: AuthContext, pagination: PaginationDto = {}): Promise<{ data: StaffShiftStatement[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.PAYSLIP_VIEW_OWN))) throw new ForbiddenException('Permission required.');
      const [profile] = await manager.query(`SELECT id FROM staff_profile WHERE user_id = $1`, [ctx.userId]);
      if (!profile) return { data: [], total: 0 };
      const { skip, take } = paginationSkipTake({ page: pagination.page, limit: pagination.limit ?? 50 });
      const where = `pr.organisation_id = $1 AND pr.workspace_id = $2 AND pr.staff_profile_id = $3 AND pr.status = ANY($4::text[])`;
      const params = [ctx.organisationId, ctx.workspaceId, profile.id, PAYROLL_APPROVED_STATUSES];
      const rows: Array<Record<string, unknown>> = await manager.query(
        `SELECT pr.id, pr.status, pr.attendance_id, pr.shift_id, pr.worked_minutes, pr.pay_rate_pence, pr.amount_pence, pr.approved_at,
                ${STATEMENT_SELECT}, v.name AS venue_name, jr.name AS role_name,
                ${assignmentTimeSql().start} AS starts_at, ${assignmentTimeSql().end} AS ends_at
           FROM payroll_record pr
           JOIN attendance a ON a.id = pr.attendance_id
           JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
           JOIN shift s ON s.id = pr.shift_id
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
          WHERE ${where}
          ORDER BY pr.approved_at DESC, pr.id
          LIMIT $5 OFFSET $6`,
        [...params, take, skip],
      );
      const [{ total }] = await manager.query(`SELECT count(*)::int AS total FROM payroll_record pr WHERE ${where}`, params);
      const alloc = await allocateRecords(manager, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! },
        rows.map((r) => ({ id: r.id as string, startsAt: r.starts_at as Date })));
      return {
        total,
        data: rows.map((r) => ({
          payrollRecordId: r.id as string,
          status: r.status as PayrollRecordStatusType,
          attendanceId: r.attendance_id as string,
          shiftId: r.shift_id as string,
          venueName: r.venue_name as string,
          roleName: r.role_name as string,
          startsAt: iso(r.starts_at)!,
          endsAt: iso(r.ends_at)!,
          workedMinutes: Number(r.worked_minutes),
          payRatePence: Number(r.pay_rate_pence),
          amountPence: Number(r.amount_pence),
          approvedAt: iso(r.approved_at)!,
          ...(() => { const v = toAllocationView(alloc.get(r.id as string)); return { payrollPeriod: v.payrollPeriod, payday: v.payday, allocationStatus: v.status }; })(),
          statement: toStatement(r)!,
        })),
      };
    });
  }

  /** Single approve: 404 outside the workspace, 409 unless pending_approval, 403 for own hours. */
  async approve(ctx: AuthContext, id: string): Promise<PayrollRecordView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_APPROVE);
      const [record] = await this.lockRecords(manager, ctx, [id]);
      if (!record) throw new NotFoundException('Payroll record not found.');
      assertTransition(PAYROLL_RECORD_TRANSITIONS, record.status, PayrollRecordStatus.APPROVED);
      if (record.staff_user_id === ctx.userId) throw new ForbiddenException(OWN_HOURS_MESSAGE);
      await this.applyApproval(manager, ctx, [record], false);
      const [view] = await this.views(manager, ctx, [id]);
      return view!;
    });
  }

  /**
   * Bulk approve with honest per-id results (owner decision 2026-10-21: "8 records approved. 2 require attention.").
   * Every id is authorised and validated on its own, under a row lock, in ONE transaction: only ids that exist in THIS
   * workspace, are `pending_approval` (assertTransition) and are not the caller's own hours are approved; every other
   * id is reported back as blocked with a reason and left untouched. Ids that were not sent are never touched.
   * `not_found` deliberately does not distinguish "unknown" from "another workspace's record".
   */
  async bulkApprove(ctx: AuthContext, ids: string[]): Promise<BulkApproveResult> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_APPROVE);
      const found = new Map((await this.lockRecords(manager, ctx, ids)).map((r) => [r.id, r]));
      const eligible: LockedRecord[] = [];
      const blocked: BulkApproveResult['blocked'] = [];
      for (const id of ids) {
        const record = found.get(id);
        if (!record) { blocked.push({ id, reason: 'not_found', message: NOT_FOUND_MESSAGE }); continue; }
        if (!(PAYROLL_RECORD_TRANSITIONS[record.status] ?? []).includes(PayrollRecordStatus.APPROVED)) {
          blocked.push({ id, reason: 'not_ready', message: NOT_READY_MESSAGE }); continue;
        }
        if (record.staff_user_id === ctx.userId) { blocked.push({ id, reason: 'own_hours', message: OWN_HOURS_MESSAGE }); continue; }
        assertTransition(PAYROLL_RECORD_TRANSITIONS, record.status, PayrollRecordStatus.APPROVED);
        eligible.push(record);
      }
      if (eligible.length) await this.applyApproval(manager, ctx, eligible, true);
      const approved = eligible.length ? await this.views(manager, ctx, eligible.map((r) => r.id)) : [];
      return { approved, blocked };
    });
  }

  /** The one approval write: decision + pay statement REQUEST in one conditional UPDATE, then one audit row per record. */
  private async applyApproval(manager: EntityManager, ctx: AuthContext, records: LockedRecord[], bulk: boolean): Promise<void> {
    const ids = records.map((r) => r.id);
    const [, updated] = (await manager.query(
      `UPDATE payroll_record SET status = $3, approved_at = now(), approved_by = $4, statement_status = 'pending', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND status = $5`,
      [ids, ctx.workspaceId, PayrollRecordStatus.APPROVED, ctx.userId, PayrollRecordStatus.PENDING_APPROVAL],
    )) as [unknown, number];
    if (updated !== ids.length) throw new ConflictException('Payroll changed while you were approving it. Refresh and try again.');
    // C1b realtime (review F8): the payroll audience is the same for every record of this workspace — resolved at most
    // ONCE per approval (lazily, so still zero SQL while REALTIME_ENABLED is false), one event per record from it.
    let audienceOnce: Promise<RealtimeRecipient[]> | undefined;
    const sharedAudience = (m: EntityManager) => (audienceOnce ??= payrollAudience(m, ctx.workspaceId!));
    for (const record of records) {
      await this.auditService.record(manager, ctx, AuditAction.PAYROLL_RECORD_APPROVED, {
        entityType: 'payroll_record',
        entityId: record.id,
        metadata: {
          attendanceId: record.attendance_id, shiftId: record.shift_id, staffProfileId: record.staff_profile_id,
          workedMinutes: Number(record.worked_minutes), amountPence: Number(record.amount_pence), bulk, payStatementRequested: true,
        },
      });
      await this.emitPayrollChanged(manager, ctx, ctx.workspaceId!, 'payroll_record', record.id, 'approved', sharedAudience); // C1b realtime
    }
  }

  /**
   * Re-queues a FAILED Approved Shift Statement through the same durable path (statement_status failed → pending,
   * attempts reset, in this transaction; the dispatcher does the rest). Audited. 409 unless the statement is failed.
   */
  async retryStatement(ctx: AuthContext, id: string): Promise<PayrollRecordView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_APPROVE);
      const [record] = await manager.query(
        `SELECT id, status, statement_status, statement_attempts FROM payroll_record WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 FOR UPDATE`,
        [id, ctx.organisationId, ctx.workspaceId]);
      if (!record) throw new NotFoundException('Payroll record not found.');
      if (record.statement_status !== 'failed') throw new ConflictException('Only a failed Approved Shift Statement can be retried.');
      await manager.query(
        `UPDATE payroll_record SET statement_status = 'pending', statement_attempts = 0, statement_error = NULL, updated_at = now() WHERE id = $1 AND statement_status = 'failed'`, [id]);
      await this.auditService.record(manager, ctx, AuditAction.SHIFT_STATEMENT_RETRY_REQUESTED, {
        entityType: 'payroll_record', entityId: id, metadata: { previousAttempts: Number(record.statement_attempts) },
      });
      const [view] = await this.views(manager, ctx, [id]);
      return view!;
    });
  }

  /** Reason required (DTO 3-500 chars). The record leaves the approval queue and never reaches staff History. */
  async reject(ctx: AuthContext, id: string, reason: string): Promise<PayrollRecordView> {
    const trimmed = reason.trim();
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertPayrollAccess(manager, ctx, PermissionFlag.PAYROLL_APPROVE);
      const [record] = await this.lockRecords(manager, ctx, [id]);
      if (!record) throw new NotFoundException('Payroll record not found.');
      assertTransition(PAYROLL_RECORD_TRANSITIONS, record.status, PayrollRecordStatus.REJECTED);
      const [, updated] = (await manager.query(
        `UPDATE payroll_record SET status = $3, rejected_at = now(), rejected_by = $4, rejection_reason = $5, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND status = $6`,
        [id, ctx.workspaceId, PayrollRecordStatus.REJECTED, ctx.userId, trimmed, PayrollRecordStatus.PENDING_APPROVAL],
      )) as [unknown, number];
      if (updated !== 1) throw new ConflictException('Payroll changed while you were rejecting it. Refresh and try again.');
      await this.auditService.record(manager, ctx, AuditAction.PAYROLL_RECORD_REJECTED, {
        entityType: 'payroll_record',
        entityId: id,
        metadata: { attendanceId: record.attendance_id, shiftId: record.shift_id, staffProfileId: record.staff_profile_id, reason: trimmed },
      });
      await this.emitPayrollChanged(manager, ctx, ctx.workspaceId!, 'payroll_record', id, 'rejected'); // C1b realtime
      const [view] = await this.views(manager, ctx, [id]);
      return view!;
    });
  }

  /**
   * Layer 2. The workspace is the session's own (never a request value). Venue Managers are categorically outside
   * payroll (architecture §1.2 / §5.7) — 403 even if a flag were ever granted to them by mistake.
   */
  async assertPayrollAccess(manager: EntityManager, ctx: AuthContext, flag: typeof PermissionFlag.PAYROLL_VIEW | typeof PermissionFlag.PAYROLL_APPROVE): Promise<void> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.canAccessPayroll(manager, ctx, flag))) throw new ForbiddenException('Permission required.');
  }

  /** Non-throwing form of the layer-2 check, shared with ShiftStatementFilePolicy. */
  async canAccessPayroll(manager: EntityManager, ctx: AuthContext, flag: typeof PermissionFlag.PAYROLL_VIEW | typeof PermissionFlag.PAYROLL_APPROVE): Promise<boolean> {
    if (!ctx.workspaceId) return false;
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) return false;
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    return scope.kind !== 'venue';
  }

  /** Row-locks the records of THIS workspace among `ids`, in id order (deadlock-free for overlapping bulk requests). */
  private async lockRecords(manager: EntityManager, ctx: AuthContext, ids: string[]): Promise<LockedRecord[]> {
    return manager.query(
      `SELECT pr.id, pr.status, pr.attendance_id, pr.shift_id, pr.staff_profile_id, pr.worked_minutes, pr.amount_pence, sp.user_id AS staff_user_id
         FROM payroll_record pr JOIN staff_profile sp ON sp.id = pr.staff_profile_id
        WHERE pr.id = ANY($1::uuid[]) AND pr.organisation_id = $2 AND pr.workspace_id = $3
        ORDER BY pr.id
        FOR UPDATE OF pr`,
      [ids, ctx.organisationId, ctx.workspaceId],
    );
  }

  private async views(manager: EntityManager, ctx: AuthContext, ids: string[]): Promise<PayrollRecordView[]> {
    const rows = await manager.query(`${VIEW_SELECT} AND pr.id = ANY($4::uuid[]) ORDER BY pr.id`, [ctx.organisationId, ctx.workspaceId, ctx.userId, ids]);
    return rows.map(toView);
  }
}
