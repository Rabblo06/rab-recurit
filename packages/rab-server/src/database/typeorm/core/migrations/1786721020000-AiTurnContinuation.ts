import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI 5b (Phase 5 wiring, docs/ai/PHASE5_TWENTY_PLAN.md; p5 DOC-DRAFTS §5): the CONTINUATION turn after a person decided an
 * AI write proposal. A continuation is a NEW assistant turn with no new user message: it continues the paused turn and
 * carries, in its history, only a server-written tool result for the decided proposal (never a note body or argument).
 *
 * `core.ai_message` gains:
 *   - `continues_turn_id` — the paused assistant turn this one continues (same conversation; FK (id, conversation_id));
 *   - `continuation_ref`  — the decided proposal (FK `ai_action_proposal(id)`), at most ONE continuation per proposal
 *                           (unique partial index `ai_message_one_continuation`).
 * `ai_message_role_status_check` is replaced: a user message has none of the three references; an assistant turn has
 * EITHER a request message (a question) OR a continuation (continues_turn_id + continuation_ref), never both, never none.
 * No new grant (crewflow_app already INSERTs rows under the owner + eligibility policy; it gets NO UPDATE of either
 * column). The existing FORCE RLS and owner policies are unchanged and re-asserted. Not production-approved (N1).
 */
const TABLE = 'core.ai_message';
const OLD_CHECK = `(role = 'user' AND status IS NULL AND request_message_id IS NULL)
  OR (role = 'assistant' AND status IS NOT NULL AND request_message_id IS NOT NULL AND client_request_id IS NULL AND session_id IS NOT NULL)`;
const NEW_CHECK = `(role = 'user' AND status IS NULL AND request_message_id IS NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL)
  OR (role = 'assistant' AND status IS NOT NULL AND client_request_id IS NULL AND session_id IS NOT NULL
      AND ((request_message_id IS NOT NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL)
        OR (request_message_id IS NULL AND continues_turn_id IS NOT NULL AND continuation_ref IS NOT NULL)))`;

export class AiTurnContinuation1786721020000 implements MigrationInterface {
  name = 'AiTurnContinuation1786721020000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN continues_turn_id uuid, ADD COLUMN continuation_ref uuid;`);
    await runner.query(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_continues_fkey FOREIGN KEY (continues_turn_id, conversation_id) REFERENCES core.ai_message(id, conversation_id) ON DELETE CASCADE;`,
    );
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_continuation_ref_fkey FOREIGN KEY (continuation_ref) REFERENCES core.ai_action_proposal(id) ON DELETE CASCADE;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ai_message_role_status_check;`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_role_status_check CHECK (${NEW_CHECK});`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_continuation ON ${TABLE} (continuation_ref) WHERE continuation_ref IS NOT NULL;`);

    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = 'ai_message') AS forced,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_column_privilege('crewflow_app', '${TABLE}', 'continues_turn_id', 'UPDATE') AS app_update_continues,
         has_column_privilege('crewflow_app', '${TABLE}', 'continuation_ref', 'UPDATE') AS app_update_ref,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, boolean>>;
    if (check.forced !== true || check.app_delete || check.app_truncate || check.app_update_continues || check.app_update_ref || check.app_bypass) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    // Refuse rather than silently drop continuation turns (the restored CHECK cannot hold them).
    // row_security = off: an RLS-bound role gets an error instead of a silently filtered zero (fail closed).
    await runner.query(`SET LOCAL row_security = off`);
    const [{ n }] = (await runner.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE continues_turn_id IS NOT NULL`)) as Array<{ n: number }>;
    await runner.query(`SET LOCAL row_security = on`);
    if (n > 0) throw new Error(`${this.name}: ${n} continuation turn(s) exist; down() refuses to drop them`);
    await runner.query(`DROP INDEX IF EXISTS core.ai_message_one_continuation;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ai_message_role_status_check;`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_message_role_status_check CHECK (${OLD_CHECK});`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ai_message_continuation_ref_fkey, DROP CONSTRAINT IF EXISTS ai_message_continues_fkey;`);
    await runner.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS continuation_ref, DROP COLUMN IF EXISTS continues_turn_id;`);
  }
}
