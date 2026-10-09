import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, step 22 — remediation of unconditional write policies.
 *
 * Verified on rab_crewflow_hws_phase3 as rab_app inside rolled-back transactions (see
 * docs/architecture/HYPER-WORKSPACE-PHASE3-FOUNDATION.md):
 * - UPDATE/DELETE on core.user, core.user_role and core.user_permission_override into another
 *   organisation returned 0 rows. Protection currently comes from the organisation-scoped SELECT
 *   policies, not from the write policies.
 * - INSERT into another organisation SUCCEEDED for core.user (user_write WITH CHECK true),
 *   core.user_role (user_role_write WITH CHECK true) and core.user_permission_override (its WITH CHECK
 *   was passed). That is a real cross-tenant write.
 *
 * This migration scopes every write policy on those three tables to core.current_org(). Same-
 * organisation writes are unaffected. Platform-admin and bootstrap flows that operate across
 * organisations must use a narrow, audited SECURITY DEFINER function (none is introduced here).
 *
 * down() restores the original unconditional policies exactly, for rollback only.
 */
export class TenantWritePolicies1786674800000 implements MigrationInterface {
  name = 'TenantWritePolicies1786674800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY user_write ON core."user";`);
    await queryRunner.query(`DROP POLICY user_update ON core."user";`);
    await queryRunner.query(`DROP POLICY user_delete ON core."user";`);
    await queryRunner.query(`CREATE POLICY user_write ON core."user" FOR INSERT WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_update ON core."user" FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_delete ON core."user" FOR DELETE USING (organisation_id = core.current_org());`);

    await queryRunner.query(`DROP POLICY user_role_write ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_update ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_delete ON core.user_role;`);
    await queryRunner.query(`CREATE POLICY user_role_write ON core.user_role FOR INSERT WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_role_update ON core.user_role FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_role_delete ON core.user_role FOR DELETE USING (organisation_id = core.current_org());`);

    await queryRunner.query(`DROP POLICY user_permission_override_write ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_update ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_delete ON core.user_permission_override;`);
    await queryRunner.query(`CREATE POLICY user_permission_override_write ON core.user_permission_override FOR INSERT WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_permission_override_update ON core.user_permission_override FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`CREATE POLICY user_permission_override_delete ON core.user_permission_override FOR DELETE USING (organisation_id = core.current_org());`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY user_write ON core."user";`);
    await queryRunner.query(`DROP POLICY user_update ON core."user";`);
    await queryRunner.query(`DROP POLICY user_delete ON core."user";`);
    await queryRunner.query(`CREATE POLICY user_write ON core."user" FOR INSERT WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_update ON core."user" FOR UPDATE USING (true) WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_delete ON core."user" FOR DELETE USING (true);`);

    await queryRunner.query(`DROP POLICY user_role_write ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_update ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_delete ON core.user_role;`);
    await queryRunner.query(`CREATE POLICY user_role_write ON core.user_role FOR INSERT WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_role_update ON core.user_role FOR UPDATE USING (true) WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_role_delete ON core.user_role FOR DELETE USING (true);`);

    await queryRunner.query(`DROP POLICY user_permission_override_write ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_update ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_delete ON core.user_permission_override;`);
    await queryRunner.query(`CREATE POLICY user_permission_override_write ON core.user_permission_override FOR INSERT WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_permission_override_update ON core.user_permission_override FOR UPDATE USING (true) WITH CHECK (true);`);
    await queryRunner.query(`CREATE POLICY user_permission_override_delete ON core.user_permission_override FOR DELETE USING (true);`);
  }
}
