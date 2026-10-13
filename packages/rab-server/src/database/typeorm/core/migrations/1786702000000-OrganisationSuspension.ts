import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.8 — reversible organisation suspension (never a hard delete; see docs/HANDOFF.md for the
 * owner-approved scope). `core.organisation` has no RLS policy of its own (it IS the tenant root
 * — see that entity's own doc comment) and no FORCE to consider; these columns need no grant
 * changes, since `crewflow_app` already has whatever SELECT/UPDATE privilege it has on this table
 * today (confirmed: `AuthService.login()`/`completeLogin()` already read from it).
 */
export class OrganisationSuspension1786702000000 implements MigrationInterface {
  name = 'OrganisationSuspension1786702000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.organisation
        ADD COLUMN suspended_at timestamptz NULL,
        ADD COLUMN suspended_by uuid NULL REFERENCES core."user"(id),
        ADD COLUMN suspended_reason text NULL,
        ADD COLUMN reactivated_at timestamptz NULL,
        ADD COLUMN reactivated_by uuid NULL REFERENCES core."user"(id);
    `);
    // A reason/actor with no timestamp (or vice versa) is a data-integrity bug, not a valid state —
    // enforced by the database, not left to application discipline alone.
    await queryRunner.query(`
      ALTER TABLE core.organisation
        ADD CONSTRAINT organisation_suspension_consistency
        CHECK (
          (suspended_at IS NULL) = (suspended_by IS NULL)
          AND (reactivated_at IS NULL) = (reactivated_by IS NULL)
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.organisation DROP CONSTRAINT organisation_suspension_consistency;`);
    await queryRunner.query(`
      ALTER TABLE core.organisation
        DROP COLUMN suspended_at,
        DROP COLUMN suspended_by,
        DROP COLUMN suspended_reason,
        DROP COLUMN reactivated_at,
        DROP COLUMN reactivated_by;
    `);
  }
}
