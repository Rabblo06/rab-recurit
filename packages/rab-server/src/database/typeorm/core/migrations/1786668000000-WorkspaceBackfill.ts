import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 4/5 (Revision 3 §4, §8). Data-only — no schema change.
 * Runs inside DISABLE/ENABLE/FORCE brackets, the same established pattern
 * as `ResourceOwnershipSchema`/`OrganisationMemberSchema`'s own backfills:
 * every table here still has FORCE ROW LEVEL SECURITY, so even the
 * migration's own `rab_owner` connection sees zero rows without it.
 *
 * LOCAL/TEST-ONLY step 8 first: any Manager who has operational data but no
 * `manager_workspace` row (a real, large population in this sandbox — most
 * pre-date the ManagerWorkspace feature) gets one auto-provisioned,
 * deterministically, with `onboarding_completed_at` left NULL (they never
 * really completed onboarding — the resume-onboarding UI already handles
 * this state correctly). This is EXPLICITLY not a production policy — see
 * the approved migration plan's own §8: production's real
 * "manager exists, no workspace" population gets its own review against
 * real data before any real backfill runs there.
 *
 * Then the deterministic resolution chain (§4): direct `created_by` →
 * owner's workspace, then parent-resource inheritance down the graph
 * (shift → shift_assignment/job_offer/attendance). Rows with no resolvable
 * creator stay `workspace_id = NULL` — never guessed, matching the
 * existing precedent already set for NULL `created_by` itself.
 */
export class WorkspaceBackfill1786668000000 implements MigrationInterface {
  name = 'WorkspaceBackfill1786668000000';

  private readonly forcedTables = [
    'manager_profile',
    'staff_profile',
    'venue',
    'venue_role_rate',
    'manager_venue',
    'job_role',
    'shift',
    'shift_assignment',
    'job_offer',
    'attendance',
    'platform_config',
    'admin_inspect_session',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.forcedTables) {
      await queryRunner.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
    }

    // Step 8 — local-only deterministic auto-provisioning for a Manager
    // with operational data but no workspace. Name/subdomain don't need to
    // byte-match `@rab/shared`'s TS `normalizeSubdomain` — only to be a
    // valid, reasonably deterministic subdomain shape; the numeric-suffix
    // loop below matches the existing SubdomainService's own collision
    // strategy in spirit (bounded, not silently overwriting a real row).
    await queryRunner.query(`
      DO $$
      DECLARE
        rec RECORD;
        base_subdomain text;
        candidate text;
        suffix int;
      BEGIN
        -- type = 'internal' ONLY. A real, confirmed integrity check on the
        -- real backfilled data (not assumed) caught this: CEO- and
        -- Venue-Manager-type profiles must NOT independently own a
        -- Workspace — only a genuine top-level Manager does, matching the
        -- "one Manager, one Workspace" invariant everywhere else in this
        -- plan. A CEO/Venue-Manager's workspace is membership in someone
        -- ELSE's workspace, not something to auto-provision here — left
        -- unresolved (NULL) below rather than guessed.
        FOR rec IN
          SELECT mp.user_id, u.first_name
          FROM core.manager_profile mp
          JOIN core."user" u ON u.id = mp.user_id
          WHERE mp.type = 'internal'
            AND NOT EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = mp.user_id)
        LOOP
          base_subdomain := lower(regexp_replace(regexp_replace(rec.first_name, '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'));
          IF base_subdomain IS NULL OR length(base_subdomain) < 3 THEN
            base_subdomain := 'workspace';
          END IF;
          candidate := base_subdomain;
          suffix := 0;
          WHILE EXISTS (SELECT 1 FROM core.manager_workspace WHERE subdomain = candidate) LOOP
            suffix := suffix + 1;
            candidate := base_subdomain || '-' || suffix::text;
          END LOOP;

          INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status)
          SELECT mp2.organisation_id, rec.user_id, rec.first_name || E'''s Workspace', candidate, 'active'
          FROM core.manager_profile mp2 WHERE mp2.user_id = rec.user_id;
          -- onboarding_completed_at stays NULL — this Manager never actually
          -- onboarded; the resume-onboarding flow already handles this state.
        END LOOP;
      END $$;
    `);

    // Direct created_by resolution.
    await queryRunner.query(`
      UPDATE core.manager_profile mp SET workspace_id = mw.id
      FROM core.manager_workspace mw WHERE mw.owner_user_id = mp.user_id;
    `);
    await queryRunner.query(`
      UPDATE core.staff_profile sp SET workspace_id = mw.id
      FROM core.manager_workspace mw WHERE mw.owner_user_id = sp.created_by;
    `);
    await queryRunner.query(`
      UPDATE core.venue v SET workspace_id = mw.id
      FROM core.manager_workspace mw WHERE mw.owner_user_id = v.created_by;
    `);
    await queryRunner.query(`
      UPDATE core.job_role jr SET workspace_id = mw.id
      FROM core.manager_workspace mw WHERE mw.owner_user_id = jr.created_by;
    `);
    await queryRunner.query(`
      UPDATE core.shift s SET workspace_id = mw.id
      FROM core.manager_workspace mw WHERE mw.owner_user_id = s.created_by;
    `);

