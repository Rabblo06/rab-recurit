import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 3 — core.manager_profile: FORCE ROW LEVEL SECURITY.
 *
 * Manager profiles are organisation-scoped identity bridges (manager_profile_tenant: organisation_id = current_org()).
 * The NOT FORCE exemption existed only for the retired resolve_workspace_for_user. Owner-run code reads them inside a
 * bound organisation only, so FORCE makes an unbound owner read return zero rows, which is the fail-closed behaviour.
 *
 * No policy semantics change: only the FORCE flag. down() restores NOT FORCE, the state before this migration.
 */
export class ManagerProfileForceRls1786675810000 implements MigrationInterface {
  name = 'ManagerProfileForceRls1786675810000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_profile FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile NO FORCE ROW LEVEL SECURITY;`);
  }
}
