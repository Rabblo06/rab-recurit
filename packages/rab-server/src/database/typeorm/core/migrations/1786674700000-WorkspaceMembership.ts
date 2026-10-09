import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 — single CORE membership authority for "which workspace may this verified user
 * enter, for this application target?" (docs/architecture/10-PHASE-ARCHITECTURE-MIGRATION.md).
 *
 * Identity/tenancy metadata ONLY. No employment, venue, rate, availability, shift, offer,
 * attendance or payroll data lives here; those stay in workspace business tables.
 *
 * Guarantees enforced by PostgreSQL, not by service code:
 * - application_target is restricted to the three real targets (same values as
 *   core.refresh_token / core.password_reset_token).
 * - organisation_id must agree with BOTH the user's organisation and the workspace's
 *   organisation (composite foreign keys). A row cannot point at another organisation's workspace.
 * - at most ONE ACTIVE membership per user per application target (partial unique index).
 * - at most one row per (user, workspace, target) regardless of status.
 *
 * Pre-auth exemption (trade-off): the resolver below runs before any tenant context exists,
 * so the table is NOT FORCE ROW LEVEL SECURITY, matching manager_workspace and the other
 * pre-auth tables. ENABLE RLS is kept, with an organisation-scoped policy for ordinary reads
 * and writes. The table owner (rab_owner) is exempt. rab_app is not. Review required before
 * approval (CLAUDE.md security trade-off block). The CI allowlist must list this table.
 */
export class WorkspaceMembership1786674700000 implements MigrationInterface {
  name = 'WorkspaceMembership1786674700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite keys that let other tables reference (id, organisation_id) and make cross-org rows impossible.
    await queryRunner.query(`ALTER TABLE core.manager_workspace ADD CONSTRAINT manager_workspace_id_organisation_key UNIQUE (id, organisation_id);`);
    await queryRunner.query(`ALTER TABLE core."user" ADD CONSTRAINT user_id_organisation_key UNIQUE (id, organisation_id);`);

    await queryRunner.query(`
      CREATE TABLE core.workspace_membership (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id     uuid NOT NULL,
        user_id             uuid NOT NULL,
        workspace_id        uuid NOT NULL,
        application_target  text NOT NULL
          CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app')),
        status              text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'removed')),
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT workspace_membership_user_org_fkey
          FOREIGN KEY (user_id, organisation_id) REFERENCES core."user" (id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT workspace_membership_workspace_org_fkey
          FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT workspace_membership_user_workspace_target_key
          UNIQUE (user_id, workspace_id, application_target)
      );
    `);

    // The invariant: one ACTIVE workspace per user per application target.
    await queryRunner.query(`
      CREATE UNIQUE INDEX workspace_membership_one_active_per_target
        ON core.workspace_membership (user_id, application_target)
        WHERE status = 'active';
    `);
    await queryRunner.query(`CREATE INDEX workspace_membership_workspace_idx ON core.workspace_membership (workspace_id);`);

    // Pre-auth: NO FORCE (see header). ENABLE + organisation-scoped USING/WITH CHECK.
    await queryRunner.query(`ALTER TABLE core.workspace_membership ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY workspace_membership_tenant ON core.workspace_membership
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.workspace_membership TO rab_app;`);
    await queryRunner.query(`REVOKE DELETE ON core.workspace_membership FROM rab_app;`);

    // The ONE resolver. Returns every ACTIVE row for (user, target) with NO LIMIT, so the caller can
    // see a count of 0, 1, or (corruption) more than 1, and fail closed on >1. The partial unique index
    // makes >1 impossible; the caller still asserts it. Owner-run, so the NO FORCE table is readable pre-auth.
    await queryRunner.query(`
      CREATE FUNCTION core.resolve_workspace_membership(p_user_id uuid, p_application_target text)
      RETURNS TABLE (organisation_id uuid, workspace_id uuid)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
      BEGIN
        IF p_user_id IS NULL OR p_application_target IS NULL THEN
          RAISE EXCEPTION 'user id and application target are required' USING ERRCODE = '22004';
        END IF;
        IF p_application_target NOT IN ('manager_web', 'venue_manager_app', 'staff_app') THEN
          RAISE EXCEPTION 'unknown application target' USING ERRCODE = '22023';
        END IF;
        RETURN QUERY
          SELECT m.organisation_id, m.workspace_id
            FROM core.workspace_membership m
            JOIN core.manager_workspace w ON w.id = m.workspace_id AND w.organisation_id = m.organisation_id
           WHERE m.user_id = p_user_id
             AND m.application_target = p_application_target
             AND m.status = 'active'
             AND w.status = 'active';
      END;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.resolve_workspace_membership(uuid, text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.resolve_workspace_membership(uuid, text) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.resolve_workspace_membership(uuid, text);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.workspace_membership;`);
    await queryRunner.query(`ALTER TABLE core."user" DROP CONSTRAINT IF EXISTS user_id_organisation_key;`);
    await queryRunner.query(`ALTER TABLE core.manager_workspace DROP CONSTRAINT IF EXISTS manager_workspace_id_organisation_key;`);
  }
}
