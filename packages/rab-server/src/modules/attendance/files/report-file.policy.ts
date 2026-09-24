import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { FileKindPolicy } from '../../../engine/core-modules/storage/file-access.registry';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftReport } from '../entities/shift-report.entity';
import { ShiftReportService } from '../services/shift-report.service';

/**
 * Who may download a generated report PDF (roster or final timesheet).
 *
 * Layer 2 (this file): the caller must hold `report.view` — the SAME flag that
 * guards `GET /attendance/report/shift/:shiftId` — and must pass the SAME
 * scope rule that endpoint applies (`ShiftReportService.canReadShift`: a Venue
 * Manager only their venues' shifts, a plain Manager only shifts they
 * created). Staff never hold `report.view`.
 * Layer 4 (RLS, before this runs): `stored_file`'s policy limits rows to the
 * caller's organisation and workspace. RLS does NOT narrow to a single venue
 * (neither does `shift_report`'s own policy) — that finer cut is this policy's job.
 */
export class ReportFilePolicy implements FileKindPolicy {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly shiftReports: ShiftReportService,
  ) {}

  async canRead(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<boolean> {
    if (file.resourceType !== 'shift_report') return false;
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.REPORT_VIEW))) return false;
    const report = await manager.findOne(ShiftReport, { where: { id: file.resourceId } });
    if (!report) return false;
    const shift = await manager.findOne(Shift, { where: { id: report.shiftId } });
    // Venue scoping lives HERE, not in RLS: shift_report's RLS is workspace-wide (a Venue Manager shares the workspace),
    // and the per-venue restriction is the service-layer rule the report endpoint itself uses.
    return shift !== null && (await this.shiftReports.canReadShift(manager, ctx, shift));
  }
}
