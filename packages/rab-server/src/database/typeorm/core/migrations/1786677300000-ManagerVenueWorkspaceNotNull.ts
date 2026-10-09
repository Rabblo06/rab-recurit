import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * core.manager_venue.workspace_id becomes NOT NULL. A link row must always belong to a workspace, which the composite manager-profile FK
 * (manager_profile_id, organisation_id, workspace_id) already requires. The Workspace Schema V1 physical table is NOT NULL since its creation.
 *
 * Preflight, fail closed: the migration refuses to run if any row has a NULL workspace_id. Nothing is repaired silently.
 * down() drops the NOT NULL constraint only; the composite FK and every other constraint are untouched.
 */
export class ManagerVenueWorkspaceNotNull1786677300000 implements MigrationInterface {
  name = 'ManagerVenueWorkspaceNotNull1786677300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // manager_venue is FORCE RLS, so a count without an organisation context sees no rows and would pass for the wrong reason.
    // Count per organisation under that organisation's context instead.
    const orgs: Array<{ id: string }> = await queryRunner.query('SELECT id FROM core.organisation');
    let nulls = 0;
    for (const org of orgs) {
      await queryRunner.query(`SELECT set_config('rab.organisation_id', $1, true)`, [org.id]);
      const row = await queryRunner.query('SELECT count(*)::int AS n FROM core.manager_venue WHERE workspace_id IS NULL');
      nulls += row[0].n;
    }
    if (nulls !== 0) {
      throw new Error('manager_venue has ' + nulls + ' row(s) with NULL workspace_id; refusing to add NOT NULL');
    }
    await queryRunner.query('ALTER TABLE core.manager_venue ALTER COLUMN workspace_id SET NOT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE core.manager_venue ALTER COLUMN workspace_id DROP NOT NULL');
  }
}
