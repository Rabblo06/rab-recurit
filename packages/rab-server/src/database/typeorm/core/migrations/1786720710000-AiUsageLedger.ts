import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 7 M7-2 (docs/ai/PHASE7_TWENTY_PLAN.md §2.3 / §4, C7-2, D7-3, D7-10): `core.ai_usage`, the per-turn, per-user,
 * INSERT-ONLY usage ledger. Tenant-scoped: ENABLE + FORCE RLS, USING + WITH CHECK, all in THIS migration (CLAUDE.md).
 *
 * Why a new table (C7-2): a per-user budget needs a per-user seed. Seeding from turn rows would let a user regain budget
 * by deleting conversations; putting `user_id` into `ai_usage_daily` would change its key again and expose per-user rows
 * to every session of the organisation through its org-only policy. `ai_usage_daily` stays the organisation roll-up.
 *
 * Columns (metadata only — never a prompt, a reply, a tool argument or result):
 *   id, organisation_id (FK organisation, cascade), user_id, turn_id (UNIQUE, deliberately NO FK to the turn, so the row
 *   outlives the conversation and deleting a chat never hands budget back), usage_date (UTC day), kind ∈ chat | title |
 *   agent (no `agent` row is written before EX-3), model (catalogue id format), steps, input / cached input / cache write /
 *   output tokens, cost_usd_micros (estimated, integer micro-USD — never pence), outcome ∈ completed | failed | cancelled,
 *   created_at. FK (user_id, organisation_id) → core."user" ON DELETE CASCADE: erasing a user erases their usage rows
 *   (rule 3.8).
 *
 * Policies:
 *   INSERT  WITH CHECK  organisation_id = core.current_org() AND user_id = core.current_uid()   (only for yourself)
 *   SELECT  USING       organisation_id = core.current_org() AND (user_id = core.current_uid() OR core.ai_settings_writer())
 *                       (your own rows; the organisation's CEO reads the organisation — monitoring data about other people,
 *                       THREAT-MODEL entry "AI-P7-usage")
 *   Retention (SELECT + DELETE) only inside `core.ai_usage_purge_expired`: `current_user = 'crewflow'` (the definer owner)
 *   AND the transaction-local flag `rab.ai_usage_retention = on` AND the bound organisation. `crewflow_app` is never
 *   `crewflow` and holds no DELETE anyway.
 *   With no tenant context bound every predicate is NULL ⇒ zero rows (fail closed).
 * Grants to `crewflow_app`: SELECT; INSERT on the data columns only (not `id`, not `created_at`). No UPDATE, no DELETE, no
 * TRUNCATE: insert-only at the grant level.
 *
 * Retention (D7-10): `core.ai_usage_purge_expired(p_retention interval)` — SECURITY DEFINER owned by `crewflow` (the table
 * owner, like `core.ai_purge_expired_conversations`), `search_path = pg_catalog, pg_temp`, a hard 400-day floor in SQL,
 * the BOUND organisation only (no context → 0), returns the number of rows removed (a count, never ids). EXECUTE for
 * `crewflow_app` only. Wiring it into the existing AI retention job under AI_RETENTION_MODE is 7b.
 *
 * Post-condition (refuses to record the migration on drift): FORCE + owner, the four policies, insert-only grants, the
 * function's definer / owner / EXECUTE, and `crewflow_app` without BYPASSRLS.
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
const TABLE = 'core.ai_usage';
const PURGE_FN = 'core.ai_usage_purge_expired(interval)';
const ORG = `organisation_id = core.current_org()`;
const RETENTION = `${ORG} AND current_user = 'crewflow' AND current_setting('rab.ai_usage_retention', true) = 'on'`;
export const AI_USAGE_LEDGER_INSERT_COLUMNS = [
  'organisation_id',
  'user_id',
  'turn_id',
  'usage_date',
  'kind',
  'model',
  'steps',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'output_tokens',
  'cost_usd_micros',
  'outcome',
] as const;
export const AI_USAGE_RETENTION_FLOOR_DAYS = 400;

