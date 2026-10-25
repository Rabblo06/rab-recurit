import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Part A (docs/ai/PART_A_PLAN.md §3, owner decision 8): the schema a development run with a real model needs. Two
 * existing FORCE-RLS tables change; no table is created and no policy is loosened for the runtime role.
 *
 * 1. `core.ai_usage_daily` gains per-model rows and an estimated cost:
 *      - `model text NOT NULL` (catalogue id, same CHECK as `ai_message_model_check`). Rows that already exist (none on a
 *        database where AiPhase1Schema1786720220000 is applied in the same batch) get `legacy-unattributed`; the default
 *        is then dropped so every new row must name its model.
 *      - `cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (>= 0)`: estimated provider cost in integer micro-USD. It is NOT
 *        money in the payroll sense (no pence, no money.ts) — it is the meter behind AI_DAILY_BUDGET_USD.
 *      - the primary key becomes (organisation_id, usage_date, model). Choice (REAL_PROVIDER_PLAN conflict i): extend the
 *        table rather than add `ai_usage_model_daily`. Changing the PK is a new migration (the merged one is untouched),
 *        builds one small index and rewrites no heap; a second table would need its own RLS, grants, posture lines and a
 *        second write per turn. Every reader already aggregates (`sum(...)`), so the admin summary function is unchanged.
 *      - `crewflow_app` gains UPDATE on `cost_usd_micros` only (the counters it already had). `model` is never updatable.
 *
 * 2. `core.organisation_ai_setting` gains `synthetic_data boolean NOT NULL DEFAULT false`: the marker that lets a REAL
 *    provider answer this organisation in development (owner condition 5). Writable ONLY through
 *    `core.ai_dev_mark_organisation_synthetic(uuid)`:
 *      - SECURITY DEFINER, owned by `rab_secure_owner` (NOLOGIN; owner of `core.user`, which it must read), pinned
 *        search_path, EXECUTE for `crewflow` (the operator identity the `seed-ai-demo` command runs as) and nobody else —
 *        never `crewflow_app`, so no API or Worker request path can reach it;
 *      - refuses a database carrying the disposable-test marker (catalog value, not a session setting), an unknown
 *        organisation, and an organisation with no user or ANY user whose email is not `@example.test`;
 *      - sets only `synthetic_data` (never `enabled`: turning AI on stays a platform-admin action with step-up + reason).
 *    Column-level grants: `crewflow_app` loses its table-wide INSERT (which would have covered the new column) and gets
 *    INSERT on exactly the columns the admin switch writes; its UPDATE columns are unchanged, so it can neither insert nor
 *    update `synthetic_data`. Two new policies admit the definer's own write: `current_user = 'rab_secure_owner'` AND
 *    the transaction-local flag `rab.ai_synthetic_marker = on` AND the bound organisation. `crewflow_app` can set the flag
 *    but is never `rab_secure_owner`, and it has no column privilege anyway. FORCE RLS stays on both tables.
 *
 * 3. `core.ai_dev_synthetic_check()` (owner-approved Part A exception, re-verification before every real-provider request):
 *    a read-only definer about the BOUND organisation only, returning 'ok' or a fixed reason code. EXECUTE for crewflow_app.
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
const MARKER_FN = 'core.ai_dev_mark_organisation_synthetic(uuid)';
const MARKER_WRITE = `organisation_id = core.current_org() AND current_user = 'rab_secure_owner' AND current_setting('rab.ai_synthetic_marker', true) = 'on'`;

export class AiDevRealProvider1786720230000 implements MigrationInterface {
  name = 'AiDevRealProvider1786720230000';

