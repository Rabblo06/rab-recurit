import { MigrationInterface, QueryRunner } from 'typeorm';

import { AI_ERROR_CODES_1786720220000 } from './1786720220000-AiPhase1Schema';

/**
 * AI Phase 7 M7-1 (docs/ai/PHASE7_TWENTY_PLAN.md §4; resolution X-1: the turn is the assistant `core.ai_message` row, so
 * this migration targets `ai_message` directly — no "detect the turn table" logic). No table is created, no policy is
 * touched, FORCE RLS stays on both tables.
 *
 * 1. `core.ai_usage_daily` += `cached_input_tokens`, `cache_write_tokens` (`bigint NOT NULL DEFAULT 0`, CHECK ≥ 0). The
 *    runtime role already inserts table-wide; it gains UPDATE on exactly these two counters (the UPSERT of `recordTurn`).
 * 2. `core.ai_message` (the turn row) += `cached_input_tokens integer`, `cache_write_tokens integer`, `cost_usd_micros
 *    bigint` (NULL until the turn's terminal compare-and-set UPDATE writes them; CHECK ≥ 0). Column UPDATE grants to the
 *    runtime role for these three only. Estimated cost is integer micro-USD, never pence.
 * 3. `ai_message_error_code_check` is replaced by the Phase 1 codes + `AI_USER_BUDGET_EXHAUSTED` (the caller's own daily
 *    cost allowance ran out) and `AI_CONTEXT_FULL` (the conversation no longer fits the per-step context budget). Agent 9
 *    re-checks this list against the integration head when renumbering (a later phase may have added codes).
 * 4. `core.ai_admin_usage_summary(date, date, integer)` is dropped and re-created with three more columns
 *    ("costUsdMicros", "cachedInputTokens", "cacheWriteTokens"). Unchanged otherwise: SECURITY DEFINER owned by
 *    `rab_secure_owner`, `search_path = pg_catalog, pg_temp`, refuses anyone but an ACTIVE platform administrator (42501),
 *    at most 93 days, ≤ 200 organisations, counts and estimated cost only (never content, rule 11.4); EXECUTE for
 *    `crewflow_app` only (not PUBLIC, not `crewflow`).
 * Post-condition (refuses to record the migration on drift): FORCE RLS still on both tables (owner `crewflow`), no DELETE
 * for the runtime role on either, no UPDATE of the turn's identity columns, the new column grants present, the function's
 * owner / definer / search_path / EXECUTE as above, and `crewflow_app` without BYPASSRLS.
 *
 * `down()` refuses while any turn row still carries one of the two new codes (rewriting stored outcomes is a deliberate,
 * owner-approved step, never a side effect of a rollback), then restores the Phase 1 CHECK, the Phase 1 function and
 * drops the columns.
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
export const AI_USAGE_ERROR_CODES_M7_1: readonly string[] = ['AI_USER_BUDGET_EXHAUSTED', 'AI_CONTEXT_FULL'];
export const AI_ERROR_CODES_M7_1: readonly string[] = [...AI_ERROR_CODES_1786720220000, ...AI_USAGE_ERROR_CODES_M7_1];

const SUMMARY_FN = 'core.ai_admin_usage_summary(date, date, integer)';
const codeList = (codes: readonly string[]) => codes.map((c) => `'${c}'`).join(', ');

/** The function body shared by up() (with the cost/cache columns) and down() (the Phase 1 shape). */
function summaryFunction(withCost: boolean): string {
  const extraColumns = withCost ? `, "costUsdMicros" bigint, "cachedInputTokens" bigint, "cacheWriteTokens" bigint` : '';
  const extraSums = withCost
    ? `,
                 coalesce(sum(u.cost_usd_micros), 0)::bigint AS cost_usd_micros, coalesce(sum(u.cached_input_tokens), 0)::bigint AS cached_input_tokens,
                 coalesce(sum(u.cache_write_tokens), 0)::bigint AS cache_write_tokens`
    : '';
  const extraAssign = withCost ? `
            "costUsdMicros" := v_row.cost_usd_micros; "cachedInputTokens" := v_row.cached_input_tokens; "cacheWriteTokens" := v_row.cache_write_tokens;` : '';
  return `
      CREATE FUNCTION core.ai_admin_usage_summary(p_from date, p_to date, p_limit integer)
      RETURNS TABLE ("organisationId" uuid, "organisationName" text, "aiEnabled" boolean, "inputTokens" bigint, "outputTokens" bigint,
                     "turns" bigint, "failedTurns" bigint, "cancelledTurns" bigint, "toolCalls" bigint${extraColumns})
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_prev  text := pg_catalog.current_setting('rab.organisation_id', true);
        v_org   record;
        v_row   record;
        v_count integer := 0;
        v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
      BEGIN
        IF NOT core.is_active_platform_admin(core.current_uid()) THEN
          RAISE EXCEPTION 'ai_admin_usage_summary: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;
        IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
          RAISE EXCEPTION 'ai_admin_usage_summary: invalid date range (at most 93 days)' USING ERRCODE = '22023';
        END IF;
        FOR v_org IN SELECT o.id, o.name FROM core.organisation o ORDER BY o.name, o.id LOOP
          EXIT WHEN v_count >= v_limit;
          PERFORM pg_catalog.set_config('rab.organisation_id', v_org.id::text, true);
          SELECT coalesce((SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = v_org.id), false) AS enabled,
                 coalesce(sum(u.input_tokens), 0)::bigint AS input_tokens, coalesce(sum(u.output_tokens), 0)::bigint AS output_tokens,
                 coalesce(sum(u.turns), 0)::bigint AS turns, coalesce(sum(u.failed_turns), 0)::bigint AS failed_turns,
                 coalesce(sum(u.cancelled_turns), 0)::bigint AS cancelled_turns, coalesce(sum(u.tool_calls), 0)::bigint AS tool_calls${extraSums}
            INTO v_row
            FROM core.ai_usage_daily u
           WHERE u.organisation_id = v_org.id AND u.usage_date BETWEEN p_from AND p_to;
          IF v_row.enabled OR v_row.turns > 0 THEN
            v_count := v_count + 1;
            "organisationId" := v_org.id; "organisationName" := v_org.name; "aiEnabled" := v_row.enabled;
            "inputTokens" := v_row.input_tokens; "outputTokens" := v_row.output_tokens; "turns" := v_row.turns;
            "failedTurns" := v_row.failed_turns; "cancelledTurns" := v_row.cancelled_turns; "toolCalls" := v_row.tool_calls;${extraAssign}
            RETURN NEXT;
          END IF;
        END LOOP;
        PERFORM pg_catalog.set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $fn$;
    `;
}

