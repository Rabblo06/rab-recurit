import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 2 M1 (docs/ai/PHASE2_TWENTY_PLAN.md §2.1, §2.2, §2.5, §4): a queued second message, 2-second checkpoints and
 * model-written titles. No table is created, so no new RLS policy is needed; the existing FORCE-RLS owner policies of
 * `core.ai_message` / `core.ai_conversation` (AiPhase1Schema1786720220000) cover the new columns, and a post-condition
 * refuses to record the migration if any of that drifted.
 *
 *   1. `ai_message_one_active_turn` (one queued OR running assistant turn per conversation) is replaced by TWO partial
 *      unique indexes, so the database alone guarantees at most ONE running and ONE queued turn per conversation:
 *        ai_message_one_running_turn (conversation_id) WHERE role = 'assistant' AND status = 'running'
 *        ai_message_one_queued_turn  (conversation_id) WHERE role = 'assistant' AND status = 'queued'
 *      A racing submit or claim loses with 23505 (mapped to 409 AI_TURN_IN_PROGRESS / a deferred claim).
 *   2. `ai_message.checkpointed_at timestamptz` + `GRANT UPDATE (checkpointed_at)`: the Worker writes `content` +
 *      `tool_calls` every 2 s under the lease compare-and-set (it already holds UPDATE on both). A dead Worker leaves the
 *      last checkpoint as the partial answer (`failed / AI_WORKER_INTERRUPTED`) — the owner's own text, same RLS, same
 *      retention and erasure cascade.
 *   3. `ai_conversation.title_source text NOT NULL DEFAULT 'auto'` (CHECK auto | pending | model | user) +
 *      `GRANT UPDATE (title_source)`. Every pre-existing conversation becomes `user` (its title is never regenerated).
 *
 * Post-condition (fail closed): both tables still ENABLE + FORCE and owned by `crewflow`; `crewflow_app` has no DELETE on
 * `ai_message`, no UPDATE on any tenant/owner/identity column of either table, holds the two new column grants and has
 * no BYPASSRLS; the owner policies' predicates are byte-identical to what they were before this migration ran.
 *
 * `down()` refuses while any conversation has both a running and a queued turn (the old single index could not be built);
 * the operator cancels those first. Not production-approved (N1, production-migration-approval.ts). Other code refers to
 * this migration only through `AI_P2_MIGRATION_QUEUED_TURN_CHECKPOINT` (modules/ai/constants/ai.constants.ts).
 */
const TABLES = ['ai_message', 'ai_conversation'] as const;
const TENANT_COLUMNS = ['id', 'organisation_id', 'workspace_id', 'user_id', 'conversation_id'] as const;

interface PolicyRow {
  policyname: string;
  tablename: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

async function ownerPolicies(runner: QueryRunner): Promise<string> {
  const rows = (await runner.query(
    `SELECT policyname, tablename, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'core' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`,
    [TABLES],
  )) as PolicyRow[];
  return JSON.stringify(rows);
}

export class AiQueuedTurnCheckpoint1786720300000 implements MigrationInterface {
  name = 'AiQueuedTurnCheckpoint1786720300000';

