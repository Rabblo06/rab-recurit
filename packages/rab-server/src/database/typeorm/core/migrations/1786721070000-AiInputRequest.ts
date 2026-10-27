import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 5c (Batch 3 S7; docs/ai/PHASE5_TWENTY_PLAN.md §2.1 + M2 + M3, resolution X-3): the assistant may ASK the user a
 * question or for a short form; the turn then PAUSES as `waiting_for_input` until the user answers, asks something else,
 * cancels, or the request expires. The answer writes NO domain data: it only feeds a continuation turn (the 5b mechanism).
 *
 * 1. NEW tenant-scoped table `core.ai_input_request` (one per paused turn), ENABLE + FORCE RLS, USING + WITH CHECK, all in
 *    THIS migration (CLAUDE.md):
 *      id, organisation_id, workspace_id, user_id, conversation_id (FK → ai_conversation, cascade), turn_id (FK
 *      (turn_id, conversation_id) → ai_message, cascade; UNIQUE: one request per turn), tool_call_id, kind ∈ question |
 *      form, spec (the validated, sanitised question / form, jsonb object ≤ 8 KB), state ∈ awaiting_input | answered |
 *      superseded | expired (@rab/shared AI_INPUT_REQUEST_TRANSITIONS), answer (jsonb string or object ≤ 8 KB, only when
 *      answered), answered_at, expires_at (fixed by the database at insert: 15 minutes), created_at, updated_at.
 *    Policies: SELECT USING owner (organisation AND workspace AND user = the bound session); INSERT WITH CHECK owner AND
 *    `core.ai_actor_eligible()` AND state = 'awaiting_input' AND no answer; UPDATE USING owner, WITH CHECK owner AND
 *    `core.ai_actor_eligible()`. No DELETE policy, no DELETE / TRUNCATE grant: rows leave only with their conversation.
 *    Column grants to crewflow_app: INSERT (organisation_id, workspace_id, user_id, conversation_id, turn_id,
 *    tool_call_id, kind, spec); UPDATE (state, answer, answered_at, updated_at); SELECT.
 *    Trigger `core.ai_input_request_guard()` (BEFORE UPDATE, SECURITY INVOKER, fixed search_path): identity, spec and
 *    expiry immutable; only awaiting_input → answered | superseded | expired; answered only before expiry, expired only
 *    after; the answer is written exactly once, on → answered. With no tenant context every predicate is NULL ⇒ 0 rows.
 * 2. `core.ai_message`:
 *      - `ai_message_status_check` += 'waiting_for_input' (exactly the @rab/shared AI_TURN_TRANSITIONS states);
 *      - `ai_message_waiting_check`: a waiting turn holds no lease;
 *      - `continuation_input_ref` (FK → ai_input_request, cascade; unique partial index: at most ONE continuation per
 *        answered request); `ai_message_role_status_check` replaced: a continuation continues a turn with EXACTLY one of
 *        a decided proposal (5b) or an answered input request (5c). No UPDATE grant on the new column.
 *    The one-running / one-queued indexes are unchanged: a waiting turn is in neither. FORCE RLS re-asserted.
 *
 * down(): refuses while any input request or waiting turn exists (row_security = off, so an RLS-bound role gets an error,
 * not a silently filtered zero); then restores the 5b CHECKs and drops the column, function and table.
 * Not production-approved (N1). Dev number above 1786721060000; Agent 9 renumbers it at the integration merge.
 */
const OWNER = `organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND user_id = core.current_uid()`;
const TABLE = 'core.ai_input_request';