async function createSummary(runner: QueryRunner, withCost: boolean): Promise<void> {
  await runner.query(summaryFunction(withCost));
  await runner.query(`ALTER FUNCTION core.ai_admin_usage_summary(date, date, integer) OWNER TO rab_secure_owner;`);
  await runner.query(`REVOKE ALL ON FUNCTION ${SUMMARY_FN} FROM PUBLIC;`);
  await runner.query(`GRANT EXECUTE ON FUNCTION ${SUMMARY_FN} TO crewflow_app;`);
}

export class AiUsageCacheAccounting1786720700000 implements MigrationInterface {
  name = 'AiUsageCacheAccounting1786720700000';

  async up(runner: QueryRunner): Promise<void> {
    // ── 1. ai_usage_daily: cache counters ────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD COLUMN cached_input_tokens bigint NOT NULL DEFAULT 0;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD CONSTRAINT ai_usage_daily_cache_check CHECK (cached_input_tokens >= 0 AND cache_write_tokens >= 0);`);
    await runner.query(`GRANT UPDATE (cached_input_tokens, cache_write_tokens) ON core.ai_usage_daily TO crewflow_app;`);

    // ── 2. ai_message (the turn row): cache split + estimated cost ───────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_message ADD COLUMN cached_input_tokens integer;`);
    await runner.query(`ALTER TABLE core.ai_message ADD COLUMN cache_write_tokens integer;`);
    await runner.query(`ALTER TABLE core.ai_message ADD COLUMN cost_usd_micros bigint;`);
    await runner.query(
      `ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_cache_cost_check CHECK (coalesce(cached_input_tokens, 0) >= 0 AND coalesce(cache_write_tokens, 0) >= 0 AND coalesce(cost_usd_micros, 0) >= 0);`,
    );
    await runner.query(`GRANT UPDATE (cached_input_tokens, cache_write_tokens, cost_usd_micros) ON core.ai_message TO crewflow_app;`);

    // ── 3. turn error codes ──────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_error_code_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_error_code_check CHECK (error_code IS NULL OR error_code IN (${codeList(AI_ERROR_CODES_M7_1)}));`);

    // ── 4. admin usage summary with estimated cost and cache counters (DROP + CREATE: the return type changes) ──────────
    await runner.query(`DROP FUNCTION ${SUMMARY_FN};`);
    await createSummary(runner, true);

    await this.verify(runner, true);
  }

