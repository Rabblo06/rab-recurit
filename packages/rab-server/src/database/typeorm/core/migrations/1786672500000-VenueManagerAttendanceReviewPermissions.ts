import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The attendance review flow (Venue Manager reviews a finished shift, corrects
 * clock-in/out/break with a reason, then Finalise & Send) needs two permissions
 * the production `venue_manager` role never had: `attendance.edit` (correct a
 * record) and `report.export` (finalise the shift report). Without them a real
 * Venue Manager saw the Report screen and every action on it returned 403.
 *
 * Scope is NOT widened by this grant: `AttendanceService.correct` and
 * `ShiftReportService.finalise` re-check the caller's own venue scope in the
 * service (404 outside their assigned venues), which is what actually confines
 * a Venue Manager to their venues.
 *
 * Additive and idempotent, same shape as `VenueRequestDefaultPermissions` /
 * `AttendanceSchema`'s backfill: the permission rows are created if absent (a
 * freshly migrated database has none until bootstrap), then granted to every
 * existing system `venue_manager` role. Deliberate per-user revocations still
 * win in `PermissionsService`. New organisations get the same permissions via
 * `ROLE_DEFS` in `ManagerService`.
 */
export class VenueManagerAttendanceReviewPermissions1786672500000 implements MigrationInterface {
  name = 'VenueManagerAttendanceReviewPermissions1786672500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO core.permission (key, resource, action)
      VALUES ('attendance.edit', 'attendance', 'edit'), ('report.export', 'report', 'export')
      ON CONFLICT (key) DO NOTHING;
    `);
    // Both core.role (read) and core.role_permission (write) are FORCE-RLS'd and a migration binds no tenant context —
    // same standard bracket as AttendanceSchema's cross-organisation backfill.
    await queryRunner.query(`ALTER TABLE core.role DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
      SELECT r.organisation_id, r.id, p.id
      FROM core.role r
      CROSS JOIN core.permission p
      WHERE r.key = 'venue_manager' AND r.is_system = true AND p.key IN ('attendance.edit', 'report.export')
      ON CONFLICT DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
  }

  async down(): Promise<void> {
    // Additive defaults cannot safely be distinguished from grants an administrator later made deliberately.
  }
}