export const AI_INPUT_REQUEST_POLICIES_1786721070000 = ['ai_input_request_insert', 'ai_input_request_select', 'ai_input_request_update'] as const;
export const AI_INPUT_REQUEST_INSERT_COLUMNS_1786721070000 = ['organisation_id', 'workspace_id', 'user_id', 'conversation_id', 'turn_id', 'tool_call_id', 'kind', 'spec'] as const;
export const AI_INPUT_REQUEST_UPDATE_COLUMNS_1786721070000 = ['state', 'answer', 'answered_at', 'updated_at'] as const;
/** Frozen copy of @rab/shared AI_TURN_TRANSITIONS' states at this migration. */
export const AI_TURN_STATUSES_1786721070000 = ['queued', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const;

const ROLE_CHECK_5B = `(role = 'user' AND status IS NULL AND request_message_id IS NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL)
  OR (role = 'assistant' AND status IS NOT NULL AND client_request_id IS NULL AND session_id IS NOT NULL
      AND ((request_message_id IS NOT NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL)
        OR (request_message_id IS NULL AND continues_turn_id IS NOT NULL AND continuation_ref IS NOT NULL)))`;
const ROLE_CHECK_5C = `(role = 'user' AND status IS NULL AND request_message_id IS NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL AND continuation_input_ref IS NULL)
  OR (role = 'assistant' AND status IS NOT NULL AND client_request_id IS NULL AND session_id IS NOT NULL
      AND ((request_message_id IS NOT NULL AND continues_turn_id IS NULL AND continuation_ref IS NULL AND continuation_input_ref IS NULL)
        OR (request_message_id IS NULL AND continues_turn_id IS NOT NULL AND ((continuation_ref IS NULL) <> (continuation_input_ref IS NULL)))))`;
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export class AiInputRequest1786721070000 implements MigrationInterface {
  name = 'AiInputRequest1786721070000';

  async up(runner: QueryRunner): Promise<void> {
    // ── 1. core.ai_input_request ────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE ${TABLE} (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid        NOT NULL,
        workspace_id     uuid        NOT NULL,
        user_id          uuid        NOT NULL,
        conversation_id  uuid        NOT NULL,
        turn_id          uuid        NOT NULL,
        tool_call_id     text        NOT NULL,
        kind             text        NOT NULL,
        spec             jsonb       NOT NULL,
        state            text        NOT NULL DEFAULT 'awaiting_input',
        answer           jsonb,
        answered_at      timestamptz,
        expires_at       timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_input_request_conversation_fkey FOREIGN KEY (conversation_id, organisation_id, workspace_id, user_id)
          REFERENCES core.ai_conversation(id, organisation_id, workspace_id, user_id) ON DELETE CASCADE,
        CONSTRAINT ai_input_request_turn_fkey FOREIGN KEY (turn_id, conversation_id) REFERENCES core.ai_message(id, conversation_id) ON DELETE CASCADE,
        CONSTRAINT ai_input_request_turn_key UNIQUE (turn_id),
        CONSTRAINT ai_input_request_id_conversation_key UNIQUE (id, conversation_id),
        CONSTRAINT ai_input_request_kind_check CHECK (kind IN ('question', 'form')),
        CONSTRAINT ai_input_request_tool_call_id_check CHECK (tool_call_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        CONSTRAINT ai_input_request_spec_check CHECK (jsonb_typeof(spec) = 'object' AND pg_column_size(spec) <= 8192),
        CONSTRAINT ai_input_request_state_check CHECK (state IN ('awaiting_input', 'answered', 'superseded', 'expired')),
        CONSTRAINT ai_input_request_answer_check CHECK (
          (state = 'answered') = (answer IS NOT NULL) AND (answer IS NULL) = (answered_at IS NULL)
          AND (answer IS NULL OR (jsonb_typeof(answer) IN ('string', 'object') AND pg_column_size(answer) <= 8192))
        ),
        CONSTRAINT ai_input_request_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
      );
    `);
    await runner.query(`CREATE INDEX ai_input_request_conversation_idx ON ${TABLE} (organisation_id, conversation_id, created_at);`);

    await runner.query(`
      CREATE FUNCTION core.ai_input_request_guard()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
           OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
           OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.spec IS DISTINCT FROM OLD.spec OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'ai_input_request: identity, spec and expiry are immutable' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.state IS DISTINCT FROM OLD.state THEN
          IF NOT (OLD.state = 'awaiting_input' AND NEW.state IN ('answered', 'superseded', 'expired')) THEN
            RAISE EXCEPTION 'ai_input_request: transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.state = 'answered' AND NEW.expires_at <= pg_catalog.now() THEN
            RAISE EXCEPTION 'ai_input_request: an expired request cannot be answered' USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.state = 'expired' AND NEW.expires_at > pg_catalog.now() THEN
            RAISE EXCEPTION 'ai_input_request: not expired yet' USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        IF (NEW.answer IS DISTINCT FROM OLD.answer OR NEW.answered_at IS DISTINCT FROM OLD.answered_at)
           AND NOT (OLD.state = 'awaiting_input' AND NEW.state = 'answered') THEN
          RAISE EXCEPTION 'ai_input_request: the answer is written once, when answering' USING ERRCODE = 'check_violation';
        END IF;
        NEW.updated_at := pg_catalog.now();
        RETURN NEW;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_input_request_guard() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_input_request_guard() FROM PUBLIC;`);
    await runner.query(`CREATE TRIGGER ai_input_request_guard BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION core.ai_input_request_guard();`);

    // Ownership + RLS in the same migration (owner crewflow, like every ordinary FORCE-RLS tenant table).
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);
    await runner.query(`CREATE POLICY ai_input_request_select ON ${TABLE} FOR SELECT USING (${OWNER});`);
    await runner.query(
      `CREATE POLICY ai_input_request_insert ON ${TABLE} FOR INSERT WITH CHECK (${OWNER} AND core.ai_actor_eligible() AND state = 'awaiting_input' AND answer IS NULL AND answered_at IS NULL);`,
    );
    await runner.query(`CREATE POLICY ai_input_request_update ON ${TABLE} FOR UPDATE USING (${OWNER}) WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);
    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (${AI_INPUT_REQUEST_INSERT_COLUMNS_1786721070000.join(', ')}) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (${AI_INPUT_REQUEST_UPDATE_COLUMNS_1786721070000.join(', ')}) ON ${TABLE} TO crewflow_app;`);

    // ── 2. core.ai_message ──────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_status_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_status_check CHECK (status IN (${list(AI_TURN_STATUSES_1786721070000)}));`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_waiting_check CHECK (status IS DISTINCT FROM 'waiting_for_input' OR (lease_token IS NULL AND lease_expires_at IS NULL));`);
    await runner.query(`ALTER TABLE core.ai_message ADD COLUMN continuation_input_ref uuid;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_continuation_input_ref_fkey FOREIGN KEY (continuation_input_ref) REFERENCES ${TABLE}(id) ON DELETE CASCADE;`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_role_status_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_role_status_check CHECK (${ROLE_CHECK_5C});`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_input_continuation ON core.ai_message (continuation_input_ref) WHERE continuation_input_ref IS NOT NULL;`);

    await this.verify(runner);
  }

  /** Refuse to record the migration on drift. */
  private async verify(runner: QueryRunner): Promise<void> {
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow' FROM pg_class c WHERE c.oid = '${TABLE}'::regclass) AS forced,
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow' FROM pg_class c WHERE c.oid = 'core.ai_message'::regclass) AS message_forced,
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_input_request') AS policies,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'ai_input_request' AND privilege_type = 'INSERT') AS insert_cols,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'ai_input_request' AND privilege_type = 'UPDATE') AS update_cols,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS can_select,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS can_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS can_truncate,
         has_column_privilege('crewflow_app', 'core.ai_message', 'continuation_input_ref', 'UPDATE') AS app_update_input_ref,
         (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = '${TABLE}'::regclass AND t.tgname = 'ai_input_request_guard' AND t.tgenabled = 'O') AS triggers,
         (SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner) = 'crewflow'
            FROM pg_proc p WHERE p.oid = 'core.ai_input_request_guard()'::regprocedure) AS guard_ok,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.ai_message'::regclass AND conname = 'ai_message_status_check') AS status_check,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, unknown>>;
    const same = (a: unknown, b: readonly string[]) => JSON.stringify(a) === JSON.stringify([...b].sort());
    if (
      check?.forced !== true ||
      check.message_forced !== true ||
      !same(check.policies, AI_INPUT_REQUEST_POLICIES_1786721070000) ||
      !same(check.insert_cols, AI_INPUT_REQUEST_INSERT_COLUMNS_1786721070000) ||
      !same(check.update_cols, AI_INPUT_REQUEST_UPDATE_COLUMNS_1786721070000) ||
      check.can_select !== true ||
      check.can_delete !== false ||
      check.can_truncate !== false ||
      check.app_update_input_ref !== false ||
      check.triggers !== 1 ||
      check.guard_ok !== true ||
      typeof check.status_check !== 'string' ||
      !AI_TURN_STATUSES_1786721070000.every((s) => (check.status_check as string).includes(`'${s}'`)) ||
      check.app_bypass !== false
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL row_security = off`);
    const [{ n }] = (await runner.query(
      `SELECT ((SELECT count(*) FROM ${TABLE}) + (SELECT count(*) FROM core.ai_message WHERE status = 'waiting_for_input' OR continuation_input_ref IS NOT NULL))::int AS n`,
    )) as Array<{ n: number }>;
    await runner.query(`SET LOCAL row_security = on`);
    if (n > 0) throw new Error(`${this.name}: ${n} input request(s), waiting turn(s) or input continuation(s) exist; down() refuses to drop them`);
    await runner.query(`DROP INDEX IF EXISTS core.ai_message_one_input_continuation;`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_role_status_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_role_status_check CHECK (${ROLE_CHECK_5B});`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT IF EXISTS ai_message_continuation_input_ref_fkey;`);
    await runner.query(`ALTER TABLE core.ai_message DROP COLUMN IF EXISTS continuation_input_ref;`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT IF EXISTS ai_message_waiting_check;`);
    await runner.query(`ALTER TABLE core.ai_message DROP CONSTRAINT ai_message_status_check;`);
    await runner.query(`ALTER TABLE core.ai_message ADD CONSTRAINT ai_message_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'));`);
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_input_request_guard();`);
  }
}
