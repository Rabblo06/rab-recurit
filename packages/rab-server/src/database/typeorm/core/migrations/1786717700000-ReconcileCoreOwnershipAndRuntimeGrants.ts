import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fresh-install correctness: CF-09, CF-41 residue, CF-42 and the PUBLIC part of CF-13 (October 15 master audit).
 *
 * Evidence (two brand-new clusters built from migrations only, 2026-10-15):
 *   - Built `rab_owner` → bootstrap (the only sequence that yields a working database), the result matches the long-lived
 *     test database EXCEPT that `crewflow_app` cannot EXECUTE `core.auth_find_session_by_web_token_hash(text)`. Every
 *     cookie-authenticated request then fails with 503. The test database only works because that grant was hand-applied
 *     (CF-09). The same build leaves 5 tables and 9 functions owned by the bootstrap superuser, including the SECURITY
 *     DEFINER `mark_workspace_schema_superseded`, which therefore runs with superuser authority (CF-41, CF-13).
 *   - 5 SECURITY DEFINER functions keep PostgreSQL's default PUBLIC EXECUTE (CF-13).
 *   - `crewflow_app` holds UPDATE/DELETE on `core.permission` and DML on `core.migrations` (CF-42). Runtime only ever
 *     INSERTs missing permission keys (the seed CLI); it never renames or deletes one, and never writes the ledger.
 *   - Development databases also showed drift that this migration removes: `crewflow_app` with UPDATE/DELETE on the
 *     insert-only `core.audit_log`, and with EXECUTE on the provisioner-only workspace-schema functions.
 *
 * What it does (idempotent; every statement is a no-op where the catalog is already correct):
 *   1. Ownership. The 12 pre-auth tables (`NOT_FORCED_ALLOWLIST` ∪ {organisation, platform_admin}) stay owned by
 *      `rab_secure_owner`. Every other `core` relation becomes owned by `crewflow`. Every non-DEFINER `core` function becomes
 *      owned by `crewflow`. `worker_cleanup_oauth_transaction_state` (DEFINER over a `crewflow` table) stays `crewflow`. Every
 *      other DEFINER function, including `mark_workspace_schema_superseded`, becomes owned by `rab_secure_owner`, like its
 *      sibling `mark_workspace_schema_failed`. Schema `core` is owned by `crewflow`. Nothing ends up owned by a superuser.
 *   2. Grants. EXECUTE on the cookie-session lookup to `crewflow_app` (CF-09). PUBLIC EXECUTE revoked from every DEFINER
 *      function, with the five that relied on it granted explicitly to `crewflow` and `crewflow_app` (the only roles that
 *      call them). UPDATE/DELETE on `permission` and all DML on `migrations` revoked from `crewflow_app`. UPDATE, DELETE and
 *      TRUNCATE on `audit_log` revoked from both roles. Provisioner-only functions revoked from `crewflow_app`.
 *   3. Verification. The migration then re-reads the catalog and RAISES (rolling back everything) if any expectation is not
 *      met. A GRANT that PostgreSQL silently turns into a WARNING can therefore never be recorded as applied (CF-41).
 *
 * Authority: it changes the owner of objects owned by `rab_secure_owner`, `crewflow` and possibly a superuser, so the
 * connecting role must be able to act as each current owner and each new owner. It checks that up front, per object, and
 * refuses with the list of objects it cannot reconcile. It never grants anything to a LOGIN role beyond the reference model,
 * never touches RLS, and never adds BYPASSRLS.
 *
 * down(): intentionally a no-op. Restoring superuser ownership, PUBLIC EXECUTE or runtime DML on the ledger would re-create
 * the defects; the corrected state is the intended state documented in the role architecture.
 */
const SECURE_TABLES = [
  'account_invite',
  'login_history',
  'manager_workspace',
  'member_invitation',
  'organisation',
  'password_reset_token',
  'platform_admin',
  'refresh_token',
  'user',
  'user_auth_identity',
  'user_session',
  'worker_due_work',
];

/** SECURITY DEFINER functions owned by `crewflow` by design (they act only on `crewflow`-owned tables). */
const CREWFLOW_DEFINER_FUNCTIONS = ['worker_cleanup_oauth_transaction_state(integer)'];

/** DEFINER functions that relied on PUBLIC EXECUTE; called by the API/worker (`crewflow_app`) and by CLIs (`crewflow`). */
const FORMERLY_PUBLIC_FUNCTIONS = [
  'auth_find_password_hash_by_user_id(uuid)',
  'audit_existing_user_ids(uuid[])',
  'organisation_is_suspended(uuid)',
  'create_organisation(text,citext)',
  'list_organisations_for_admin()',
];