export class AiUsageLedger1786720710000 implements MigrationInterface {
  name = 'AiUsageLedger1786720710000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE ${TABLE} (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id     uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id             uuid        NOT NULL,
        turn_id             uuid        NOT NULL,
        usage_date          date        NOT NULL,
        kind                text        NOT NULL,
        model               text        NOT NULL,
        steps               smallint    NOT NULL DEFAULT 0,
        input_tokens        bigint      NOT NULL DEFAULT 0,
        cached_input_tokens bigint      NOT NULL DEFAULT 0,
        cache_write_tokens  bigint      NOT NULL DEFAULT 0,
        output_tokens       bigint      NOT NULL DEFAULT 0,
        cost_usd_micros     bigint      NOT NULL DEFAULT 0,
        outcome             text        NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_usage_turn_key UNIQUE (turn_id),
        CONSTRAINT ai_usage_user_fkey FOREIGN KEY (user_id, organisation_id)
          REFERENCES core."user"(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_usage_kind_check CHECK (kind IN ('chat', 'title', 'agent')),
        CONSTRAINT ai_usage_model_check CHECK (model ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
        CONSTRAINT ai_usage_outcome_check CHECK (outcome IN ('completed', 'failed', 'cancelled')),
        CONSTRAINT ai_usage_counts_check CHECK (steps >= 0 AND input_tokens >= 0 AND cached_input_tokens >= 0 AND cache_write_tokens >= 0
                                                AND output_tokens >= 0 AND cost_usd_micros >= 0)
      );
    `);
    await runner.query(`CREATE INDEX ai_usage_org_day_user_idx ON ${TABLE} (organisation_id, usage_date, user_id);`);

    // ── Ownership + RLS (same migration) ────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);
    await runner.query(`CREATE POLICY ai_usage_own_insert ON ${TABLE} FOR INSERT WITH CHECK (${ORG} AND user_id = core.current_uid());`);
    await runner.query(`CREATE POLICY ai_usage_own_or_ceo_select ON ${TABLE} FOR SELECT USING (${ORG} AND (user_id = core.current_uid() OR core.ai_settings_writer()));`);
    await runner.query(`CREATE POLICY ai_usage_retention_select ON ${TABLE} FOR SELECT USING (${RETENTION});`);
    await runner.query(`CREATE POLICY ai_usage_retention_delete ON ${TABLE} FOR DELETE USING (${RETENTION});`);
    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (${AI_USAGE_LEDGER_INSERT_COLUMNS.join(', ')}) ON ${TABLE} TO crewflow_app;`);

    // ── Retention purge (organisation-bound, count only) ────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_usage_purge_expired(p_retention interval)
      RETURNS integer
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_org uuid := core.current_org();
        v_n   integer;
      BEGIN
        -- Hard floor in SQL, independent of any configuration: even a buggy or compromised caller on the runtime role can
        -- never purge usage rows younger than ${AI_USAGE_RETENTION_FLOOR_DAYS} days (interval '0' would otherwise mean "everything").
        IF p_retention IS NULL OR p_retention < interval '${AI_USAGE_RETENTION_FLOOR_DAYS} days' THEN
          RAISE EXCEPTION 'ai_usage_purge_expired: retention must be at least ${AI_USAGE_RETENTION_FLOOR_DAYS} days' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_org IS NULL THEN RETURN 0; END IF;
        PERFORM pg_catalog.set_config('rab.ai_usage_retention', 'on', true);
        DELETE FROM core.ai_usage u WHERE u.organisation_id = v_org AND u.usage_date < (pg_catalog.now() - p_retention)::date;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        PERFORM pg_catalog.set_config('rab.ai_usage_retention', '', true);
        RETURN v_n;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_usage_purge_expired(interval) OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION ${PURGE_FN} FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION ${PURGE_FN} TO crewflow_app;`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow' FROM pg_class c WHERE c.oid = '${TABLE}'::regclass) AS forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = '${TABLE}'::regclass)::int AS policies,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS app_select,
         has_any_column_privilege('crewflow_app', '${TABLE}', 'UPDATE') AS app_update,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_column_privilege('crewflow_app', '${TABLE}', 'id', 'INSERT') AS app_id_insert,
         has_column_privilege('crewflow_app', '${TABLE}', 'created_at', 'INSERT') AS app_created_insert,
         has_column_privilege('crewflow_app', '${TABLE}', 'cost_usd_micros', 'INSERT') AS app_cost_insert,
         has_table_privilege('public', '${TABLE}', 'SELECT') AS public_select,
         (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'crewflow' AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
            FROM pg_proc p WHERE p.oid = '${PURGE_FN}'::regprocedure) AS purge_definer_ok,
         has_function_privilege('crewflow_app', '${PURGE_FN}', 'EXECUTE') AS purge_app_execute,
         EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = '${PURGE_FN}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS purge_public_execute,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean>>;
    if (
      check.forced !== true || check.policies !== 4 || check.app_select !== true ||
      check.app_update || check.app_delete || check.app_truncate || check.app_id_insert || check.app_created_insert || check.app_cost_insert !== true ||
      check.public_select || check.purge_definer_ok !== true || check.purge_app_execute !== true || check.purge_public_execute || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP FUNCTION IF EXISTS ${PURGE_FN};`);
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
  }
}
