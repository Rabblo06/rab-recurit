import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1D (FULL-ARCHITECTURE-UPGRADE-PLAN.md P1 program) — PostgreSQL-authoritative security
 * versions. Builds the authoritative version infrastructure a future Redis cache (P1E, not built
 * here) will need to detect staleness. PostgreSQL remains the sole authority; no cache of any
 * kind is introduced by this migration.
 *
 * ── THE SIX VERSION DOMAINS ──────────────────────────────────────────────────────────────────
 * `core.user_session.security_version` already exists (P1B, `UserSession1786678000000`) and is
 * NOT touched here — its own narrow "this session's own revocation" semantics are untouched, per
 * the owner's explicit instruction not to casually repurpose or weaken it. The other five domains
 * are new:
 *
 *   - `core."user".security_version`       — this user's OWN account authority (password
 *     changed/reset, status suspended/reactivated/deactivated). Bumped by the services that own
 *     those mutations, never by this migration's own functions.
 *   - `core.role.permission_version`       — which permissions a ROLE grants. Bumped once per
 *     role when `core.role_permission` changes for it (`RoleService.setPermissions`) — NOT
 *     fanned out to every current holder's own row (the owner's brief, §3.4, explicitly asks to
 *     avoid an unnecessary synchronous mass update here). A holder's EFFECTIVE permission version
 *     is the composite `user.security_version` (covers gaining/losing a role) + `SUM(role
 *     .permission_version)` over every role currently held (covers a role's OWN definition
 *     changing — SUM, not MAX: see `SecurityVersionService.readVector`'s own doc comment for the
 *     real bug MAX had, found and fixed before this ever shipped to a consumer) — computed at
 *     read time by `SecurityVersionService.readVector`, never stored
 *     redundantly on the user row.
 *   - `core.workspace_membership.security_version` — this membership row's own lifecycle
 *     (suspended/reinstated). Bumped inside `suspend_workspace_membership`/
 *     `reinstate_workspace_membership` themselves (both already SECURITY DEFINER, already the
 *     sole mutation path for this transition — see WorkspaceMembershipCutover1786675000000).
 *   - `core.platform_admin.security_version` — platform-admin grant/revoke. Bumped at all THREE
 *     real write paths (`PlatformAdminService.grant/revoke`, the recovery CLI, and the
 *     auto-bootstrap CLI) — found by an explicit audit of every INSERT/UPDATE against this table,
 *     not assumed from the one REST-reachable service.
 *   - `core.organisation.security_version` — organisation-level security configuration: the three
 *     auth-provider toggles (`OrganisationAuthProvidersService.update`) AND maintenance mode
 *     (`AdminPanelService.setMaintenanceMode`, which writes a DIFFERENT table,
 *     `core.platform_config`, by organisation id — folded into this ONE domain rather than adding
 *     a seventh version column, per the owner's own "avoid duplicate overlapping version sources"
 *     instruction: both are "is this organisation's security posture configured the way a cached
 *     decision assumed," the same question, answered by the same counter).
 *
 * ── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────────────────────────
 * - Does not wire any cache (P1E's job).
 * - Does not add a "role revoked from user" or "user permission override" mutation path — neither
 *   exists anywhere in this codebase today (audited directly, not assumed: `core.user_role` is
 *   INSERT-only at account creation; `core.user_permission_override` has no write path at all).
 *   `user.security_version` already covers "this user's role set changed" for whenever a
 *   role-reassignment feature is eventually built — that future code MUST bump it; flagged here
 *   rather than built, since inventing that feature is out of scope.
 * - Does not change `core.user_session`'s own trigger/semantics.
 * - Does not weaken any existing RLS policy — every new column is read/written through the exact
 *   same policies and roles already governing its table; none of the six domains' policies
 *   reference these new columns.
 *
 * ── WHY THIS MIGRATION ALSO NEEDS THE PRIVILEGED BOOTSTRAP CONNECTION ───────────────────────
 * `core."user"`, `core.platform_admin` and `core.organisation` are 3 of the 11 pre-auth-sensitive
 * tables owned by the NOLOGIN `rab_secure_owner` (P1C.2) — `ALTER TABLE ... ADD COLUMN` and
 * `GRANT` both require the executing role to own the table (or be a member of the owner, or be
 * superuser); `crewflow` deliberately is neither. Confirmed empirically: running this migration
 * under `crewflow` fails with `permission denied` on the very first `ALTER TABLE core."user"`.
 * Same mechanism, same fix as `CrewflowSingleCredentialRoleArchitecture1786682000000` — run this
 * one migration via the same privileged bootstrap connection documented there (locally,
 * `postgres://rab:rab@<host>:<port>/rab`), never the ordinary `crewflow` runtime credential.
 * `core.role` and `core.workspace_membership` are ordinary crewflow-owned tables and would have
 * worked fine under `crewflow` alone, but a migration is one transaction — it cannot run some
 * statements as one role and others as a different one, so the whole file needs the elevated
 * connection.
 */
export class SecurityVersionVectors1786683000000 implements MigrationInterface {
  name = 'SecurityVersionVectors1786683000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    // ---- 1. Version columns, one per domain (user_session's is pre-existing, untouched) -----
    await queryRunner.query(`
      ALTER TABLE core."user" ADD COLUMN security_version bigint NOT NULL DEFAULT 1;
      ALTER TABLE core."user" ADD CONSTRAINT user_security_version_check CHECK (security_version > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE core.role ADD COLUMN permission_version bigint NOT NULL DEFAULT 1;
      ALTER TABLE core.role ADD CONSTRAINT role_permission_version_check CHECK (permission_version > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE core.platform_admin ADD COLUMN security_version bigint NOT NULL DEFAULT 1;
      ALTER TABLE core.platform_admin ADD CONSTRAINT platform_admin_security_version_check CHECK (security_version > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE core.organisation ADD COLUMN security_version bigint NOT NULL DEFAULT 1;
      ALTER TABLE core.organisation ADD CONSTRAINT organisation_security_version_check CHECK (security_version > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE core.workspace_membership ADD COLUMN security_version bigint NOT NULL DEFAULT 1;
      ALTER TABLE core.workspace_membership ADD CONSTRAINT workspace_membership_security_version_check CHECK (security_version > 0);
    `);

    // ---- 2. Grants: user/platform_admin/organisation are 3 of the 11 pre-auth-sensitive tables
    // (P1C.2) with NARROW, column-scoped grants to crewflow rather than a blanket table grant —
    // the new column needs to be added to those lists explicitly, or crewflow (the ordinary
    // runtime role, non-owner of these three) could not read or write it at all. role and
    // workspace_membership are ordinary crewflow-OWNED tables (not in the 11), so ownership
    // already covers any new column with no grant statement needed.
    await queryRunner.query(`GRANT SELECT (security_version) ON core."user" TO crewflow;`);
    await queryRunner.query(`GRANT INSERT (security_version), UPDATE (security_version) ON core."user" TO crewflow;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE (security_version) ON core.platform_admin TO crewflow;`);
    await queryRunner.query(`GRANT SELECT (security_version) ON core.organisation TO crewflow;`);
    await queryRunner.query(`GRANT INSERT (security_version), UPDATE (security_version) ON core.organisation TO crewflow;`);

    // ---- 3. workspace_membership's own lifecycle functions bump its new column. CREATE OR
    // REPLACE on top of WorkspaceMembershipCutover1786675000000's bodies — identical in every
    // other respect (same SECURITY DEFINER, same search_path, same GUC save/restore, same
    // cross-org 42501 guard), only the UPDATE's SET list gains one column.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.suspend_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'suspended', updated_at = now(), security_version = security_version + 1
         WHERE user_id = p_user_id AND status = 'active';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.reinstate_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'active', updated_at = now(), security_version = security_version + 1
         WHERE user_id = p_user_id AND status = 'suspended';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.suspend_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'suspended', updated_at = now()
         WHERE user_id = p_user_id AND status = 'active';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.reinstate_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'active', updated_at = now()
         WHERE user_id = p_user_id AND status = 'suspended';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);
    await queryRunner.query(`ALTER TABLE core.workspace_membership DROP COLUMN security_version;`);
    await queryRunner.query(`ALTER TABLE core.organisation DROP COLUMN security_version;`);
    await queryRunner.query(`ALTER TABLE core.platform_admin DROP COLUMN security_version;`);
    await queryRunner.query(`ALTER TABLE core.role DROP COLUMN permission_version;`);
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN security_version;`);
  }
}

/**
 * Fails closed: `ALTER TABLE`/`GRANT` against `rab_secure_owner`-owned tables requires the
 * connecting role to own them, be a member of the owner, or be superuser. `crewflow` is
 * deliberately none of those — see this migration's own "WHY THIS MIGRATION ALSO NEEDS..."
 * section for the concrete credential that satisfies this locally.
 */
async function assertBootstrapPrivilege(queryRunner: QueryRunner): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT current_user AS rolname, rolsuper, pg_has_role(current_user, 'rab_secure_owner', 'MEMBER') AS is_owner_member
       FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolname: string; rolsuper: boolean; is_owner_member: boolean }>;
  const [row] = rows;
  if (!row || !(row.rolsuper || row.is_owner_member)) {
    throw new Error(
      `SecurityVersionVectors1786683000000 refuses to run as '${row?.rolname ?? 'unknown'}': this migration alters and ` +
        `grants on tables owned by rab_secure_owner, which requires the connecting role to be a superuser or a member of ` +
        `rab_secure_owner. Re-run with DATABASE_URL pointed at the privileged bootstrap connection documented in this ` +
        `migration's own header comment — never the ordinary crewflow runtime credential.`,
    );
  }
}