  async up(runner: QueryRunner): Promise<void> {
    // ── 1. ai_usage_daily: per-model rows + estimated cost ──────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD COLUMN model text NOT NULL DEFAULT 'legacy-unattributed';`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ALTER COLUMN model DROP DEFAULT;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD CONSTRAINT ai_usage_daily_model_check CHECK (model ~ '^[a-z0-9][a-z0-9._-]{0,99}$');`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD COLUMN cost_usd_micros bigint NOT NULL DEFAULT 0;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD CONSTRAINT ai_usage_daily_cost_check CHECK (cost_usd_micros >= 0);`);
    await runner.query(`
      DO $pk$
      DECLARE v_name text;
      BEGIN
        SELECT conname INTO v_name FROM pg_constraint WHERE conrelid = 'core.ai_usage_daily'::regclass AND contype = 'p';
        IF v_name IS NULL THEN RAISE EXCEPTION 'AiDevRealProvider1786720230000: ai_usage_daily has no primary key'; END IF;
        EXECUTE format('ALTER TABLE core.ai_usage_daily DROP CONSTRAINT %I', v_name);
      END
      $pk$;
    `);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD CONSTRAINT ai_usage_daily_pkey PRIMARY KEY (organisation_id, usage_date, model);`);
    await runner.query(`GRANT UPDATE (cost_usd_micros) ON core.ai_usage_daily TO crewflow_app;`);

    // ── 2. organisation_ai_setting.synthetic_data (seed-only marker) ────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.organisation_ai_setting ADD COLUMN synthetic_data boolean NOT NULL DEFAULT false;`);
    // Table-wide INSERT would extend to the new column: replace it with the exact columns the admin switch writes.
    await runner.query(`REVOKE INSERT ON core.organisation_ai_setting FROM crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, enabled, updated_by, reason) ON core.organisation_ai_setting TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, synthetic_data, reason), UPDATE (synthetic_data, updated_at) ON core.organisation_ai_setting TO rab_secure_owner;`);
    await runner.query(`CREATE POLICY organisation_ai_setting_synthetic_marker_insert ON core.organisation_ai_setting FOR INSERT WITH CHECK (${MARKER_WRITE});`);
    await runner.query(`CREATE POLICY organisation_ai_setting_synthetic_marker_update ON core.organisation_ai_setting FOR UPDATE USING (${MARKER_WRITE}) WITH CHECK (${MARKER_WRITE});`);

    await runner.query(`
      CREATE FUNCTION core.ai_dev_mark_organisation_synthetic(p_organisation_id uuid)
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_prev   text := pg_catalog.current_setting('rab.organisation_id', true);
        v_users  integer;
        v_other  integer;
      BEGIN
        IF p_organisation_id IS NULL THEN
          RAISE EXCEPTION 'ai_dev_mark_organisation_synthetic: organisation required' USING ERRCODE = '22023';
        END IF;
        -- The DATABASE-level marker from the catalog (a session SET cannot fake it away): never on a disposable test database.
        IF EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
           WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 AND cfg = 'crewflow.disposable_test_database=true'
        ) THEN
          RAISE EXCEPTION 'ai_dev_mark_organisation_synthetic: refused on a disposable test database' USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM core.organisation o WHERE o.id = p_organisation_id) THEN
          RAISE EXCEPTION 'ai_dev_mark_organisation_synthetic: organisation not found' USING ERRCODE = 'P0002';
        END IF;
        SELECT count(*)::integer, count(*) FILTER (WHERE pg_catalog.lower(u.email::text) NOT LIKE '%@example.test')::integer
          INTO v_users, v_other
          FROM core."user" u WHERE u.organisation_id = p_organisation_id;
        IF v_users = 0 OR v_other > 0 THEN
          RAISE EXCEPTION 'ai_dev_mark_organisation_synthetic: every user of a synthetic organisation must have an @example.test address' USING ERRCODE = '55000';
        END IF;
        PERFORM pg_catalog.set_config('rab.organisation_id', p_organisation_id::text, true);
        PERFORM pg_catalog.set_config('rab.ai_synthetic_marker', 'on', true);
        INSERT INTO core.organisation_ai_setting (organisation_id, synthetic_data, reason)
        VALUES (p_organisation_id, true, 'seed-ai-demo: synthetic development data')
        ON CONFLICT (organisation_id) DO UPDATE SET synthetic_data = true, updated_at = pg_catalog.now();
        PERFORM pg_catalog.set_config('rab.ai_synthetic_marker', '', true);
        PERFORM pg_catalog.set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN true;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_dev_mark_organisation_synthetic(uuid) OWNER TO rab_secure_owner;`);
    await runner.query(`REVOKE ALL ON FUNCTION ${MARKER_FN} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON FUNCTION ${MARKER_FN} FROM crewflow_app;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION ${MARKER_FN} TO crewflow;`);

