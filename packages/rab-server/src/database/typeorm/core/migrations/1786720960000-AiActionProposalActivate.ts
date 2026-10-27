import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 5a — activates the INERT `core.ai_action_proposal` (AiPhase1Schema1786720220000) for human-approved AI writes
 * (docs/ai/PHASE5_TWENTY_PLAN.md §3 M1, resolution X-1: the turn = the assistant `core.ai_message` row).
 *
 * The earlier migration's post-condition ("no INSERT, no UPDATE grant") stays true for its point in history and is never
 * edited; this migration supersedes it with its own post-condition below.
 *
 * Layers this migration adds (the application layers are AiProposalService / AiProposalExecutorService):
 *   - Columns for the proposal lifecycle; `turn_id` + `conversation_id` → `ai_message(id, conversation_id)` CASCADE, so a
 *     proposal can never reference another conversation's turn and leaves with its conversation (retention, erasure).
 *   - CHECKs: the three write tools only (a new one = a reviewed migration); no tenant / user / status / pay key in the
 *     arguments; 15-minute expiry fixed at insert; decision bookkeeping; high impact ⇒ a reason once approved; more than 10
 *     people affected ⇒ high impact (the runtime role cannot store a large proposal as "normal").
 *   - Trigger `core.ai_action_proposal_guard()` (BEFORE UPDATE, SECURITY INVOKER, fixed search_path): only the
 *     `@rab/shared` AI_PROPOSAL_TRANSITIONS edges; identity, content and expiry immutable; the decider is always the bound
 *     user AND the proposal's owner; APPROVED only before expiry, EXPIRED only after it.
 *   - Per-command policies (layer 4 owner predicate; layer 5 `core.ai_actor_eligible()` on every write; INSERT only as
 *     PENDING and undecided). No DELETE policy, no DELETE / TRUNCATE grant: rows leave only by conversation cascade.
 *   - Column-level INSERT / UPDATE grants for `crewflow_app` (it can never set `id`, `status` on insert, `expires_at`,
 *     `created_at`, nor UPDATE any identity, content or expiry column).
 *
 * Refuses to run while the table has any row (it was inert; rows here would mean something wrote it without a grant).
 * The row checks run with `row_security = off`, so a role that is subject to RLS gets an error instead of a silently
 * filtered zero (fail closed). Not production-approved (N1, production-migration-approval.ts).
 */
const OWNER = `organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND user_id = core.current_uid()`;

/** Frozen copies (a migration never follows later code): AI_WRITE_TOOL_NAMES and the keys no argument object may carry. */
export const AI_WRITE_TOOLS_1786720960000 = ['add_staff_note', 'create_draft_shift', 'update_draft_shift'] as const;
export const AI_FORBIDDEN_ARGUMENT_KEYS_1786720960000 = [
  'organisationId',
  'organisation_id',
  'workspaceId',
  'workspace_id',
  'userId',
  'user_id',
  'status',
  'payRatePence',
  'pay_rate_pence',
  'chargeRatePence',
  'charge_rate_pence',
] as const;
export const AI_PROPOSAL_ERROR_CODES_1786720960000 = ['stale', 'not_permitted', 'not_found', 'conflict', 'invalid', 'internal'] as const;
export const AI_PROPOSAL_POLICIES_1786720960000 = ['ai_action_proposal_select', 'ai_action_proposal_insert', 'ai_action_proposal_update'] as const;
export const AI_PROPOSAL_INSERT_COLUMNS_1786720960000 = [
  'organisation_id',
  'workspace_id',
  'user_id',
  'conversation_id',
  'turn_id',
  'tool_call_id',
  'group_id',
  'tool',
  'arguments',
  'summary',
  'editable_fields',
  'target_type',
  'target_id',
  'snapshot_hash',
  'impact',
  'affected_count',
] as const;
export const AI_PROPOSAL_UPDATE_COLUMNS_1786720960000 = [
  'status',
  'decided_by',
  'decided_at',
  'decision_reason',
  'final_arguments',
  'impact',
  'affected_count',
  'result_entity_type',
  'result_entity_id',
  'executed_at',
  'error_code',
  'updated_at',
] as const;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

