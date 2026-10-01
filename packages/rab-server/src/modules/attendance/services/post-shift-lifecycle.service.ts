import { POST_SHIFT_COMPLETE_HOURS, POST_SHIFT_EXPIRED_HOURS } from '@rab/shared';
import { EntityManager } from 'typeorm';
import {
  AuditAction,
  AuditService,
} from '../../../engine/core-modules/audit/audit.service';

/** Called inside a trusted tenant transaction. Never changes payroll status or pay. */
export class PostShiftLifecycleService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Read-only discovery, called under the Worker's rab_app workspace
   * transaction with RLS enabled and forced. PHASE 7.1 — thresholds now come from `@rab/shared`'s
   * `POST_SHIFT_COMPLETE_HOURS`/`POST_SHIFT_EXPIRED_HOURS` (1h/2h,
   * previously 2h/6h) via parameterized `make_interval(hours => $N)` —
   * matching `advance()`'s own established parameterization below, rather
   * than a second copy of the literal interval text. The database's own
   * `attendance_post_shift_order` CHECK constraint is a SEPARATE,
   * necessarily-duplicated source of truth — see that constant file's own
   * doc comment for why it can't be unified further.
   */
  static discover(manager: EntityManager) {
    return manager.query<
      Array<{
        id: string;
        organisation_id: string;
        workspace_id: string | null;
      }>
    >(
      `
        SELECT id, organisation_id, workspace_id FROM core.attendance
        WHERE workspace_id IS NOT NULL AND clock_out_at IS NOT NULL AND status IN ('clocked_out','under_review','approved','disputed')
          AND ((post_shift_completed_at IS NULL AND clock_out_at <= now() - make_interval(hours => $1))
            OR (post_shift_expired_at IS NULL AND clock_out_at <= now() - make_interval(hours => $2)))
        ORDER BY clock_out_at LIMIT 500
      `,
      [POST_SHIFT_COMPLETE_HOURS, POST_SHIFT_EXPIRED_HOURS],
    );
  }

  async advance(manager: EntityManager, attendanceId: string): Promise<number> {
    const [row] = await manager.query(
      `SELECT id, organisation_id, clock_out_at,
      post_shift_completed_at, post_shift_expired_at, now() AS server_now,
      clock_out_at <= now() - make_interval(hours => $2) AS complete_due,
      clock_out_at <= now() - make_interval(hours => $3) AS expired_due
      FROM core.attendance WHERE id=$1 AND organisation_id=core.current_org() AND workspace_id=core.current_workspace() AND clock_out_at IS NOT NULL
        AND status IN ('clocked_out','under_review','approved','disputed')
      FOR UPDATE`,
      [attendanceId, POST_SHIFT_COMPLETE_HOURS, POST_SHIFT_EXPIRED_HOURS],
    );
    if (!row) return 0;
    const clockOut = new Date(row.clock_out_at).getTime();
    let count = 0;
    for (const milestone of [
      {
        column: 'post_shift_completed_at',
        hours: POST_SHIFT_COMPLETE_HOURS,
        due: 'complete_due',
        from: 'clockedOut',
        to: 'complete',
        action: AuditAction.ATTENDANCE_POST_SHIFT_COMPLETED,
      },
      {
        column: 'post_shift_expired_at',
        hours: POST_SHIFT_EXPIRED_HOURS,
        due: 'expired_due',
        from: 'complete',
        to: 'expired',
        action: AuditAction.ATTENDANCE_POST_SHIFT_EXPIRED,
      },
    ] as const) {
      if (row[milestone.column] || !row[milestone.due]) continue;
      const effectiveAt = new Date(clockOut + milestone.hours * 3600000);
      await manager.query(
        `UPDATE core.attendance SET ${milestone.column}=clock_out_at + make_interval(hours => $2), updated_at=now() WHERE id=$1`,
        [row.id, milestone.hours],
      );
      await this.audit.record(
        manager,
        { organisationId: row.organisation_id, userId: '' },
        milestone.action,
        {
          actorUserId: null,
          entityType: 'attendance',
          entityId: row.id,
          metadata: {
            source: 'worker',
            previousState: milestone.from,
            newState: milestone.to,
            effectiveAt: effectiveAt.toISOString(),
            processedAt: new Date(row.server_now).toISOString(),
            clockOutAt: new Date(clockOut).toISOString(),
          },
        },
      );
      count++;
    }
    return count;
  }
}
