import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, items 5–7 — step D: backfill of IDENTITY METADATA only.
 *
 * Approved by the owner: workspace_membership is tenancy-routing metadata, not workspace business data. Only
 * (organisation_id, user_id, workspace_id) is written. No staff, shift, offer, attendance, payroll, venue or report
 * row is read for writing or copied.
 *
 * Sources, each proven to be an authoritative identity mapping today:
 *   manager_workspace.owner_user_id      → the owner's workspace
 *   staff_profile.user_id / workspace_id → the staff member's workspace
 *   manager_profile.user_id / workspace_id → a venue manager's workspace (NULL = not yet assigned, see below)
 *
 * Fail-closed gates (any violation RAISES and the whole migration rolls back):
 *   G1 missing      — a staff_profile with NULL workspace_id (a staff member must belong to one workspace)
 *   G2 org mismatch — a source row whose organisation_id differs from the user's organisation_id
 *   G3 conflicting  — one user mapped to more than one workspace across the sources
 *   G4 conflicting existing membership — an existing membership row that disagrees with the authority mapping
 *
 * Not a gate, reported instead: a manager_profile of type venue or internal/ceo with NULL workspace_id. Those people
 * are unassigned or have no operational workspace by design, so they get no membership row and therefore resolve
 * to no workspace, exactly as the old resolver did.
 *
 * Idempotent: ON CONFLICT (user_id, workspace_id) DO NOTHING. Reversible: down() removes only source = 'backfill' rows.
 */
/** The authoritative mappings, one row per source fact. Kept as one definition so every check reads the same set. */
const SOURCES_SQL = `
    SELECT w.owner_user_id AS user_id, w.organisation_id, w.id AS workspace_id, 'manager_workspace' AS source
      FROM core.manager_workspace w
    UNION ALL
    SELECT sp.user_id, sp.organisation_id, sp.workspace_id, 'staff_profile'
      FROM core.staff_profile sp WHERE sp.workspace_id IS NOT NULL
    UNION ALL
    SELECT mp.user_id, mp.organisation_id, mp.workspace_id, 'manager_profile'
      FROM core.manager_profile mp WHERE mp.workspace_id IS NOT NULL
  `;

export class WorkspaceMembershipBackfill1786675100000 implements MigrationInterface {
  name = 'WorkspaceMembershipBackfill1786675100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        v_missing_staff  bigint;
        v_org_mismatch   bigint;
        v_conflicting    bigint;
        v_conflict_exist bigint;
        v_expected       bigint;
        v_inserted       bigint;
        v_users_needing  bigint;
        v_unassigned_mgr bigint;
        v_by_source      text;
      BEGIN
        SELECT count(*) INTO v_missing_staff FROM core.staff_profile WHERE workspace_id IS NULL;

        SELECT count(*) INTO v_org_mismatch
          FROM (${SOURCES_SQL}) s
          JOIN core."user" u ON u.id = s.user_id
         WHERE u.organisation_id <> s.organisation_id;

        SELECT count(*) INTO v_conflicting FROM (
          SELECT user_id FROM (${SOURCES_SQL}) s
           GROUP BY user_id HAVING count(DISTINCT workspace_id) > 1
        ) c;

        SELECT count(*) INTO v_conflict_exist
          FROM core.workspace_membership m
          JOIN (SELECT DISTINCT user_id, workspace_id FROM (${SOURCES_SQL}) s) d
            ON d.user_id = m.user_id
         WHERE m.workspace_id <> d.workspace_id;

        IF v_missing_staff > 0 OR v_org_mismatch > 0 OR v_conflicting > 0 OR v_conflict_exist > 0 THEN
          RAISE EXCEPTION 'membership backfill stopped: missing_staff=%, org_mismatch=%, conflicting_users=%, conflicting_existing=%',
            v_missing_staff, v_org_mismatch, v_conflicting, v_conflict_exist USING ERRCODE = 'P0001';
        END IF;

        SELECT count(*) INTO v_expected FROM (SELECT DISTINCT user_id, workspace_id FROM (${SOURCES_SQL}) s) d;

        INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
          SELECT DISTINCT s.organisation_id, s.user_id, s.workspace_id, 'active', 'backfill'
            FROM (${SOURCES_SQL}) s
          ON CONFLICT (user_id, workspace_id) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;

        SELECT count(DISTINCT u.id) INTO v_users_needing FROM core."user" u
         WHERE u.id IN (SELECT user_id FROM (${SOURCES_SQL}) s)
            OR u.id IN (SELECT user_id FROM core.staff_profile)
            OR u.id IN (SELECT user_id FROM core.manager_profile WHERE type = 'venue');
        SELECT count(*) INTO v_unassigned_mgr FROM core.manager_profile WHERE workspace_id IS NULL;

        SELECT string_agg(source || '=' || n, ', ' ORDER BY source) INTO v_by_source FROM (
          SELECT source, count(*) AS n FROM (${SOURCES_SQL}) s GROUP BY source
        ) x;

        RAISE NOTICE 'membership backfill: users_needing_membership=%, expected_pairs=%, inserted=%, already_correct=%, unassigned_manager_profiles=%, source_rows[%]',
          v_users_needing, v_expected, v_inserted, v_expected - v_inserted, v_unassigned_mgr, v_by_source;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM core.workspace_membership WHERE source = 'backfill';`);
  }
}
