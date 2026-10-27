import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crewflow Platform Admin Panel (Phase A plan §4 migration 1, docs/admin-panel/PHASE_A_PLAN.md): five narrow, read-only,
 * platform-admin-gated SECURITY DEFINER functions for the panel's cross-organisation reads. Since the 2026-10-15
 * organisation-isolation hardening a platform administrator has NO blanket RLS visibility; these functions are the only
 * cross-tenant read path the panel adds. They never write.
 *
 * Every function:
 *   - is owned by `rab_secure_owner` (NOLOGIN; owner of the NOT-FORCE identity tables `user`, `user_session`,
 *     `platform_admin`, `organisation`, `manager_workspace`, `user_mfa_recovery_code`, `login_history`), SECURITY DEFINER,
 *     `SET search_path = pg_catalog, pg_temp` with every object schema-qualified;
 *   - has `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO crewflow_app` only (not crewflow: no CLI caller);
 *   - starts by raising SQLSTATE 42501 unless `core.is_active_platform_admin(core.current_uid())` — so an unbound or
 *     non-admin caller gets an error, never rows (fail closed), whatever the service layer did;
 *   - returns a FIXED column set: ids, names, emails, statuses, counts and timestamps. Never a password/temporary-password
 *     hash, a TOTP secret, a recovery-code hash, a token or token hash, an IP address, a user agent, an email body or a
 *     job payload. `admin_search_users` returns whether 2FA is on, when it was turned on and how many recovery codes are
 *     unused (owner policy 2026-10-24: 2FA is optional; the panel only SHOWS the state);
 *   - bounds its page: ≤25 rows for user search, ≤50 for every list.
 *
 * FORCE-RLS tables (`audit_log`, `workspace_schema_registry`) stay FORCEd: the functions read them by binding ONE target
 * organisation at a time (`set_config('rab.organisation_id', …, true)`, the `revokeSessionsForPrivilegedGrant` /
 * register-function precedent) and restore the caller's binding before returning. No BYPASSRLS, no FORCE change, no
 * policy change. `rab_secure_owner` gains `SELECT` on `core.audit_log` (it had none; precedent
 * SecureOwnerManagerProfileSelectGrant1786709000000) — still subject to `audit_log_tenant` because the table is FORCEd.
 *
 * Audit timeline allowlist: only the platform-admin actions below are ever returned (frozen here; the service has the
 * same list in `admin-panel-audit-actions.ts`, and a unit test asserts they are identical). `user.invite_resent` is
 * returned only when the row says `via = platform_admin` (the CEO-invite resend from the panel).
 *
 * Verification block at the end refuses the migration on drift (owner, definer, search_path, PUBLIC execute,
 * crewflow_app execute, and that an unbound caller is refused with 42501).
 * Dev/test only: NOT in production-migration-approval.ts (N1).
 */
export const ADMIN_AUDIT_ACTIONS_1786720100000: readonly string[] = [
  'platform_admin.granted',
  'platform_admin.revoked',
  'platform_admin.bootstrapped',
  'organisation.suspended',
  'organisation.reactivated',
  'organisation_invitation.sent',
  'organisation_invitation.resent',
  'organisation_invitation.revoked',
  'admin.inspect_started',
  'admin.inspect_ended',
  'admin.inspect_mutation_refused',
  'user.mfa_reset_by_admin',
  'user.mfa_reset_refused',
  'platform_config.smtp_updated',
  'platform_config.maintenance_mode_changed',
  'email.replay_requested',
  'admin.sessions_revoked',
  'admin.queue_jobs_retried',
  'admin.queue_jobs_deleted',
  'admin.user_searched',
  'admin.user_viewed',
  'admin.organisation_searched',
  'admin.test_email_sent',
  'admin.email_replay_reason',
];
/** Returned only when `metadata->>'via' = 'platform_admin'` (the same action is also written by tenant managers). */
export const ADMIN_AUDIT_VIA_ACTIONS_1786720100000: readonly string[] = ['user.invite_resent'];

