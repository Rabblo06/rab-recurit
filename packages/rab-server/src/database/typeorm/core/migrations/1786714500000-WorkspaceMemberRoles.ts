import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Custom workspace-member roles (Settings → Members → Roles / Invite), owner-approved design 2026-10-14:
 * membership-based access, roles scoped per workspace, Manager + CEO manage roles, no escalation.
 *
 * WHAT CHANGES
 *  1. `core.role.workspace_id` — NULL for system roles (`manager`, `ceo`, `staff`, `venue_manager`, …) and for
 *     legacy organisation-level custom roles; set for every NEW custom role, which belongs to exactly one
 *     Manager-owned workspace. Composite FK to `manager_workspace(id, organisation_id)` so it can never point at
 *     another organisation's workspace.
 *  2. `role_member_key`: a role's key starts with `custom_` IFF it is a workspace-member role. Authentication
 *     recognises a member role only by that prefix (`application-access.ts`), so the prefix is unforgeable and a
 *     custom role can never take a privileged system key (`manager`, `admin`, `super_admin`, …) — the previous
 *     slug-the-name scheme allowed that. `role_identity_immutable` stops a role being moved between workspaces
 *     or re-keyed afterwards.
 *  3. RLS on `core.role` is tightened from organisation-only to "system roles, plus custom roles of the CURRENT
 *     workspace": Manager B can neither see, edit nor assign Manager A's roles (404 at the service layer).
 *     `role_permission` / `user_role` writes additionally require the role to be visible to the writer.
 *  4. `role_permission_member_allowlist` (trigger): a workspace-member role may hold only the read-only flags
 *     in `MEMBER_ROLE_ALLOWED_PERMISSIONS` (@rab/shared). This is the database backstop for the service-layer
 *     escalation and allowlist checks; it keeps leadership, role/user management and recruitment-Staff
 *     self-service flags (and `manager.manage`, which `manager_workspace_write` honours) off member roles.
 *  5. `core.member_holds_workspace_permission(workspace, flag)` + `staff_profile_member_select`: a member may
 *     SELECT staff of THEIR workspace only through a custom role bound to that same workspace that grants
 *     `staff.view`. System-role holders (Venue Managers, Staff) can never satisfy it, so venue scoping is
 *     untouched. The service layer still applies the workspace owner's creator-based record scope on top.
 *  6. `workspace_membership_owner_select`: the workspace OWNER can list memberships of their own workspace
 *     (Team tab). Everyone else still sees only their own membership row.
 *  7. `role.view` + `role.manage` are granted to the system `manager` and `ceo` roles of every organisation
 *     (owner decision), with each role's permission_version bumped so cached security snapshots refresh.
 *
 * NOT CHANGED: creator-based ownership of Staff, Venues and Shifts; venue-manager scoping; staff_profile write
 * policies; the per-workspace HWS schema template (members see no staff there yet — fail closed); Staff / Venue
 * Manager creation flows.
 */
export class WorkspaceMemberRoles1786714500000 implements MigrationInterface {
  name = 'WorkspaceMemberRoles1786714500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuse rather than guess: an existing role already using the reserved prefix would be silently promoted
    // to a member role by the checks below.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM core.role WHERE key LIKE 'custom\\_%') THEN
          RAISE EXCEPTION 'core.role already contains keys with the reserved custom_ prefix; review them before applying WorkspaceMemberRoles1786714500000';
        END IF;
      END $$;
    `);

    await queryRunner.query(`ALTER TABLE core.role ADD COLUMN workspace_id uuid;`);
    await queryRunner.query(`
      ALTER TABLE core.role
        ADD CONSTRAINT role_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
          REFERENCES core.manager_workspace(id, organisation_id) ON DELETE RESTRICT,
        ADD CONSTRAINT role_system_is_organisation_wide CHECK (NOT (is_system AND workspace_id IS NOT NULL)),
        ADD CONSTRAINT role_member_key CHECK ((key LIKE 'custom\\_%') = (workspace_id IS NOT NULL)),
        ADD CONSTRAINT role_id_workspace_key UNIQUE (id, workspace_id);
    `);
    await queryRunner.query(`CREATE INDEX role_workspace_idx ON core.role (workspace_id) WHERE workspace_id IS NOT NULL;`);

    await queryRunner.query(`
      CREATE FUNCTION core.guard_role_identity() RETURNS trigger
      LANGUAGE plpgsql SET search_path = core, pg_catalog AS $$
      BEGIN
        IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.key <> OLD.key OR NEW.is_system <> OLD.is_system
           OR NEW.organisation_id <> OLD.organisation_id THEN
          RAISE EXCEPTION 'a role''s organisation, workspace, key and system flag are immutable' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await queryRunner.query(`CREATE TRIGGER role_identity_immutable BEFORE UPDATE ON core.role FOR EACH ROW EXECUTE FUNCTION core.guard_role_identity();`);

