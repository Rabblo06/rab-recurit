import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — fixes a second real, confirmed defect: `core.list_organisations_for_admin()`
 * (`ListOrganisationsForAdmin1786707000000`) is owned by `rab_secure_owner` and LEFT JOINs
 * `core.manager_profile` (owned by `crewflow`, not `rab_secure_owner`) to resolve each
 * organisation's CEO. A SECURITY DEFINER function's privileges come from its OWNER's actual
 * GRANTs, not merely from being SECURITY DEFINER — `rab_secure_owner` already holds full grants on
 * `core."user"` (needed by `auth_find_users_by_email` and others) but had ZERO grants on
 * `core.manager_profile` (never needed before this function existed), so the join failed with
 * "permission denied for table manager_profile" even though RLS itself was never the obstacle.
 *
 * SELECT only — `rab_secure_owner` never needs to write `manager_profile` through this path.
 */
export class SecureOwnerManagerProfileSelectGrant1786709000000 implements MigrationInterface {
  name = 'SecureOwnerManagerProfileSelectGrant1786709000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT SELECT ON core.manager_profile TO rab_secure_owner;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON core.manager_profile FROM rab_secure_owner;`);
  }
}
