import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 6a, M6.3 (docs/ai/PHASE6_TWENTY_PLAN.md §3.1): agent DEFINITIONS AND STORAGE ONLY. The owner deferred EX-3
 * (2026-10-25): nothing in this migration can run an agent, enable a trigger, schedule a fire or record an event.
 *
 * Three tenant tables (schema `core`, owner `crewflow`, ENABLE + FORCE RLS in this migration, no TRUNCATE, no BYPASSRLS):
 *
 *  `ai_agent` — a saved prompt + model tier + role, per Manager workspace.
 *    - `name` slug `^[a-z][a-z0-9-]{1,49}$`, unique per workspace among live (not soft-deleted) agents; `label` 1..80;
 *      `description` ≤ 500; `prompt` 1..8,000 (AI_AGENT_LIMITS); `model_tier` fast|smart; `model_id` a catalogue LOOKUP
 *      key or NULL (the Phase 1 id regex; the service checks the catalogue); `response_format` 'text' only (P6-D10).
 *    - `kind` custom|standard|system. Only `custom` rows can be inserted or changed by the runtime role: `kind` is in no
 *      column grant and every write policy requires `kind = 'custom'`. Standard / system agents (none exist yet; a later
 *      migration or platform code ships them) can never be edited or deleted through the API or by crewflow_app.
 *    - `role_id` (nullable): composite FK `(role_id, workspace_id, role_is_agent)` → `role(id, workspace_id,
 *      assignable_to_agents)` with the constant `role_is_agent = true` — an agent can only reference an AGENT role of its
 *      OWN workspace (declarative, RLS-independent; RoleAssignableToAgents1786721040000 makes the flag immutable).
 *    - `config_version` is maintained by the trigger `ai_agent_config_version` (+1 when prompt, model, format or role
 *      change; otherwise kept) — never writable by the runtime role. 6b's principal compares it with the trigger snapshot.
 *    - `is_active` stays false in 6a (no grant). No DELETE grant: soft delete (`deleted_at`) only; rows leave by the
 *      organisation / workspace cascade. At most 20 live agents per workspace (`ai_agent_limit_guard`, advisory lock).
 *  `ai_agent_trigger` — a schedule (restricted DSL, P6-D5) or a record-event list (catalogue v1, P6-D3), max 5 per agent.
 *    - **EX-3 gate at layer 4:** CHECK `ai_agent_trigger_ex3_gate` = NOT enabled AND no run-as user, consent, snapshot or
 *      next fire. No row can ever be enabled until a reviewed 6b migration drops this constraint after the owner approves
 *      EX-3. The run-as / consent / snapshot / next-run columns exist (final shape) but have no UPDATE grant in 6a.
 *    - The write policy also carries the plan's `(NOT enabled OR run_as_user_id = core.current_uid())`: nobody can ever
 *      enable a trigger as someone else, even after the gate is lifted.
 *  `ai_agent_event` — the record-event outbox (6b). SELECT only for crewflow_app: no INSERT/UPDATE/DELETE grant and no
 *    write policy; the 6b SECURITY DEFINER recorder is NOT created here (no execution path in 6a).
 *
 * `core.ai_agent_writer()` (STABLE, SECURITY INVOKER, search_path pinned): the RLS writer predicate = the organisation's
 * CEO (`core.ai_settings_writer()`), one named place 6b can tighten. Reads: the bound organisation AND workspace AND
 * `core.ai_actor_eligible()` (CEO / current Initial Manager) — other managers, venue managers and staff read 0 rows; with
 * no tenant context every predicate is NULL ⇒ 0 rows.
 *
 * `organisation_ai_setting.agents_enabled boolean NOT NULL DEFAULT false` (P6-D7, the per-organisation agents switch):
 * written only under the existing platform-admin policies (no new policy); the admin route is Phase 6b / Agent 9.
 *
 * NOT here (6b, after EX-3): `ai_agent_record_event()`, `ai_agent_trigger_pause()`, `ai_agent_event_purge()`, run columns.
 * Not production-approved (N1). Dev number in Agent 6's range; Agent 9 renumbers it at the integration merge.
 */
