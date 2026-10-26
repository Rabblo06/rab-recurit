import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI 4w (Phase 4 wiring, docs/ai/PHASE4_TWENTY_PLAN.md §2.3 (3), DOC-DRAFTS §4 item 4): skill TAGS on a question.
 * `core.ai_message.skills` holds the 1..2 skill NAMES the user tagged on THIS user message (never content), checked
 * active + readable at submit (`AiSkillReader.assertTaggable`); the Worker loads them with the same `load_skills` handler
 * and budget before the question. NULL for every other row.
 *
 *   CHECK: user messages only; 1..2 distinct names; each matches `AI_SKILL_NAME_PATTERN` (^[a-z][a-z0-9-]{1,47}$).
 * No new grant: `crewflow_app` already INSERTs `ai_message` rows (the existing owner INSERT policy and its
 * `ai_actor_eligible()` predicate apply) and gets NO UPDATE of this column. No table is created; the existing FORCE RLS and
 * owner policies of `ai_message` are unchanged and re-asserted below. Not production-approved (N1).
 */
const TABLE = 'core.ai_message';
const NAME = '[a-z][a-z0-9-]{1,47}';

export class AiMessageSkillTags1786721010000 implements MigrationInterface {
  name = 'AiMessageSkillTags1786721010000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN skills text[];`);
    await runner.query(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_skills_check CHECK (
         skills IS NULL OR (
           role = 'user'
           AND cardinality(skills) BETWEEN 1 AND 2
           AND array_to_string(skills, ',') ~ '^${NAME}(,${NAME})?$'
           AND (cardinality(skills) = 1 OR skills[1] <> skills[2])
         )
       );`,
    );

    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = 'ai_message') AS forced,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_column_privilege('crewflow_app', '${TABLE}', 'skills', 'UPDATE') AS app_update_skills,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, boolean>>;
    if (check.forced !== true || check.app_delete || check.app_truncate || check.app_update_skills || check.app_bypass) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ai_message_skills_check;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS skills;`);
  }
}
