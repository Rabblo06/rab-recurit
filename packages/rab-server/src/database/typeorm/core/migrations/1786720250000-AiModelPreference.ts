import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 1 "real models only" (docs/ai/PHASE1_TWENTY_PLAN.md §2.1 M2, C10 / C12 / D6): the organisation's model choice
 * per tier (Settings → AI, the CEO), in a table of its own.
 *
 * `core.organisation_ai_model_preference` (tenant-scoped, ENABLE + FORCE RLS in this migration, owner `crewflow`):
 *   - one row per (organisation, tier ∈ {fast, smart}); no row = "Choose automatically";
 *   - `model_id` is only a LOOKUP KEY into the code catalogue (format CHECK here; the service requires an AVAILABLE model
 *     of that tier on write, and the resolver re-validates it on every use, skipping a stale pin — the SDK only ever
 *     receives the catalogue's `providerModelId`, never this text);
 *   - `updated_by`, `reason` (3..500) and `updated_at` record who changed it and why (the audit row `ai.default_changed`
 *     is written in the same transaction by the service).
 *
 * Why NOT a column on `organisation_ai_setting`: that row is written only by an active platform administrator, at the RLS
 * and at the grant level (rule 1.2). A CEO UPDATE policy there would let RLS pass a CEO's write of `enabled`, because
 * `crewflow_app` holds UPDATE(enabled) and column grants are per role, not per user — the org switch would be protected
 * by application code alone.
 *
 * Policies (layers 4–5):
 *   SELECT                — `organisation_id = core.current_org()` (the bound organisation reads its own pins: availability,
 *                           submit and the Worker resolve the model from them);
 *   INSERT/UPDATE/DELETE  — additionally `core.ai_settings_writer()`: the bound user is the organisation's CEO
 *                           (`manager_profile.type = 'ceo'`, not archived); INSERT/UPDATE also require
 *                           `updated_by = core.current_uid()` (no forged author). A custom role carrying `ai.settings`
 *                           grants nothing to a non-CEO.
 * Grants to `crewflow_app`: SELECT; INSERT (organisation_id, tier, model_id, updated_by, reason); UPDATE (model_id,
 * updated_by, reason, updated_at); DELETE ("Choose automatically"). No TRUNCATE, no UPDATE of organisation_id or tier.
 *
 * `core.ai_settings_writer()`: SQL, STABLE, SECURITY INVOKER, `search_path = pg_catalog, pg_temp`, EXECUTE only for
 * `crewflow` and `crewflow_app`. A post-condition refuses to record the migration on drift (FORCE, owner, grants,
 * no BYPASSRLS on the runtime role).
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
const TABLE = 'core.organisation_ai_model_preference';
const ORG = `organisation_id = core.current_org()`;
const WRITER = `${ORG} AND core.ai_settings_writer()`;

export class AiModelPreference1786720250000 implements MigrationInterface {
  name = 'AiModelPreference1786720250000';

  async up(runner: QueryRunner): Promise<void> {
    // ── CEO-writer predicate (layer 5) ──────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_settings_writer()
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
        SELECT EXISTS (
          SELECT 1 FROM core.manager_profile mp
           WHERE mp.user_id = core.current_uid()
             AND mp.organisation_id = core.current_org()
             AND mp.archived_at IS NULL
             AND mp.type = 'ceo'
        )
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_settings_writer() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_settings_writer() FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_settings_writer() TO crewflow, crewflow_app;`);

    // ── organisation_ai_model_preference ────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE ${TABLE} (
        organisation_id uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        tier            text        NOT NULL,
        model_id        text        NOT NULL,
        updated_by      uuid        NOT NULL,
        reason          text        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_ai_model_preference_pkey PRIMARY KEY (organisation_id, tier),
        CONSTRAINT organisation_ai_model_preference_tier_check CHECK (tier IN ('fast', 'smart')),
        CONSTRAINT organisation_ai_model_preference_model_id_check CHECK (model_id ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
        CONSTRAINT organisation_ai_model_preference_reason_check CHECK (length(reason) BETWEEN 3 AND 500)
      );
    `);
    // Owner: crewflow, like every ordinary FORCE-RLS tenant table (phase-B migrations run as the bootstrap superuser, so
    // ownership is stated explicitly — migration-object-ownership.spec).
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);

    await runner.query(`CREATE POLICY organisation_ai_model_preference_read ON ${TABLE} FOR SELECT USING (${ORG});`);
    await runner.query(`CREATE POLICY organisation_ai_model_preference_ceo_insert ON ${TABLE} FOR INSERT WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_model_preference_ceo_update ON ${TABLE} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY organisation_ai_model_preference_ceo_delete ON ${TABLE} FOR DELETE USING (${WRITER});`);

    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, tier, model_id, updated_by, reason) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (model_id, updated_by, reason, updated_at) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT DELETE ON ${TABLE} TO crewflow_app;`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = 'organisation_ai_model_preference') AS forced,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'organisation_ai_model_preference')::int AS policies,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS app_select,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_table_privilege('crewflow_app', '${TABLE}', 'INSERT') AS app_table_insert,
         has_column_privilege('crewflow_app', '${TABLE}', 'model_id', 'INSERT') AS app_insert_model,
         has_column_privilege('crewflow_app', '${TABLE}', 'created_at', 'INSERT') AS app_insert_created,
         has_column_privilege('crewflow_app', '${TABLE}', 'model_id', 'UPDATE') AS app_update_model,
         has_column_privilege('crewflow_app', '${TABLE}', 'organisation_id', 'UPDATE') AS app_update_org,
         has_column_privilege('crewflow_app', '${TABLE}', 'tier', 'UPDATE') AS app_update_tier,
         has_function_privilege('crewflow_app', 'core.ai_settings_writer()', 'EXECUTE') AS app_writer_execute,
         (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname = 'ai_settings_writer') AS writer_definer,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean>>;
    if (
      check.forced !== true || check.policies !== 4 || check.app_select !== true || check.app_delete !== true || check.app_truncate ||
      check.app_table_insert || check.app_insert_model !== true || check.app_insert_created || check.app_update_model !== true ||
      check.app_update_org || check.app_update_tier || check.app_writer_execute !== true || check.writer_definer || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_settings_writer();`);
  }
}
