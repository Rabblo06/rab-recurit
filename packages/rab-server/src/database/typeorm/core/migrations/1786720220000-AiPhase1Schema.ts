import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 1 schema (docs/ai/PHASE1_PLAN.md §3, docs/ai/CREWFLOW_AI_SECURITY_AUDIT.md). One migration, every table's RLS
 * in the SAME migration that creates it (CLAUDE.md).
 *
 * Tables (all `core`, all tenant-scoped, all ENABLE + FORCE RLS, all owned by `crewflow`):
 *   organisation_ai_setting — the per-organisation AI switch. No row ⇒ OFF (default). Readable by the bound organisation;
 *                             INSERT/UPDATE only when the bound user is an ACTIVE platform administrator (the database
 *                             refuses a tenant write even if application code attempted one). There is no generic
 *                             feature-flag table to reuse: organisation settings are columns on `core.organisation`,
 *                             which is NOT FORCE and on which `crewflow_app` holds table-wide UPDATE, so a column there
 *                             could be flipped by any tenant-bound write path. A dedicated FORCE table makes "platform
 *                             admin only" a database rule.
 *   ai_conversation        — one row per conversation, bound to (organisation, workspace, user) by composite FKs.
 *   ai_message             — user and assistant turns; child FK on (conversation_id, organisation_id, workspace_id,
 *                             user_id), so a message can never reference another tenant's or user's conversation.
 *   ai_usage_daily         — token/turn counters per organisation per UTC day (metadata only, never content).
 *   ai_action_proposal     — INERT Phase-3 schema: the runtime role may only SELECT it; there is no INSERT/UPDATE grant
 *                             and no code path. Activating it is a later, separately approved migration.
 *
 * Visibility (layer 4 = the owner predicate, layer 5 = eligibility on writes):
 *   - conversation / message / proposal rows are visible ONLY when organisation, workspace AND user equal the bound
 *     context. A platform administrator gets NO policy branch here: admin reads go through `core.ai_admin_usage_summary`
 *     (counts only) and never return content. Admin Inspect is refused by the service before any query.
 *   - INSERT additionally requires `core.ai_actor_eligible()`: the bound user is the organisation's CEO or its CURRENT
 *     Initial Manager (owner decision; same predicate as ManagerMarkPaidInitialManagerCalendar1786719300000).
 *   - Retention: DELETE/SELECT for the purge run only inside `core.ai_purge_expired_conversations` (SECURITY DEFINER,
 *     owner crewflow), which binds `rab.ai_retention=on` for its own statements; the retention policies require
 *     `current_user = 'crewflow'` AND that flag AND the bound organisation. `crewflow_app` cannot satisfy it (it is not
 *     crewflow) and has no DELETE on messages at all.
 *   - With no tenant context bound every predicate is NULL ⇒ zero rows (fail closed).
 *
 * Grants: least privilege, UPDATE restricted to the mutable columns (identity/tenant columns are never updatable by the
 * runtime role). No TRUNCATE. User erasure: `core.user` DELETE cascades through the composite FKs.
 *
 * Bounded content: titles ≤ 120 chars, messages ≤ 16 000 chars, ≤ 200 messages per conversation, tool metadata ≤ 8 KB.
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
const OWNER = `organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND user_id = core.current_uid()`;
const RETENTION = `organisation_id = core.current_org() AND current_user = 'crewflow' AND current_setting('rab.ai_retention', true) = 'on'`;

export const AI_ERROR_CODES_1786720220000: readonly string[] = [
  'AI_ACCESS_REVOKED',
  'AI_MODEL_TIMEOUT',
  'AI_MODEL_ERROR',
  'AI_TURN_TOKEN_LIMIT',
  'AI_WORKER_INTERRUPTED',
  'AI_SERVICE_UNAVAILABLE',
  'AI_INTERNAL_ERROR',
  'AI_BUDGET_EXHAUSTED',
];

export const AI_TABLES_1786720220000 = ['organisation_ai_setting', 'ai_conversation', 'ai_message', 'ai_usage_daily', 'ai_action_proposal'] as const;

export class AiPhase1Schema1786720220000 implements MigrationInterface {
  name = 'AiPhase1Schema1786720220000';