    // Owner-approved Part A exception, control (a): re-verified IMMEDIATELY before every real-provider request, never cached.
    // The runtime role cannot see other users' rows under `user` RLS, so this narrow definer answers ONE question about the
    // BOUND organisation only (no parameter: no cross-tenant oracle): is it still marked synthetic, does it have users, and
    // is every user's address exactly `@example.test`, on a database without the disposable-test marker? It returns a
    // fixed reason code, never a row. STABLE, read-only.
    await runner.query(`
      CREATE FUNCTION core.ai_dev_synthetic_check()
      RETURNS text
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_org     uuid := core.current_org();
        v_synth   boolean;
        v_users   integer;
        v_other   integer;
      BEGIN
        IF v_org IS NULL THEN RETURN 'no_context'; END IF;
        SELECT s.synthetic_data INTO v_synth FROM core.organisation_ai_setting s WHERE s.organisation_id = v_org;
        IF v_synth IS DISTINCT FROM true THEN RETURN 'not_synthetic'; END IF;
        SELECT count(*)::integer, count(*) FILTER (WHERE pg_catalog.lower(u.email::text) NOT LIKE '%@example.test')::integer
          INTO v_users, v_other
          FROM core."user" u WHERE u.organisation_id = v_org;
        IF v_users = 0 THEN RETURN 'no_users'; END IF;
        IF v_other > 0 THEN RETURN 'non_synthetic_user'; END IF;
        IF EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
           WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 AND cfg = 'crewflow.disposable_test_database=true'
        ) THEN RETURN 'test_database'; END IF;
        RETURN 'ok';
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_dev_synthetic_check() OWNER TO rab_secure_owner;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_dev_synthetic_check() FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_dev_synthetic_check() TO crewflow_app, crewflow;`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname IN ('ai_usage_daily', 'organisation_ai_setting') AND c.relrowsecurity AND c.relforcerowsecurity
             AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         has_table_privilege('crewflow_app', 'core.organisation_ai_setting', 'INSERT') AS app_table_insert,
         has_column_privilege('crewflow_app', 'core.organisation_ai_setting', 'synthetic_data', 'INSERT') AS app_marker_insert,
         has_column_privilege('crewflow_app', 'core.organisation_ai_setting', 'synthetic_data', 'UPDATE') AS app_marker_update,
         has_column_privilege('crewflow_app', 'core.organisation_ai_setting', 'enabled', 'INSERT') AS app_enabled_insert,
         has_function_privilege('crewflow_app', '${MARKER_FN}', 'EXECUTE') AS app_marker_execute,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'model', 'UPDATE') AS app_model_update,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'cost_usd_micros', 'UPDATE') AS app_cost_update,
         has_table_privilege('crewflow_app', 'core.ai_usage_daily', 'DELETE') AS app_usage_delete,
         (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'rab_secure_owner' FROM pg_proc p WHERE p.oid = '${MARKER_FN}'::regprocedure) AS definer_ok,
         (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'rab_secure_owner' FROM pg_proc p WHERE p.oid = 'core.ai_dev_synthetic_check()'::regprocedure) AS check_definer_ok,
         has_function_privilege('crewflow_app', 'core.ai_dev_synthetic_check()', 'EXECUTE') AS app_check_execute,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean>>;
    if (
      check.forced !== 2 ||
      check.app_table_insert || check.app_marker_insert || check.app_marker_update || !check.app_enabled_insert ||
      check.app_marker_execute || check.app_model_update || !check.app_cost_update || check.app_usage_delete ||
      !check.definer_ok || !check.check_definer_ok || !check.app_check_execute || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_dev_synthetic_check();`);
    await runner.query(`DROP FUNCTION IF EXISTS ${MARKER_FN};`);
    await runner.query(`DROP POLICY IF EXISTS organisation_ai_setting_synthetic_marker_update ON core.organisation_ai_setting;`);
    await runner.query(`DROP POLICY IF EXISTS organisation_ai_setting_synthetic_marker_insert ON core.organisation_ai_setting;`);
    await runner.query(`REVOKE INSERT (organisation_id, synthetic_data, reason), UPDATE (synthetic_data, updated_at) ON core.organisation_ai_setting FROM rab_secure_owner;`);
    await runner.query(`REVOKE INSERT (organisation_id, enabled, updated_by, reason) ON core.organisation_ai_setting FROM crewflow_app;`);
    await runner.query(`GRANT INSERT ON core.organisation_ai_setting TO crewflow_app;`);
    await runner.query(`ALTER TABLE core.organisation_ai_setting DROP COLUMN synthetic_data;`);

    await runner.query(`REVOKE UPDATE (cost_usd_micros) ON core.ai_usage_daily FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP CONSTRAINT ai_usage_daily_pkey;`);
    // Fails loudly (duplicate key) if one organisation-day already has rows for two models: merging usage rows is a
    // deliberate operator decision, never a silent side effect of a rollback.
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD CONSTRAINT ai_usage_daily_pkey PRIMARY KEY (organisation_id, usage_date);`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP CONSTRAINT ai_usage_daily_cost_check;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP COLUMN cost_usd_micros;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP CONSTRAINT ai_usage_daily_model_check;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP COLUMN model;`);
  }
}
