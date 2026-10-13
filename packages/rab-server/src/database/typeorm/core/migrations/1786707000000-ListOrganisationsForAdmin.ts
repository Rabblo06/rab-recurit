import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — Platform Super Admin's organisations list is genuinely cross-tenant by nature (the
 * entire point of the role), which `core.organisation`'s own `organisation_self` RLS policy
 * (`id = current_org()`) cannot satisfy for more than one row per bound context. Same SECURITY
 * DEFINER precedent as every other cross-tenant admin read in this codebase
 * (`is_active_platform_admin`, `auth_find_users_by_email`) — the caller's own platform-admin
 * status is verified at the SERVICE layer (`OrganisationOnboardingService`, via
 * `PlatformAdminService.isPlatformAdmin`) BEFORE this function is ever called; the function itself
 * enforces no caller-identity check, same as every other narrow lookup function here.
 */
export class ListOrganisationsForAdmin1786707000000 implements MigrationInterface {
  name = 'ListOrganisationsForAdmin1786707000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.list_organisations_for_admin()
      RETURNS TABLE (
        id uuid,
        name text,
        slug citext,
        "suspendedAt" timestamptz,
        "createdAt" timestamptz,
        "ceoUserId" uuid,
        "ceoEmail" citext,
        "ceoFirstName" text,
        "ceoLastName" text,
        "ceoStatus" text
      )
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT o.id, o.name, o.slug, o.suspended_at, o.created_at,
               u.id, u.email, u.first_name, u.last_name, u.status
          FROM core.organisation o
          LEFT JOIN core.manager_profile mp ON mp.organisation_id = o.id AND mp.type = 'ceo'
          LEFT JOIN core."user" u ON u.id = mp.user_id
         ORDER BY o.created_at DESC;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.list_organisations_for_admin() OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.list_organisations_for_admin() TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.list_organisations_for_admin();`);
  }
}
