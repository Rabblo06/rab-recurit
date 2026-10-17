import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supersedes BackfillCustomRoleObjectRules1786717200000 (finding F-08, October 15 organisation-security report). That
 * migration is left untouched because it has already been applied.
 *
 * Why the earlier one is not enough: its outer `SELECT ... FROM core.role` runs BEFORE any tenant context is bound. `core.role`
 * is FORCE ROW LEVEL SECURITY and owned by `crewflow`, the ordinary NOSUPERUSER/NOBYPASSRLS migration role
 * (CrewflowSingleCredentialRoleArchitecture1786682000000). Under that role, `core.current_org()` is NULL, the policy returns
 * zero rows, and the loop body never runs. It is a silent no-op. It only did its job where migrations ran as a superuser
 * (local and test databases).
 *
 * This migration does the same backfill, with the same semantics, in a way that works under `crewflow` with every policy
 * enforced:
 *   1. Workspaces are discovered through `core.worker_list_workspaces(after, limit)`. This is the existing SECURITY DEFINER,
 *      keyset-paginated routing list (ids and organisation ids only). The migration role already has EXECUTE on it. RLS is
 *      never disabled, no role membership is needed, and nothing reads `manager_workspace` directly.
 *   2. For each workspace, `rab.organisation_id` / `rab.workspace_id` are bound transaction-locally, BEFORE `core.role`,
 *      `core.role_permission` and `core.role_object_permission` are read or written. These are the same settings
 *      `core.current_org()` / `core.current_workspace()` read at runtime. Every policy's USING and WITH CHECK is therefore
 *      satisfied honestly, for that one workspace only.
 *   3. Coverage is complete by construction: `role_workspace_fkey` (workspace_id, organisation_id) → manager_workspace
 *      guarantees every custom role belongs to a workspace the discovery function returns.
 *
 * Semantics (as in 1786717200000, with the one narrowing below): a custom workspace-member role (`custom_%`, not system) that has NO object rules
 * gets one `grant` rule (can_read = true, no record filter) for each object whose route flag it already holds
 * (staff.view → staff, venue.view → venue, schedule.view → shift). No field is made visible, no flag changes and no
 * security version is bumped. MemberAccessPolicyService resolves policy from PostgreSQL per request, with no cache, so the
 * restored access applies on the next request.
 *
 * One deliberate narrowing compared with 1786717200000: roles with `can_read_all_objects = true` are skipped. That column was
 * added by RoleObjectFieldPermissions1786716000000 with default false, so only the role editor can have set it, and such a
 * role is never a legacy role. It already reads every object with no rules (MemberAccessPolicyService: override ??
 * can_read_all_objects). Adding rules to it would not change access, but it would rewrite the editor's saved
 * "All Objects, inherit" definition. The restored development data contains exactly one such role.
 *
 * Idempotent and preserving: a role with ANY existing object rule is skipped, so an editor-made definition is never
 * overridden, and `ON CONFLICT DO NOTHING` covers concurrent writers. Where 1786717200000 already did the work (superuser
 * runs), this migration finds nothing to do.
 *
 * down() is intentionally a no-op. A backfilled rule cannot be told apart from an identical editor-made rule. Deleting it
 * would re-create the silent access loss this migration exists to fix.
 */
export class BackfillCustomRoleObjectRulesUnderForcedRls1786717600000 implements MigrationInterface {
  name = 'BackfillCustomRoleObjectRulesUnderForcedRls1786717600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $backfill$
      DECLARE
        w record;
        v_after uuid := NULL;
        v_page integer;
        v_inserted integer;
        v_total integer := 0;
        v_workspaces integer := 0;
      BEGIN
        LOOP
          v_page := 0;
          FOR w IN SELECT d.workspace_id, d.organisation_id FROM core.worker_list_workspaces(v_after, 100) d LOOP
            v_page := v_page + 1;
            v_workspaces := v_workspaces + 1;
            v_after := w.workspace_id;
            PERFORM set_config('rab.organisation_id', w.organisation_id::text, true);
            PERFORM set_config('rab.workspace_id', w.workspace_id::text, true);

            INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read)
            SELECT ro.id, ro.workspace_id, ro.organisation_id, m.object_key, true
              FROM core.role ro
              JOIN core.role_permission rp ON rp.role_id = ro.id
              JOIN core.permission p ON p.id = rp.permission_id
              JOIN (VALUES ('staff.view', 'staff'), ('venue.view', 'venue'), ('schedule.view', 'shift')) AS m(flag, object_key)
                ON m.flag = p.key
             WHERE ro.workspace_id = w.workspace_id
               AND ro.organisation_id = w.organisation_id
               AND ro.is_system = false
               AND ro.key LIKE 'custom\\_%'
               AND ro.can_read_all_objects = false
               AND NOT EXISTS (SELECT 1 FROM core.role_object_permission x WHERE x.role_id = ro.id)
            ON CONFLICT (role_id, object_key) DO NOTHING;
            GET DIAGNOSTICS v_inserted = ROW_COUNT;
            v_total := v_total + v_inserted;
          END LOOP;
          -- The discovery function caps a page at 100 rows; a shorter page is the last one.
          EXIT WHEN v_page < 100;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
        RAISE NOTICE 'BackfillCustomRoleObjectRulesUnderForcedRls: % workspace(s) scanned, % object rule(s) inserted', v_workspaces, v_total;
      END
      $backfill$;
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op; see the class comment.
  }
}
