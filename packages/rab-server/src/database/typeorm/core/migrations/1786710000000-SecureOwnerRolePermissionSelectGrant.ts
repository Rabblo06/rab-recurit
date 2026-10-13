import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — follow-up to `SecureOwnerManagerProfileSelectGrant1786709000000`: granting SELECT on
 * `manager_profile` alone was not enough. `manager_profile_tenant`'s policy (as rewritten by
 * `ManagerProfilePlatformAdminRls1786708000000`) also references `core.user_role`,
 * `core.role_permission` and `core.permission` in its pre-existing `manager.manage` EXISTS
 * branch — and Postgres checks GRANTs on every table a policy expression references at query
 * REWRITE time, not only on whichever OR-branch ultimately evaluates true. `rab_secure_owner` had
 * no grant on any of the three, so `core.list_organisations_for_admin()` still failed with
 * "permission denied for table user_role" even after the new `is_active_platform_admin()` branch
 * was added and would, on its own, have been sufficient. All three are read-only, low-sensitivity
 * reference/junction tables — SELECT only, same narrow scope as the manager_profile grant.
 */
export class SecureOwnerRolePermissionSelectGrant1786710000000 implements MigrationInterface {
  name = 'SecureOwnerRolePermissionSelectGrant1786710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT SELECT ON core.user_role TO rab_secure_owner;`);
    await queryRunner.query(`GRANT SELECT ON core.role_permission TO rab_secure_owner;`);
    await queryRunner.query(`GRANT SELECT ON core.permission TO rab_secure_owner;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON core.user_role FROM rab_secure_owner;`);
    await queryRunner.query(`REVOKE SELECT ON core.role_permission FROM rab_secure_owner;`);
    await queryRunner.query(`REVOKE SELECT ON core.permission FROM rab_secure_owner;`);
  }
}
