import {
  assertSafePence,
  assertTransition,
  PAYROLL_ADJUSTMENT_TRANSITIONS,
  PayrollAdjustmentKind,
  PayrollAdjustmentKindType,
  PayrollAdjustmentStatus,
  PayrollAdjustmentStatusType,
  PayrollRecordStatus,
  PermissionFlag,
} from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { AddPayrollAdditionDto, AddPayrollCorrectionDto, ListPayrollAdjustmentsDto } from '../dto/payroll-adjustment.dto';
import { Allocation, allocateRecords, PeriodRef, periodsById } from './payroll-allocation';

type Flag = typeof PermissionFlag.PAYROLL_VIEW | typeof PermissionFlag.PAYROLL_CALCULATE | typeof PermissionFlag.PAYROLL_APPROVE;

/** Step-up action recorded on a refusal (STEP_UP_ACTIONS). */
export const PAYROLL_ADJUSTMENT_APPROVE_STEP_UP = 'payroll.adjustment.approve' as const;

/** Statuses of the ORIGINAL payroll record a correction may point at: its pay was approved (decision 3, "after approval"). */
const CORRECTABLE_RECORD_STATUSES: readonly string[] = [PayrollRecordStatus.APPROVED, PayrollRecordStatus.PROCESSING, PayrollRecordStatus.PAID];

/** One adjustment as the manager console sees it. Money is integer pence. */
export interface PayrollAdjustmentView {
  id: string;
  kind: PayrollAdjustmentKindType;
  status: PayrollAdjustmentStatusType;
  staffProfileId: string;
  staffName: string;
  amountPence: number;
  reason: string;
  correctsPayrollRecordId: string | null;
  createdAt: string;
  createdByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectionReason: string | null;
  /** The run that included it (null until a run of its period is prepared after approval). */
  runId: string | null;
  /** True once that run is finalised: the line can never change again (database guard). */
  locked: boolean;
  /** The calendar period it is (or will be) paid in. Null while pending / rejected, or when no period is configured. */
  payrollPeriod: { id: string; start: string; end: string } | null;
  payday: string | null;
  /** The caller created it (they can never approve or reject it). */
  createdByMe: boolean;
}

export interface PayrollAdjustmentList {
  data: PayrollAdjustmentView[];
  total: number;
}

/** One approved adjustment of a payroll run or of a staff member's payslip (no reason: it may name other people). */
export interface AdjustmentLine {
  id: string;
  staffProfileId: string;
  kind: PayrollAdjustmentKindType;
  amountPence: number;
  correctsPayrollRecordId: string | null;
}

/** Per-kind sums of a set of adjustment lines, integer pence. */
export interface AdjustmentTotals {
  correctionsPence: number;
  bonusesPence: number;
  expensesPence: number;
  adjustmentsPence: number;
}

export const ZERO_ADJUSTMENT_TOTALS: Readonly<AdjustmentTotals> = Object.freeze({ correctionsPence: 0, bonusesPence: 0, expensesPence: 0, adjustmentsPence: 0 });

/** Pure: per-kind totals of adjustment lines (each a safe integer; every sum re-checked). */
export function adjustmentTotals(lines: readonly Pick<AdjustmentLine, 'kind' | 'amountPence'>[]): AdjustmentTotals {
  const t = { ...ZERO_ADJUSTMENT_TOTALS };
  for (const l of lines) {
    const amount = assertSafePence(l.amountPence, 'payroll_adjustment.amount_pence');
    if (l.kind === PayrollAdjustmentKind.CORRECTION) t.correctionsPence = assertSafePence(t.correctionsPence + amount, 'corrections total');
    else if (l.kind === PayrollAdjustmentKind.BONUS) t.bonusesPence = assertSafePence(t.bonusesPence + amount, 'bonuses total');
    else if (l.kind === PayrollAdjustmentKind.EXPENSE) t.expensesPence = assertSafePence(t.expensesPence + amount, 'expenses total');
    else throw new RangeError(`unknown payroll adjustment kind ${String(l.kind)}`);
    t.adjustmentsPence = assertSafePence(t.adjustmentsPence + amount, 'adjustments total');
  }
  return t;
}

