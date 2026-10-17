import { PermissionFlag, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';

/** Read-only roster, independent of payroll/attendance writes. No directory access. */
@Injectable()
export class ShiftTeamService {
  constructor(private readonly tenant: TenantContextService, private readonly permissions: PermissionsService) {}

  async list(ctx: AuthContext, shiftId: string) {
    if (ctx.applicationTarget !== 'staff_app' || ctx.role !== 'staff' ||
        !(await this.permissions.userHasPermission(ctx, PermissionFlag.ATTENDANCE_CLOCK))) {
      throw new ForbiddenException('Staff attendance access required.');
    }
    return this.tenant.runInWorkspaceContext(ctx, async (manager, schema) => {
      const scope = { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! };
      // Resolve self while the normal own-profile-only RLS is still in force.
      const caller = await manager.findOneBy(StaffProfile, { ...scope, userId: ctx.userId });
      if (!caller) throw new NotFoundException('Shift not found.');
      // Same parent-first lock order as attendance/cancellation/confirmation.
      const shift = await manager.findOne(Shift, {
        where: { ...scope, id: shiftId }, lock: { mode: 'pessimistic_read' },
      });
      if (!shift || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        throw new NotFoundException('Shift not found.');
      }
      const assignment = await manager.findOne(ShiftAssignment, {
        where: { ...scope, shiftId, staffProfileId: caller.id, status: ShiftAssignmentStatus.CONFIRMED },
        lock: { mode: 'pessimistic_read' },
      });
      if (!assignment) throw new NotFoundException('Shift not found.');
      const [readScope] = await manager.query(`SELECT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = $1 AND tablename = 'staff_profile'
        AND policyname = 'staff_profile_shift_team_select') AS ready`, [schema]);
      if (!readScope?.ready) throw new ServiceUnavailableException('Team visibility is not available yet.');
      // Transaction-local capability, derived above, never accepted from HTTP.
      // The additive SELECT policy rechecks confirmed membership and live shift.
      await manager.query(`SELECT set_config('rab.team_shift_id', $1, true), set_config('rab.team_staff_id', $2, true)`, [shiftId, caller.id]);
      const time = assignmentTimeSql();
      const rows = await manager.query(`
        SELECT COALESCE(NULLIF(trim(u.first_name), ''), 'Team member') AS "displayName",
               ${time.start} AS "startsAt", ${time.end} AS "endsAt",
               sa.staff_profile_id = $4 AS "isYou"
        FROM shift_assignment sa
        JOIN shift s ON s.id = sa.shift_id AND s.organisation_id = sa.organisation_id AND s.workspace_id = sa.workspace_id
        JOIN staff_profile sp ON sp.id = sa.staff_profile_id AND sp.organisation_id = sa.organisation_id AND sp.workspace_id = sa.workspace_id
        JOIN core."user" u ON u.id = sp.user_id AND u.organisation_id = sp.organisation_id
        JOIN venue v ON v.id = s.venue_id AND v.organisation_id = s.organisation_id AND v.workspace_id = s.workspace_id
        WHERE sa.shift_id = $1 AND sa.organisation_id = $2 AND sa.workspace_id = $3
          AND sa.status = 'confirmed' AND s.venue_id = $5 AND s.status NOT IN ('cancelled', 'completed')
        ORDER BY ${time.start}, u.first_name, sa.id
      `, [shiftId, ctx.organisationId, ctx.workspaceId, caller.id, shift.venueId]);
      return rows as Array<{ displayName: string; startsAt: Date; endsAt: Date; isYou: boolean }>;
    });
  }
}
