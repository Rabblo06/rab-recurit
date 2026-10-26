import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 2 M2 (docs/ai/PHASE2_TWENTY_PLAN.md §2.5, §4): `core.ai_usage_daily.title_calls` — thread-title model calls
 * are billed and metered like turns (their tokens and estimated cost go into the same per-model row), but they are
 * counted separately so `turns` keeps meaning "questions answered".
 *
 *   `title_calls integer NOT NULL DEFAULT 0 CHECK (title_calls >= 0)` + `GRANT UPDATE (title_calls)` to `crewflow_app`
 *   (INSERT is already table-wide). `core.ai_admin_usage_summary` is unchanged: its columns are fixed, and title cost is
 *   already inside `cost_usd_micros`.
 *
 * Post-condition (fail closed): the table is still ENABLE + FORCE and owned by `crewflow`; `crewflow_app` has no DELETE /
 * TRUNCATE, no UPDATE of the row key (organisation_id, usage_date, model), holds the new column grant and has no
 * BYPASSRLS; the table's policies are byte-identical to what they were before. Not production-approved (N1). Other code
 * refers to this migration only through `AI_P2_MIGRATION_USAGE_TITLE_CALLS` (modules/ai/constants/ai.constants.ts).
 */
async function usagePolicies(runner: QueryRunner): Promise<string> {
  const rows = (await runner.query(
    `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_usage_daily' ORDER BY policyname`,
  )) as unknown[];
  return JSON.stringify(rows);
}

export class AiUsageTitleCalls1786720310000 implements MigrationInterface {
  name = 'AiUsageTitleCalls1786720310000';

  async up(runner: QueryRunner): Promise<void> {
    const policiesBefore = await usagePolicies(runner);
    await runner.query(`ALTER TABLE core.ai_usage_daily ADD COLUMN title_calls integer NOT NULL DEFAULT 0 CONSTRAINT ai_usage_daily_title_calls_check CHECK (title_calls >= 0);`);
    await runner.query(`GRANT UPDATE (title_calls) ON core.ai_usage_daily TO crewflow_app;`);

    const [check] = (await runner.query(
      `SELECT
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = 'ai_usage_daily' AND c.relrowsecurity AND c.relforcerowsecurity
             AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         has_table_privilege('crewflow_app', 'core.ai_usage_daily', 'DELETE') AS usage_delete,
         has_table_privilege('crewflow_app', 'core.ai_usage_daily', 'TRUNCATE') AS usage_truncate,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'organisation_id', 'UPDATE') AS org_update,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'usage_date', 'UPDATE') AS date_update,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'model', 'UPDATE') AS model_update,
         has_column_privilege('crewflow_app', 'core.ai_usage_daily', 'title_calls', 'UPDATE') AS title_calls_grant,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean>>;
    const policiesAfter = await usagePolicies(runner);
    if (
      check.forced !== 1 ||
      check.usage_delete || check.usage_truncate || check.org_update || check.date_update || check.model_update ||
      !check.title_calls_grant || check.app_bypass !== false ||
      policiesAfter !== policiesBefore
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify({ ...check, policiesUnchanged: policiesAfter === policiesBefore })}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`REVOKE UPDATE (title_calls) ON core.ai_usage_daily FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily DROP COLUMN title_calls;`);
  }
}
