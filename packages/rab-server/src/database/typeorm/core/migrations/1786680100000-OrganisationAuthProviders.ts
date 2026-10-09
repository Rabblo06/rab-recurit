import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.1B, Migration B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.5, owner decision §1/§4 of the
 * P1C.1B brief).
 *
 * Organisation-level (= Crewflow's tenant-equivalent to Twenty's Workspace — confirmed by the
 * P1C.1A audit; NOT `core.manager_workspace`, a private per-manager sub-workspace, a different
 * pre-existing concept) authentication-provider toggles.
 *
 * Effective availability for a provider is always `system_enabled AND organisation_enabled` —
 * the system-level env flag (`AUTH_GOOGLE_ENABLED`/`AUTH_MICROSOFT_ENABLED`/
 * `AUTH_PASSWORD_ENABLED`) is the actual safety net, so these three columns default `true`: the
 * moment an operator turns a provider on at the system level, every EXISTING organisation is
 * immediately eligible with zero per-org admin action required. This migration alone changes no
 * observable behaviour (system-level Google/Microsoft default to `false`).
 *
 * The CHECK constraint is the OWNER'S EXPLICIT instruction to close the P1C.1A-named lockout gap
 * at the schema level, not just the application layer: an organisation can never be written with
 * all three of its OWN flags false, structurally. This does not by itself prevent the
 * system-AND-organisation combination from leaving zero EFFECTIVE providers (that needs the
 * runtime mutation-time + startup checks built alongside this migration, in
 * `organisation-auth-providers.service.ts` and the boot-time validator) — the CHECK is one layer
 * of a two-layer design, not the whole of it.
 *
 * Also adds `core.auth_find_organisation_by_slug(slug)` — the pre-auth SECURITY DEFINER lookup
 * `GET /rest/v1/auth/config` needs to resolve an organisation's OWN provider flags from a public
 * slug before any tenant context exists, same established pattern as every other pre-auth
 * function in this codebase (PreAuthLookupFunctions1786667400000). Returns only the three
 * boolean flags — never the organisation's name, id, or any other column — and nothing at all
 * for an unknown slug, so the public config endpoint cannot be used to enumerate which slugs
 * exist.
 */
export class OrganisationAuthProviders1786680100000 implements MigrationInterface {
  name = 'OrganisationAuthProviders1786680100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.organisation
        ADD COLUMN password_auth_enabled boolean NOT NULL DEFAULT true,
        ADD COLUMN google_auth_enabled boolean NOT NULL DEFAULT true,
        ADD COLUMN microsoft_auth_enabled boolean NOT NULL DEFAULT true,
        ADD CONSTRAINT organisation_auth_provider_not_all_disabled
          CHECK (password_auth_enabled OR google_auth_enabled OR microsoft_auth_enabled);
    `);
    // `core.organisation` carries no RLS policy at all (it IS the tenant — see organisation.entity.ts's
    // own doc comment, and the P1C.1A audit) and no column-level grant tightening exists on it
    // today — these columns inherit whatever blanket SELECT/UPDATE grant the table already has.

    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_organisation_by_slug(p_slug citext)
      RETURNS TABLE (password_auth_enabled boolean, google_auth_enabled boolean, microsoft_auth_enabled boolean)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT password_auth_enabled, google_auth_enabled, microsoft_auth_enabled
        FROM core.organisation WHERE slug = p_slug;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_organisation_by_slug(citext) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_organisation_by_slug(citext) TO rab_app;`);

    // `core.organisation` carries the real `organisation_self` RLS policy (`id = current_org()`,
    // IdentitySchema1786665800000) — found live by this checkpoint's own integration test, not
    // assumed from the entity's own (stale) doc comment: a plain `rab_app` scan with no tenant
    // context bound sees ZERO rows, exactly like every other RLS-protected table. The startup
    // lockout guard (OrganisationAuthProvidersService.onApplicationBootstrap) genuinely needs to
    // see every organisation's own flags at once, before any one tenant context exists — the
    // same cross-tenant-visibility need `core.worker_list_workspaces` already solves for the
    // worker (WorkerRuntimeFunctions1786676500000). Narrow SECURITY DEFINER function, exactly
    // that pattern: only the three boolean flags, never name/slug/address/contact/settings.
    await queryRunner.query(`
      CREATE FUNCTION core.auth_list_organisation_providers()
      RETURNS TABLE ("passwordAuthEnabled" boolean, "googleAuthEnabled" boolean, "microsoftAuthEnabled" boolean)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT password_auth_enabled, google_auth_enabled, microsoft_auth_enabled FROM core.organisation;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_list_organisation_providers() FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_list_organisation_providers() TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_list_organisation_providers();`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_organisation_by_slug(citext);`);
    await queryRunner.query(`
      ALTER TABLE core.organisation
        DROP CONSTRAINT IF EXISTS organisation_auth_provider_not_all_disabled,
        DROP COLUMN IF EXISTS microsoft_auth_enabled,
        DROP COLUMN IF EXISTS google_auth_enabled,
        DROP COLUMN IF EXISTS password_auth_enabled;
    `);
  }
}
