import { MigrationInterface, QueryRunner } from 'typeorm';

export class VenueRequestDefaultPermissions1786671800000 implements MigrationInterface {
  name = 'VenueRequestDefaultPermissions1786671800000';
  async up(queryRunner: QueryRunner): Promise<void> {
    const organisations: { id: string }[] = await queryRunner.query('SELECT id FROM core.organisation');
    for (const organisation of organisations) {
      await queryRunner.query("SELECT set_config('rab.organisation_id', $1, true)", [organisation.id]);
      await queryRunner.query(`INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
        SELECT r.organisation_id, r.id, p.id FROM core.role r CROSS JOIN core.permission p
        WHERE r.organisation_id = $1 AND r.key = 'venue_manager' AND r.is_system = true
          AND p.key IN ('staff.view', 'venue.view', 'schedule.view', 'staffing_request.create')
        ON CONFLICT DO NOTHING`, [organisation.id]);
    }
    await queryRunner.query("SELECT set_config('rab.organisation_id', '', true)");
    // Deliberate user-level revocations still win in PermissionsService.
    // No direct offer.send or approval permission is granted.
  }
  async down(): Promise<void> {
    // Additive defaults cannot safely be distinguished from existing grants.
  }
}
