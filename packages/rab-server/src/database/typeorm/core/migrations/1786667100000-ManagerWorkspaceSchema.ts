import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.manager_workspace` — a private, individually-owned workspace per
 * Manager (see `ManagerWorkspace` entity doc comment for why this is not
 * named `workspace`, avoiding a collision with the existing
 * `WorkspaceController`/`WorkspaceService`, which is a different concept:
 * editing the shared Organisation's own settings).
 *
 * `UNIQUE(owner_user_id)`: one Manager, one Workspace. `subdomain` is
 * `citext` + globally `UNIQUE` (not scoped to organisation_id) — same
 * case-insensitive-uniqueness idiom `Organisation.slug` already uses,
 * because a subdomain is a platform-wide hostname, not an org-scoped label.
 *
 * SECURITY TRADE-OFF — SELECT is permissive (`USING (true)`), INSERT/UPDATE/
 * DELETE are tenant-scoped.
 * Decision:   Split policies by operation instead of one `organisation_id =
 *             core.current_org()` predicate covering every operation (the
 *             shape every other tenant table in this codebase uses).
 * Reason:     Subdomain availability is a genuinely global, cross-tenant
 *             check by nature (`SubdomainService.checkAvailability` — "is
 *             ANY org's Manager already using this name") — not a
 *             per-organisation lookup. `rab_app` (the app's runtime role)
 *             is subject to RLS regardless of FORCE — only the table owner
 *             is exempted by no-FORCE (confirmed in IdentitySchema's own
 *             trade-off note) — so a single `current_org()`-gated policy
 *             would make every cross-org availability check silently see
 *             zero rows (always "available", even when taken), leaving the
 *             DB's `UNIQUE(subdomain)` constraint as the only real
 *             enforcement and turning a real collision into an unhandled
 *             500 instead of a clean 409.
 * Risk:       Any authenticated caller can SELECT every row's full column
 *             set at the database layer, including `owner_user_id`/`name`.
 * Mitigation: The only code path that runs an unfiltered SELECT is
 *             `SubdomainService.checkAvailability`, whose response shape is
 *             hardcoded to `{available, normalized, suggested, alternatives}`
 *             — never owner/name/id/organisation — so the permissive read
 *             is never actually exposed beyond availability. Every other
 *             read (`GET /me`, the manager/admin list) still goes through
 *             `runInTenantContext` and application-level ownership checks;
 *             this policy only widens what SELECT *could* return at the SQL
 *             level, not what any endpoint actually does with it.
 * Reversal:   If a future feature needs a real cross-org directory read,
 *             narrow this to a `SECURITY DEFINER` function scoped to
 *             exactly the availability check, same reversal path already
 *             recorded for `organisation` in IdentitySchema.
 */
export class ManagerWorkspaceSchema1786667100000 implements MigrationInterface {
  name = 'ManagerWorkspaceSchema1786667100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.manager_workspace (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id          uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        owner_user_id            uuid NOT NULL UNIQUE REFERENCES core."user"(id) ON DELETE CASCADE,
        name                     text NOT NULL,
        subdomain                citext NOT NULL UNIQUE,
        logo_key                 text,
        status                   text NOT NULL DEFAULT 'active',
        onboarding_completed_at  timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX manager_workspace_org_idx ON core.manager_workspace (organisation_id);`);

    await queryRunner.query(`ALTER TABLE core.manager_workspace ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_workspace FORCE ROW LEVEL SECURITY;`);
    // Two policies — see the SECURITY TRADE-OFF note above this class.
    // Permissive policies are OR'd per operation: SELECT is covered by both
    // (always true), INSERT/UPDATE/DELETE are only covered by the
    // tenant-scoped one below.
    await queryRunner.query(`
      CREATE POLICY manager_workspace_select ON core.manager_workspace
        FOR SELECT USING (true);
    `);
    await queryRunner.query(`
      CREATE POLICY manager_workspace_write ON core.manager_workspace
        FOR ALL USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.manager_workspace`);
  }
}
