import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Venue / Venue Manager / Shift Approval workflow audit — a real, confirmed
 * production bug found while tracing why the Venue Manager mobile app's
 * "All Users" / "Users" pages showed "No staff found in your assigned
 * venues." even for a Venue Manager genuinely assigned to a venue with real
 * staff.
 *
 * Root cause (confirmed by direct RLS simulation as `rab_app`, not guessed
 * from reading policy SQL): `ManagerProfile.workspaceId` is NULL-by-default
 * for a `type: 'venue'` profile (its own doc comment already flagged this —
 * "isn't resolved at creation time yet"). `core.resolve_workspace_for_user()`
 * uses exactly that column to compute `ctx.workspaceId`, so a Venue Manager
 * with no resolved workspace gets `ctx.workspaceId = NULL` on every request,
 * making `core.current_workspace()` NULL — which means the `user_select`
 * RLS policy's two workspace-matching branches (`staff_profile.workspace_id
 * = core.current_workspace()` / `manager_profile.workspace_id =
 * core.current_workspace()`) can never match. Confirmed empirically: a
 * simulated `rab_app` session for such a Venue Manager sees ZERO rows in
 * `core.user` — not even themselves via any other user's row — regardless
 * of what any service-level query (`StaffService.venueDirectory`, the new
 * `venueStaffPool`, or anything else joining `User`) asks for. This is
 * strictly upstream of, and independent from, the `venueDirectory()`
 * query-scope fix shipped alongside this migration.
 *
 * `WorkspaceBackfill1786668000000` already contains the correct resolution
 * rule for this ("if every one of a Venue Manager's `manager_venue`
 * assignments agrees on exactly one workspace, that's a real deterministic
 * membership signal") — but it ran once, at a point before
 * `ManagerService.assignVenue()` had ever actually been wired up to any UI,
 * so there were zero real `manager_venue` rows for it to resolve against.
 * Migrations are never edited after merge (see CLAUDE.md), so this reruns
 * the identical rule as a fresh migration against the `manager_venue` rows
 * that exist today. `ManagerService.assignVenue()` itself now also performs
 * this same resolution at the moment of a Venue Manager's FIRST venue
 * assignment going forward — this migration only catches the accounts that
 * were assigned before that runtime fix shipped.
 *
 * Deliberately conservative, matching the original rule exactly: only fills
 * a NULL `workspace_id`, never overwrites one; only resolves when every one
 * of a Venue Manager's assignments agrees on exactly one workspace — a
 * Venue Manager whose assignments genuinely span more than one workspace is
 * a real ambiguity, left NULL rather than guessed (the same known,
 * still-open "CEO/Venue-Manager workspace assignment" design blocker the
 * `ManagerProfile.workspaceId` doc comment already flags).
 */
export class VenueManagerWorkspaceBackfill1786671400000 implements MigrationInterface {
  name = 'VenueManagerWorkspaceBackfill1786671400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_venue DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.venue DISABLE ROW LEVEL SECURITY;`);

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

    await queryRunner.query(`ALTER TABLE core.venue ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.venue FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_venue ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_venue FORCE ROW LEVEL SECURITY;`);
  }

  public async down(): Promise<void> {
    // Data-only, deliberately not reversed — see WorkspaceBackfill's
    // identical precedent: this only ever fills a previously-NULL
    // workspace_id, never overwrites or deletes a row.
  }
}