    // ── RLS: role visibility per workspace ───────────────────────────────────────────────────────────────
    await queryRunner.query(`DROP POLICY role_tenant ON core.role;`);
    await queryRunner.query(`
      CREATE POLICY role_tenant ON core.role
        USING (organisation_id = core.current_org() AND (workspace_id IS NULL OR workspace_id = core.current_workspace()))
        WITH CHECK (organisation_id = core.current_org() AND (workspace_id IS NULL OR workspace_id = core.current_workspace()));
    `);
    // Reads stay organisation-wide (SECURITY DEFINER policy helpers read role_permission as rab_secure_owner);
    // every write must target a role the writer can see.
    await queryRunner.query(`DROP POLICY role_permission_tenant ON core.role_permission;`);
    await queryRunner.query(`CREATE POLICY role_permission_select ON core.role_permission FOR SELECT USING (organisation_id = core.current_org());`);
    const visibleRole = (table: string) => `(organisation_id = core.current_org() AND EXISTS (SELECT 1 FROM core.role r WHERE r.id = ${table}.role_id))`;
    await queryRunner.query(`CREATE POLICY role_permission_insert ON core.role_permission FOR INSERT WITH CHECK ${visibleRole('role_permission')};`);
    await queryRunner.query(`CREATE POLICY role_permission_update ON core.role_permission FOR UPDATE USING ${visibleRole('role_permission')} WITH CHECK ${visibleRole('role_permission')};`);
    await queryRunner.query(`CREATE POLICY role_permission_delete ON core.role_permission FOR DELETE USING ${visibleRole('role_permission')};`);
    await queryRunner.query(`ALTER POLICY user_role_write ON core.user_role WITH CHECK ${visibleRole('user_role')};`);
    await queryRunner.query(`ALTER POLICY user_role_update ON core.user_role USING (organisation_id = core.current_org()) WITH CHECK ${visibleRole('user_role')};`);