/** Workspace-schema lifecycle functions only the provisioner (`crewflow`) may run. */
const PROVISIONER_ONLY_FUNCTIONS = [
  'provision_workspace_schema(uuid)',
  'register_workspace_schema(uuid)',
  'mark_workspace_schema_ready(uuid,integer)',
  'mark_workspace_schema_failed(uuid,text)',
  'begin_workspace_schema_attempt(uuid)',
  'worker_list_pending_workspace_schemas(integer)',
  'worker_resolve_workspace_organisation(uuid)',
];

/** Runtime functions `crewflow_app` must be able to EXECUTE (the API and worker fail closed without them). */
const REQUIRED_RUNTIME_FUNCTIONS = [
  'auth_find_session_by_web_token_hash(text)',
  'worker_cleanup_oauth_transaction_state(integer)',
  ...FORMERLY_PUBLIC_FUNCTIONS,
];

const sqlList = (items: string[]) => items.map((i) => `'${i}'`).join(', ');

export class ReconcileCoreOwnershipAndRuntimeGrants1786717700000 implements MigrationInterface {
  name = 'ReconcileCoreOwnershipAndRuntimeGrants1786717700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0. Authority, per object, before anything changes.
    await queryRunner.query(`
      DO $authority$
      DECLARE
        v_missing text;
      BEGIN
        WITH wanted AS (
          SELECT format('table %s', c.oid::regclass) AS obj, c.relowner AS cur,
                 CASE WHEN c.relname = ANY (ARRAY[${sqlList(SECURE_TABLES)}]) THEN 'rab_secure_owner' ELSE 'crewflow' END AS tgt
            FROM pg_class c
           WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          UNION ALL
          SELECT format('function %s', p.oid::regprocedure), p.proowner,
                 CASE WHEN NOT p.prosecdef THEN 'crewflow'
                      WHEN replace(p.oid::regprocedure::text, 'core.', '') = ANY (ARRAY[${sqlList(CREWFLOW_DEFINER_FUNCTIONS)}]) THEN 'crewflow'
                      ELSE 'rab_secure_owner' END
            FROM pg_proc p
           WHERE p.pronamespace = 'core'::regnamespace
          UNION ALL
          SELECT 'schema core', n.nspowner, 'crewflow' FROM pg_namespace n WHERE n.nspname = 'core'
        )
        SELECT string_agg(obj, ', ' ORDER BY obj) INTO v_missing
          FROM wanted
         WHERE pg_get_userbyid(cur) <> tgt
           AND NOT (pg_has_role(current_user, cur, 'USAGE') AND pg_has_role(current_user, tgt, 'USAGE'));
        IF v_missing IS NOT NULL THEN
          RAISE EXCEPTION 'ReconcileCoreOwnershipAndRuntimeGrants1786717700000 refuses to run as %: it cannot act as the current and the intended owner of: %. Run it with the privileged bootstrap connection.',
            current_user, v_missing USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);

    // 1. Ownership.
    await queryRunner.query(`
      DO $owners$
      DECLARE
        r record;
      BEGIN
        -- Schema first: a non-superuser can only hand an object to a role that has CREATE on its schema.
        IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'core') <> 'crewflow' THEN
          ALTER SCHEMA core OWNER TO crewflow;
        END IF;

        FOR r IN
          SELECT c.oid::regclass AS rel, c.relkind,
                 CASE WHEN c.relname = ANY (ARRAY[${sqlList(SECURE_TABLES)}]) THEN 'rab_secure_owner' ELSE 'crewflow' END AS tgt
            FROM pg_class c
           WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
             AND pg_get_userbyid(c.relowner) <> CASE WHEN c.relname = ANY (ARRAY[${sqlList(SECURE_TABLES)}]) THEN 'rab_secure_owner' ELSE 'crewflow' END
             -- An identity/serial sequence follows its table's owner automatically.
             AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
        LOOP
          EXECUTE format('ALTER %s %s OWNER TO %I',
            CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.rel, r.tgt);
        END LOOP;