  async up(runner: QueryRunner): Promise<void> {
    // ── Eligibility predicate (layer 5) ─────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_actor_eligible()
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
        SELECT EXISTS (
          SELECT 1 FROM core.manager_profile mp
           WHERE mp.user_id = core.current_uid()
             AND mp.organisation_id = core.current_org()
             AND mp.archived_at IS NULL
             AND (mp.type = 'ceo' OR (mp.type = 'internal' AND mp.is_initial_manager AND mp.superseded_at IS NULL))
        )
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_actor_eligible() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_actor_eligible() FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_actor_eligible() TO crewflow, crewflow_app;`);

    // ── organisation_ai_setting ─────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE core.organisation_ai_setting (
        organisation_id uuid        PRIMARY KEY REFERENCES core.organisation(id) ON DELETE CASCADE,
        enabled         boolean     NOT NULL DEFAULT false,
        updated_by      uuid,
        reason          text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_ai_setting_reason_check CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500)
      );
    `);

    // ── ai_conversation ─────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE core.ai_conversation (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid        NOT NULL,
        user_id          uuid        NOT NULL,
        title            text,
        message_count    integer     NOT NULL DEFAULT 0,
        last_message_at  timestamptz NOT NULL DEFAULT now(),
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_conversation_user_fkey FOREIGN KEY (user_id, organisation_id)
          REFERENCES core."user"(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_conversation_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
          REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_conversation_scope_key UNIQUE (id, organisation_id, workspace_id, user_id),
        CONSTRAINT ai_conversation_title_check CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
        CONSTRAINT ai_conversation_message_count_check CHECK (message_count BETWEEN 0 AND 200)
      );
    `);
    await runner.query(`CREATE INDEX ai_conversation_owner_recent_idx ON core.ai_conversation (organisation_id, workspace_id, user_id, last_message_at DESC, id DESC);`);
    await runner.query(`CREATE INDEX ai_conversation_retention_idx ON core.ai_conversation (organisation_id, last_message_at);`);

    // ── ai_message ──────────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE core.ai_message (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id     uuid        NOT NULL,
        workspace_id        uuid        NOT NULL,
        user_id             uuid        NOT NULL,
        conversation_id     uuid        NOT NULL,
        seq                 integer     NOT NULL,
        role                text        NOT NULL,
        status              text,
        content             text        NOT NULL DEFAULT '',
        client_request_id   uuid,
        request_message_id  uuid,
        tool_calls          jsonb       NOT NULL DEFAULT '[]'::jsonb,
        input_tokens        integer,
        output_tokens       integer,
        reserved_tokens     integer     NOT NULL DEFAULT 0,
        session_id          uuid,
        model               text,
        error_code          text,
        lease_token         uuid,
        lease_expires_at    timestamptz,
        cancel_requested_at timestamptz,
        started_at          timestamptz,
        completed_at        timestamptz,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_message_conversation_fkey FOREIGN KEY (conversation_id, organisation_id, workspace_id, user_id)
          REFERENCES core.ai_conversation(id, organisation_id, workspace_id, user_id) ON DELETE CASCADE,
        CONSTRAINT ai_message_seq_key UNIQUE (conversation_id, seq),
        CONSTRAINT ai_message_id_conversation_key UNIQUE (id, conversation_id),
        CONSTRAINT ai_message_request_fkey FOREIGN KEY (request_message_id, conversation_id)
          REFERENCES core.ai_message(id, conversation_id) ON DELETE CASCADE,
        CONSTRAINT ai_message_seq_check CHECK (seq BETWEEN 1 AND 200),
        CONSTRAINT ai_message_role_check CHECK (role IN ('user', 'assistant')),
        -- The assistant-turn state machine (@rab/shared AI_TURN_TRANSITIONS); a user message has no state (NULL).
        CONSTRAINT ai_message_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        CONSTRAINT ai_message_role_status_check CHECK (
          (role = 'user' AND status IS NULL AND request_message_id IS NULL)
          OR (role = 'assistant' AND status IS NOT NULL AND request_message_id IS NOT NULL AND client_request_id IS NULL AND session_id IS NOT NULL)
        ),
        CONSTRAINT ai_message_content_check CHECK (length(content) <= 16000),
        CONSTRAINT ai_message_tool_calls_check CHECK (jsonb_typeof(tool_calls) = 'array' AND pg_column_size(tool_calls) <= 8192),
        CONSTRAINT ai_message_tokens_check CHECK (coalesce(input_tokens, 0) >= 0 AND coalesce(output_tokens, 0) >= 0 AND reserved_tokens >= 0),
        CONSTRAINT ai_message_model_check CHECK (model IS NULL OR model ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
        CONSTRAINT ai_message_error_code_check CHECK (error_code IS NULL OR error_code IN (${AI_ERROR_CODES_1786720220000.map((c) => `'${c}'`).join(', ')}))
      );
    `);
    await runner.query(`CREATE UNIQUE INDEX ai_message_client_request_key ON core.ai_message (conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_active_turn ON core.ai_message (conversation_id) WHERE role = 'assistant' AND status IN ('queued', 'running');`);
    await runner.query(`CREATE UNIQUE INDEX ai_message_one_reply ON core.ai_message (request_message_id) WHERE request_message_id IS NOT NULL;`);
    await runner.query(`CREATE INDEX ai_message_conversation_seq_idx ON core.ai_message (organisation_id, conversation_id, seq);`);

    // ── ai_usage_daily ──────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE core.ai_usage_daily (
        organisation_id  uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        usage_date       date        NOT NULL,
        input_tokens     bigint      NOT NULL DEFAULT 0,
        output_tokens    bigint      NOT NULL DEFAULT 0,
        turns            integer     NOT NULL DEFAULT 0,
        failed_turns     integer     NOT NULL DEFAULT 0,
        cancelled_turns  integer     NOT NULL DEFAULT 0,
        tool_calls       integer     NOT NULL DEFAULT 0,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organisation_id, usage_date),
        CONSTRAINT ai_usage_daily_counts_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND turns >= 0 AND failed_turns >= 0 AND cancelled_turns >= 0 AND tool_calls >= 0)
      );
    `);

    // ── ai_action_proposal (INERT) ──────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE core.ai_action_proposal (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid        NOT NULL,
        workspace_id     uuid        NOT NULL,
        user_id          uuid        NOT NULL,
        conversation_id  uuid        NOT NULL,
        tool             text        NOT NULL,
        arguments        jsonb       NOT NULL,
        summary          text        NOT NULL,
        status           text        NOT NULL DEFAULT 'PENDING',
        decided_by       uuid,
        decided_at       timestamptz,
        expires_at       timestamptz NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_action_proposal_conversation_fkey FOREIGN KEY (conversation_id, organisation_id, workspace_id, user_id)
          REFERENCES core.ai_conversation(id, organisation_id, workspace_id, user_id) ON DELETE CASCADE,
        CONSTRAINT ai_action_proposal_tool_check CHECK (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
        CONSTRAINT ai_action_proposal_arguments_check CHECK (jsonb_typeof(arguments) = 'object' AND pg_column_size(arguments) <= 8192),
        CONSTRAINT ai_action_proposal_summary_check CHECK (length(summary) BETWEEN 1 AND 2000),
        CONSTRAINT ai_action_proposal_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'EXPIRED'))
      );
    `);
    await runner.query(`CREATE INDEX ai_action_proposal_owner_idx ON core.ai_action_proposal (organisation_id, workspace_id, user_id, created_at DESC);`);

    // ── Ownership + RLS (same migration) ────────────────────────────────────────────────────────────────────────────
    // Owner: crewflow, like every ordinary FORCE-RLS tenant table (phase-B migrations run as the bootstrap superuser, so
    // ownership is stated explicitly — migration-object-ownership.spec). The retention function relies on it.
    await runner.query(`ALTER TABLE core.organisation_ai_setting OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE core.ai_conversation OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE core.ai_message OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE core.ai_usage_daily OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE core.ai_action_proposal OWNER TO crewflow;`);
    for (const t of AI_TABLES_1786720220000) {
      await runner.query(`ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY;`);
      await runner.query(`ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY;`);
      await runner.query(`REVOKE ALL ON core.${t} FROM PUBLIC;`);
      await runner.query(`REVOKE ALL ON core.${t} FROM crewflow_app;`);
    }

    // organisation_ai_setting: read by the bound organisation; written only by an active platform administrator.
    const adminWrite = `organisation_id = core.current_org() AND core.is_active_platform_admin(core.current_uid())`;
    await runner.query(`CREATE POLICY organisation_ai_setting_read ON core.organisation_ai_setting FOR SELECT USING (organisation_id = core.current_org());`);
    await runner.query(`CREATE POLICY organisation_ai_setting_admin_insert ON core.organisation_ai_setting FOR INSERT WITH CHECK (${adminWrite});`);
    await runner.query(`CREATE POLICY organisation_ai_setting_admin_update ON core.organisation_ai_setting FOR UPDATE USING (${adminWrite}) WITH CHECK (${adminWrite});`);
    await runner.query(`GRANT SELECT, INSERT ON core.organisation_ai_setting TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (enabled, updated_by, reason, updated_at) ON core.organisation_ai_setting TO crewflow_app;`);

    // ai_conversation
    await runner.query(`CREATE POLICY ai_conversation_owner_select ON core.ai_conversation FOR SELECT USING (${OWNER});`);
    await runner.query(`CREATE POLICY ai_conversation_owner_insert ON core.ai_conversation FOR INSERT WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);
    await runner.query(`CREATE POLICY ai_conversation_owner_update ON core.ai_conversation FOR UPDATE USING (${OWNER}) WITH CHECK (${OWNER});`);
    await runner.query(`CREATE POLICY ai_conversation_owner_delete ON core.ai_conversation FOR DELETE USING (${OWNER});`);
    await runner.query(`CREATE POLICY ai_conversation_retention_select ON core.ai_conversation FOR SELECT USING (${RETENTION});`);
    await runner.query(`CREATE POLICY ai_conversation_retention_delete ON core.ai_conversation FOR DELETE USING (${RETENTION});`);
    await runner.query(`GRANT SELECT, INSERT, DELETE ON core.ai_conversation TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (title, message_count, last_message_at, updated_at) ON core.ai_conversation TO crewflow_app;`);

    // ai_message (no DELETE: rows leave only by conversation cascade)
    await runner.query(`CREATE POLICY ai_message_owner_select ON core.ai_message FOR SELECT USING (${OWNER});`);
    await runner.query(`CREATE POLICY ai_message_owner_insert ON core.ai_message FOR INSERT WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);
    await runner.query(`CREATE POLICY ai_message_owner_update ON core.ai_message FOR UPDATE USING (${OWNER}) WITH CHECK (${OWNER});`);
    await runner.query(`CREATE POLICY ai_message_retention_select ON core.ai_message FOR SELECT USING (${RETENTION});`);
    await runner.query(`GRANT SELECT, INSERT ON core.ai_message TO crewflow_app;`);
    await runner.query(
      `GRANT UPDATE (status, content, tool_calls, input_tokens, output_tokens, model, error_code, lease_token, lease_expires_at, cancel_requested_at, started_at, completed_at, updated_at) ON core.ai_message TO crewflow_app;`,
    );

    // ai_usage_daily (organisation-level metadata)
    await runner.query(`CREATE POLICY ai_usage_daily_tenant ON core.ai_usage_daily FOR ALL USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());`);
    await runner.query(`GRANT SELECT, INSERT ON core.ai_usage_daily TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (input_tokens, output_tokens, turns, failed_turns, cancelled_turns, tool_calls, updated_at) ON core.ai_usage_daily TO crewflow_app;`);

    // ai_action_proposal (INERT: SELECT only)
    await runner.query(`CREATE POLICY ai_action_proposal_owner ON core.ai_action_proposal FOR ALL USING (${OWNER}) WITH CHECK (${OWNER} AND core.ai_actor_eligible());`);
    await runner.query(`GRANT SELECT ON core.ai_action_proposal TO crewflow_app;`);

    // ── Retention purge (authorised worker function, organisation-bound) ────────────────────────────────────────────
    // p_retention: age since the conversation's last message, at least 30 days (hard floor below, refused otherwise).
    // p_batch: conversations per call, 1..1000. p_dry_run: true (or NULL) = COUNT what would be purged, delete nothing
    // (AI_RETENTION_MODE=report); false = delete (AI_RETENTION_MODE=purge). Only the BOUND organisation is ever touched
    // (no context → 0), and a conversation with a queued/running turn is never purged.
    await runner.query(`
      CREATE FUNCTION core.ai_purge_expired_conversations(p_retention interval, p_batch integer, p_dry_run boolean)
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
        -- never purge conversations younger than 30 days (interval '0' would otherwise mean "everything").
        IF p_retention IS NULL OR p_retention < interval '30 days' THEN
          RAISE EXCEPTION 'ai_purge_expired_conversations: retention must be at least 30 days' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF p_batch IS NULL OR p_batch < 1 OR p_batch > 1000 THEN
          RAISE EXCEPTION 'ai_purge_expired_conversations: batch must be 1..1000' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_org IS NULL THEN RETURN 0; END IF;
        PERFORM pg_catalog.set_config('rab.ai_retention', 'on', true);
        IF coalesce(p_dry_run, true) THEN
          SELECT count(*)::integer INTO v_n FROM core.ai_conversation c
           WHERE c.organisation_id = v_org AND c.last_message_at < pg_catalog.now() - p_retention
             AND NOT EXISTS (SELECT 1 FROM core.ai_message m WHERE m.conversation_id = c.id AND m.status IN ('queued', 'running'));
        ELSE
          DELETE FROM core.ai_conversation c
           WHERE c.id IN (SELECT x.id FROM core.ai_conversation x
                           WHERE x.organisation_id = v_org AND x.last_message_at < pg_catalog.now() - p_retention
                             AND NOT EXISTS (SELECT 1 FROM core.ai_message m WHERE m.conversation_id = x.id AND m.status IN ('queued', 'running'))
                           ORDER BY x.last_message_at
                           LIMIT p_batch)
             AND c.organisation_id = v_org;
          -- No FOR UPDATE in the subquery: under FORCE RLS a row lock needs an UPDATE policy, which the retention path
          -- deliberately does not have. The DELETE locks its own rows; a concurrent cycle simply deletes nothing twice.
          GET DIAGNOSTICS v_n = ROW_COUNT;
        END IF;
        PERFORM pg_catalog.set_config('rab.ai_retention', '', true);
        RETURN v_n;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_purge_expired_conversations(interval, integer, boolean) OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_purge_expired_conversations(interval, integer, boolean) FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_purge_expired_conversations(interval, integer, boolean) TO crewflow_app;`);

    // ── Platform-admin usage metadata (counts only, never content) ──────────────────────────────────────────────────
    await runner.query(`GRANT SELECT ON core.ai_usage_daily, core.organisation_ai_setting TO rab_secure_owner;`);
    await runner.query(`
      CREATE FUNCTION core.ai_admin_usage_summary(p_from date, p_to date, p_limit integer)
      RETURNS TABLE ("organisationId" uuid, "organisationName" text, "aiEnabled" boolean, "inputTokens" bigint, "outputTokens" bigint,
                     "turns" bigint, "failedTurns" bigint, "cancelledTurns" bigint, "toolCalls" bigint)
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
                 coalesce(sum(u.cancelled_turns), 0)::bigint AS cancelled_turns, coalesce(sum(u.tool_calls), 0)::bigint AS tool_calls
            INTO v_row
            FROM core.ai_usage_daily u
           WHERE u.organisation_id = v_org.id AND u.usage_date BETWEEN p_from AND p_to;
          IF v_row.enabled OR v_row.turns > 0 THEN
            v_count := v_count + 1;
            "organisationId" := v_org.id; "organisationName" := v_org.name; "aiEnabled" := v_row.enabled;
            "inputTokens" := v_row.input_tokens; "outputTokens" := v_row.output_tokens; "turns" := v_row.turns;
            "failedTurns" := v_row.failed_turns; "cancelledTurns" := v_row.cancelled_turns; "toolCalls" := v_row.tool_calls;
            RETURN NEXT;
          END IF;
        END LOOP;
        PERFORM pg_catalog.set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_admin_usage_summary(date, date, integer) OWNER TO rab_secure_owner;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_admin_usage_summary(date, date, integer) FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_admin_usage_summary(date, date, integer) TO crewflow_app;`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity
             AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         has_table_privilege('crewflow_app', 'core.ai_message', 'DELETE') AS msg_delete,
         has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'INSERT') AS proposal_insert,
         has_any_column_privilege('crewflow_app', 'core.ai_action_proposal', 'UPDATE') AS proposal_update,
         has_table_privilege('crewflow_app', 'core.ai_usage_daily', 'DELETE') AS usage_delete,
         has_column_privilege('crewflow_app', 'core.ai_message', 'organisation_id', 'UPDATE') AS msg_tenant_update,
         has_column_privilege('crewflow_app', 'core.ai_conversation', 'user_id', 'UPDATE') AS conv_owner_update,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
      [AI_TABLES_1786720220000],
    )) as Array<Record<string, number | boolean>>;
    if (
      check.forced !== AI_TABLES_1786720220000.length ||
      check.msg_delete || check.proposal_insert || check.proposal_update || check.usage_delete ||
      check.msg_tenant_update || check.conv_owner_update || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_admin_usage_summary(date, date, integer);`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_purge_expired_conversations(interval, integer, boolean);`);
    await runner.query(`DROP TABLE IF EXISTS core.ai_action_proposal;`);
    await runner.query(`DROP TABLE IF EXISTS core.ai_usage_daily;`);
    await runner.query(`DROP TABLE IF EXISTS core.ai_message;`);
    await runner.query(`DROP TABLE IF EXISTS core.ai_conversation;`);
    await runner.query(`DROP TABLE IF EXISTS core.organisation_ai_setting;`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_actor_eligible();`);
  }
}
