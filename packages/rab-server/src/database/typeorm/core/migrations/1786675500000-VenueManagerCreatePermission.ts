import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 1 (decision C) — the NORMAL Manager's narrow Venue Manager creation permission.
 *
 * `venue_manager.create` lets an internal Manager create a Venue Manager inside THEIR OWN workspace. It is deliberately
 * NOT `manager.manage` (MANAGER_MANAGE), which stays a CEO/admin capability. Granted to existing system `manager` roles
 * here; new organisations receive it through ROLE_DEFS in ManagerService.
 *
 * The creation service derives the workspace from the caller's server-side context and never reads one from the request,
 * so this grant does not widen tenancy: a Manager can only create Venue Managers in Workspace A (their own).
 *
 * Same bracket as VenueManagerAttendanceReviewPermissions: the migration binds no tenant context, and role / role_permission
 * are FORCE-RLS'd, so RLS is disabled only for the duration of this owner-run grant.
 * down() removes exactly what up() added (the permission did not exist before), so it is a true inverse.
 */
export class VenueManagerCreatePermission1786675500000 implements MigrationInterface {
  name = 'VenueManagerCreatePermission1786675500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO core.permission (key, resource, action, description)
      VALUES ('venue_manager.create', 'venue_manager', 'create', 'Create a Venue Manager inside the caller''s own workspace')
      ON CONFLICT (key) DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.role DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
      SELECT r.organisation_id, r.id, p.id
        FROM core.role r
        CROSS JOIN core.permission p
       WHERE r.key = 'manager' AND r.is_system = true AND p.key = 'venue_manager.create'
      ON CONFLICT DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      DELETE FROM core.role_permission
       WHERE permission_id IN (SELECT id FROM core.permission WHERE key = 'venue_manager.create');
    `);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`DELETE FROM core.permission WHERE key = 'venue_manager.create';`);
  }
}
