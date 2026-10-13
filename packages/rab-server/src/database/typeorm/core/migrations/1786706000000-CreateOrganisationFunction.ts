import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — the ordinary runtime connection (`crewflow_app`) has never been able to insert into
 * `core.organisation` at all: that table is deliberately NOT FORCEd (CLAUDE.md's own exemption
 * list — "SECURITY DEFINER writes that can't satisfy a self-referential WITH CHECK before the
 * first row exists"), but NOT FORCE only exempts the table OWNER (`rab_secure_owner`) from its
 * `organisation_self` policy (`id = core.current_org()`) — the runtime role is never that owner,
 * so it is still bound by the policy, and a brand-new row's own id can never already equal
 * whatever `current_org()` happens to be bound to. Confirmed empirically: every existing
 * `INSERT INTO core.organisation` in this codebase runs via a CLI command on the `rab_owner`/
 * superuser connection (`bootstrap-admin`, `seed`, `seed-qa`) — there has never been a runtime API
 * path for it before this checkpoint, because Platform Super Admin organisation creation never
 * existed before this checkpoint either.
 *
 * Same precedent as `organisation_slug_taken`/`provision_workspace_schema`: a narrow SECURITY
 * DEFINER function, owned by `rab_secure_owner` (bypasses the policy by ownership, the same
 * mechanism NOT FORCE already relies on for the owner's own CLI writes), EXECUTE-granted to
 * `crewflow`/`crewflow_app`. Takes only `name`/`slug` — every other column already has a safe
 * column default (`timezone`, `settings`, the three auth-provider toggles, `security_version`).
 * Returns the new row's id; the CALLER (`OrganisationOnboardingService`) is responsible for
 * everything downstream (CEO user, role, invite, audit) via the NORMAL `runInTenantContext` path,
 * once this function has returned an id to bind as that transaction's `organisationId`.
 */
export class CreateOrganisationFunction1786706000000 implements MigrationInterface {
  name = 'CreateOrganisationFunction1786706000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.create_organisation(p_name text, p_slug citext)
      RETURNS uuid
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        INSERT INTO core.organisation (name, slug) VALUES (p_name, p_slug) RETURNING id;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.create_organisation(text, citext) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.create_organisation(text, citext) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.create_organisation(text, citext);`);
  }
}
