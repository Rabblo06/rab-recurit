import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A Phase 2 — Platform Admin redesign, full replacement (confirmed
 * with the user, not guessed: two options were presented — keep the
 * org-scoped "admin sees everything in my org, no Inspect needed" behaviour
 * as a separate, permanent "organisation owner" concept, vs. retire it
 * entirely in favour of a genuinely global admin gated behind Admin
 * Inspect — the user chose full replacement).
 *
 * `platform_admin_claim` (PK=organisation_id, "first user to claim their
 * own org wins", automatic on every new-user creation via `tryClaim`) is
 * retired. `platform_admin` (PK=user_id, no organisation_id, no
 * workspace_id, explicit `granted_by`/`revoked_by`) replaces it as a
 * genuinely platform-wide fact about a user — never automatic, never
 * org-scoped, never grantable through the ordinary role/permission system.
 *
 * The RLS-layer consequence: the `EXISTS (SELECT 1 FROM
 * core.platform_admin_claim ...)` OR-branch added to `staff_profile`,
 * `venue`, `shift`, `shift_assignment`, `job_offer`, `attendance` (by
 * `PlatformAdminOperationalRlsVisibility1786668700000`) and `job_role` (by
 * `JobRoleVenueManagerAndAdminVisibility1786668800000`) is removed
 * entirely, not reworked to reference the new table — per the mission's own
 * explicit instruction, "Never implement: platform_admin OR
 * workspace_allowed inside ordinary operational RLS. Normal Workspace RLS
 * must remain fail-closed." A platform admin outside an active Admin
 * Inspect session now sees only their own ordinary scope (owner/venue-
 * manager, exactly like anyone else) — cross-workspace/cross-org visibility
 * is available ONLY through the already-built, audited, read-only Admin
 * Inspect mechanism, which rebuilds `AuthContext` to the explicit target's
 * own identity rather than granting a blanket bypass.
 *
 * SECURITY TRADE-OFF: `core.platform_admin` is ENABLEd but NOT FORCEd —
 * same pre-auth-exemption class as `organisation`/`manager_workspace`. The
 * bootstrap CLI (`grant-platform-admin`, connects as `rab_owner`) must be
 * able to insert the very first row when zero platform admins exist yet —
 * a self-referential `WITH CHECK` requiring "the caller is already an
 * active platform admin" can never be satisfied for that first grant by any
 * `rab_app` session, by design (there is no ordinary-user path to becoming
 * the first platform admin — that's the whole point).
 */
export class PlatformAdminGlobalRedesign1786669400000 implements MigrationInterface {
  name = 'PlatformAdminGlobalRedesign1786669400000';

  private readonly retiredAdminExists = `
    EXISTS (
      SELECT 1 FROM core.platform_admin_claim pac
      WHERE pac.organisation_id = core.current_org() AND pac.user_id = core.current_uid() AND pac.revoked_at IS NULL
    )
  `;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.platform_admin (
        user_id     uuid PRIMARY KEY REFERENCES core."user"(id) ON DELETE RESTRICT,
        granted_at  timestamptz NOT NULL DEFAULT now(),
        granted_by  uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        revoked_at  timestamptz,
        revoked_by  uuid REFERENCES core."user"(id) ON DELETE SET NULL
      );
    `);

    // SECURITY DEFINER, not a plain SQL function — a plain function reading
    // `core.platform_admin` would itself be subject to that table's own RLS
    // from the calling session, creating a self-referential policy
    // evaluation loop. Owner-privileged (bypasses RLS entirely when
    // reading), narrow (one boolean answer, never returns the row), fixed
    // safe search_path, minimal EXECUTE grant — matches
    // `core.current_org()`/`resolve_workspace_for_user()`'s own established
    // pattern in this codebase.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.is_active_platform_admin(check_user_id uuid DEFAULT NULL)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = core, pg_temp
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM core.platform_admin
          WHERE user_id = COALESCE(check_user_id, core.current_uid())
            AND revoked_at IS NULL
        );
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.is_active_platform_admin(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.is_active_platform_admin(uuid) TO rab_app;`);

    await queryRunner.query(`ALTER TABLE core.platform_admin ENABLE ROW LEVEL SECURITY;`);
    // SELECT: a caller may always see their own row (so `isPlatformAdmin`'s
    // self-check works), or every row if they're themselves an active
    // admin (needed for a future admin-listing UI) — never a bare
    // enumeration for an ordinary caller, since "who holds platform-wide
    // power" is itself sensitive.
    await queryRunner.query(`
      CREATE POLICY platform_admin_select ON core.platform_admin
        FOR SELECT
        USING (user_id = core.current_uid() OR core.is_active_platform_admin());
    `);
    // INSERT/UPDATE (grant/revoke via the guarded app-layer path): only an
    // already-active platform admin may write, over `rab_app`. The
    // bootstrap CLI's first-ever grant goes through `rab_owner` instead,
    // which this NOT-FORCEd table exempts entirely — never through this
    // policy at all.
    await queryRunner.query(`
      CREATE POLICY platform_admin_write ON core.platform_admin
        FOR INSERT
        WITH CHECK (core.is_active_platform_admin());
    `);
    await queryRunner.query(`
      CREATE POLICY platform_admin_update ON core.platform_admin
        FOR UPDATE
        USING (core.is_active_platform_admin())
        WITH CHECK (core.is_active_platform_admin());
    `);

    await queryRunner.query(`
      ALTER POLICY staff_profile_tenant ON core.staff_profile
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.staff_profile_id = staff_profile.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY venue_tenant ON core.venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = venue.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_tenant ON core.shift
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = shift.venue_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_assignment_tenant ON core.shift_assignment
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_assignment.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY job_offer_tenant ON core.job_offer
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.id = job_offer.shift_assignment_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = attendance.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY job_role_tenant ON core.job_role
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_profile mp
              WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type = 'venue'
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`DROP TABLE core.platform_admin_claim;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.platform_admin_claim (
        organisation_id   uuid PRIMARY KEY REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE RESTRICT,
        claimed_at        timestamptz NOT NULL DEFAULT now(),
        revoked_at        timestamptz,
        revoked_by        uuid REFERENCES core."user"(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY platform_admin_claim_tenant ON core.platform_admin_claim
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      ALTER POLICY job_role_tenant ON core.job_role
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.manager_profile mp
              WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type = 'venue'
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = attendance.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY job_offer_tenant ON core.job_offer
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.id = job_offer.shift_assignment_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_assignment_tenant ON core.shift_assignment
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_assignment.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_tenant ON core.shift
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = shift.venue_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY venue_tenant ON core.venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = venue.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY staff_profile_tenant ON core.staff_profile
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.retiredAdminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.staff_profile_id = staff_profile.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`DROP TABLE core.platform_admin;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.is_active_platform_admin(uuid);`);
  }
}