/** Frozen copies at this migration (a unit test pins them equal to @rab/shared; a later change is a new migration). */
export const AI_AGENT_SCHEMA_EVENT_TYPES: readonly string[] = ['attendance.under_review', 'shift.cancelled', 'shift.created', 'shift.published', 'shift.staffing_changed'];
export const AI_AGENT_SCHEMA_PAUSE_REASONS: readonly string[] = [
  'owner_security_changed',
  'config_changed',
  'consent_expired',
  'owner_ineligible',
  'membership_revoked',
  'permission_revoked',
  'signed_out_everywhere',
];
export const AI_AGENT_SCHEMA_LIMITS = { promptMaxChars: 8000, labelMaxChars: 80, descriptionMaxChars: 500, agentsPerWorkspace: 20, triggersPerAgent: 5 } as const;

const AGENT = 'core.ai_agent';
const TRIGGER = 'core.ai_agent_trigger';
const EVENT = 'core.ai_agent_event';
const SCOPE = `organisation_id = core.current_org() AND workspace_id = core.current_workspace()`;
const READER = `${SCOPE} AND core.ai_actor_eligible()`;
const WRITER = `${SCOPE} AND core.ai_agent_writer()`;
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export class AiAgentSchema1786721050000 implements MigrationInterface {
  name = 'AiAgentSchema1786721050000';

  async up(runner: QueryRunner): Promise<void> {
    // ── The writer predicate ─────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_agent_writer() RETURNS boolean
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
      AS $fn$ SELECT core.ai_settings_writer() $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_agent_writer() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_agent_writer() FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION core.ai_agent_writer() TO crewflow_app;`);

    // An agent may only reference an AGENT role of its own workspace (composite FK target).
    await runner.query(`ALTER TABLE core.role ADD CONSTRAINT role_id_workspace_agent_key UNIQUE (id, workspace_id, assignable_to_agents);`);

    // ── core.ai_agent ────────────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE ${AGENT} (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid        NOT NULL,
        kind             text        NOT NULL DEFAULT 'custom',
        name             text        NOT NULL,
        label            text        NOT NULL,
        description      text,
        prompt           text        NOT NULL,
        model_tier       text        NOT NULL,
        model_id         text,
        response_format  text        NOT NULL DEFAULT 'text',
        role_id          uuid,
        role_is_agent    boolean     NOT NULL DEFAULT true,
        is_active        boolean     NOT NULL DEFAULT false,
        config_version   integer     NOT NULL DEFAULT 1,
        created_by       uuid        NOT NULL,
        updated_by       uuid        NOT NULL,
        deleted_at       timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_agent_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_role_fkey FOREIGN KEY (role_id, workspace_id, role_is_agent) REFERENCES core.role(id, workspace_id, assignable_to_agents),
        CONSTRAINT ai_agent_id_workspace_key UNIQUE (id, workspace_id),
        CONSTRAINT ai_agent_kind_check CHECK (kind IN ('custom', 'standard', 'system')),
        CONSTRAINT ai_agent_name_check CHECK (name ~ '^[a-z][a-z0-9-]{1,49}$'),
        CONSTRAINT ai_agent_label_check CHECK (length(btrim(label)) BETWEEN 1 AND ${AI_AGENT_SCHEMA_LIMITS.labelMaxChars} AND length(label) <= ${AI_AGENT_SCHEMA_LIMITS.labelMaxChars}),
        CONSTRAINT ai_agent_description_check CHECK (description IS NULL OR length(description) <= ${AI_AGENT_SCHEMA_LIMITS.descriptionMaxChars}),
        CONSTRAINT ai_agent_prompt_check CHECK (length(btrim(prompt)) >= 1 AND length(prompt) <= ${AI_AGENT_SCHEMA_LIMITS.promptMaxChars}),
        CONSTRAINT ai_agent_model_tier_check CHECK (model_tier IN ('fast', 'smart')),
        CONSTRAINT ai_agent_model_id_check CHECK (model_id IS NULL OR model_id ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
        CONSTRAINT ai_agent_response_format_check CHECK (response_format = 'text'),
        CONSTRAINT ai_agent_role_is_agent_check CHECK (role_is_agent),
        CONSTRAINT ai_agent_config_version_check CHECK (config_version > 0)
      );
    `);
    await runner.query(`CREATE UNIQUE INDEX ai_agent_workspace_name_live_key ON ${AGENT} (workspace_id, name) WHERE deleted_at IS NULL;`);
    await runner.query(`CREATE INDEX ai_agent_role_idx ON ${AGENT} (role_id) WHERE role_id IS NOT NULL;`);
    await runner.query(`ALTER TABLE ${AGENT} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${AGENT} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${AGENT} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${AGENT} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${AGENT} FROM crewflow_app;`);
    await runner.query(`CREATE POLICY ai_agent_read ON ${AGENT} FOR SELECT USING (${READER});`);
    await runner.query(
      `CREATE POLICY ai_agent_insert ON ${AGENT} FOR INSERT WITH CHECK (${WRITER} AND kind = 'custom' AND deleted_at IS NULL AND created_by = core.current_uid() AND updated_by = core.current_uid());`,
    );
    await runner.query(
      `CREATE POLICY ai_agent_update ON ${AGENT} FOR UPDATE USING (${WRITER} AND kind = 'custom' AND deleted_at IS NULL) WITH CHECK (${WRITER} AND kind = 'custom' AND updated_by = core.current_uid());`,
    );
    await runner.query(`GRANT SELECT ON ${AGENT} TO crewflow_app;`);
    await runner.query(
      `GRANT INSERT (organisation_id, workspace_id, name, label, description, prompt, model_tier, model_id, response_format, role_id, created_by, updated_by) ON ${AGENT} TO crewflow_app;`,
    );
    await runner.query(`GRANT UPDATE (label, description, prompt, model_tier, model_id, response_format, role_id, updated_by, updated_at, deleted_at) ON ${AGENT} TO crewflow_app;`);

    // config_version: server-maintained, unforgeable (+1 when the run-relevant configuration changes).
    await runner.query(`
      CREATE FUNCTION core.ai_agent_config_version() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
      BEGIN
        IF NEW.prompt IS DISTINCT FROM OLD.prompt OR NEW.model_tier IS DISTINCT FROM OLD.model_tier OR NEW.model_id IS DISTINCT FROM OLD.model_id
           OR NEW.response_format IS DISTINCT FROM OLD.response_format OR NEW.role_id IS DISTINCT FROM OLD.role_id THEN
          NEW.config_version := OLD.config_version + 1;
        ELSE
          NEW.config_version := OLD.config_version;
        END IF;
        RETURN NEW;
      END
      $fn$;
    `);
    await runner.query(`CREATE TRIGGER ai_agent_config_version BEFORE UPDATE ON ${AGENT} FOR EACH ROW EXECUTE FUNCTION core.ai_agent_config_version();`);

    // At most 20 live agents per workspace (backstop of the service's clean 409; same advisory key as the service).
    await runner.query(`
      CREATE FUNCTION core.ai_agent_limit_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE n integer;
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_agent:' || NEW.workspace_id::text, 0));
        SELECT count(*) INTO n FROM core.ai_agent a WHERE a.workspace_id = NEW.workspace_id AND a.deleted_at IS NULL;
        IF n >= ${AI_AGENT_SCHEMA_LIMITS.agentsPerWorkspace} THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_workspace_limit',
            MESSAGE = 'ai_agent: at most ${AI_AGENT_SCHEMA_LIMITS.agentsPerWorkspace} agents per workspace';
        END IF;
        RETURN NEW;
      END
      $fn$;
    `);
    await runner.query(`CREATE TRIGGER ai_agent_limit BEFORE INSERT ON ${AGENT} FOR EACH ROW EXECUTE FUNCTION core.ai_agent_limit_guard();`);

    // ── core.ai_agent_trigger ────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE ${TRIGGER} (
        id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id              uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id                 uuid        NOT NULL,
        agent_id                     uuid        NOT NULL,
        kind                         text        NOT NULL,
        schedule                     jsonb,
        event_types                  text[],
        enabled                      boolean     NOT NULL DEFAULT false,
        run_as_user_id               uuid,
        enabled_at                   timestamptz,
        consent_flags                text[],
        snap_user_security_version   bigint,
        snap_agent_config_version    integer,
        snap_role_permission_version bigint,
        paused_reason                text,
        next_run_at                  timestamptz,
        last_run_at                  timestamptz,
        created_by                   uuid        NOT NULL,
        updated_by                   uuid        NOT NULL,
        created_at                   timestamptz NOT NULL DEFAULT now(),
        updated_at                   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_agent_trigger_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_trigger_agent_fkey FOREIGN KEY (agent_id, workspace_id) REFERENCES core.ai_agent(id, workspace_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_trigger_run_as_fkey FOREIGN KEY (run_as_user_id, organisation_id) REFERENCES core."user"(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_trigger_id_workspace_key UNIQUE (id, workspace_id),
        CONSTRAINT ai_agent_trigger_kind_check CHECK (kind IN ('schedule', 'record_event')),
        CONSTRAINT ai_agent_trigger_shape_check CHECK (
          (kind = 'schedule' AND event_types IS NULL AND schedule IS NOT NULL
            AND jsonb_typeof(schedule) = 'object'
            AND pg_column_size(schedule) <= 256
            AND schedule ?& ARRAY['every', 'at']
            AND (schedule - ARRAY['every', 'at', 'dow']) = '{}'::jsonb
            AND jsonb_typeof(schedule -> 'every') = 'string'
            AND (schedule ->> 'every') IN ('hour', 'day', 'weekday', 'week')
            AND jsonb_typeof(schedule -> 'at') = 'string'
            AND (schedule ->> 'at') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND (((schedule ->> 'every') = 'week') = (schedule ? 'dow'))
            AND (NOT (schedule ? 'dow') OR (jsonb_typeof(schedule -> 'dow') = 'number' AND (schedule ->> 'dow') IN ('0', '1', '2', '3', '4', '5', '6'))))
          OR (kind = 'record_event' AND schedule IS NULL AND event_types IS NOT NULL
            AND cardinality(event_types) BETWEEN 1 AND 4
            AND array_position(event_types, NULL) IS NULL
            AND event_types <@ ARRAY[${list(AI_AGENT_SCHEMA_EVENT_TYPES)}]::text[])
        ),
        CONSTRAINT ai_agent_trigger_paused_reason_check CHECK (paused_reason IS NULL OR paused_reason IN (${list(AI_AGENT_SCHEMA_PAUSE_REASONS)})),
        CONSTRAINT ai_agent_trigger_consent_check CHECK (consent_flags IS NULL OR cardinality(consent_flags) <= 16),
        -- EX-3 (owner decision 2026-10-25, deferred): no trigger is ever enabled, has a run-as user, a consent, a snapshot
        -- or a scheduled fire. Dropped only by a reviewed Phase 6b migration after the owner approves EX-3.
        CONSTRAINT ai_agent_trigger_ex3_gate CHECK (
          NOT enabled AND run_as_user_id IS NULL AND enabled_at IS NULL AND consent_flags IS NULL
          AND snap_user_security_version IS NULL AND snap_agent_config_version IS NULL AND snap_role_permission_version IS NULL
          AND next_run_at IS NULL AND last_run_at IS NULL
        )
      );
    `);
    await runner.query(`CREATE INDEX ai_agent_trigger_agent_idx ON ${TRIGGER} (agent_id);`);
    await runner.query(`ALTER TABLE ${TRIGGER} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TRIGGER} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TRIGGER} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TRIGGER} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TRIGGER} FROM crewflow_app;`);
    const enableAsSelf = `(NOT enabled OR run_as_user_id = core.current_uid())`;
    await runner.query(`CREATE POLICY ai_agent_trigger_read ON ${TRIGGER} FOR SELECT USING (${READER});`);
    await runner.query(
      `CREATE POLICY ai_agent_trigger_insert ON ${TRIGGER} FOR INSERT WITH CHECK (${WRITER} AND ${enableAsSelf} AND created_by = core.current_uid() AND updated_by = core.current_uid());`,
    );
    await runner.query(`CREATE POLICY ai_agent_trigger_update ON ${TRIGGER} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND ${enableAsSelf} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY ai_agent_trigger_delete ON ${TRIGGER} FOR DELETE USING (${WRITER});`);
    await runner.query(`GRANT SELECT, DELETE ON ${TRIGGER} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, workspace_id, agent_id, kind, schedule, event_types, created_by, updated_by) ON ${TRIGGER} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (schedule, event_types, enabled, paused_reason, updated_by, updated_at) ON ${TRIGGER} TO crewflow_app;`);

    // At most 5 triggers per agent (backstop of the service's clean 409).
    await runner.query(`
      CREATE FUNCTION core.ai_agent_trigger_limit_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE n integer;
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_agent_trigger:' || NEW.agent_id::text, 0));
        SELECT count(*) INTO n FROM core.ai_agent_trigger t WHERE t.agent_id = NEW.agent_id;
        IF n >= ${AI_AGENT_SCHEMA_LIMITS.triggersPerAgent} THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_trigger_agent_limit',
            MESSAGE = 'ai_agent_trigger: at most ${AI_AGENT_SCHEMA_LIMITS.triggersPerAgent} triggers per agent';
        END IF;
        RETURN NEW;
      END
      $fn$;
    `);
    await runner.query(`CREATE TRIGGER ai_agent_trigger_limit BEFORE INSERT ON ${TRIGGER} FOR EACH ROW EXECUTE FUNCTION core.ai_agent_trigger_limit_guard();`);

    // ── core.ai_agent_event (6b outbox; read-only to the runtime role in 6a) ──────────────────────────────────────────
    await runner.query(`
      CREATE TABLE ${EVENT} (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid        NOT NULL,
        trigger_id       uuid        NOT NULL,
        event_type       text        NOT NULL,
        entity_type      text        NOT NULL,
        entity_id        uuid        NOT NULL,
        occurred_at      timestamptz NOT NULL,
        origin_agent_id  uuid,
        status           text        NOT NULL DEFAULT 'pending',
        turn_id          uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_agent_event_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_event_trigger_fkey FOREIGN KEY (trigger_id, workspace_id) REFERENCES core.ai_agent_trigger(id, workspace_id) ON DELETE CASCADE,
        CONSTRAINT ai_agent_event_type_check CHECK (event_type IN (${list(AI_AGENT_SCHEMA_EVENT_TYPES)})),
        CONSTRAINT ai_agent_event_entity_type_check CHECK (entity_type IN ('shift', 'attendance')),
        CONSTRAINT ai_agent_event_status_check CHECK (status IN ('pending', 'dispatched', 'skipped'))
      );
    `);
    await runner.query(`CREATE INDEX ai_agent_event_trigger_pending_idx ON ${EVENT} (trigger_id, occurred_at) WHERE status = 'pending';`);
    await runner.query(`ALTER TABLE ${EVENT} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${EVENT} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${EVENT} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${EVENT} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${EVENT} FROM crewflow_app;`);
    await runner.query(`CREATE POLICY ai_agent_event_read ON ${EVENT} FOR SELECT USING (${READER});`);
    await runner.query(`GRANT SELECT ON ${EVENT} TO crewflow_app;`);

    // Trigger functions: owned by crewflow (stated literally for migration-object-ownership.spec) and not callable.
    await runner.query(`ALTER FUNCTION core.ai_agent_config_version() OWNER TO crewflow;`);
    await runner.query(`ALTER FUNCTION core.ai_agent_limit_guard() OWNER TO crewflow;`);
    await runner.query(`ALTER FUNCTION core.ai_agent_trigger_limit_guard() OWNER TO crewflow;`);
    for (const fn of ['ai_agent_config_version', 'ai_agent_limit_guard', 'ai_agent_trigger_limit_guard']) {
      await runner.query(`REVOKE ALL ON FUNCTION core.${fn}() FROM PUBLIC;`);
      await runner.query(`REVOKE ALL ON FUNCTION core.${fn}() FROM crewflow_app;`);
    }

    // ── The per-organisation agents switch (P6-D7): platform-admin writes only, under the existing policies ──────────
    await runner.query(`ALTER TABLE core.organisation_ai_setting ADD COLUMN agents_enabled boolean NOT NULL DEFAULT false;`);
    await runner.query(`GRANT SELECT (agents_enabled), INSERT (agents_enabled), UPDATE (agents_enabled) ON core.organisation_ai_setting TO crewflow_app;`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `WITH t(name) AS (VALUES ('ai_agent'), ('ai_agent_trigger'), ('ai_agent_event'))
       SELECT
         (SELECT count(*) FROM t JOIN pg_class c ON c.relname = t.name JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'core'
           WHERE c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow')::int AS forced,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_agent')::int AS agent_policies,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_agent_trigger')::int AS trigger_policies,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_agent_event')::int AS event_policies,
         (SELECT count(*) FROM pg_constraint WHERE conrelid = '${TRIGGER}'::regclass AND conname = 'ai_agent_trigger_ex3_gate' AND contype = 'c' AND convalidated)::int AS ex3_gate,
         has_table_privilege('crewflow_app', '${AGENT}', 'DELETE') AS app_agent_delete,
         has_table_privilege('crewflow_app', '${AGENT}', 'INSERT') AS app_agent_table_insert,
         has_table_privilege('crewflow_app', '${AGENT}', 'UPDATE') AS app_agent_table_update,
         has_column_privilege('crewflow_app', '${AGENT}', 'kind', 'INSERT') AS app_agent_insert_kind,
         has_column_privilege('crewflow_app', '${AGENT}', 'kind', 'UPDATE') AS app_agent_update_kind,
         has_column_privilege('crewflow_app', '${AGENT}', 'config_version', 'UPDATE') AS app_agent_update_config,
         has_column_privilege('crewflow_app', '${AGENT}', 'is_active', 'UPDATE') AS app_agent_update_active,
         has_column_privilege('crewflow_app', '${AGENT}', 'organisation_id', 'UPDATE') AS app_agent_update_org,
         has_column_privilege('crewflow_app', '${AGENT}', 'workspace_id', 'UPDATE') AS app_agent_update_ws,
         has_column_privilege('crewflow_app', '${AGENT}', 'name', 'UPDATE') AS app_agent_update_name,
         has_column_privilege('crewflow_app', '${AGENT}', 'created_by', 'UPDATE') AS app_agent_update_created_by,
         has_column_privilege('crewflow_app', '${AGENT}', 'prompt', 'UPDATE') AS app_agent_update_prompt,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'run_as_user_id', 'UPDATE') AS app_trigger_update_run_as,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'run_as_user_id', 'INSERT') AS app_trigger_insert_run_as,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'enabled', 'INSERT') AS app_trigger_insert_enabled,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'agent_id', 'UPDATE') AS app_trigger_update_agent,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'organisation_id', 'UPDATE') AS app_trigger_update_org,
         has_column_privilege('crewflow_app', '${TRIGGER}', 'next_run_at', 'UPDATE') AS app_trigger_update_next,
         has_table_privilege('crewflow_app', '${EVENT}', 'INSERT') OR has_table_privilege('crewflow_app', '${EVENT}', 'UPDATE') OR has_table_privilege('crewflow_app', '${EVENT}', 'DELETE') AS app_event_write,
         has_any_column_privilege('crewflow_app', '${EVENT}', 'INSERT') OR has_any_column_privilege('crewflow_app', '${EVENT}', 'UPDATE') AS app_event_column_write,
         has_table_privilege('crewflow_app', '${AGENT}', 'TRUNCATE') OR has_table_privilege('crewflow_app', '${TRIGGER}', 'TRUNCATE') OR has_table_privilege('crewflow_app', '${EVENT}', 'TRUNCATE') AS app_truncate,
         (SELECT count(*) FROM pg_trigger tg WHERE tg.tgrelid IN ('${AGENT}'::regclass, '${TRIGGER}'::regclass) AND tg.tgname IN ('ai_agent_config_version', 'ai_agent_limit', 'ai_agent_trigger_limit') AND tg.tgenabled = 'O' AND NOT tg.tgisinternal)::int AS guard_triggers,
         (SELECT bool_or(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname IN ('ai_agent_writer', 'ai_agent_config_version', 'ai_agent_limit_guard', 'ai_agent_trigger_limit_guard')) AS any_definer,
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname LIKE 'ai_agent%' AND p.proname NOT IN ('ai_agent_writer', 'ai_agent_config_version', 'ai_agent_limit_guard', 'ai_agent_trigger_limit_guard'))::int AS extra_functions,
         has_function_privilege('crewflow_app', 'core.ai_agent_limit_guard()', 'EXECUTE') OR has_function_privilege('crewflow_app', 'core.ai_agent_trigger_limit_guard()', 'EXECUTE') OR has_function_privilege('crewflow_app', 'core.ai_agent_config_version()', 'EXECUTE') AS app_guard_execute,
         has_column_privilege('crewflow_app', 'core.organisation_ai_setting', 'agents_enabled', 'UPDATE') AS app_switch_update,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean | string | null>>;
    const mustBeFalse = [
      'app_agent_delete', 'app_agent_table_insert', 'app_agent_table_update', 'app_agent_insert_kind', 'app_agent_update_kind', 'app_agent_update_config',
      'app_agent_update_active', 'app_agent_update_org', 'app_agent_update_ws', 'app_agent_update_name', 'app_agent_update_created_by',
      'app_trigger_update_run_as', 'app_trigger_insert_run_as', 'app_trigger_insert_enabled', 'app_trigger_update_agent', 'app_trigger_update_org',
      'app_trigger_update_next', 'app_event_write', 'app_event_column_write', 'app_truncate', 'any_definer', 'app_guard_execute', 'app_bypass',
    ];
    if (
      check.forced !== 3 || check.agent_policies !== 3 || check.trigger_policies !== 4 || check.event_policies !== 1 || check.ex3_gate !== 1 ||
      check.app_agent_update_prompt !== true || check.guard_triggers !== 3 || check.extra_functions !== 0 || check.app_switch_update !== true ||
      mustBeFalse.some((k) => check[k] !== false)
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`REVOKE SELECT (agents_enabled), INSERT (agents_enabled), UPDATE (agents_enabled) ON core.organisation_ai_setting FROM crewflow_app;`);
    await runner.query(`ALTER TABLE core.organisation_ai_setting DROP COLUMN IF EXISTS agents_enabled;`);
    await runner.query(`DROP TABLE IF EXISTS ${EVENT};`);
    await runner.query(`DROP TABLE IF EXISTS ${TRIGGER};`);
    await runner.query(`DROP TABLE IF EXISTS ${AGENT};`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_agent_trigger_limit_guard();`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_agent_limit_guard();`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_agent_config_version();`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_agent_writer();`);
    await runner.query(`ALTER TABLE core.role DROP CONSTRAINT IF EXISTS role_id_workspace_agent_key;`);
  }
}