  async up(runner: QueryRunner): Promise<void> {
    const policiesBefore = await ownerPolicies(runner);

    // ── 1. one running + one queued turn per conversation ───────────────────────────────────────────────────────────
    await runner.query(`DROP INDEX core.ai_message_one_active_turn;`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_running_turn ON core.ai_message (conversation_id) WHERE role = 'assistant' AND status = 'running';`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_queued_turn ON core.ai_message (conversation_id) WHERE role = 'assistant' AND status = 'queued';`);

    // ── 2. checkpoints ──────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.ai_message ADD COLUMN checkpointed_at timestamptz;`);
    await runner.query(`GRANT UPDATE (checkpointed_at) ON core.ai_message TO crewflow_app;`);

    // ── 3. who wrote the title ──────────────────────────────────────────────────────────────────────────────────────
    // Every conversation that exists before Phase 2 is filled with `user` by the ADD COLUMN default itself (a catalog-level
    // fill, so FORCE RLS cannot make it a silent no-op the way a context-less UPDATE would be): its title was typed by the
    // user or is the first-question fallback, and is never regenerated. New rows then default to `auto`.
    await runner.query(
      `ALTER TABLE core.ai_conversation ADD COLUMN title_source text NOT NULL DEFAULT 'user'
         CONSTRAINT ai_conversation_title_source_check CHECK (title_source IN ('auto', 'pending', 'model', 'user'));`,
    );
    await runner.query(`ALTER TABLE core.ai_conversation ALTER COLUMN title_source SET DEFAULT 'auto';`);
    await runner.query(`GRANT UPDATE (title_source) ON core.ai_conversation TO crewflow_app;`);

    // ── Post-condition (refuse to record the migration on drift) ─────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity
             AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         has_table_privilege('crewflow_app', 'core.ai_message', 'DELETE') AS msg_delete,
         has_table_privilege('crewflow_app', 'core.ai_message', 'TRUNCATE') AS msg_truncate,
         has_table_privilege('crewflow_app', 'core.ai_conversation', 'TRUNCATE') AS conv_truncate,
         (SELECT bool_or(has_column_privilege('crewflow_app', 'core.ai_message', col, 'UPDATE')) FROM unnest($2::text[]) col) AS msg_tenant_update,
         (SELECT bool_or(has_column_privilege('crewflow_app', 'core.ai_conversation', col, 'UPDATE'))
            FROM unnest($2::text[]) col WHERE col <> 'conversation_id') AS conv_tenant_update,
         has_column_privilege('crewflow_app', 'core.ai_message', 'checkpointed_at', 'UPDATE') AS checkpoint_grant,
         has_column_privilege('crewflow_app', 'core.ai_conversation', 'title_source', 'UPDATE') AS title_source_grant,
         (SELECT count(*) FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'ai_message'
           AND indexname IN ('ai_message_one_running_turn', 'ai_message_one_queued_turn'))::int AS turn_indexes,
         (SELECT count(*) FROM pg_indexes WHERE schemaname = 'core' AND indexname = 'ai_message_one_active_turn')::int AS old_index,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
      [TABLES, TENANT_COLUMNS],
    )) as Array<Record<string, number | boolean>>;
    const policiesAfter = await ownerPolicies(runner);
    if (
      check.forced !== TABLES.length ||
      check.msg_delete || check.msg_truncate || check.conv_truncate ||
      check.msg_tenant_update || check.conv_tenant_update ||
      !check.checkpoint_grant || !check.title_source_grant ||
      check.turn_indexes !== 2 || check.old_index !== 0 ||
      check.app_bypass !== false ||
      policiesAfter !== policiesBefore
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify({ ...check, policiesUnchanged: policiesAfter === policiesBefore })}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    // The single-active-turn index first (it can coexist with the two new ones): if any conversation has a running AND a
    // queued turn it cannot be built, and down() refuses with a clear message before anything else changes. The index
    // build itself is the authority (it sees every row whatever the RLS context of the migration connection).
    await runner.query(`
      DO $restore$
      BEGIN
        CREATE UNIQUE INDEX ai_message_one_active_turn ON core.ai_message (conversation_id) WHERE role = 'assistant' AND status IN ('queued', 'running');
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION '${this.name}: down() refused: a conversation has a running AND a queued turn, so the single-active-turn index cannot be rebuilt. Cancel the queued turns (or let the queue drain) first.'
          USING ERRCODE = 'unique_violation';
      END
      $restore$;`);
    await runner.query(`DROP INDEX core.ai_message_one_queued_turn;`);
    await runner.query(`DROP INDEX core.ai_message_one_running_turn;`);
    await runner.query(`REVOKE UPDATE (title_source) ON core.ai_conversation FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_conversation DROP COLUMN title_source;`);
    await runner.query(`REVOKE UPDATE (checkpointed_at) ON core.ai_message FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.ai_message DROP COLUMN checkpointed_at;`);
  }
}