export const ADMIN_READ_FUNCTIONS_1786720100000: readonly string[] = [
  'admin_platform_overview()',
  'admin_search_users(text,text,integer)',
  'admin_list_platform_admins()',
  'admin_list_workspace_schemas(text,uuid,timestamp with time zone,uuid,integer)',
  'admin_list_audit_events(text[],uuid,timestamp with time zone,uuid,integer)',
];

/** Role filter values (system role keys) for the User security table, plus the platform-admin pseudo-role. */
export const ADMIN_USER_ROLE_FILTERS_1786720100000: readonly string[] = ['ceo', 'org_admin', 'manager', 'venue_manager', 'staff', 'platform_admin'];

/** Shared match predicate / kind of admin_search_users (empty query = every user, newest first). */
const MATCH = `(
                 v_q = ''
                 OR (v_id IS NOT NULL AND u.id = v_id)
                 OR (v_id IS NULL AND (
                       lower(u.email::text) LIKE v_like ESCAPE '\\'
                       OR lower(u.first_name) LIKE v_like ESCAPE '\\'
                       OR lower(u.last_name) LIKE v_like ESCAPE '\\'
                       OR lower(u.first_name || ' ' || u.last_name) LIKE v_like ESCAPE '\\')))`;
const MATCH_KIND = `CASE WHEN v_q = '' THEN 'recent' WHEN v_id IS NOT NULL THEN 'id' WHEN lower(u.email::text) = lower(v_q) THEN 'email' ELSE 'prefix' END`;

const sqlTextArray = (values: readonly string[]) => `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')}]::text[]`;

const GATE = (fn: string) => `
        IF core.current_uid() IS NULL OR NOT core.is_active_platform_admin(core.current_uid()) THEN
          RAISE EXCEPTION '${fn}: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;`;

/** Fixed labels / SQLSTATEs pass through; anything that looks like free text becomes UNCLASSIFIED (no raw error text). */
const SAFE_ERROR = (expr: string) => `CASE WHEN ${expr} IS NULL THEN NULL WHEN ${expr} ~ '^[A-Za-z0-9_.:/() -]{1,120}$' THEN ${expr} ELSE 'UNCLASSIFIED' END`;

export class AdminPanelReadFunctions1786720100000 implements MigrationInterface {
  name = 'AdminPanelReadFunctions1786720100000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`GRANT SELECT ON core.audit_log TO rab_secure_owner;`);