interface AdjustmentRow {
  id: string;
  kind: PayrollAdjustmentKindType;
  status: PayrollAdjustmentStatusType;
  staff_profile_id: string;
  staff_user_id: string;
  amount_pence: string;
  reason: string;
  corrects_payroll_record_id: string | null;
  created_by: string;
  created_at: Date;
  decided_at: Date | null;
  rejection_reason: string | null;
  run_id: string | null;
  locked_at: Date | null;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

const ADJ_COLS = `a.id, a.kind, a.status, a.staff_profile_id, a.staff_user_id, a.amount_pence, a.reason, a.corrects_payroll_record_id,
  a.created_by, a.created_at, a.decided_at, a.rejection_reason, a.run_id, a.locked_at`;

/**
 * Payroll adjustments (owner decision 3, 21 Nov 2026): corrections (plus or minus, linked to the original approved record),
 * bonuses and expenses as separate approved lines, never a free-form deduction. Five layers:
 *  1. PermissionGuard on each handler (PayrollAdjustmentController);
 *  2. HERE, before any read or write: the same flag (payroll.view to read, payroll.calculate to add, payroll.approve to
 *     decide) and never a Venue Manager; approve / reject also refuse the line's creator and the staff member it pays
 *     (403), and approve needs a recent step-up of THIS session (403 STEP_UP_REQUIRED, decision 5);
 *  3. every query pinned to the session's organisation AND workspace (another workspace's id is a 404, never a 403);
 *  4. RLS tenant predicate; 5. RLS non-venue workspace manager predicate (staff read only their own approved lines),
 *     plus CHECK constraints for the segregation rule and core.payroll_adjustment_guard() for the state machine and lock.
 * Jobs, commands and other services reach these rules through the service; the route adds nothing the service lacks.
 */
@Injectable()
export class PayrollAdjustmentService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpReauthService,
  ) {}

  private async assertFlag(m: EntityManager, ctx: AuthContext, flag: Flag): Promise<void> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
    if ((await this.resourceScope.resolveTx(m, ctx)).kind === 'venue') throw new ForbiddenException('Permission required.');
  }

  // ------------------------------------------------------------------------------------------------------------- reads

  async list(ctx: AuthContext, dto: ListPayrollAdjustmentsDto = {}): Promise<PayrollAdjustmentList> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const where = ['a.organisation_id = $1', 'a.workspace_id = $2'];
      const params: unknown[] = [ctx.organisationId, ctx.workspaceId];
      if (dto.status) where.push(`a.status = $${params.push(dto.status)}`);
      if (dto.kind) where.push(`a.kind = $${params.push(dto.kind)}`);
      if (dto.staffProfileId) where.push(`a.staff_profile_id = $${params.push(dto.staffProfileId)}`);
      const { skip, take } = paginationSkipTake(dto);
      // sql-injection-reviewed: `where` holds only literal fragments with $n placeholders (every filter value is a bound parameter).
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM core.payroll_adjustment a WHERE ${where.join(' AND ')}`, params);
      const rows: AdjustmentRow[] = await m.query(
        // sql-injection-reviewed: `where` holds only literal fragments with $n placeholders (every filter value is a bound parameter).
        `SELECT ${ADJ_COLS} FROM core.payroll_adjustment a WHERE ${where.join(' AND ')}
          ORDER BY a.created_at DESC, a.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, take, skip],
      );
      return { data: await this.views(m, ctx, rows), total: Number(n) };
    });
  }

  // ------------------------------------------------------------------------------------------------------------ writes

  /** A correction of an approved payroll record: plus or minus, the staff member taken from that record. */
  async addCorrection(ctx: AuthContext, dto: AddPayrollCorrectionDto): Promise<PayrollAdjustmentView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      if (!Number.isSafeInteger(dto.amountPence) || dto.amountPence === 0) throw new BadRequestException('A correction must be a whole number of pence, plus or minus, never £0.00.');
      const t = businessTables(m);
      const [record] = await m.query(
        `SELECT pr.id, pr.status, pr.staff_profile_id, pr.amount_pence, sp.user_id AS staff_user_id
           FROM ${t.payroll_record} pr JOIN ${t.staff_profile} sp ON sp.id = pr.staff_profile_id
          WHERE pr.id = $1 AND pr.organisation_id = $2 AND pr.workspace_id = $3 FOR UPDATE OF pr`,
        [dto.payrollRecordId, ctx.organisationId, ctx.workspaceId],
      );
      if (!record) throw new NotFoundException('Payroll record not found.');
      if (!CORRECTABLE_RECORD_STATUSES.includes(record.status)) {
        throw new ConflictException({ code: 'PAYROLL_RECORD_NOT_APPROVED', message: 'Only approved pay can be corrected. Approve or reject the record instead.' });
      }
      if (record.staff_user_id === ctx.userId) throw this.ownPay();
      if (dto.amountPence < 0) {
        // Assumption flagged for the owner (decision 3): an overpayment correction can never take back more than the
        // original record paid. Pending and approved negative corrections of the same record count together.
        const [{ taken }] = await m.query(
          `SELECT COALESCE(sum(amount_pence), 0)::text AS taken FROM core.payroll_adjustment
            WHERE organisation_id = $1 AND workspace_id = $2 AND corrects_payroll_record_id = $3 AND amount_pence < 0 AND status <> 'rejected'`,
          [ctx.organisationId, ctx.workspaceId, record.id],
        );
        const original = assertSafePence(Number(record.amount_pence), 'payroll_record.amount_pence');
        if (assertSafePence(Number(taken), 'negative corrections') + dto.amountPence < -original) {
          throw new ConflictException({ code: 'PAYROLL_CORRECTION_EXCEEDS_ORIGINAL', message: 'A reduction cannot be larger than what the original shift paid.' });
        }
      }
      return this.insert(m, ctx, {
        kind: PayrollAdjustmentKind.CORRECTION, staffProfileId: record.staff_profile_id, staffUserId: record.staff_user_id,
        amountPence: dto.amountPence, reason: dto.reason, correctsPayrollRecordId: record.id,
      });
    });
  }

  async addBonus(ctx: AuthContext, dto: AddPayrollAdditionDto): Promise<PayrollAdjustmentView> {
    return this.addAddition(ctx, PayrollAdjustmentKind.BONUS, dto);
  }

  async addExpense(ctx: AuthContext, dto: AddPayrollAdditionDto): Promise<PayrollAdjustmentView> {
    return this.addAddition(ctx, PayrollAdjustmentKind.EXPENSE, dto);
  }

  private async addAddition(ctx: AuthContext, kind: typeof PayrollAdjustmentKind.BONUS | typeof PayrollAdjustmentKind.EXPENSE, dto: AddPayrollAdditionDto): Promise<PayrollAdjustmentView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      // Layer 2 repeats the DTO rule: a direct caller (job, command, another service) gets the same refusal.
      if (!Number.isSafeInteger(dto.amountPence) || dto.amountPence <= 0) throw new BadRequestException('A bonus or an expense must be a whole number of pence above £0.00.');
      const t = businessTables(m);
      const [staff] = await m.query(
        `SELECT sp.id, sp.user_id FROM ${t.staff_profile} sp WHERE sp.id = $1 AND sp.organisation_id = $2 AND sp.workspace_id = $3`,
        [dto.staffProfileId, ctx.organisationId, ctx.workspaceId],
      );
      if (!staff) throw new NotFoundException('Staff member not found.');
      if (staff.user_id === ctx.userId) throw this.ownPay();
      return this.insert(m, ctx, { kind, staffProfileId: staff.id, staffUserId: staff.user_id, amountPence: dto.amountPence, reason: dto.reason, correctsPayrollRecordId: null });
    });
  }

  private async insert(
    m: EntityManager,
    ctx: AuthContext,
    v: { kind: PayrollAdjustmentKindType; staffProfileId: string; staffUserId: string; amountPence: number; reason: string; correctsPayrollRecordId: string | null },
  ): Promise<PayrollAdjustmentView> {
    const [row] = await m.query(
      `INSERT INTO core.payroll_adjustment (organisation_id, workspace_id, staff_profile_id, staff_user_id, kind, amount_pence, reason, corrects_payroll_record_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ctx.organisationId, ctx.workspaceId, v.staffProfileId, v.staffUserId, v.kind, assertSafePence(v.amountPence, 'amountPence'), v.reason, v.correctsPayrollRecordId, ctx.userId],
    );
    await this.audit.record(m, ctx, AuditAction.PAYROLL_ADJUSTMENT_CREATED, {
      entityType: 'payroll_adjustment', entityId: row.id, targetUserId: v.staffUserId,
      metadata: { kind: v.kind, amountPence: v.amountPence, staffProfileId: v.staffProfileId, correctsPayrollRecordId: v.correctsPayrollRecordId },
    });
    return (await this.views(m, ctx, await this.rows(m, ctx, [row.id])))[0]!;
  }

  /**
   * Approve: a DIFFERENT person than the creator, never the staff member it pays, holding payroll.approve, with a recent
   * step-up of THIS session. The step-up is checked first, before any read (like every STEP_UP_ACTIONS operation: a stale,
   * possibly stolen session learns nothing, not even whether the id exists), and outside our transaction (its refusal is
   * audited in a short transaction of its own: never a second pool connection held under ours). Then flag, 404, 403
   * (same person / own pay), 409 (state machine), all under the row lock, then the write.
   */
  async approve(ctx: AuthContext, id: string): Promise<PayrollAdjustmentView> {
    await this.stepUp.assertRecentStepUp(ctx, PAYROLL_ADJUSTMENT_APPROVE_STEP_UP);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_APPROVE);
      const row = await this.load(m, ctx, id, true);
      this.assertDecidable(ctx, row, PayrollAdjustmentStatus.APPROVED);
      await m.query(
        `UPDATE core.payroll_adjustment SET status = 'approved', decided_by = $2, decided_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'pending_approval'`,
        [id, ctx.userId],
      );
      await this.audit.record(m, ctx, AuditAction.PAYROLL_ADJUSTMENT_APPROVED, {
        entityType: 'payroll_adjustment', entityId: id, targetUserId: row.staff_user_id,
        metadata: { kind: row.kind, amountPence: Number(row.amount_pence), staffProfileId: row.staff_profile_id, createdBy: row.created_by },
      });
      return (await this.views(m, ctx, await this.rows(m, ctx, [id])))[0]!;
    });
  }

  /** Reject: same people rule as approve (never the creator, never the paid staff member); a reason is required. No money moves. */
  async reject(ctx: AuthContext, id: string, reason: string): Promise<PayrollAdjustmentView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_APPROVE);
      const row = await this.load(m, ctx, id, true);
      this.assertDecidable(ctx, row, PayrollAdjustmentStatus.REJECTED);
      await m.query(
        `UPDATE core.payroll_adjustment SET status = 'rejected', decided_by = $2, decided_at = now(), rejection_reason = $3, updated_at = now()
          WHERE id = $1 AND status = 'pending_approval'`,
        [id, ctx.userId, reason],
      );
      await this.audit.record(m, ctx, AuditAction.PAYROLL_ADJUSTMENT_REJECTED, {
        entityType: 'payroll_adjustment', entityId: id, targetUserId: row.staff_user_id,
        metadata: { kind: row.kind, staffProfileId: row.staff_profile_id, reason },
      });
      return (await this.views(m, ctx, await this.rows(m, ctx, [id])))[0]!;
    });
  }

  private assertDecidable(ctx: AuthContext, row: AdjustmentRow, to: PayrollAdjustmentStatusType): void {
    if (row.created_by === ctx.userId) {
      throw new ForbiddenException({ code: 'PAYROLL_ADJUSTMENT_SAME_PERSON', message: 'A different person must approve or reject an adjustment you added.' });
    }
    if (row.staff_user_id === ctx.userId) throw this.ownPay();
    assertTransition(PAYROLL_ADJUSTMENT_TRANSITIONS, row.status, to);
  }

  private ownPay(): ForbiddenException {
    return new ForbiddenException({ code: 'PAYROLL_ADJUSTMENT_OWN_PAY', message: 'You cannot add, approve or reject an adjustment to your own pay.' });
  }

  // ------------------------------------------------------------------------------ payroll run hooks (caller's transaction)

  /**
   * Run prepare (PayrollRunService.prepare, same transaction, run already locked FOR UPDATE and the workspace's run lock
   * held): adds every APPROVED adjustment of this workspace that is in no run yet and allocates to `periodId`. Allocation =
   * the agency calendar period containing the APPROVAL date (Europe/London), carried forward to the next period whose run
   * is not finalised when that period's run is already finalised ("sits on the next period": an approved original is never
   * edited, a finalised run never changes). No configured period = left out (unallocated), never invented.
   */
  async includeInRun(m: EntityManager, ctx: AuthContext, runId: string, periodId: string): Promise<{ added: number; carriedForward: number }> {
    const candidates: Array<{ id: string; decided_at: Date }> = await m.query(
      `SELECT id, decided_at FROM core.payroll_adjustment
        WHERE organisation_id = $1 AND workspace_id = $2 AND status = 'approved' AND run_id IS NULL
        ORDER BY id FOR UPDATE`,
      [ctx.organisationId, ctx.workspaceId],
    );
    const alloc = await this.allocate(m, ctx, candidates);
    const ids = candidates.filter((c) => alloc.get(c.id)?.period?.id === periodId && alloc.get(c.id)?.status !== 'unallocated').map((c) => c.id);
    if (!ids.length) return { added: 0, carriedForward: 0 };
    const carriedForward = ids.filter((id) => alloc.get(id)!.status === 'carried_forward').length;
    await m.query(
      `UPDATE core.payroll_adjustment SET run_id = $3, included_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND status = 'approved' AND run_id IS NULL`,
      [ids, ctx.workspaceId, runId],
    );
    await this.audit.record(m, ctx, AuditAction.PAYROLL_ADJUSTMENTS_INCLUDED, { entityType: 'payroll_run', entityId: runId, metadata: { periodId, adjustments: ids.length, carriedForward } });
    return { added: ids.length, carriedForward };
  }

  /** Run finalise (same transaction): locks the run's adjustments; from now on the database refuses any change to them. */
  async lockForRun(m: EntityManager, ctx: AuthContext, runId: string): Promise<number> {
    const [, n] = (await m.query(
      `UPDATE core.payroll_adjustment SET locked_at = now(), updated_at = now() WHERE run_id = $1 AND workspace_id = $2 AND locked_at IS NULL`,
      [runId, ctx.workspaceId],
    )) as [unknown, number];
    return n;
  }

  /** The approved lines of one run (manager read; RLS lets only workspace payroll managers see every staff member's). */
  async linesForRun(m: EntityManager, ctx: AuthContext, runId: string): Promise<AdjustmentLine[]> {
    const rows = await m.query(
      `SELECT id, staff_profile_id, kind, amount_pence, corrects_payroll_record_id FROM core.payroll_adjustment
        WHERE run_id = $1 AND organisation_id = $2 AND workspace_id = $3 AND status = 'approved' ORDER BY created_at, id`,
      [runId, ctx.organisationId, ctx.workspaceId],
    );
    return rows.map(toLine);
  }

  /**
   * Staff app: the caller's OWN approved lines (RLS: staff_user_id = the session user AND approved), grouped by the run
   * that included them, plus the not-yet-included ones with their allocation (upcoming). Never another person's lines.
   */
  async linesForStaff(m: EntityManager, ctx: AuthContext, staffProfileId: string): Promise<{ inRuns: Array<AdjustmentLine & { runId: string }>; upcoming: Array<AdjustmentLine & { allocation: Allocation }> }> {
    const rows: Array<Record<string, unknown>> = await m.query(
      `SELECT id, staff_profile_id, kind, amount_pence, corrects_payroll_record_id, run_id, decided_at FROM core.payroll_adjustment
        WHERE organisation_id = $1 AND workspace_id = $2 AND staff_profile_id = $3 AND staff_user_id = $4 AND status = 'approved'
        ORDER BY decided_at, id`,
      [ctx.organisationId, ctx.workspaceId, staffProfileId, ctx.userId],
    );
    const inRuns = rows.filter((r) => r.run_id).map((r) => ({ ...toLine(r), runId: r.run_id as string }));
    const pending = rows.filter((r) => !r.run_id);
    const alloc = await this.allocate(m, ctx, pending.map((r) => ({ id: r.id as string, decided_at: r.decided_at as Date })));
    return { inRuns, upcoming: pending.map((r) => ({ ...toLine(r), allocation: alloc.get(r.id as string)! })) };
  }

  // ------------------------------------------------------------------------------------------------------------ helpers

  /** Allocation by approval date through the shared calendar rules (a pending line has no allocation). */
  private allocate(m: EntityManager, ctx: AuthContext, rows: ReadonlyArray<{ id: string; decided_at: Date | null }>): Promise<Map<string, Allocation>> {
    // allocateRecords also looks for a run line of each id; adjustment ids never have one, so only the date rules apply.
    return allocateRecords(m, { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! },
      rows.filter((r) => r.decided_at).map((r) => ({ id: r.id, startsAt: r.decided_at! })));
  }

  private async load(m: EntityManager, ctx: AuthContext, id: string, forUpdate: boolean): Promise<AdjustmentRow> {
    const [row] = await m.query(
      // sql-injection-reviewed: interpolates the module constant ADJ_COLS and a literal FOR UPDATE ternary; every value is a bound $n parameter.
      `SELECT ${ADJ_COLS} FROM core.payroll_adjustment a WHERE a.id = $1 AND a.organisation_id = $2 AND a.workspace_id = $3 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id, ctx.organisationId, ctx.workspaceId],
    );
    if (!row) throw new NotFoundException('Payroll adjustment not found.');
    return row;
  }

  private async rows(m: EntityManager, ctx: AuthContext, ids: string[]): Promise<AdjustmentRow[]> {
    // sql-injection-reviewed: interpolates the module constant ADJ_COLS and a literal FOR UPDATE ternary; every value is a bound $n parameter.
    return m.query(`SELECT ${ADJ_COLS} FROM core.payroll_adjustment a WHERE a.id = ANY($1::uuid[]) AND a.organisation_id = $2 AND a.workspace_id = $3`, [ids, ctx.organisationId, ctx.workspaceId]);
  }

  private async views(m: EntityManager, ctx: AuthContext, rows: AdjustmentRow[]): Promise<PayrollAdjustmentView[]> {
    if (!rows.length) return [];
    const t = businessTables(m);
    const staffIds = [...new Set(rows.map((r) => r.staff_profile_id))];
    const names: Array<{ id: string; first_name: string; last_name: string }> = await m.query(
      `SELECT sp.id, u.first_name, u.last_name FROM ${t.staff_profile} sp JOIN core."user" u ON u.id = sp.user_id
        WHERE sp.id = ANY($1::uuid[]) AND sp.workspace_id = $2`,
      [staffIds, ctx.workspaceId],
    );
    const staffName = new Map(names.map((n) => [n.id, `${n.first_name} ${n.last_name}`]));
    const people: Array<{ id: string; created_by_name: string | null; decided_by_name: string | null }> = await m.query(
      `SELECT a.id,
              (SELECT u.first_name || ' ' || u.last_name FROM core."user" u WHERE u.id = a.created_by) AS created_by_name,
              (SELECT u.first_name || ' ' || u.last_name FROM core."user" u WHERE u.id = a.decided_by) AS decided_by_name
         FROM core.payroll_adjustment a WHERE a.id = ANY($1::uuid[]) AND a.workspace_id = $2`,
      [rows.map((r) => r.id), ctx.workspaceId],
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    const alloc = await this.allocate(m, ctx, rows.filter((r) => r.status === PayrollAdjustmentStatus.APPROVED && !r.run_id));
    const runs: Array<{ id: string; period_id: string }> = rows.some((r) => r.run_id)
      ? await m.query(`SELECT id, period_id FROM ${t.payroll_run} WHERE id = ANY($1::uuid[]) AND workspace_id = $2`, [rows.filter((r) => r.run_id).map((r) => r.run_id), ctx.workspaceId])
      : [];
    const runPeriod = new Map(runs.map((r) => [r.id, r.period_id]));
    const periods = await periodsById(m, ctx.organisationId!, [...new Set(runs.map((r) => r.period_id))]);
    return rows.map((r) => {
      const period: PeriodRef | null = r.run_id ? periods.get(runPeriod.get(r.run_id) ?? '') ?? null : alloc.get(r.id)?.period ?? null;
      return {
        id: r.id, kind: r.kind, status: r.status, staffProfileId: r.staff_profile_id, staffName: staffName.get(r.staff_profile_id) ?? '',
        amountPence: assertSafePence(Number(r.amount_pence), 'payroll_adjustment.amount_pence'), reason: r.reason,
        correctsPayrollRecordId: r.corrects_payroll_record_id, createdAt: iso(r.created_at)!, createdByName: byId.get(r.id)?.created_by_name ?? null,
        decidedAt: iso(r.decided_at), decidedByName: byId.get(r.id)?.decided_by_name ?? null, rejectionReason: r.rejection_reason,
        runId: r.run_id, locked: r.locked_at !== null,
        payrollPeriod: period ? { id: period.id, start: period.start, end: period.end } : null, payday: period?.payday ?? null,
        createdByMe: r.created_by === ctx.userId,
      };
    });
  }

}

function toLine(r: Record<string, unknown>): AdjustmentLine {
  return {
    id: r.id as string, staffProfileId: r.staff_profile_id as string, kind: r.kind as PayrollAdjustmentKindType,
    amountPence: assertSafePence(Number(r.amount_pence), 'payroll_adjustment.amount_pence'), correctsPayrollRecordId: (r.corrects_payroll_record_id as string) ?? null,
  };
}
