import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.2-F — makes the P1C.2 single-application-credential role migration (previously only a
 * manual, undocumented, gitignored scratch script — `.audit/p1c2-migration.sql`, run by hand
 * against the live local database) into a reviewed, version-controlled, repeatable migration.
 * Every statement below was already executed and empirically verified against the live local
 * database before this file was written (see docs/P1-MASTER-EXECUTION-STATUS.md's P1C.2 entry for
 * the full audit trail and test results) — this file encodes that SAME sequence so a fresh install
 * or an unmigrated existing install can reach the identical end state, not a redesign.
 *
 * ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────────────────────
 * Replaces the two-role `rab_owner` (migration owner) / `rab_app` (ordinary runtime, NOBYPASSRLS)
 * split with:
 *   - `crewflow` (LOGIN) — the one application credential for ordinary API/Worker/CLI runtime and
 *     for workspace schema provisioning. Owns every ordinary tenant table (all carry FORCE ROW
 *     LEVEL SECURITY, so ownership never bypasses them) and every `workspace_<uuid>` schema's
 *     business tables.
 *   - `rab_secure_owner` (NOLOGIN) — owns the 11 pre-auth-sensitive tables (`user`, `login_history`,
 *     `refresh_token`, `password_reset_token`, `manager_workspace`, `worker_due_work`,
 *     `account_invite`, `user_session`, `user_auth_identity`, `organisation`, `platform_admin`) and
 *     the 31 SECURITY DEFINER functions that read at least one of them before any tenant context
 *     exists, plus every `workspace_<uuid>` schema NAMESPACE (not its business tables). `crewflow`
 *     has narrow, column-scoped grants on the 11 tables and EXECUTE on the 31 functions, but is
 *     NEVER a member of `rab_secure_owner` — this is the entire point of the split (see the
 *     empirical proof below).
 *   - `rab_owner`/`rab_app` are retired: every privilege REVOKEd, then `ALTER ROLE ... NOLOGIN`.
 *     Not dropped (CLAUDE.md: never `DROP ROLE ... CASCADE`) — reversible, cannot authenticate.
 *
 * ── WHY TWO ROLES, NOT ONE ────────────────────────────────────────────────────────────────────
 * `FORCE ROW LEVEL SECURITY` binds the table OWNER too (including inside SECURITY DEFINER
 * execution) — ordinary FORCE'd tables are therefore safe for the runtime role to own. The 11
 * tables above do NOT carry FORCE (NOT_FORCED_ALLOWLIST, see CLAUDE.md and
 * `tools/check-rls-coverage.ts`) precisely because pre-auth lookups (resolving an opaque
 * cookie/token/email to an identity) must run with no tenant context bound yet — so if the runtime
 * role owned them too, a context-free query would return every row in the table. Proven
 * empirically before this design was chosen: a throwaway role made owner of `core.user_session`
 * (NOT_FORCE) with zero tenant context returned 6,508 rows; the same test against an ordinary
 * FORCE'd table returned 0.
 *
 * ── HOW TO RUN THIS MIGRATION (read before invoking) ─────────────────────────────────────────
 * This is the ONE migration in this codebase that CANNOT run under the ordinary migration
 * connection (`crewflow`, or historically `rab_owner`) — `ALTER TABLE/FUNCTION ... OWNER TO
 * rab_secure_owner` requires the executing role to be a member of `rab_secure_owner` (Postgres
 * rule), which no application-reachable role is, by design (requirement 2 of the owner-approved
 * P1C.2 design: "crewflow must not inherit or be able to SET ROLE into their owner role, directly
 * or indirectly"). `assertBootstrapPrivilege` below enforces this at runtime — the migration fails
 * closed with an actionable error rather than silently running under insufficient privilege or
 * silently skipping the ownership tightening.
 *
 * Locally (docker-compose): temporarily set `DATABASE_URL` to the Postgres container's own
 * bootstrap superuser — `postgres://rab:rab@<host>:<port>/rab` (from
 * `packages/rab-docker/postgres-init/01-roles.sql`'s own `POSTGRES_USER`/`POSTGRES_PASSWORD` —
 * NOT a new credential, never placed in the app's own `.env` or any deployed container's
 * environment, never reachable from a request path), run `yarn nx run rab-server:migration:run`
 * (TypeORM skips every already-applied migration and runs only this one next), then restore
 * `DATABASE_URL` to the ordinary `crewflow` connection string for normal operation.
 *
 * On a managed Postgres provider (production — NOT YET AUTHORIZED, see
 * docs/P1-MASTER-EXECUTION-STATUS.md's P1C.2-F entry for what's still outstanding before a
 * production cutover), the provider's own highest-privilege/admin role plays the same part — that
 * decision is explicitly out of scope for this migration file and must be re-approved separately
 * before this migration is ever pointed at a production database.
 *
 * Requires `CREWFLOW_BOOTSTRAP_PASSWORD` to be set in the environment the migration runs in (fail
 * closed if unset — never a hardcoded or default password for a real login role). This is a
 * migration-time-only variable; it does not need to appear in the app's own `.env` once `crewflow`
 * already exists with that password (though it may stay identical to the value `DATABASE_URL`'s
 * own `crewflow:<password>@...` already uses, since this migration is also how that password gets
 * SET in the first place).
 *
 * ── SECURITY TRADE-OFF (owner-accepted in writing before P1C.2 began) ────────────────────────
 * `crewflow` now owns far more tables than `rab_app` ever did — a compromised `crewflow` credential
 * has DDL authority over most business data (though NOT over the 11 pre-auth-sensitive tables or
 * their functions, which remain genuinely out of its reach). This is not equivalent
 * compromise-containment to the old `rab_app`/`rab_owner` split, where the runtime role owned
 * nothing at all.
 *
 * ── REPRODUCIBILITY NOTES ─────────────────────────────────────────────────────────────────────
 * - Existing `workspace_<uuid>` schemas are discovered dynamically (`pg_namespace` pattern match),
 *   never hardcoded — this file must behave identically whether run against a fresh install with
 *   zero workspaces or an existing install with any number of them.
 * - `core.provision_workspace_schema` (rewritten below) is what gives every workspace schema
 *   created AFTER this migration the correct ownership automatically — this migration only needs
 *   to fix up schemas that already existed before it ran.
 * - All `ALTER ... OWNER TO`/`CREATE ROLE`/`GRANT`/`REVOKE` statements are safe to re-run
 *   (idempotent): re-applying this migration against an already-migrated database changes nothing.
 */
export class CrewflowSingleCredentialRoleArchitecture1786682000000 implements MigrationInterface {
  name = 'CrewflowSingleCredentialRoleArchitecture1786682000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    const crewflowPassword = requireBootstrapPassword();

    // ---- 1. Roles --------------------------------------------------------------------------
    await queryRunner.query(
      `DO $do$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crewflow') THEN
           CREATE ROLE crewflow LOGIN PASSWORD '${crewflowPassword}';
         ELSE
           ALTER ROLE crewflow PASSWORD '${crewflowPassword}';
         END IF;
       END $do$;`,
    );
    await queryRunner.query(
      `DO $do$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rab_secure_owner') THEN
           CREATE ROLE rab_secure_owner NOLOGIN;
         END IF;
       END $do$;`,
    );

    // ---- 2. Bulk ownership transfer: everything rab_owner/rab_app currently own moves to crewflow
    await queryRunner.query(`REASSIGN OWNED BY rab_owner TO crewflow;`);
    await queryRunner.query(`REASSIGN OWNED BY rab_app TO crewflow;`);

    // ---- 3. Pull the 11 pre-auth-sensitive tables back to the narrow NOLOGIN owner ----------
    const sensitiveTables = [
      'user',
      'login_history',
      'refresh_token',
      'password_reset_token',
      'manager_workspace',
      'worker_due_work',
      'account_invite',
      'user_session',
      'user_auth_identity',
      'organisation',
      'platform_admin',
    ];
    for (const table of sensitiveTables) {
      await queryRunner.query(`ALTER TABLE core."${table}" OWNER TO rab_secure_owner;`);
    }

    // ---- 4. Pre-auth / cross-tenant SECURITY DEFINER functions stay with the narrow owner --
    const sensitiveFunctions = [
      `admin_workspace_in_org(p_workspace_id uuid, p_organisation_id uuid)`,
      `auth_count_recent_login_failures(p_email citext, p_since timestamp with time zone)`,
      `auth_find_account_invite_org(p_token_hash text)`,
      `auth_find_organisation_by_slug(p_slug citext)`,
      `auth_find_password_reset_token_org(p_token_hash text)`,
      `auth_find_refresh_token_org(p_token_hash text)`,
      `auth_find_session_by_web_token_hash(p_hash text)`,
      `auth_find_user_by_provider_identity(p_provider text, p_subject text)`,
      `auth_find_users_by_email(p_email citext)`,
      `auth_list_organisation_providers()`,
      `count_user_session_backfill_status()`,
      `is_active_platform_admin(check_user_id uuid)`,
      `organisation_slug_taken(p_slug citext, p_exclude_org_id uuid)`,
      `user_owns_manager_workspace(check_user_id uuid)`,
      `workspace_subdomain_taken(p_subdomain citext, p_exclude_workspace_id uuid)`,
      `resolve_membership_for_session(p_sid uuid)`,
      `resolve_membership_for_user(p_user_id uuid)`,
      `worker_cleanup_auth_tokens(p_batch integer)`,
      `worker_claim_due_work(p_job_type text, p_batch integer, p_lease_seconds integer)`,
      `worker_complete_due_work(p_id uuid, p_lease_token uuid)`,
      `worker_reschedule_due_work(p_id uuid, p_lease_token uuid, p_due_at timestamp with time zone)`,
      `worker_list_organisations(p_after uuid, p_limit integer)`,
      `worker_list_workspaces(p_after uuid, p_limit integer)`,
      `begin_workspace_schema_attempt(p_workspace_id uuid)`,
      `mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)`,
      `mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer)`,
      `register_workspace_schema(p_workspace_id uuid)`,
      `workspace_schema_routable(p_workspace_id uuid)`,
      // Classification fix found via a real failing abuse-case test, not assumption: both of these
      // ALSO pre-auth-read core.user before any tenant context exists.
      `suspend_workspace_membership(uuid)`,
      `reinstate_workspace_membership(uuid)`,
    ];
    for (const fn of sensitiveFunctions) {
      // GRANT's function-signature syntax accepts the same "[argname] argtype" form as the
      // function's own declaration (argname is optional and ignored for matching) — no signature
      // transformation needed between ALTER FUNCTION and GRANT EXECUTE below.
      await queryRunner.query(`ALTER FUNCTION core.${fn} OWNER TO rab_secure_owner;`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow;`);
    }
    // P2.0 (found live, via workspace-lifecycle-grant-tightening.integration.spec.ts failing with
    // P0002 instead of the expected 42501 — crewflow reached the function body instead of being
    // denied at the permission check): `sensitiveFunctions` above is the list of every function
    // needing ownership moved to rab_secure_owner, which is NOT the same list as "every function
    // crewflow should be able to call" — four of these five workspace-lifecycle entries are
    // exactly the ones WorkspaceLifecycleGrantTightening1786677800000 deliberately revoked from
    // rab_app (§8A.9 Check A: a caller must go through the service layer's own state machine,
    // never call these SECURITY DEFINER mutators directly). The blanket GRANT EXECUTE loop above
    // silently re-opened that narrowing for crewflow during the rab_app→crewflow rename — this
    // migration never ran against any real database before this fix (confirmed via git: untracked,
    // never merged), so closing it here rather than in a follow-up migration loses nothing.
    // `workspace_schema_routable` and `provision_workspace_schema` are deliberately NOT revoked
    // here: the former is the live per-request routing check crewflow must call every request, the
    // latter is already safe by its own internal structural checks regardless of caller role.
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.register_workspace_schema(p_workspace_id uuid) FROM crewflow;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.begin_workspace_schema_attempt(p_workspace_id uuid) FROM crewflow;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer) FROM crewflow;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text) FROM crewflow;`);

    // ---- 5. Existing workspace_<uuid> schema NAMESPACES (not their business tables, which stay
    // crewflow's) — discovered dynamically, never hardcoded, so this works identically on a fresh
    // install (zero matches) or an existing install (N matches).
    await queryRunner.query(`
      DO $do$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$' LOOP
          EXECUTE format('ALTER SCHEMA %I OWNER TO rab_secure_owner', r.nspname);
          EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO crewflow', r.nspname);
        END LOOP;
      END $do$;
    `);

    // ---- 6. rab_secure_owner needs CREATE on the database itself (provision_workspace_schema's
    // own CREATE SCHEMA) and USAGE on core (owning objects in a schema does not imply USAGE on the
    // schema itself — the first real bug this design surfaced, found via a functional test
    // failure, not review).
    await queryRunner.query(`
      DO $do$
      BEGIN
        EXECUTE format('GRANT CREATE ON DATABASE %I TO rab_secure_owner', current_database());
      END $do$;
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO rab_secure_owner;`);
    await queryRunner.query(`GRANT USAGE, CREATE ON SCHEMA core TO crewflow;`);
    // resolve_membership_for_session/_for_user read this AFTER binding context;
    // suspend/reinstate_workspace_membership UPDATE it.
    await queryRunner.query(`GRANT SELECT, UPDATE ON core.workspace_membership TO rab_secure_owner;`);
    // Found via a genuine fresh-install provisioning test (P1C.2-F), not assumed: register_workspace_schema
    // INSERTs, mark_workspace_schema_ready/_failed UPDATE, and workspace_schema_routable SELECTs
    // core.workspace_schema_registry — an ordinary (crewflow-owned) table these rab_secure_owner-owned
    // functions touch precisely because they also read core.manager_workspace (one of the 11) pre-context.
    // Owning the FUNCTION never implies privilege on every table its body happens to touch.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.workspace_schema_registry TO rab_secure_owner;`);

    // ---- 7. Replicate the narrow table/column grants rab_app used to have on the 11 exempt
    // tables, onto crewflow (1:1, read from rab_app's own live ACLs when this was first designed —
    // not invented, see docs/P1-MASTER-EXECUTION-STATUS.md).
    const tableGrants: Array<[string, string]> = [
      ['DELETE', 'account_invite'], ['INSERT', 'account_invite'], ['SELECT', 'account_invite'], ['UPDATE', 'account_invite'],
      ['DELETE', 'login_history'], ['INSERT', 'login_history'], ['SELECT', 'login_history'], ['UPDATE', 'login_history'],
      ['DELETE', 'manager_workspace'], ['INSERT', 'manager_workspace'], ['SELECT', 'manager_workspace'], ['UPDATE', 'manager_workspace'],
      ['DELETE', 'organisation'], ['INSERT', 'organisation'], ['SELECT', 'organisation'], ['UPDATE', 'organisation'],
      ['DELETE', 'password_reset_token'], ['INSERT', 'password_reset_token'], ['SELECT', 'password_reset_token'], ['UPDATE', 'password_reset_token'],
      ['DELETE', 'platform_admin'], ['INSERT', 'platform_admin'], ['SELECT', 'platform_admin'], ['UPDATE', 'platform_admin'],
      ['DELETE', 'refresh_token'], ['INSERT', 'refresh_token'], ['SELECT', 'refresh_token'], ['UPDATE', 'refresh_token'],
      ['DELETE', 'user'], ['INSERT', 'user'], ['UPDATE', 'user'],
      ['SELECT', 'user_auth_identity'],
      ['SELECT', 'user_session'],
      ['DELETE', 'worker_due_work'], ['INSERT', 'worker_due_work'], ['SELECT', 'worker_due_work'], ['UPDATE', 'worker_due_work'],
    ];
    for (const [privilege, table] of tableGrants) {
      await queryRunner.query(`GRANT ${privilege} ON core."${table}" TO crewflow;`);
    }

    const columnGrants: Array<{ privilege: string; table: string; columns: string[] }> = [
      {
        privilege: 'INSERT', table: 'account_invite',
        columns: ['accepted_at', 'cleanup_at', 'created_at', 'created_by', 'expires_at', 'id', 'organisation_id', 'revoked_at', 'send_number', 'token_hash', 'user_id'],
      },
      {
        privilege: 'SELECT', table: 'account_invite',
        columns: ['accepted_at', 'cleanup_at', 'created_at', 'created_by', 'expires_at', 'id', 'organisation_id', 'revoked_at', 'send_number', 'token_hash', 'user_id'],
      },
      {
        privilege: 'UPDATE', table: 'account_invite',
        columns: ['accepted_at', 'cleanup_at', 'created_at', 'created_by', 'expires_at', 'id', 'organisation_id', 'revoked_at', 'send_number', 'token_hash', 'user_id'],
      },
      { privilege: 'INSERT', table: 'login_history', columns: ['created_at', 'email', 'id', 'ip', 'organisation_id', 'provider', 'success', 'user_agent', 'user_id'] },
      { privilege: 'SELECT', table: 'login_history', columns: ['created_at', 'email', 'id', 'ip', 'organisation_id', 'provider', 'success', 'user_agent', 'user_id'] },
      { privilege: 'UPDATE', table: 'login_history', columns: ['created_at', 'email', 'id', 'ip', 'organisation_id', 'provider', 'success', 'user_agent', 'user_id'] },
      {
        privilege: 'INSERT', table: 'manager_workspace',
        columns: ['created_at', 'id', 'logo_file_id', 'logo_key', 'name', 'onboarding_completed_at', 'organisation_id', 'owner_user_id', 'schema_last_error', 'schema_migrated_at', 'schema_status', 'schema_version', 'status', 'subdomain', 'updated_at'],
      },
      {
        privilege: 'SELECT', table: 'manager_workspace',
        columns: ['created_at', 'id', 'logo_file_id', 'logo_key', 'name', 'onboarding_completed_at', 'organisation_id', 'owner_user_id', 'schema_last_error', 'schema_migrated_at', 'schema_status', 'schema_version', 'status', 'subdomain', 'updated_at'],
      },
      {
        privilege: 'UPDATE', table: 'manager_workspace',
        columns: ['created_at', 'id', 'logo_file_id', 'logo_key', 'name', 'onboarding_completed_at', 'organisation_id', 'owner_user_id', 'schema_last_error', 'schema_migrated_at', 'schema_status', 'schema_version', 'status', 'subdomain', 'updated_at'],
      },
      {
        privilege: 'INSERT', table: 'organisation',
        columns: ['address', 'contact', 'created_at', 'google_auth_enabled', 'id', 'legal_name', 'logo_file_id', 'logo_key', 'microsoft_auth_enabled', 'name', 'password_auth_enabled', 'settings', 'slug', 'timezone'],
      },
      {
        privilege: 'SELECT', table: 'organisation',
        columns: ['address', 'contact', 'created_at', 'google_auth_enabled', 'id', 'legal_name', 'logo_file_id', 'logo_key', 'microsoft_auth_enabled', 'name', 'password_auth_enabled', 'settings', 'slug', 'timezone'],
      },
      {
        privilege: 'UPDATE', table: 'organisation',
        columns: ['address', 'contact', 'created_at', 'google_auth_enabled', 'id', 'legal_name', 'logo_file_id', 'logo_key', 'microsoft_auth_enabled', 'name', 'password_auth_enabled', 'settings', 'slug', 'timezone'],
      },
      {
        privilege: 'INSERT', table: 'password_reset_token',
        columns: ['application_target', 'created_at', 'expires_at', 'id', 'organisation_id', 'purpose', 'token_hash', 'used_at', 'user_id'],
      },
      {
        privilege: 'SELECT', table: 'password_reset_token',
        columns: ['application_target', 'created_at', 'expires_at', 'id', 'organisation_id', 'purpose', 'token_hash', 'used_at', 'user_id'],
      },
      {
        privilege: 'UPDATE', table: 'password_reset_token',
        columns: ['application_target', 'created_at', 'expires_at', 'id', 'organisation_id', 'purpose', 'token_hash', 'used_at', 'user_id'],
      },
      { privilege: 'INSERT', table: 'platform_admin', columns: ['granted_at', 'granted_by', 'revoked_at', 'revoked_by', 'user_id'] },
      { privilege: 'SELECT', table: 'platform_admin', columns: ['granted_at', 'granted_by', 'revoked_at', 'revoked_by', 'user_id'] },
      { privilege: 'UPDATE', table: 'platform_admin', columns: ['granted_at', 'granted_by', 'revoked_at', 'revoked_by', 'user_id'] },
      {
        privilege: 'INSERT', table: 'refresh_token',
        columns: ['application_target', 'created_at', 'device_id', 'expires_at', 'family_expires_at', 'family_id', 'id', 'ip', 'organisation_id', 'replaced_by', 'revoked_at', 'token_hash', 'user_agent', 'user_id'],
      },
      {
        privilege: 'SELECT', table: 'refresh_token',
        columns: ['application_target', 'created_at', 'device_id', 'expires_at', 'family_expires_at', 'family_id', 'id', 'ip', 'organisation_id', 'replaced_by', 'revoked_at', 'token_hash', 'user_agent', 'user_id'],
      },
      {
        privilege: 'UPDATE', table: 'refresh_token',
        columns: ['application_target', 'created_at', 'device_id', 'expires_at', 'family_expires_at', 'family_id', 'id', 'ip', 'organisation_id', 'replaced_by', 'revoked_at', 'token_hash', 'user_agent', 'user_id'],
      },
      {
        // Deliberately excludes password_hash/totp_secret_encrypted — matches
        // RevokeUserPasswordHashSelectFromApp1786669800000's intent, replicated onto crewflow.
        privilege: 'INSERT', table: 'user',
        columns: ['avatar_file_id', 'avatar_key', 'created_at', 'deleted_at', 'email', 'email_verified_at', 'first_name', 'id', 'last_login_at', 'last_name', 'must_reset_password', 'organisation_id', 'password_hash', 'phone', 'status', 'temporary_password_hash', 'totp_enabled', 'totp_secret_encrypted', 'updated_at'],
      },
      {
        privilege: 'SELECT', table: 'user',
        columns: ['avatar_file_id', 'avatar_key', 'created_at', 'deleted_at', 'email', 'email_verified_at', 'first_name', 'id', 'last_login_at', 'last_name', 'must_reset_password', 'organisation_id', 'phone', 'status', 'totp_enabled', 'updated_at'],
      },
      {
        privilege: 'UPDATE', table: 'user',
        columns: ['avatar_file_id', 'avatar_key', 'created_at', 'deleted_at', 'email', 'email_verified_at', 'first_name', 'id', 'last_login_at', 'last_name', 'must_reset_password', 'organisation_id', 'password_hash', 'phone', 'status', 'temporary_password_hash', 'totp_enabled', 'totp_secret_encrypted', 'updated_at'],
      },
      { privilege: 'INSERT', table: 'user_auth_identity', columns: ['created_at', 'id', 'last_used_at', 'organisation_id', 'provider', 'provider_subject', 'user_id', 'verified_email_snapshot'] },
      { privilege: 'SELECT', table: 'user_auth_identity', columns: ['created_at', 'id', 'last_used_at', 'organisation_id', 'provider', 'provider_subject', 'user_id', 'verified_email_snapshot'] },
      { privilege: 'UPDATE', table: 'user_auth_identity', columns: ['last_used_at'] },
      {
        privilege: 'INSERT', table: 'user_session',
        columns: ['absolute_expires_at', 'application_target', 'auth_provider', 'created_at', 'device_id', 'id', 'ip_address', 'last_seen_at', 'organisation_id', 'user_agent', 'user_id', 'web_session_token_hash', 'workspace_id'],
      },
      {
        privilege: 'SELECT', table: 'user_session',
        columns: ['absolute_expires_at', 'application_target', 'auth_provider', 'created_at', 'device_id', 'device_name', 'device_type', 'id', 'idle_expires_at', 'ip_address', 'last_seen_at', 'mfa_verified_at', 'organisation_id', 'platform', 'revoked_at', 'revoked_reason', 'security_version', 'updated_at', 'user_agent', 'user_id', 'web_session_token_hash', 'workspace_id'],
      },
      { privilege: 'UPDATE', table: 'user_session', columns: ['last_seen_at', 'revoked_at', 'revoked_reason', 'security_version'] },
      {
        privilege: 'INSERT', table: 'worker_due_work',
        columns: ['attempt_count', 'created_at', 'due_at', 'id', 'job_type', 'lease_token', 'lease_until', 'organisation_id', 'status', 'subject_id', 'subject_type', 'updated_at', 'workspace_id'],
      },
      {
        privilege: 'SELECT', table: 'worker_due_work',
        columns: ['attempt_count', 'created_at', 'due_at', 'id', 'job_type', 'lease_token', 'lease_until', 'organisation_id', 'status', 'subject_id', 'subject_type', 'updated_at', 'workspace_id'],
      },
      {
        privilege: 'UPDATE', table: 'worker_due_work',
        columns: ['attempt_count', 'created_at', 'due_at', 'id', 'job_type', 'lease_token', 'lease_until', 'organisation_id', 'status', 'subject_id', 'subject_type', 'updated_at', 'workspace_id'],
      },
    ];
    for (const { privilege, table, columns } of columnGrants) {
      const columnList = columns.map((c) => `"${c}"`).join(', ');
      await queryRunner.query(`GRANT ${privilege} (${columnList}) ON core."${table}" TO crewflow;`);
    }

    // ---- 8. provision_workspace_schema had hardcoded rab_owner/rab_app role-name string literals
    // in its own SQL body — rewritten to rab_secure_owner/crewflow (and widened to GRANT USAGE,
    // CREATE, since crewflow now creates the 15 business tables inside the new schema itself, where
    // rab_app previously never needed CREATE).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.provision_workspace_schema(p_workspace_id uuid)
       RETURNS text
       LANGUAGE plpgsql
       SECURITY DEFINER
       SET search_path TO 'pg_catalog', 'pg_temp'
      AS $pwsfn$
        DECLARE
          v_name   text;
          v_status text;
          v_owner  text;
        BEGIN
          IF p_workspace_id IS NULL THEN
            RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
          END IF;

          v_name := 'workspace_' || replace(p_workspace_id::text, '-', '');
          IF v_name !~ '^workspace_[0-9a-f]{32}$' THEN
            RAISE EXCEPTION 'derived schema name failed canonical check' USING ERRCODE = '22023';
          END IF;

          SELECT w.schema_status INTO v_status
            FROM core.manager_workspace w
           WHERE w.id = p_workspace_id
             FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
          END IF;
          IF v_status IS NULL THEN
            RAISE EXCEPTION 'workspace is not in a provisionable state' USING ERRCODE = '55000';
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = v_name) THEN
            EXECUTE format('CREATE SCHEMA %I AUTHORIZATION rab_secure_owner', v_name);
          END IF;

          SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner
            FROM pg_catalog.pg_namespace n
           WHERE n.nspname = v_name;
          IF v_owner IS DISTINCT FROM 'rab_secure_owner' THEN
            RAISE EXCEPTION 'existing schema is not owned by rab_secure_owner' USING ERRCODE = '42501';
          END IF;

          -- P1C.2: crewflow is the single application login now; it creates the 15 business tables
          -- within this schema itself (provisionWorkspaceSchema's own raw-SQL template step, run on
          -- crewflow's own connection), so it needs CREATE here, not just USAGE.
          EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO crewflow', v_name);

          RETURN v_name;
        END;
        $pwsfn$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.provision_workspace_schema(uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace_schema(uuid) TO crewflow;`);

    // ---- 9. Final cleanup: revoke every stale direct grant rab_app/rab_owner held (ownership
    // already moved via REASSIGN OWNED above), and retire both as application logins.
    await queryRunner.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core FROM rab_app, rab_owner;`);
    await queryRunner.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA core FROM rab_app, rab_owner;`);
    await queryRunner.query(`REVOKE ALL PRIVILEGES ON SCHEMA core FROM rab_app, rab_owner;`);
    await queryRunner.query(`
      DO $do$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$' LOOP
          EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM rab_app, rab_owner', r.nspname);
          EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM rab_app, rab_owner', r.nspname);
        END LOOP;
      END $do$;
    `);
    await queryRunner.query(`
      DO $do$
      BEGIN
        EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM rab_app, rab_owner', current_database());
      END $do$;
    `);
    await queryRunner.query(`ALTER ROLE rab_app NOLOGIN;`);
    await queryRunner.query(`ALTER ROLE rab_owner NOLOGIN;`);
  }

  /**
   * Best-effort reversal, not a byte-for-byte restoration — see the class doc comment. Restores
   * LOGIN and full ownership to rab_owner (the pre-P1C.2 model: rab_owner owned everything, rab_app
   * only ever held grants), and restores rab_app's broad grants. It deliberately does NOT replay
   * every individual historical migration's own narrow rab_app grant one at a time — if a rollback
   * needs to go further back than this migration, `migration:revert` continuing past this file
   * naturally re-applies each earlier migration's own down(), which already knows its own narrow
   * grant exactly. This down() only undoes what THIS migration's up() changed.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);

    await queryRunner.query(`ALTER ROLE rab_owner LOGIN;`);
    await queryRunner.query(`ALTER ROLE rab_app LOGIN;`);

    // Ownership: everything crewflow and rab_secure_owner hold moves back to rab_owner, matching
    // the pre-P1C.2 model where rab_owner owned everything (including the 11 sensitive tables —
    // they were only ever RLS-exempted via NO FORCE ROW LEVEL SECURITY, never ownership-separated).
    await queryRunner.query(`REASSIGN OWNED BY crewflow TO rab_owner;`);
    await queryRunner.query(`REASSIGN OWNED BY rab_secure_owner TO rab_owner;`);

    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO rab_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO rab_app;`);
    await queryRunner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO rab_app;`);
    // Mirror the up() fix above: this blanket EXECUTE grant would otherwise re-open the exact same
    // four functions on rab_app that WorkspaceLifecycleGrantTightening1786677800000 (an earlier,
    // separate, already-applied migration this down() does not itself touch) deliberately revoked
    // — rolling back THIS migration must restore the state to exactly what it was immediately
    // before this migration ran, which already had those four revoked.
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.register_workspace_schema(p_workspace_id uuid) FROM rab_app;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.begin_workspace_schema_attempt(p_workspace_id uuid) FROM rab_app;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer) FROM rab_app;`);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text) FROM rab_app;`);
    // Restore the one narrowing we know mattered (RevokeUserPasswordHashSelectFromApp1786669800000's
    // intent) rather than leave the blanket SELECT above accidentally wider than it ever was.
    await queryRunner.query(`REVOKE SELECT ("password_hash", "temporary_password_hash", "totp_secret_encrypted") ON core."user" FROM rab_app;`);
    await queryRunner.query(`
      DO $do$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$' LOOP
          EXECUTE format('ALTER SCHEMA %I OWNER TO rab_owner', r.nspname);
          EXECUTE format('GRANT USAGE ON SCHEMA %I TO rab_app', r.nspname);
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rab_app', r.nspname);
        END LOOP;
      END $do$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.provision_workspace_schema(p_workspace_id uuid)
       RETURNS text
       LANGUAGE plpgsql
       SECURITY DEFINER
       SET search_path TO 'pg_catalog', 'pg_temp'
      AS $pwsfn$
        DECLARE
          v_name   text;
          v_status text;
          v_owner  text;
        BEGIN
          IF p_workspace_id IS NULL THEN
            RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
          END IF;

          v_name := 'workspace_' || replace(p_workspace_id::text, '-', '');
          IF v_name !~ '^workspace_[0-9a-f]{32}$' THEN
            RAISE EXCEPTION 'derived schema name failed canonical check' USING ERRCODE = '22023';
          END IF;

          SELECT w.schema_status INTO v_status
            FROM core.manager_workspace w
           WHERE w.id = p_workspace_id
             FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
          END IF;
          IF v_status IS NULL THEN
            RAISE EXCEPTION 'workspace is not in a provisionable state' USING ERRCODE = '55000';
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = v_name) THEN
            EXECUTE format('CREATE SCHEMA %I AUTHORIZATION rab_owner', v_name);
          END IF;

          SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner
            FROM pg_catalog.pg_namespace n
           WHERE n.nspname = v_name;
          IF v_owner IS DISTINCT FROM 'rab_owner' THEN
            RAISE EXCEPTION 'existing schema is not owned by rab_owner' USING ERRCODE = '42501';
          END IF;

          EXECUTE format('GRANT USAGE ON SCHEMA %I TO rab_app', v_name);

          RETURN v_name;
        END;
        $pwsfn$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.provision_workspace_schema(uuid) OWNER TO rab_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace_schema(uuid) TO rab_app;`);

    await queryRunner.query(`DROP ROLE IF EXISTS rab_secure_owner;`);
    await queryRunner.query(`DROP ROLE IF EXISTS crewflow;`);
  }
}

/**
 * Fails closed: refuses to run under `crewflow` (or any other non-bootstrap role) rather than
 * silently skip the ownership-tightening statements or error midway through with a confusing
 * partial-privilege message. Checks for superuser OR CREATEROLE (the latter covers a managed
 * provider's highest-privilege role, which may not expose true Postgres superuser) — see the class
 * doc comment's "HOW TO RUN THIS MIGRATION" section for which concrete credential satisfies this
 * locally.
 */
async function assertBootstrapPrivilege(queryRunner: QueryRunner): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolsuper: boolean; rolcreaterole: boolean; rolname: string }>;
  const [row] = rows;
  if (!row || !(row.rolsuper || row.rolcreaterole)) {
    throw new Error(
      `CrewflowSingleCredentialRoleArchitecture1786682000000 refuses to run as '${row?.rolname ?? 'unknown'}': ` +
        `this migration performs ALTER TABLE/FUNCTION ... OWNER TO rab_secure_owner, which requires the ` +
        `connecting role to be a superuser or have CREATEROLE. Re-run with DATABASE_URL pointed at the ` +
        `privileged bootstrap connection documented in this migration's own header comment — never the ` +
        `ordinary crewflow runtime credential.`,
    );
  }
}

function requireBootstrapPassword(): string {
  const password = process.env.CREWFLOW_BOOTSTRAP_PASSWORD;
  if (!password) {
    throw new Error(
      'CREWFLOW_BOOTSTRAP_PASSWORD is required to run CrewflowSingleCredentialRoleArchitecture1786682000000 ' +
        '— refusing to create or reset the crewflow login role with no password, or a hardcoded one.',
    );
  }
  if (/[^A-Za-z0-9!@#$%^&*_\-+=.]/.test(password)) {
    throw new Error(
      'CREWFLOW_BOOTSTRAP_PASSWORD contains a character that could break out of the single-quoted literal ' +
        'this migration inlines it into — use only letters, digits, and !@#$%^&*_-+=. .',
    );
  }
  return password;
}