    // ── 1. Platform overview: counts only ─────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.admin_platform_overview()
      RETURNS TABLE (
        "organisationsTotal" integer, "organisationsSuspended" integer,
        "usersTotal" integer, "usersSignedIn7d" integer,
        "activeSessions" integer, "platformAdminSessionsToday" integer, "platformAdminsActive" integer,
        "workspacesReady" integer, "workspacesCreating" integer, "workspacesFailed" integer, "workspacesOther" integer
      )
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN${GATE('admin_platform_overview')}
        RETURN QUERY SELECT
          (SELECT count(*)::integer FROM core.organisation),
          (SELECT count(*)::integer FROM core.organisation o WHERE o.suspended_at IS NOT NULL),
          (SELECT count(*)::integer FROM core."user" u WHERE u.deleted_at IS NULL),
          (SELECT count(*)::integer FROM core."user" u WHERE u.deleted_at IS NULL AND u.last_login_at >= now() - interval '7 days'),
          (SELECT count(*)::integer FROM core.user_session s
            WHERE s.revoked_at IS NULL AND s.absolute_expires_at > now() AND (s.idle_expires_at IS NULL OR s.idle_expires_at > now())),
          (SELECT count(*)::integer FROM core.user_session s JOIN core.platform_admin pa ON pa.user_id = s.user_id AND pa.revoked_at IS NULL
            WHERE s.created_at >= date_trunc('day', now())),
          (SELECT count(*)::integer FROM core.platform_admin pa WHERE pa.revoked_at IS NULL),
          (SELECT count(*)::integer FROM core.manager_workspace w WHERE w.schema_status = 'READY'),
          (SELECT count(*)::integer FROM core.manager_workspace w WHERE w.schema_status IN ('CREATING', 'MIGRATING')),
          (SELECT count(*)::integer FROM core.manager_workspace w WHERE w.schema_status = 'FAILED'),
          (SELECT count(*)::integer FROM core.manager_workspace w WHERE w.schema_status IS NULL OR w.schema_status = 'SUPERSEDED');
      END;
      $fn$;
    `);

    // ── 2. User search (empty query = most recent users; optional role filter) ─────────────────────────────────────────
    // Roles live in FORCE-RLS `user_role`/`role`: read with ONE organisation bound at a time (the row's own organisation).
    await runner.query(`
      CREATE FUNCTION core.admin_search_users(p_query text, p_role text, p_limit integer)
      RETURNS TABLE (
        "userId" uuid, "organisationId" uuid, "organisationName" text,
        "firstName" text, "lastName" text, "email" text, "status" text,
        "createdAt" timestamptz, "lastLoginAt" timestamptz,
        "totpEnabled" boolean, "mfaEnabledAt" timestamptz, "recoveryCodesRemaining" integer, "recoveryCodesTotal" integer,
        "isPlatformAdmin" boolean, "roleKeys" text[], "roleNames" text[], "matchKind" text
      )
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_q text := btrim(coalesce(p_query, ''));
        v_role text := nullif(btrim(coalesce(p_role, '')), '');
        v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
        v_like text;
        v_id uuid := CASE WHEN btrim(coalesce(p_query, '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN btrim(p_query)::uuid END;
        v_prev text := current_setting('rab.organisation_id', true);
        v_ids jsonb := '[]'::jsonb;
        v_part jsonb;
        v_org record;
        v_row jsonb;
        v_out jsonb := '[]'::jsonb;
        v_keys text[];
        v_names text[];
      BEGIN${GATE('admin_search_users')}
        IF v_q <> '' AND (char_length(v_q) < 3 OR char_length(v_q) > 200) THEN
          RAISE EXCEPTION 'admin_search_users: the query must be 3 to 200 characters' USING ERRCODE = '22023';
        END IF;
        IF v_role IS NOT NULL AND NOT (v_role = ANY (${sqlTextArray(ADMIN_USER_ROLE_FILTERS_1786720100000)})) THEN
          RAISE EXCEPTION 'admin_search_users: unknown role filter' USING ERRCODE = '22023';
        END IF;
        v_like := replace(replace(replace(lower(v_q), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%';
        IF v_role IS NULL OR v_role = 'platform_admin' THEN
          SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind)), '[]'::jsonb) INTO v_ids FROM (
            SELECT u.id, ${MATCH_KIND} AS kind
              FROM core."user" u
             WHERE u.deleted_at IS NULL AND ${MATCH}
               AND (v_role IS NULL OR EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id AND pa.revoked_at IS NULL))
             ORDER BY (CASE WHEN v_q <> '' AND lower(u.email::text) = lower(v_q) THEN 0 ELSE 1 END), u.created_at DESC, u.id
             LIMIT v_limit
          ) x;
        ELSE
          FOR v_org IN SELECT o.id FROM core.organisation o ORDER BY o.id LOOP
            PERFORM set_config('rab.organisation_id', v_org.id::text, true);
            SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind)), '[]'::jsonb) INTO v_part FROM (
              SELECT u.id, ${MATCH_KIND} AS kind
                FROM core."user" u
               WHERE u.organisation_id = v_org.id AND u.deleted_at IS NULL AND ${MATCH}
                 AND EXISTS (SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
                              WHERE ur.user_id = u.id AND ur.organisation_id = v_org.id AND r.key = v_role)
               ORDER BY u.created_at DESC, u.id
               LIMIT v_limit
            ) x;
            v_ids := v_ids || v_part;
          END LOOP;
        END IF;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_ids) LOOP
          PERFORM set_config('rab.organisation_id', coalesce((SELECT u.organisation_id::text FROM core."user" u WHERE u.id = (v_row->>'id')::uuid), ''), true);
          SELECT coalesce(array_agg(DISTINCT r.key), '{}'::text[]), coalesce(array_agg(DISTINCT r.name), '{}'::text[])
            INTO v_keys, v_names
            FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = (v_row->>'id')::uuid;
          v_out := v_out || jsonb_build_array(v_row || jsonb_build_object('role_keys', to_jsonb(v_keys[1:10]), 'role_names', to_jsonb(v_names[1:10])));
        END LOOP;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN QUERY
          SELECT u.id, u.organisation_id, o.name, u.first_name, u.last_name, u.email::text, u.status,
                 u.created_at, u.last_login_at,
                 coalesce(u.totp_enabled, false), u.mfa_enabled_at,
                 CASE WHEN coalesce(u.totp_enabled, false)
                      THEN (SELECT count(*)::integer FROM core.user_mfa_recovery_code c WHERE c.user_id = u.id AND c.used_at IS NULL)
                      ELSE 0 END,
                 CASE WHEN coalesce(u.totp_enabled, false)
                      THEN (SELECT count(*)::integer FROM core.user_mfa_recovery_code c WHERE c.user_id = u.id)
                      ELSE 0 END,
                 EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id AND pa.revoked_at IS NULL),
                 ARRAY(SELECT jsonb_array_elements_text(e->'role_keys')),
                 ARRAY(SELECT jsonb_array_elements_text(e->'role_names')),
                 e->>'kind'
            FROM jsonb_array_elements(v_out) e
            JOIN core."user" u ON u.id = (e->>'id')::uuid
            LEFT JOIN core.organisation o ON o.id = u.organisation_id
           ORDER BY (CASE WHEN e->>'kind' IN ('id', 'email') THEN 0 ELSE 1 END), u.created_at DESC, u.id
           LIMIT v_limit;
      END;
      $fn$;
    `);

    // ── 3. Active platform administrators ─────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.admin_list_platform_admins()
      RETURNS TABLE (
        "userId" uuid, "firstName" text, "lastName" text, "email" text,
        "organisationId" uuid, "organisationName" text, "totpEnabled" boolean,
        "grantedAt" timestamptz, "grantedBy" uuid, "grantedByFirstName" text, "grantedByLastName" text
      )
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN${GATE('admin_list_platform_admins')}
        RETURN QUERY
          SELECT pa.user_id, u.first_name, u.last_name, u.email::text, u.organisation_id, o.name,
                 coalesce(u.totp_enabled, false), pa.granted_at, pa.granted_by, g.first_name, g.last_name
            FROM core.platform_admin pa
            JOIN core."user" u ON u.id = pa.user_id
            LEFT JOIN core.organisation o ON o.id = u.organisation_id
            LEFT JOIN core."user" g ON g.id = pa.granted_by
           WHERE pa.revoked_at IS NULL
           -- The caller's own row first (so "you" is always present), then the most recently granted; ≤50 rows. The
           -- panel shows "N of M" from admin_platform_overview when there are more.
           ORDER BY (pa.user_id = core.current_uid()) DESC, pa.granted_at DESC, pa.user_id
           LIMIT 50;
      END;
      $fn$;
    `);

    // ── 4. Workspace schemas (manager_workspace + the FORCE-RLS registry, read one organisation at a time) ─────────────
    await runner.query(`
      CREATE FUNCTION core.admin_list_workspace_schemas(
        p_status text, p_organisation_id uuid, p_before_updated timestamptz, p_before_id uuid, p_limit integer
      )
      RETURNS TABLE (
        "workspaceId" uuid, "organisationId" uuid, "organisationName" text, "workspaceName" text,
        "schemaName" text, "schemaStatus" text, "schemaVersion" integer, "schemaError" text, "schemaMigratedAt" timestamptz,
        "updatedAt" timestamptz, "registryStatus" text, "moduleVersion" integer, "driftStatus" text, "registryError" text
      )
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
        v_prev text := current_setting('rab.organisation_id', true);
        v_rows jsonb;
        v_row jsonb;
        v_out jsonb := '[]'::jsonb;
        v_reg record;
      BEGIN${GATE('admin_list_workspace_schemas')}
        IF p_status IS NOT NULL AND p_status NOT IN ('CREATING', 'READY', 'MIGRATING', 'FAILED', 'SUPERSEDED') THEN
          RAISE EXCEPTION 'admin_list_workspace_schemas: unknown status' USING ERRCODE = '22023';
        END IF;
        IF (p_before_updated IS NULL) <> (p_before_id IS NULL) THEN
          RAISE EXCEPTION 'admin_list_workspace_schemas: incomplete cursor' USING ERRCODE = '22023';
        END IF;
        SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC, x.id DESC), '[]'::jsonb) INTO v_rows FROM (
          SELECT w.id, w.organisation_id, o.name AS organisation_name, w.name, w.schema_status, w.schema_version,
                 ${SAFE_ERROR('w.schema_last_error')} AS schema_error, w.schema_migrated_at, w.updated_at
            FROM core.manager_workspace w
            LEFT JOIN core.organisation o ON o.id = w.organisation_id
           WHERE (p_status IS NULL OR w.schema_status = p_status)
             AND (p_organisation_id IS NULL OR w.organisation_id = p_organisation_id)
             AND (p_before_updated IS NULL OR (w.updated_at, w.id) < (p_before_updated, p_before_id))
           ORDER BY w.updated_at DESC, w.id DESC
           LIMIT v_limit
        ) x;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
          -- The registry is FORCE RLS (organisation_id = current_org()): bind THIS row's organisation for the lookup only.
          PERFORM set_config('rab.organisation_id', v_row->>'organisation_id', true);
          SELECT r.schema_name, r.status, r.module_version, r.drift_status, ${SAFE_ERROR('r.migration_error')} AS migration_error
            INTO v_reg
            FROM core.workspace_schema_registry r WHERE r.workspace_id = (v_row->>'id')::uuid;
          v_out := v_out || jsonb_build_array(v_row || jsonb_build_object(
            'registry_schema_name', v_reg.schema_name, 'registry_status', v_reg.status, 'module_version', v_reg.module_version,
            'drift_status', v_reg.drift_status, 'registry_error', v_reg.migration_error));
        END LOOP;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN QUERY
          SELECT (e->>'id')::uuid, (e->>'organisation_id')::uuid, e->>'organisation_name', e->>'name',
                 coalesce(e->>'registry_schema_name', 'workspace_' || replace(e->>'id', '-', '')),
                 e->>'schema_status', (e->>'schema_version')::integer, e->>'schema_error', (e->>'schema_migrated_at')::timestamptz,
                 (e->>'updated_at')::timestamptz, e->>'registry_status', (e->>'module_version')::integer, e->>'drift_status',
                 e->>'registry_error'
            FROM jsonb_array_elements(v_out) e;
      END;
      $fn$;
    `);

    // ── 5. Admin audit timeline (fixed action allowlist, keyset pages ≤50, one organisation bound at a time) ────────────
    await runner.query(`
      CREATE FUNCTION core.admin_list_audit_events(
        p_actions text[], p_user uuid, p_before_created timestamptz, p_before_id uuid, p_limit integer
      )
      RETURNS TABLE (
        "id" uuid, "organisationId" uuid, "organisationName" text, "action" text,
        "actorUserId" uuid, "actorFirstName" text, "actorLastName" text,
        "targetUserId" uuid, "targetFirstName" text, "targetLastName" text,
        "entityType" text, "entityId" uuid, "createdAt" timestamptz, "reason" text, "detail" jsonb
      )
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_allowed constant text[] := ${sqlTextArray(ADMIN_AUDIT_ACTIONS_1786720100000)};
        v_via constant text[] := ${sqlTextArray(ADMIN_AUDIT_VIA_ACTIONS_1786720100000)};
        v_actions text[];
        v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
        v_prev text := current_setting('rab.organisation_id', true);
        v_org record;
        v_acc jsonb := '[]'::jsonb;
        v_part jsonb;
      BEGIN${GATE('admin_list_audit_events')}
        IF p_actions IS NULL OR cardinality(p_actions) = 0 THEN
          v_actions := v_allowed || v_via;
        ELSIF NOT (p_actions <@ (v_allowed || v_via)) THEN
          RAISE EXCEPTION 'admin_list_audit_events: action outside the admin allowlist' USING ERRCODE = '22023';
        ELSE
          v_actions := p_actions;
        END IF;
        IF (p_before_created IS NULL) <> (p_before_id IS NULL) THEN
          RAISE EXCEPTION 'admin_list_audit_events: incomplete cursor' USING ERRCODE = '22023';
        END IF;
        FOR v_org IN SELECT o.id, o.name FROM core.organisation o ORDER BY o.id LOOP
          -- audit_log is FORCE RLS (organisation_id = current_org()): read one organisation's rows at a time.
          PERFORM set_config('rab.organisation_id', v_org.id::text, true);
          SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_part FROM (
            SELECT a.id, a.organisation_id, v_org.name AS organisation_name, a.action, a.actor_user_id, a.target_user_id,
                   a.entity_type, a.entity_id, a.created_at,
                   left(a.metadata->>'reason', 500) AS reason,
                   jsonb_strip_nulls(jsonb_build_object(
                     'queue', CASE WHEN a.metadata->>'queue' ~ '^[a-z0-9:-]{1,64}$' THEN a.metadata->>'queue' END,
                     'count', CASE WHEN jsonb_typeof(a.metadata->'count') = 'number' THEN a.metadata->'count' END,
                     'resultCount', CASE WHEN jsonb_typeof(a.metadata->'resultCount') = 'number' THEN a.metadata->'resultCount' END,
                     'revokedSessions', CASE WHEN jsonb_typeof(a.metadata->'revokedSessions') = 'number' THEN a.metadata->'revokedSessions' END,
                     'enabled', CASE WHEN jsonb_typeof(a.metadata->'enabled') = 'boolean' THEN a.metadata->'enabled' END,
                     'kind', CASE WHEN a.metadata->>'kind' ~ '^[a-z_]{1,32}$' THEN a.metadata->>'kind' END,
                     'refusal', CASE WHEN a.metadata->>'refusal' ~ '^[a-z_]{1,64}$' THEN a.metadata->>'refusal' END
                   )) AS detail
              FROM core.audit_log a
             WHERE a.organisation_id = v_org.id
               AND a.action = ANY (v_actions)
               AND (NOT (a.action = ANY (v_via)) OR a.metadata->>'via' = 'platform_admin')
               AND (p_user IS NULL OR a.actor_user_id = p_user OR a.target_user_id = p_user)
               AND (p_before_created IS NULL OR (a.created_at, a.id) < (p_before_created, p_before_id))
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT v_limit
          ) x;
          v_acc := v_acc || v_part;
        END LOOP;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN QUERY
          SELECT (e->>'id')::uuid, (e->>'organisation_id')::uuid, e->>'organisation_name', e->>'action',
                 (e->>'actor_user_id')::uuid, au.first_name, au.last_name,
                 (e->>'target_user_id')::uuid, tu.first_name, tu.last_name,
                 e->>'entity_type', (e->>'entity_id')::uuid, (e->>'created_at')::timestamptz, e->>'reason', e->'detail'
            FROM jsonb_array_elements(v_acc) e
            LEFT JOIN core."user" au ON au.id = (e->>'actor_user_id')::uuid
            LEFT JOIN core."user" tu ON tu.id = (e->>'target_user_id')::uuid
           ORDER BY (e->>'created_at')::timestamptz DESC, (e->>'id')::uuid DESC
           LIMIT v_limit;
      END;
      $fn$;
    `);

    // Owner stated explicitly per object (migration-object-ownership.spec.ts reads these literally).
    await runner.query(`ALTER FUNCTION core.admin_platform_overview() OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.admin_search_users(text,text,integer) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.admin_list_platform_admins() OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.admin_list_workspace_schemas(text,uuid,timestamptz,uuid,integer) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.admin_list_audit_events(text[],uuid,timestamptz,uuid,integer) OWNER TO rab_secure_owner;`);
    for (const fn of ADMIN_READ_FUNCTIONS_1786720100000) {
      await runner.query(`REVOKE ALL ON FUNCTION core.${fn} FROM PUBLIC;`);
      await runner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow_app;`);
    }

    await this.verify(runner);
  }

  public async down(runner: QueryRunner): Promise<void> {
    for (const fn of ADMIN_READ_FUNCTIONS_1786720100000) await runner.query(`DROP FUNCTION IF EXISTS core.${fn};`);
    await runner.query(`REVOKE SELECT ON core.audit_log FROM rab_secure_owner;`);
  }

  /** Refuses the migration if any function drifted from the contract above. */
  private async verify(runner: QueryRunner): Promise<void> {
    const rows: Array<{ sig: string; owner: string; definer: boolean; config: string[] | null; public_exec: boolean; app_exec: boolean; crewflow_exec: boolean }> =
      await runner.query(
        `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')) AS public_exec,
                has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_exec,
                has_function_privilege('crewflow', p.oid, 'EXECUTE') AS crewflow_exec
           FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'admin\\_%' AND p.proname <> 'admin_workspace_in_org'`,
      );
    const problems: string[] = [];
    for (const fn of ADMIN_READ_FUNCTIONS_1786720100000) {
      const row = rows.find((r) => r.sig === `core.${fn}`);
      if (!row) {
        problems.push(`${fn}: missing`);
        continue;
      }
      if (row.owner !== 'rab_secure_owner') problems.push(`${fn}: owner ${row.owner}`);
      if (!row.definer) problems.push(`${fn}: not SECURITY DEFINER`);
      if (!(row.config ?? []).includes('search_path=pg_catalog, pg_temp')) problems.push(`${fn}: search_path ${JSON.stringify(row.config)}`);
      if (row.public_exec) problems.push(`${fn}: PUBLIC may execute`);
      if (!row.app_exec) problems.push(`${fn}: crewflow_app may not execute`);
      if (row.crewflow_exec) problems.push(`${fn}: crewflow may execute (no CLI caller is intended)`);
    }
    // Unbound caller (no rab.user_id): every function must refuse with 42501, never return rows.
    for (const call of [
      'core.admin_platform_overview()',
      `core.admin_search_users('', NULL, 10)`,
      'core.admin_list_platform_admins()',
      'core.admin_list_workspace_schemas(NULL, NULL, NULL, NULL, 10)',
      'core.admin_list_audit_events(NULL, NULL, NULL, NULL, 10)',
    ]) {
      // A call that returns instead of raising 42501 throws P0001 out of the DO block and fails the migration.
      await runner.query(`
        DO $verify$
        BEGIN
          PERFORM set_config('rab.user_id', '', true);
          PERFORM * FROM ${call};
          RAISE EXCEPTION 'AdminPanelReadFunctions verification: unbound call to % returned rows instead of 42501', '${call.replace(/'/g, "''")}';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END
        $verify$;
      `);
    }
    if (problems.length > 0) throw new Error(`${this.name}: verification failed — ${problems.join('; ')}`);
  }
}