  async down(runner: QueryRunner): Promise<void> {
    const [{ n }] = (await runner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE error_code = ANY($1::text[])`, [AI_USAGE_ERROR_CODES_M7_1])) as Array<{ n: number }>;
    if (n > 0) {
      throw new Error(
        `${this.name}: down() refused — ${n} turn row(s) still use ${AI_USAGE_ERROR_CODES_M7_1.join(' / ')}. Rewrite them (owner-approved, in the same guarded run) before rolling back.`,
      );
    }
    await runner.query(`DROP FUNCTION ${SUMMARY_FN};`);
    await createSummary(runner, false);

    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_error_code_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_error_code_check CHECK (error_code IS NULL OR error_code IN (${codeList(AI_ERROR_CODES_1786720220000)}));`);

    await runner.query(`REVOKE UPDATE (cached_input_tokens, cache_write_tokens, cost_usd_micros) ON core.ai_message FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_cache_cost_check;`);
    await runner.query(`ALTER TABLE core.ai_message DROP COLUMN cost_usd_micros;`);
    await runner.query(`ALTER TABLE core.ai_message DROP COLUMN cache_write_tokens;`);
    await runner.query(`ALTER TABLE core.ai_message DROP COLUMN cached_input_tokens;`);

    await runner.query(`REVOKE UPDATE (cached_input_tokens, cache_write_tokens) ON core.ai_usage_daily FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP CONSTRAINT ai_usage_daily_cache_check;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP COLUMN cache_write_tokens;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP COLUMN cached_input_tokens;`);

    await this.verify(runner, false);
  }

  /** Refuses to record (or to roll back) on drift. */
  private async verify(runner: QueryRunner, up: boolean): Promise<void> {
    const [check] = (await runner.query(
      `SELECT
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname IN ('ai_message', 'ai_usage_daily') AND c.relrowsecurity AND c.relforcerowsecurity
             AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         has_table_privilege('crewflow_app', 'core.ai_message', 'DELETE') AS msg_delete,
         has_table_privilege('crewflow_app', 'core.ai_usage_daily', 'DELETE') AS usage_delete,
         has_column_privilege('crewflow_app', 'core.ai_message', 'organisation_id', 'UPDATE') AS msg_org_update,
         has_column_privilege('crewflow_app', 'core.ai_message', 'user_id', 'UPDATE') AS msg_user_update,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'model', 'UPDATE') AS usage_model_update,
         (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'rab_secure_owner' AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
            FROM pg_proc p WHERE p.oid = '${SUMMARY_FN}'::regprocedure) AS summary_definer_ok,
         has_function_privilege('crewflow_app', '${SUMMARY_FN}', 'EXECUTE') AS summary_app_execute,
         has_function_privilege('crewflow', '${SUMMARY_FN}', 'EXECUTE') AS summary_crewflow_execute,
         EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = '${SUMMARY_FN}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS summary_public_execute,
         (SELECT pg_get_function_result('${SUMMARY_FN}'::regprocedure)) AS summary_result,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'core' AND ((table_name = 'ai_usage_daily' AND column_name IN ('cached_input_tokens', 'cache_write_tokens'))
              OR (table_name = 'ai_message' AND column_name IN ('cached_input_tokens', 'cache_write_tokens', 'cost_usd_micros'))))::int AS new_columns,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean | string>>;
    const result = String(check.summary_result);
    const costColumns = result.includes('"costUsdMicros" bigint') && result.includes('"cachedInputTokens" bigint') && result.includes('"cacheWriteTokens" bigint');
    let columnGrants = true;
    if (up) {
      const [grants] = (await runner.query(
        `SELECT
           has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'cached_input_tokens', 'UPDATE')
             AND has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'cache_write_tokens', 'UPDATE')
             AND has_column_privilege('crewflow_app', 'core.ai_message', 'cached_input_tokens', 'UPDATE')
             AND has_column_privilege('crewflow_app', 'core.ai_message', 'cache_write_tokens', 'UPDATE')
             AND has_column_privilege('crewflow_app', 'core.ai_message', 'cost_usd_micros', 'UPDATE') AS ok`,
      )) as Array<{ ok: boolean }>;
      columnGrants = grants.ok === true;
    }
    if (
      check.forced !== 2 ||
      check.msg_delete || check.usage_delete || check.msg_org_update || check.msg_user_update || check.usage_model_update ||
      check.summary_definer_ok !== true || check.summary_app_execute !== true || check.summary_crewflow_execute || check.summary_public_execute ||
      costColumns !== up || check.new_columns !== (up ? 5 : 0) || !columnGrants || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }
}
