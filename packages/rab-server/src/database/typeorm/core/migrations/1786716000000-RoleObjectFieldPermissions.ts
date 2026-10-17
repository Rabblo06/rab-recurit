import { MigrationInterface, QueryRunner } from 'typeorm';

const OBJECT_KEYS = `('staff', 'venue', 'shift')`;
const ROLE_ICONS = `('shield', 'user', 'users', 'briefcase', 'calendar', 'building', 'eye', 'star', 'clipboard', 'key')`;

/**
 * Object-, field- and record-level permissions for CUSTOM workspace-member roles (Settings → Members → Roles editor).
 *
 * WHAT IS ADDED (additive, forward-only)
 *  - `core.role`: `description`, `icon` (allowlist), `assignable_to_members`, `can_read_all_objects` (the "All Objects →
 *    See" baseline), `updated_at`; a per-workspace case-insensitive unique role name for custom roles. System roles can
 *    never carry the member baseline (`role_member_baseline_only`).
 *  - `core.role_object_permission`: one row per (custom role, object): `can_read` tri-state (NULL = inherit the role's
 *    baseline, TRUE = grant, FALSE = deny) and a validated `record_filter` (record-level predicate tree, compiled by the
 *    server from an allowlist — never SQL).
 *  - `core.role_field_permission`: explicit field visibility per (custom role, object, field). Absent = the server's
 *    default for that field (sensitive fields default to hidden).
 *
 * ISOLATION: both tables carry organisation_id + workspace_id, a composite FK to `role(id, workspace_id)` (so a row can
 * only belong to a CUSTOM role of the same workspace — system roles have workspace_id NULL and can never match) and to
 * `manager_workspace(id, organisation_id)`, and FORCE RLS scoped to the current organisation AND workspace. Rows cascade
 * away with their role.
 *
 * The effective object reads are still materialised into the existing `role_permission` flags (staff.view / venue.view /
 * schedule.view) by RoleService in the same transaction, so `PermissionGuard`, the member RLS branch and the member
 * allowlist trigger are unchanged. Every write bumps `role.permission_version` in the same transaction (service layer),
 * which invalidates cached auth snapshots; the rules themselves are read fresh from PostgreSQL per request.
 */
export class RoleObjectFieldPermissions1786716000000 implements MigrationInterface {
  name = 'RoleObjectFieldPermissions1786716000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.role
        ADD COLUMN description text,
        ADD COLUMN icon text,
        ADD COLUMN assignable_to_members boolean NOT NULL DEFAULT true,
        ADD COLUMN can_read_all_objects boolean NOT NULL DEFAULT false,
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
        ADD CONSTRAINT role_description_length CHECK (description IS NULL OR length(description) <= 500),
        ADD CONSTRAINT role_icon_allowlist CHECK (icon IS NULL OR icon IN ${ROLE_ICONS}),
        ADD CONSTRAINT role_member_baseline_only CHECK (workspace_id IS NOT NULL OR can_read_all_objects = false);
    `);
    // New names only (existing system role names are unaffected).
    await queryRunner.query(`ALTER TABLE core.role ADD CONSTRAINT role_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 80) NOT VALID;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX role_member_name_per_workspace ON core.role (workspace_id, lower(btrim(name))) WHERE workspace_id IS NOT NULL;
    `);

    for (const table of ['role_object_permission', 'role_field_permission']) {
      const extra =
        table === 'role_object_permission'
          ? `can_read boolean,
             record_filter jsonb,
             updated_by uuid REFERENCES core."user"(id) ON DELETE SET NULL,
             PRIMARY KEY (role_id, object_key),
             CONSTRAINT role_object_permission_filter_shape CHECK (
               record_filter IS NULL OR (jsonb_typeof(record_filter) = 'object' AND pg_column_size(record_filter) <= 8192)
             ),`
          : `field_key text NOT NULL CHECK (field_key ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
             can_read boolean NOT NULL,
             PRIMARY KEY (role_id, object_key, field_key),`;
      await queryRunner.query(`
        CREATE TABLE core.${table} (
          role_id          uuid NOT NULL,
          workspace_id     uuid NOT NULL,
          organisation_id  uuid NOT NULL,
          object_key       text NOT NULL CHECK (object_key IN ${OBJECT_KEYS}),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          ${extra}
          CONSTRAINT ${table}_role_fkey FOREIGN KEY (role_id, workspace_id) REFERENCES core.role(id, workspace_id) ON DELETE CASCADE,
          CONSTRAINT ${table}_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
            REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE
        );
      `);
      await queryRunner.query(`CREATE INDEX ${table}_workspace_idx ON core.${table} (organisation_id, workspace_id);`);
      await queryRunner.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE core.${table} FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant ON core.${table}
          USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
          WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
      `);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.${table} TO crewflow, crewflow_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // CF-11 (October 15 audit; owner-approved 2026-10-15): fail closed. The object/field rules are about to disappear,
    // and the pre-editor code treats the materialised staff.view / venue.view / schedule.view flags as full visibility
    // (pay, address, date of birth, right-to-work and other sensitive staff fields included). So every custom
    // workspace-member role loses those flags first, and its version is bumped so cached authorisation snapshots die.
    // System and organisation-level roles (workspace_id IS NULL) are untouched. An administrator re-grants access
    // deliberately after a rollback. Each workspace is processed with its own tenant context bound, so this works under
    // FORCE RLS exactly like BackfillCustomRoleObjectRulesUnderForcedRls1786717600000.
    await queryRunner.query(`
      DO $strip$
      DECLARE
        w record;
        v_after uuid := NULL;
        v_page integer;
      BEGIN
        LOOP
          v_page := 0;
          FOR w IN SELECT d.workspace_id, d.organisation_id FROM core.worker_list_workspaces(v_after, 100) d LOOP
            v_page := v_page + 1;
            v_after := w.workspace_id;
            PERFORM set_config('rab.organisation_id', w.organisation_id::text, true);
            PERFORM set_config('rab.workspace_id', w.workspace_id::text, true);
            UPDATE core.role SET permission_version = permission_version + 1
             WHERE workspace_id = w.workspace_id AND NOT is_system
               AND EXISTS (SELECT 1 FROM core.role_permission rp JOIN core.permission p ON p.id = rp.permission_id
                            WHERE rp.role_id = core.role.id AND p.key IN ('staff.view', 'venue.view', 'schedule.view'));
            DELETE FROM core.role_permission rp USING core.role r, core.permission p
             WHERE r.id = rp.role_id AND p.id = rp.permission_id AND r.workspace_id = w.workspace_id AND NOT r.is_system
               AND p.key IN ('staff.view', 'venue.view', 'schedule.view');
          END LOOP;
          EXIT WHEN v_page < 100;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $strip$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS core.role_field_permission;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.role_object_permission;`);
    await queryRunner.query(`DROP INDEX IF EXISTS core.role_member_name_per_workspace;`);
    await queryRunner.query(`
      ALTER TABLE core.role
        DROP CONSTRAINT IF EXISTS role_name_length,
        DROP CONSTRAINT IF EXISTS role_member_baseline_only,
        DROP CONSTRAINT IF EXISTS role_icon_allowlist,
        DROP CONSTRAINT IF EXISTS role_description_length,
        DROP COLUMN IF EXISTS updated_at,
        DROP COLUMN IF EXISTS can_read_all_objects,
        DROP COLUMN IF EXISTS assignable_to_members,
        DROP COLUMN IF EXISTS icon,
        DROP COLUMN IF EXISTS description;
    `);
  }
}
