import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A Phase 4 — structural, database-level guarantee that a
 * Workspace-scoped child row can never reference a parent belonging to a
 * DIFFERENT Workspace, on top of (never instead of) the existing RLS/service
 * layer checks. Deliberately NULL-tolerant: `workspace_id` stays nullable
 * (Phase 3 — deferred, see that phase's own note: the only NULL rows in this
 * local DB are 99.97% test-run noise plus a handful of genuine pre-migration
 * legacy rows in the one real seeded org, and Postgres refuses to even
 * attempt `SET NOT NULL` while they exist). Postgres's default multi-column
 * FK match type, `MATCH SIMPLE`, skips validation entirely for a row whose
 * OWN referencing columns include a NULL — so a NULL-`workspace_id` child
 * row is simply unconstrained on this dimension (exactly like every other
 * check this whole migration set already applies only where a real
 * workspace_id exists), never rejected and never silently paired with a
 * `MATCH SIMPLE`-style broadening. Proven safe before writing this: a live
 * query across every relationship below found zero rows where both sides'
 * `workspace_id` were non-null and DISAGREED.
 *
 * Parents get a `UNIQUE(id, workspace_id)` alongside their existing
 * `PRIMARY KEY(id)` — required for a composite FK to reference the pair;
 * trivially satisfied since `id` is already globally unique.
 */
export class CompositeWorkspaceForeignKeys1786669500000 implements MigrationInterface {
  name = 'CompositeWorkspaceForeignKeys1786669500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.venue ADD CONSTRAINT venue_id_workspace_id_key UNIQUE (id, workspace_id);`);
    await queryRunner.query(`ALTER TABLE core.shift ADD CONSTRAINT shift_id_workspace_id_key UNIQUE (id, workspace_id);`);
    await queryRunner.query(
      `ALTER TABLE core.shift_assignment ADD CONSTRAINT shift_assignment_id_workspace_id_key UNIQUE (id, workspace_id);`,
    );
    await queryRunner.query(`ALTER TABLE core.staff_profile ADD CONSTRAINT staff_profile_id_workspace_id_key UNIQUE (id, workspace_id);`);

    await queryRunner.query(`
      ALTER TABLE core.shift ADD CONSTRAINT shift_venue_workspace_fkey
        FOREIGN KEY (venue_id, workspace_id) REFERENCES core.venue (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.shift_assignment ADD CONSTRAINT shift_assignment_shift_workspace_fkey
        FOREIGN KEY (shift_id, workspace_id) REFERENCES core.shift (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.shift_assignment ADD CONSTRAINT shift_assignment_staff_workspace_fkey
        FOREIGN KEY (staff_profile_id, workspace_id) REFERENCES core.staff_profile (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.job_offer ADD CONSTRAINT job_offer_shift_assignment_workspace_fkey
        FOREIGN KEY (shift_assignment_id, workspace_id) REFERENCES core.shift_assignment (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.job_offer ADD CONSTRAINT job_offer_staff_workspace_fkey
        FOREIGN KEY (staff_profile_id, workspace_id) REFERENCES core.staff_profile (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.attendance ADD CONSTRAINT attendance_shift_workspace_fkey
        FOREIGN KEY (shift_id, workspace_id) REFERENCES core.shift (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.attendance ADD CONSTRAINT attendance_shift_assignment_workspace_fkey
        FOREIGN KEY (shift_assignment_id, workspace_id) REFERENCES core.shift_assignment (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.attendance ADD CONSTRAINT attendance_staff_workspace_fkey
        FOREIGN KEY (staff_profile_id, workspace_id) REFERENCES core.staff_profile (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.manager_venue ADD CONSTRAINT manager_venue_venue_workspace_fkey
        FOREIGN KEY (venue_id, workspace_id) REFERENCES core.venue (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.venue_role_rate ADD CONSTRAINT venue_role_rate_venue_workspace_fkey
        FOREIGN KEY (venue_id, workspace_id) REFERENCES core.venue (id, workspace_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.venue_role_rate DROP CONSTRAINT venue_role_rate_venue_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.manager_venue DROP CONSTRAINT manager_venue_venue_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_staff_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_shift_assignment_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_shift_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.job_offer DROP CONSTRAINT job_offer_staff_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.job_offer DROP CONSTRAINT job_offer_shift_assignment_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_staff_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_shift_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.shift DROP CONSTRAINT shift_venue_workspace_fkey;`);

    await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT staff_profile_id_workspace_id_key;`);
    await queryRunner.query(`ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_id_workspace_id_key;`);
    await queryRunner.query(`ALTER TABLE core.shift DROP CONSTRAINT shift_id_workspace_id_key;`);
    await queryRunner.query(`ALTER TABLE core.venue DROP CONSTRAINT venue_id_workspace_id_key;`);
  }
}
