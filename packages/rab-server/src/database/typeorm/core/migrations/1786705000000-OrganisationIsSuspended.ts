import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.8 — fixes a third real, confirmed defect found running the new `organisation-suspension
 * .integration.spec.ts` suite: `AuthService.completeLogin()`'s suspension check ran
 * `this.dataSource.query('SELECT suspended_at FROM core.organisation WHERE id = $1', ...)` on the
 * RAW, unbound connection pool — no `rab.organisation_id` GUC set, so `core.organisation`'s own
 * `organisation_self` RLS policy (`id = core.current_org()`) silently returned ZERO ROWS. `org` was
 * always `undefined`, `org?.suspended_at` always falsy, and the check never actually fired: a
 * suspended organisation's users could still log in normally. Confirmed live — the test "suspending
 * the organisation blocks a FRESH login attempt" got 200, not 401.
 *
 * Same fix as every other pre-auth check in `auth.service.ts` (`auth_count_recent_login_failures`,
 * `auth_find_users_by_email`): a narrow SECURITY DEFINER function, callable on the unbound
 * connection with no tenant context needed at all, since this check runs before any session/
 * workspace exists for the row being checked.
 */
export class OrganisationIsSuspended1786705000000 implements MigrationInterface {
  name = 'OrganisationIsSuspended1786705000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.organisation_is_suspended(p_organisation_id uuid)
      RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT suspended_at IS NOT NULL FROM core.organisation WHERE id = p_organisation_id;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.organisation_is_suspended(uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.organisation_is_suspended(uuid) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.organisation_is_suspended(uuid);`);
  }
}
