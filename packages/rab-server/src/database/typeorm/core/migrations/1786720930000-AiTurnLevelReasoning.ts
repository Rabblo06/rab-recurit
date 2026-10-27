import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Twenty UI deltas CD-1 / CD-7 (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md, TW-D1 / TW-D7): what a turn ran at, and how long
 * the model reasoned. `core.ai_message` (the assistant row = the turn, resolution X-1) gains:
 *   - `level`  — the level the turn ran at (CHECK: the five keys); NULL for rows older than this migration and for user
 *                messages;
 *   - `effort` — the effort sent to the provider (CHECK low | medium | high); NULL likewise;
 *   - `reasoning_ms` — reasoning DURATION only (server clock, 0..3,600,000). The reasoning TEXT is discarded in the Worker
 *                and never stored anywhere (rule 11.2).
 * Column UPDATE grants for `crewflow_app` (the Worker records what actually ran). No table is created; the existing
 * FORCE RLS and owner policies of `ai_message` are unchanged and re-asserted below.
 *
 * Dev-time number (range 1786720900000–949999); Agent 9 renumbers at merge (PL-8). Not production-approved (N1).
 */
const TABLE = 'core.ai_message';
const LEVELS = ['extra_fast', 'fast', 'balanced', 'smart', 'extra_smart'].map((l) => `'${l}'`).join(', ');

export class AiTurnLevelReasoning1786720930000 implements MigrationInterface {
  name = 'AiTurnLevelReasoning1786720930000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN level text, ADD COLUMN effort text, ADD COLUMN reasoning_ms integer;`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_level_check CHECK (level IS NULL OR (role = 'assistant' AND level IN (${LEVELS})));`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_effort_check CHECK (effort IS NULL OR (role = 'assistant' AND effort IN ('low', 'medium', 'high')));`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_reasoning_ms_check CHECK (reasoning_ms IS NULL OR (role = 'assistant' AND reasoning_ms BETWEEN 0 AND 3600000));`);
    await runner.query(`GRANT UPDATE (level, effort, reasoning_ms) ON ${TABLE} TO crewflow_app;`);

    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = 'ai_message') AS forced,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_column_privilege('crewflow_app', '${TABLE}', 'reasoning_ms', 'UPDATE') AS app_update_reasoning,
         has_column_privilege('crewflow_app', '${TABLE}', 'organisation_id', 'UPDATE') AS app_update_org,
         has_column_privilege('crewflow_app', '${TABLE}', 'user_id', 'UPDATE') AS app_update_user,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, boolean>>;
    if (check.forced !== true || check.app_delete || check.app_truncate || check.app_update_reasoning !== true || check.app_update_org || check.app_update_user || check.app_bypass) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`REVOKE UPDATE (level, effort, reasoning_ms) ON ${TABLE} FROM crewflow_app;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ai_message_reasoning_ms_check, DROP CONSTRAINT IF EXISTS ai_message_effort_check, DROP CONSTRAINT IF EXISTS ai_message_level_check;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS reasoning_ms, DROP COLUMN IF EXISTS effort, DROP COLUMN IF EXISTS level;`);
  }
}