        FOR r IN
          SELECT p.oid::regprocedure AS fn,
                 CASE WHEN NOT p.prosecdef THEN 'crewflow'
                      WHEN replace(p.oid::regprocedure::text, 'core.', '') = ANY (ARRAY[${sqlList(CREWFLOW_DEFINER_FUNCTIONS)}]) THEN 'crewflow'
                      ELSE 'rab_secure_owner' END AS tgt,
                 p.proowner
            FROM pg_proc p
           WHERE p.pronamespace = 'core'::regnamespace
        LOOP
          IF pg_get_userbyid(r.proowner) <> r.tgt THEN
            EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.fn, r.tgt);
          END IF;
        END LOOP;
      END
      $owners$;
    `);

    // 2. Grants.
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_session_by_web_token_hash(text) TO crewflow_app`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_cleanup_oauth_transaction_state(integer) TO crewflow_app`);
    await queryRunner.query(`
      DO $public$
      DECLARE
        r record;
      BEGIN
        FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
        END LOOP;
      END
      $public$;
    `);
    for (const fn of FORMERLY_PUBLIC_FUNCTIONS) {
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow, crewflow_app`);
    }
    for (const fn of PROVISIONER_ONLY_FUNCTIONS) {
      await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.${fn} FROM crewflow_app`);
    }
    // The permission catalog is extended at runtime by the seed CLI (missing PermissionFlag keys are INSERTed), so INSERT
    // stays. Renaming or deleting a key that RLS predicates match on is the risk (CF-42): UPDATE/DELETE/TRUNCATE go.
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON core.permission FROM crewflow_app`);
    await queryRunner.query(`GRANT SELECT, INSERT ON core.permission TO crewflow_app`);
    await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON core.migrations FROM crewflow_app`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON core.audit_log FROM crewflow, crewflow_app`);

    // 3. Verification: refuse to be recorded as applied unless the catalog now matches.
    await queryRunner.query(`
      DO $verify$
      DECLARE
        v text;
      BEGIN
        SELECT string_agg(x, '; ') INTO v FROM (
          SELECT format('%s owned by superuser %s', c.oid::regclass, pg_get_userbyid(c.relowner)) AS x
            FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
           WHERE c.relnamespace = 'core'::regnamespace AND o.rolsuper
          UNION ALL
          SELECT format('%s owned by superuser %s', p.oid::regprocedure, pg_get_userbyid(p.proowner))
            FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
           WHERE p.pronamespace = 'core'::regnamespace AND o.rolsuper
          UNION ALL
          SELECT format('%s is SECURITY DEFINER and PUBLIC-executable', p.oid::regprocedure)
            FROM pg_proc p
           WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
             AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
          UNION ALL
          SELECT format('crewflow_app lacks EXECUTE on core.%s', f)
            FROM unnest(ARRAY[${sqlList(REQUIRED_RUNTIME_FUNCTIONS)}]) f
           WHERE NOT has_function_privilege('crewflow_app', 'core.' || f, 'EXECUTE')
          UNION ALL
          SELECT format('crewflow_app may EXECUTE provisioner-only core.%s', f)
            FROM unnest(ARRAY[${sqlList(PROVISIONER_ONLY_FUNCTIONS)}]) f
           WHERE has_function_privilege('crewflow_app', 'core.' || f, 'EXECUTE')
          UNION ALL
          SELECT format('%s may %s core.%s', r, priv, t)
            FROM unnest(ARRAY['crewflow', 'crewflow_app']) r
            CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) priv
            CROSS JOIN (VALUES ('audit_log')) AS tt(t)
           WHERE has_table_privilege(r, 'core.' || t, priv)
          UNION ALL
          SELECT format('crewflow_app may %s core.%s', priv, t)
            FROM (VALUES ('permission', 'UPDATE'), ('permission', 'DELETE'), ('permission', 'TRUNCATE'),
                         ('migrations', 'INSERT'), ('migrations', 'UPDATE'), ('migrations', 'DELETE'), ('migrations', 'TRUNCATE')) AS pp(t, priv)
           WHERE has_table_privilege('crewflow_app', 'core.' || t, priv)
          UNION ALL
          SELECT format('crewflow_app lacks %s on user_session.idle_expires_at (session issuance would fail)', priv)
            FROM unnest(ARRAY['INSERT', 'UPDATE']) priv
           WHERE NOT has_column_privilege('crewflow_app', 'core.user_session', 'idle_expires_at', priv)
          UNION ALL
          -- Reference DML for the runtime role on ordinary (crewflow-owned) tables. A chain migrated only by a superuser
          -- leaves these empty, which no ownership change can repair: that build is refused here instead of recorded.
          SELECT format('crewflow_app lacks %s on %s', priv, c.oid::regclass)
            FROM pg_class c
            CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) priv
           WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p')
             AND NOT (c.relname = ANY (ARRAY[${sqlList(SECURE_TABLES)}]))
             AND NOT (c.relname = 'migrations' AND priv <> 'SELECT')
             AND NOT (c.relname = 'permission' AND priv IN ('UPDATE', 'DELETE'))
             AND NOT (c.relname = 'audit_log' AND priv IN ('UPDATE', 'DELETE'))
             AND NOT (c.relname = 'oauth_transaction_state' AND priv = 'DELETE')
             AND NOT has_table_privilege('crewflow_app', c.oid, priv)
          UNION ALL
          SELECT format('role %s is SUPERUSER or BYPASSRLS', rolname)
            FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app') AND (rolsuper OR rolbypassrls)
        ) problems;
        IF v IS NOT NULL THEN
          RAISE EXCEPTION 'ReconcileCoreOwnershipAndRuntimeGrants1786717700000 verification failed: %', v USING ERRCODE = 'invalid_grant_operation';
        END IF;
      END
      $verify$;
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op; see the class comment.
  }
}
