import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compatibility backfill for RoleObjectFieldPermissions1786716000000 (MEMBER_ROLE_REGRESSION_AND_SECURITY_AUDIT.md).
 *
 * Custom workspace-member roles created before the role editor hold route flags (`staff.view`, `venue.view`,
 * `schedule.view`) but have no object rules and `can_read_all_objects = false`. Under the new per-request policy
 * (MemberAccessPolicyService: override ?? baseline) their members would silently LOSE access they were granted. This
 * gives every such role an explicit `grant` rule for exactly the objects whose flag it already holds — nothing more:
 * no field is made visible (sensitive fields keep the least-privilege default), no record filter is added, no flag
 * changes, so no security version needs bumping.
 *
 * Only roles that have NO object rules yet are touched (idempotent; never overrides an editor-made definition).
 * The rule tables are FORCE-RLS, so each insert runs with that role's own organisation/workspace bound via the same
 * session settings `core.current_org()` / `core.current_workspace()` read — correct whether migrations run as a
 * superuser or as the table owner, and never weakening RLS.
 *
 * down(): removes only rules this migration could have created (grant rules, no filter, on roles whose every rule is
 * such a rule and that have no field rules) — it cannot distinguish an identical editor-made rule, so down() is
 * deliberately conservative and documented as such.
 */
export class BackfillCustomRoleObjectRules1786717200000 implements MigrationInterface {
  name = 'BackfillCustomRoleObjectRules1786717200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $backfill$
      DECLARE
        r record;
      BEGIN
        FOR r IN
          SELECT ro.id, ro.organisation_id, ro.workspace_id
            FROM core.role ro
           WHERE ro.is_system = false
             AND ro.workspace_id IS NOT NULL
             AND ro.key LIKE 'custom\\_%'
             AND NOT EXISTS (SELECT 1 FROM core.role_object_permission x WHERE x.role_id = ro.id)
        LOOP
          PERFORM set_config('rab.organisation_id', r.organisation_id::text, true);
          PERFORM set_config('rab.workspace_id', r.workspace_id::text, true);
          INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read)
          SELECT r.id, r.workspace_id, r.organisation_id, m.object_key, true
            FROM core.role_permission rp
            JOIN core.permission p ON p.id = rp.permission_id
            JOIN (VALUES ('staff.view', 'staff'), ('venue.view', 'venue'), ('schedule.view', 'shift')) AS m(flag, object_key)
              ON m.flag = p.key
           WHERE rp.role_id = r.id
          ON CONFLICT (role_id, object_key) DO NOTHING;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $backfill$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $undo$
      DECLARE
        r record;
      BEGIN
        FOR r IN
          SELECT ro.id, ro.organisation_id, ro.workspace_id
            FROM core.role ro
           WHERE ro.is_system = false AND ro.workspace_id IS NOT NULL AND ro.key LIKE 'custom\\_%'
             AND NOT EXISTS (SELECT 1 FROM core.role_field_permission f WHERE f.role_id = ro.id)
             AND NOT EXISTS (SELECT 1 FROM core.role_object_permission x WHERE x.role_id = ro.id AND (x.can_read IS DISTINCT FROM true OR x.record_filter IS NOT NULL))
             AND ro.can_read_all_objects = false
        LOOP
          PERFORM set_config('rab.organisation_id', r.organisation_id::text, true);
          PERFORM set_config('rab.workspace_id', r.workspace_id::text, true);
          DELETE FROM core.role_object_permission WHERE role_id = r.id;
        END LOOP;
      END
      $undo$;
    `);
  }
}