    // ── Member-role permission allowlist (database backstop) ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION core.enforce_member_role_permission_allowlist() RETURNS trigger
      LANGUAGE plpgsql SET search_path = core, pg_catalog AS $$
      DECLARE
        v_workspace uuid;
        v_key text;
      BEGIN
        SELECT r.workspace_id INTO v_workspace FROM core.role r WHERE r.id = NEW.role_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'role not found' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF v_workspace IS NULL THEN
          RETURN NEW; -- system or legacy organisation role: unchanged behaviour
        END IF;
        SELECT p.key INTO v_key FROM core.permission p WHERE p.id = NEW.permission_id;
        IF v_key IS NULL OR NOT (v_key = ANY (ARRAY['staff.view', 'venue.view', 'schedule.view'])) THEN
          RAISE EXCEPTION 'permission % cannot be granted to a workspace-member role', v_key USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER role_permission_member_allowlist BEFORE INSERT OR UPDATE ON core.role_permission
        FOR EACH ROW EXECUTE FUNCTION core.enforce_member_role_permission_allowlist();
    `);

    // ── Member read access to staff of their own workspace ───────────────────────────────────────────────
    // SECURITY INVOKER: evaluated under the caller's own RLS and GUCs, never widening what they can read.
    await queryRunner.query(`
      CREATE FUNCTION core.member_holds_workspace_permission(p_workspace uuid, p_permission text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path = core, pg_catalog AS $$
        SELECT EXISTS (
          SELECT 1
            FROM core.workspace_membership m
            JOIN core.user_role ur ON ur.user_id = m.user_id AND ur.organisation_id = m.organisation_id
            JOIN core.role r ON r.id = ur.role_id
            JOIN core.role_permission rp ON rp.role_id = r.id
            JOIN core.permission p ON p.id = rp.permission_id
           WHERE m.user_id = core.current_uid()
             AND m.organisation_id = core.current_org()
             AND m.workspace_id = p_workspace
             AND m.status = 'active'
             AND r.is_system = false
             AND r.workspace_id = p_workspace
             AND p.key = p_permission
        );
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.member_holds_workspace_permission(uuid, text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.member_holds_workspace_permission(uuid, text) TO crewflow, crewflow_app, rab_secure_owner;`);
    // SECURITY DEFINER readers of staff_profile run as rab_secure_owner, which already reads role_permission /
    // user_role / workspace_membership (SecureOwnerRolePermissionSelectGrant1786710000000); the helper also needs role.
    await queryRunner.query(`GRANT SELECT ON core.role TO rab_secure_owner;`);
    await queryRunner.query(`
      CREATE POLICY staff_profile_member_select ON core.staff_profile FOR SELECT
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace()
               AND core.member_holds_workspace_permission(workspace_id, 'staff.view'));
    `);

    // ── Team tab: the workspace owner lists their workspace's memberships ────────────────────────────────
    await queryRunner.query(`
      CREATE POLICY workspace_membership_owner_select ON core.workspace_membership FOR SELECT
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace()
               AND EXISTS (SELECT 1 FROM core.manager_workspace w WHERE w.id = workspace_membership.workspace_id AND w.owner_user_id = core.current_uid()));
    `);

    // ── role.view / role.manage for the system manager and ceo roles ─────────────────────────────────────
    await queryRunner.query(`
      INSERT INTO core.permission (key, resource, action, description) VALUES
        ('role.view', 'role', 'view', 'See workspace roles and their permissions'),
        ('role.manage', 'role', 'manage', 'Create and edit custom workspace-member roles and invite members with them')
      ON CONFLICT (key) DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.role DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      WITH granted AS (
        INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
        SELECT r.organisation_id, r.id, p.id
          FROM core.role r CROSS JOIN core.permission p
         WHERE r.is_system AND r.key IN ('manager', 'ceo') AND p.key IN ('role.view', 'role.manage')
        ON CONFLICT DO NOTHING
        RETURNING role_id
      )
      UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT DISTINCT role_id FROM granted);
    `);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.role DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      WITH removed AS (
        DELETE FROM core.role_permission rp USING core.role r, core.permission p
         WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.is_system AND r.key IN ('manager', 'ceo')
           AND p.key IN ('role.view', 'role.manage')
        RETURNING rp.role_id
      )
      UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT DISTINCT role_id FROM removed);
    `);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`DROP POLICY IF EXISTS workspace_membership_owner_select ON core.workspace_membership;`);
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_member_select ON core.staff_profile;`);
    await queryRunner.query(`REVOKE SELECT ON core.role FROM rab_secure_owner;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.member_holds_workspace_permission(uuid, text);`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS role_permission_member_allowlist ON core.role_permission;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.enforce_member_role_permission_allowlist();`);
    await queryRunner.query(`ALTER POLICY user_role_write ON core.user_role WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`ALTER POLICY user_role_update ON core.user_role USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`DROP POLICY IF EXISTS role_permission_select ON core.role_permission;`);
    await queryRunner.query(`DROP POLICY IF EXISTS role_permission_insert ON core.role_permission;`);
    await queryRunner.query(`DROP POLICY IF EXISTS role_permission_update ON core.role_permission;`);
    await queryRunner.query(`DROP POLICY IF EXISTS role_permission_delete ON core.role_permission;`);
    await queryRunner.query(`CREATE POLICY role_permission_tenant ON core.role_permission USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`DROP POLICY role_tenant ON core.role;`);
    await queryRunner.query(`CREATE POLICY role_tenant ON core.role USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS role_identity_immutable ON core.role;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.guard_role_identity();`);
    // Member roles (and anything referencing them) must be removed by the operator before reverting.
    await queryRunner.query(`DROP INDEX IF EXISTS core.role_workspace_idx;`);
    await queryRunner.query(`
      ALTER TABLE core.role
        DROP CONSTRAINT IF EXISTS role_id_workspace_key,
        DROP CONSTRAINT IF EXISTS role_member_key,
        DROP CONSTRAINT IF EXISTS role_system_is_organisation_wide,
        DROP CONSTRAINT IF EXISTS role_workspace_fkey,
        DROP COLUMN IF EXISTS workspace_id;
    `);
  }
}