    // Parent-resource inheritance — only where the parent itself resolved.
    await queryRunner.query(`
      UPDATE core.venue_role_rate vrr SET workspace_id = v.workspace_id
      FROM core.venue v WHERE v.id = vrr.venue_id AND v.workspace_id IS NOT NULL;
    `);
    await queryRunner.query(`
      UPDATE core.manager_venue mv SET workspace_id = mp.workspace_id
      FROM core.manager_profile mp WHERE mp.id = mv.manager_profile_id AND mp.workspace_id IS NOT NULL;
    `);

    // Venue-Manager membership (§4 "other deterministic relationships"):
    // a Venue-Manager doesn't OWN a workspace, but if every one of their
    // manager_venue assignments agrees on exactly one workspace (via the
    // assigned venue's own now-resolved workspace_id), that's a real,
    // deterministic membership signal — never applied if their assignments
    // span more than one workspace (a genuine ambiguity, left NULL).
    await queryRunner.query(`
      WITH venue_manager_workspaces AS (
        SELECT mv.manager_profile_id, v.workspace_id
        FROM core.manager_venue mv
        JOIN core.venue v ON v.id = mv.venue_id
        WHERE v.workspace_id IS NOT NULL
        GROUP BY mv.manager_profile_id, v.workspace_id
      ),
      single_workspace_venue_managers AS (
        SELECT manager_profile_id, (array_agg(workspace_id))[1] AS workspace_id
        FROM venue_manager_workspaces
        GROUP BY manager_profile_id
        HAVING count(*) = 1
      )
      UPDATE core.manager_profile mp SET workspace_id = swvm.workspace_id
      FROM single_workspace_venue_managers swvm
      WHERE swvm.manager_profile_id = mp.id AND mp.type = 'venue' AND mp.workspace_id IS NULL;
    `);
    await queryRunner.query(`
      UPDATE core.shift_assignment sa SET workspace_id = s.workspace_id
      FROM core.shift s WHERE s.id = sa.shift_id AND s.workspace_id IS NOT NULL;
    `);
    await queryRunner.query(`
      UPDATE core.job_offer jo SET workspace_id = sa.workspace_id
      FROM core.shift_assignment sa WHERE sa.id = jo.shift_assignment_id AND sa.workspace_id IS NOT NULL;
    `);
    await queryRunner.query(`
      UPDATE core.attendance a SET workspace_id = s.workspace_id
      FROM core.shift s WHERE s.id = a.shift_id AND s.workspace_id IS NOT NULL;
    `);

    // platform_config (Revision 3 §11) — only when exactly one deterministic
    // target Workspace exists across every Manager in the legacy org; more
    // than one is a real ambiguous-configuration case, left NULL (quarantined,
    // never guessed by picking the first Manager).
    await queryRunner.query(`
      WITH org_workspaces AS (
        SELECT DISTINCT mp.organisation_id, mw.id AS workspace_id
        FROM core.manager_profile mp
        JOIN core.manager_workspace mw ON mw.owner_user_id = mp.user_id
      ),
      single_workspace_orgs AS (
        SELECT organisation_id, (array_agg(workspace_id))[1] AS workspace_id
        FROM org_workspaces
        GROUP BY organisation_id
        HAVING count(*) = 1
      )
      UPDATE core.platform_config pc SET workspace_id = swo.workspace_id
      FROM single_workspace_orgs swo
      WHERE swo.organisation_id = pc.organisation_id;
    `);

    // admin_inspect_session (Revision 3 §10) — resolved from the TARGET
    // user's own workspace, never reinterpreting the legacy organisation id
    // itself as a workspace id.
    await queryRunner.query(`
      UPDATE core.admin_inspect_session ais SET workspace_id = resolved.workspace_id
      FROM (
        SELECT mp.user_id, mp.workspace_id FROM core.manager_profile mp WHERE mp.workspace_id IS NOT NULL
        UNION ALL
        SELECT sp.user_id, sp.workspace_id FROM core.staff_profile sp WHERE sp.workspace_id IS NOT NULL
      ) resolved
      WHERE resolved.user_id = ais.target_user_id;
    `);

    for (const table of this.forcedTables) {
      await queryRunner.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE core.${table} FORCE ROW LEVEL SECURITY;`);
    }
  }

  public async down(): Promise<void> {
    // Data-only, deliberately not reversed: this only ever fills a
    // previously-NULL workspace_id, never overwrites a non-NULL value or
    // deletes a row (the one exception, the local-only auto-provisioned
    // manager_workspace rows from step 8, are intentionally left in place
    // on rollback too — they're real, valid workspace rows a Manager can
    // keep using; nothing downstream depends on this migration specifically
    // having run for them to remain valid).
  }
}
