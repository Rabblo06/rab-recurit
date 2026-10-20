import { PermissionFlag } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { SaveStaffReviewDto } from '../dto/staff-review.dto';
import { ShiftReportService } from './shift-report.service';

export interface StaffReview {
  shiftId: string;
  staffProfileId: string;
  grooming: number;
  attitude: number;
  skills: number;
  attendance: number;
  timeKeeping: number;
  feedback: string | null;
  reviewerUserId: string;
  reviewerName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-shift staff performance reviews (Venue Manager "Staff review" tab). Five enforcement layers:
 * route `PermissionGuard(REVIEW_CREATE)` → this service re-checks the permission and the report scope
 * (`ShiftReportService.canReadShift`, 404 out of scope) → workspace-bound transaction → `shift_staff_review_scope` RLS
 * (tenant + shift creator / venue-linked Venue Manager; reviewer pinned to the caller) → composite FKs (the staff
 * member must hold an assignment on that very shift).
 *
 * Policy (owner brief 2026-10-17): reviews are per shift, never aggregated into a global staff rating; one review per
 * staff member per shift (upsert, never a silent duplicate); editable until the shift report is finalised; readable only
 * by those who can read the report. Staff do not see reviews (not exposed on any staff endpoint).
 */
@Injectable()
export class ShiftReviewService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly reports: ShiftReportService,
    private readonly audit: AuditService,
  ) {}

  async get(ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<{ review: StaffReview | null; editable: boolean }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertAllowed(manager, ctx, shiftId, staffProfileId);
      return { review: await this.read(manager, shiftId, staffProfileId), editable: !(await this.finalised(manager, shiftId)) };
    });
  }

  async save(ctx: AuthContext, shiftId: string, staffProfileId: string, dto: SaveStaffReviewDto): Promise<StaffReview> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await this.assertAllowed(manager, ctx, shiftId, staffProfileId);
      // Same lock the finalise path takes: a review can never land after (or race with) finalisation.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`finalise:${shiftId}`]);
      if (await this.finalised(manager, shiftId)) throw new ConflictException('This shift report has been finalised; its staff reviews can no longer be changed.');
      const feedback = dto.feedback?.trim() ? dto.feedback.trim() : null;
      const [{ inserted }] = await manager.query(
        `INSERT INTO shift_staff_review (organisation_id, workspace_id, shift_id, staff_profile_id, reviewer_user_id,
           grooming, attitude, skills, attendance, time_keeping, feedback)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (shift_id, staff_profile_id) DO UPDATE SET reviewer_user_id = EXCLUDED.reviewer_user_id,
           grooming = EXCLUDED.grooming, attitude = EXCLUDED.attitude, skills = EXCLUDED.skills, attendance = EXCLUDED.attendance,
           time_keeping = EXCLUDED.time_keeping, feedback = EXCLUDED.feedback, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [ctx.organisationId, shift.workspaceId, shiftId, staffProfileId, ctx.userId, dto.grooming, dto.attitude, dto.skills, dto.attendance, dto.timeKeeping, feedback],
      );
      await this.audit.record(manager, ctx, AuditAction.STAFF_REVIEW_SAVED, {
        entityType: 'shift_staff_review',
        entityId: shiftId,
        metadata: { shiftId, staffProfileId, created: !!inserted, ratings: [dto.grooming, dto.attitude, dto.skills, dto.attendance, dto.timeKeeping] },
      });
      return (await this.read(manager, shiftId, staffProfileId))!;
    });
  }

  private async assertAllowed(manager: EntityManager, ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<Shift> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.REVIEW_CREATE))) throw new ForbiddenException('Permission required.');
    const shift = await manager.findOne(Shift, { where: { id: shiftId } });
    if (!shift || shift.organisationId !== ctx.organisationId || !(await this.reports.canReadShift(manager, ctx, shift))) throw new NotFoundException('Shift not found.');
    const [onShift] = await manager.query(
      `SELECT 1 FROM shift_assignment WHERE shift_id = $1 AND staff_profile_id = $2 AND status IN ('confirmed','completed','no_show')`,
      [shiftId, staffProfileId],
    );
    if (!onShift) throw new NotFoundException('Staff member not found on this shift.');
    return shift;
  }

  private async finalised(manager: EntityManager, shiftId: string): Promise<boolean> {
    const [row] = await manager.query(`SELECT status FROM shift_report WHERE shift_id = $1`, [shiftId]);
    return row?.status === 'finalised';
  }

  private async read(manager: EntityManager, shiftId: string, staffProfileId: string): Promise<StaffReview | null> {
    const [r] = await manager.query(
      `SELECT r.*, u.first_name || ' ' || u.last_name AS reviewer_name FROM shift_staff_review r
         JOIN core."user" u ON u.id = r.reviewer_user_id WHERE r.shift_id = $1 AND r.staff_profile_id = $2`,
      [shiftId, staffProfileId],
    );
    if (!r) return null;
    return {
      shiftId: r.shift_id, staffProfileId: r.staff_profile_id, grooming: r.grooming, attitude: r.attitude, skills: r.skills,
      attendance: r.attendance, timeKeeping: r.time_keeping, feedback: r.feedback, reviewerUserId: r.reviewer_user_id,
      reviewerName: r.reviewer_name, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
}