async function assertNoRows(runner: QueryRunner, where: string, message: string): Promise<void> {
  await runner.query(`SET LOCAL row_security = off`);
  const [row] = (await runner.query(`SELECT count(*)::int AS n FROM core.ai_action_proposal ${where}`)) as Array<{ n: number }>;
  await runner.query(`SET LOCAL row_security = on`);
  if (!row || row.n !== 0) throw new Error(message);
}

export class AiActionProposalActivate1786720960000 implements MigrationInterface {
  name = 'AiActionProposalActivate1786720960000';

  async up(runner: QueryRunner): Promise<void> {
    await assertNoRows(runner, '', `${this.name}: core.ai_action_proposal is not empty; it was inert, so a row means an unexpected writer. Refusing.`);

    // ── Columns ─────────────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        ADD COLUMN turn_id            uuid        NOT NULL,
        ADD COLUMN tool_call_id       text        NOT NULL,
        ADD COLUMN group_id           uuid,
        ADD COLUMN origin             text        NOT NULL DEFAULT 'chat',
        ADD COLUMN editable_fields    text[]      NOT NULL DEFAULT '{}',
        ADD COLUMN final_arguments    jsonb,
        ADD COLUMN target_type        text,
        ADD COLUMN target_id          uuid,
        ADD COLUMN snapshot_hash      text        NOT NULL,
        ADD COLUMN impact             text        NOT NULL DEFAULT 'normal',
        ADD COLUMN affected_count     integer     NOT NULL DEFAULT 0,
        ADD COLUMN decision_reason    text,
        ADD COLUMN result_entity_type text,
        ADD COLUMN result_entity_id   uuid,
        ADD COLUMN executed_at        timestamptz,
        ADD COLUMN error_code         text;
    `);
    // The expiry is fixed by the database at insert (the runtime role has no INSERT grant on expires_at / created_at).
    await runner.query(`ALTER TABLE core.ai_action_proposal ALTER COLUMN expires_at SET DEFAULT now() + interval '15 minutes';`);

    // ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        ADD CONSTRAINT ai_action_proposal_turn_fkey FOREIGN KEY (turn_id, conversation_id)
          REFERENCES core.ai_message(id, conversation_id) ON DELETE CASCADE;
    `);
    // An alternative's group anchor is a proposal of the SAME conversation (so the same owner).
    await runner.query(`ALTER TABLE core.ai_action_proposal ADD CONSTRAINT ai_action_proposal_id_conversation_key UNIQUE (id, conversation_id);`);
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        ADD CONSTRAINT ai_action_proposal_group_fkey FOREIGN KEY (group_id, conversation_id)
          REFERENCES core.ai_action_proposal(id, conversation_id) ON DELETE CASCADE;
    `);
    await runner.query(`CREATE UNIQUE INDEX ai_action_proposal_tool_call_key ON core.ai_action_proposal (turn_id, tool_call_id);`);
    await runner.query(`CREATE INDEX ai_action_proposal_conversation_status_idx ON core.ai_action_proposal (organisation_id, conversation_id, status, created_at DESC);`);
    await runner.query(`CREATE INDEX ai_action_proposal_group_idx ON core.ai_action_proposal (group_id) WHERE group_id IS NOT NULL;`);

    // ── CHECKs ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const forbidden = `ARRAY[${list(AI_FORBIDDEN_ARGUMENT_KEYS_1786720960000)}]::text[]`;
    const field = `[a-z][a-zA-Z0-9]{0,31}`;
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        ADD CONSTRAINT ai_action_proposal_write_tool_check CHECK (tool IN (${list(AI_WRITE_TOOLS_1786720960000)})),
        ADD CONSTRAINT ai_action_proposal_tool_call_id_check CHECK (tool_call_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        ADD CONSTRAINT ai_action_proposal_origin_check CHECK (origin IN ('chat')),
        ADD CONSTRAINT ai_action_proposal_group_check CHECK (group_id IS NULL OR group_id <> id),
        ADD CONSTRAINT ai_action_proposal_editable_fields_check CHECK (
          cardinality(editable_fields) <= 10
          AND array_position(editable_fields, NULL) IS NULL
          AND array_to_string(editable_fields, ',') ~ '^(${field}(,${field})*)?$'
        ),
        ADD CONSTRAINT ai_action_proposal_arguments_keys_check CHECK (NOT (arguments ?| ${forbidden})),
        ADD CONSTRAINT ai_action_proposal_final_arguments_check CHECK (
          final_arguments IS NULL
          OR (jsonb_typeof(final_arguments) = 'object' AND pg_column_size(final_arguments) <= 8192 AND NOT (final_arguments ?| ${forbidden}))
        ),
        ADD CONSTRAINT ai_action_proposal_target_check CHECK (
          (target_type IS NULL) = (target_id IS NULL) AND (target_type IS NULL OR target_type IN ('shift', 'staff_profile', 'venue'))
        ),
        ADD CONSTRAINT ai_action_proposal_snapshot_hash_check CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT ai_action_proposal_impact_check CHECK (impact IN ('normal', 'high')),
        ADD CONSTRAINT ai_action_proposal_affected_count_check CHECK (affected_count BETWEEN 0 AND 1000),
        -- AI_PROPOSAL_LIMITS.highImpactAboveAffected (10), frozen here: more than 10 people is ALWAYS high impact.
        ADD CONSTRAINT ai_action_proposal_high_impact_count_check CHECK (affected_count <= 10 OR impact = 'high'),
        ADD CONSTRAINT ai_action_proposal_decision_reason_check CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 3 AND 500),
        ADD CONSTRAINT ai_action_proposal_error_code_check CHECK (
          (error_code IS NULL OR error_code IN (${list(AI_PROPOSAL_ERROR_CODES_1786720960000)})) AND (status = 'FAILED') = (error_code IS NOT NULL)
        ),
        ADD CONSTRAINT ai_action_proposal_result_check CHECK (
          (result_entity_type IS NULL) = (result_entity_id IS NULL)
          AND (result_entity_type IS NULL OR result_entity_type ~ '^[a-z][a-z_]{0,39}$')
          AND (status = 'EXECUTED') = (executed_at IS NOT NULL)
          AND (status <> 'EXECUTED' OR result_entity_id IS NOT NULL)
        ),
        ADD CONSTRAINT ai_action_proposal_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
        ADD CONSTRAINT ai_action_proposal_decided_check CHECK ((status = 'PENDING') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
        ADD CONSTRAINT ai_action_proposal_final_arguments_status_check CHECK (status NOT IN ('APPROVED', 'EXECUTED') OR final_arguments IS NOT NULL),
        ADD CONSTRAINT ai_action_proposal_high_reason_check CHECK (NOT (impact = 'high' AND status IN ('APPROVED', 'EXECUTED')) OR decision_reason IS NOT NULL);
    `);

    // ── Transition + immutability trigger (mirrors @rab/shared AI_PROPOSAL_TRANSITIONS) ─────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_action_proposal_guard()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_decision boolean := OLD.status = 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status;
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
           OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
           OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id OR NEW.group_id IS DISTINCT FROM OLD.group_id
           OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.tool IS DISTINCT FROM OLD.tool
           OR NEW.arguments IS DISTINCT FROM OLD.arguments OR NEW.summary IS DISTINCT FROM OLD.summary
           OR NEW.editable_fields IS DISTINCT FROM OLD.editable_fields OR NEW.target_type IS DISTINCT FROM OLD.target_type
           OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'ai_action_proposal: identity, content and expiry are immutable' USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'FAILED'))
                  OR (OLD.status = 'APPROVED' AND NEW.status IN ('EXECUTED', 'FAILED'))) THEN
            RAISE EXCEPTION 'ai_action_proposal: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.status = 'APPROVED' AND NEW.expires_at <= pg_catalog.now() THEN
            RAISE EXCEPTION 'ai_action_proposal: expired proposals cannot be approved' USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.status = 'EXPIRED' AND NEW.expires_at > pg_catalog.now() THEN
            RAISE EXCEPTION 'ai_action_proposal: not expired yet' USING ERRCODE = 'check_violation';
          END IF;
        END IF;

        -- The decision (from PENDING) is made by the bound user, who must be the proposal's owner; afterwards the
        -- decider and the decision time never change.
        IF v_decision THEN
          IF NEW.decided_by IS NULL OR NEW.decided_by IS DISTINCT FROM core.current_uid() OR NEW.decided_by IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'ai_action_proposal: only the proposal owner decides' USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
              OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
          RAISE EXCEPTION 'ai_action_proposal: the decision is immutable' USING ERRCODE = 'check_violation';
        END IF;

        IF (NEW.final_arguments IS DISTINCT FROM OLD.final_arguments OR NEW.impact IS DISTINCT FROM OLD.impact
            OR NEW.affected_count IS DISTINCT FROM OLD.affected_count)
           AND NOT (OLD.status = 'PENDING' AND NEW.status = 'APPROVED') THEN
          RAISE EXCEPTION 'ai_action_proposal: final arguments and impact change only on approval' USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.result_entity_type IS DISTINCT FROM OLD.result_entity_type OR NEW.result_entity_id IS DISTINCT FROM OLD.result_entity_id
            OR NEW.executed_at IS DISTINCT FROM OLD.executed_at)
           AND NOT (OLD.status = 'APPROVED' AND NEW.status = 'EXECUTED') THEN
          RAISE EXCEPTION 'ai_action_proposal: the result is written only on execution' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.error_code IS DISTINCT FROM OLD.error_code AND NOT (NEW.status = 'FAILED' AND OLD.status <> 'FAILED') THEN
          RAISE EXCEPTION 'ai_action_proposal: the error code is written only on failure' USING ERRCODE = 'check_violation';
        END IF;

        NEW.updated_at := pg_catalog.now();
        RETURN NEW;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_action_proposal_guard() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_action_proposal_guard() FROM PUBLIC;`);
    await runner.query(`CREATE TRIGGER ai_action_proposal_guard BEFORE UPDATE ON core.ai_action_proposal FOR EACH ROW EXECUTE FUNCTION core.ai_action_proposal_guard();`);

    // ── Policies (layer 4 owner predicate, layer 5 eligibility on writes) ───────────────────────────────────────────
    await runner.query(`DROP POLICY ai_action_proposal_owner ON core.ai_action_proposal;`);
    await runner.query(`CREATE POLICY ai_action_proposal_select ON core.ai_action_proposal FOR SELECT USING (${OWNER});`);
    await runner.query(
      `CREATE POLICY ai_action_proposal_insert ON core.ai_action_proposal FOR INSERT WITH CHECK (${OWNER} AND core.ai_actor_eligible() AND status = 'PENDING' AND decided_by IS NULL);`,
    );
    await runner.query(`CREATE POLICY ai_action_proposal_update ON core.ai_action_proposal FOR UPDATE USING (${OWNER}) WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);

    // ── Grants (column level; still no DELETE, no TRUNCATE) ─────────────────────────────────────────────────────────
    await runner.query(`REVOKE ALL ON core.ai_action_proposal FROM crewflow_app;`);
    await runner.query(`GRANT SELECT ON core.ai_action_proposal TO crewflow_app;`);
    await runner.query(`GRANT INSERT (${AI_PROPOSAL_INSERT_COLUMNS_1786720960000.join(', ')}) ON core.ai_action_proposal TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (${AI_PROPOSAL_UPDATE_COLUMNS_1786720960000.join(', ')}) ON core.ai_action_proposal TO crewflow_app;`);

    await this.verify(runner);
  }

  /** Refuse to record the migration on drift (supersedes the inert assertions of AiPhase1Schema1786720220000). */
  private async verify(runner: QueryRunner): Promise<void> {
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c WHERE c.oid = 'core.ai_action_proposal'::regclass) AS forced,
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_action_proposal') AS policies,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'ai_action_proposal' AND privilege_type = 'INSERT') AS insert_cols,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'ai_action_proposal' AND privilege_type = 'UPDATE') AS update_cols,
         has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'SELECT') AS can_select,
         has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'DELETE') AS can_delete,
         has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'TRUNCATE') AS can_truncate,
         (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'core.ai_action_proposal'::regclass AND t.tgname = 'ai_action_proposal_guard' AND t.tgenabled = 'O') AS triggers,
         (SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner) = 'crewflow'
            FROM pg_proc p WHERE p.oid = 'core.ai_action_proposal_guard()'::regprocedure) AS guard_ok,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, unknown>>;
    const same = (a: unknown, b: readonly string[]) => JSON.stringify(a) === JSON.stringify([...b].sort());
    if (
      check?.forced !== true ||
      !same(check.policies, AI_PROPOSAL_POLICIES_1786720960000) ||
      !same(check.insert_cols, AI_PROPOSAL_INSERT_COLUMNS_1786720960000) ||
      !same(check.update_cols, AI_PROPOSAL_UPDATE_COLUMNS_1786720960000) ||
      check.can_select !== true ||
      check.can_delete !== false ||
      check.can_truncate !== false ||
      check.triggers !== 1 ||
      check.guard_ok !== true ||
      check.app_bypass !== false
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  /**
   * Refuses while any proposal is PENDING or APPROVED (a decision could still be in flight). Otherwise the terminal rows
   * are deleted (the audit log keeps the facts: ai.proposal_* rows) and the table returns to its inert Phase 1 shape.
   */
  async down(runner: QueryRunner): Promise<void> {
    await assertNoRows(runner, `WHERE status IN ('PENDING', 'APPROVED')`, `${this.name}: PENDING or APPROVED proposals exist; let them expire or decide them first. Refusing.`);
    await runner.query(`SET LOCAL row_security = off`);
    await runner.query(`DELETE FROM core.ai_action_proposal`);
    await runner.query(`SET LOCAL row_security = on`);

    await runner.query(`REVOKE ALL ON core.ai_action_proposal FROM crewflow_app;`);
    await runner.query(`GRANT SELECT ON core.ai_action_proposal TO crewflow_app;`);
    for (const p of AI_PROPOSAL_POLICIES_1786720960000) await runner.query(`DROP POLICY IF EXISTS ${p} ON core.ai_action_proposal;`);
    await runner.query(`CREATE POLICY ai_action_proposal_owner ON core.ai_action_proposal FOR ALL USING (${OWNER}) WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);
    await runner.query(`DROP TRIGGER IF EXISTS ai_action_proposal_guard ON core.ai_action_proposal;`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_action_proposal_guard();`);
    await runner.query(`DROP INDEX IF EXISTS core.ai_action_proposal_group_idx;`);
    await runner.query(`DROP INDEX IF EXISTS core.ai_action_proposal_conversation_status_idx;`);
    await runner.query(`DROP INDEX IF EXISTS core.ai_action_proposal_tool_call_key;`);
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        DROP CONSTRAINT IF EXISTS ai_action_proposal_group_fkey,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_id_conversation_key,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_turn_fkey,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_write_tool_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_tool_call_id_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_origin_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_group_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_editable_fields_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_arguments_keys_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_final_arguments_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_target_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_snapshot_hash_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_impact_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_affected_count_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_high_impact_count_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_decision_reason_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_error_code_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_result_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_expiry_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_decided_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_final_arguments_status_check,
        DROP CONSTRAINT IF EXISTS ai_action_proposal_high_reason_check;
    `);
    await runner.query(`ALTER TABLE core.ai_action_proposal ALTER COLUMN expires_at DROP DEFAULT;`);
    await runner.query(`
      ALTER TABLE core.ai_action_proposal
        DROP COLUMN turn_id, DROP COLUMN tool_call_id, DROP COLUMN group_id, DROP COLUMN origin, DROP COLUMN editable_fields,
        DROP COLUMN final_arguments, DROP COLUMN target_type, DROP COLUMN target_id, DROP COLUMN snapshot_hash, DROP COLUMN impact,
        DROP COLUMN affected_count, DROP COLUMN decision_reason, DROP COLUMN result_entity_type, DROP COLUMN result_entity_id,
        DROP COLUMN executed_at, DROP COLUMN error_code;
    `);
  }
}
