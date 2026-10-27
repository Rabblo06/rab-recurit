import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 4 — organisation skills (docs/ai/PHASE4_TWENTY_PLAN.md §2.1, P4-D1/D2/D3/D5, resolution XD-4 / X-8).
 *
 * `core.ai_skill` (tenant-scoped, ENABLE + FORCE RLS in this migration, owner `crewflow`) holds an organisation's CUSTOM
 * skills plus a small on/off row for each BUILT-IN it has switched. Built-in TEXT lives in code
 * (modules/ai/skills/builtin-skills.ts) and is never stored, so there are no NULL-organisation rows, no definer function
 * and no NOT_FORCED_ALLOWLIST entry (conflict C1):
 *   - `is_system = true`  — a toggle row: `name` is one of the six built-in names (CHECK) and `label`, `description` and
 *                            `content` are NULL (CHECK: a built-in can only be switched, never edited);
 *   - `is_system = false` — a custom skill: `name` is none of the built-in names (CHECK), label 1..80, description
 *                            1..300 (the prompt line), content 1..20,000;
 *   - no row for a built-in = active (P4-D2). `name` ~ '^[a-z][a-z0-9-]{1,47}$', UNIQUE (organisation_id, name).
 *   - `created_by` / `updated_by`: historical user ids (no FK, as in audit_log); `reason` 3..500 = why the LAST change was
 *     made (the history is the audit log, written by the service in the same transaction).
 *
 * At most 50 custom skills per organisation: `core.ai_skill_limit_guard()` (BEFORE INSERT … WHEN NOT is_system; plpgsql,
 * SECURITY INVOKER, `search_path = pg_catalog, pg_temp`) takes `pg_advisory_xact_lock(hashtextextended('ai_skill:' ||
 * organisation_id, 0))` — the same key the service takes before its own clean 409 — counts the organisation's custom rows
 * and raises `check_violation` (constraint `ai_skill_custom_limit`) at 50. Concurrent inserts serialise on the lock, so
 * two transactions racing for the 50th slot cannot both pass. No EXECUTE grant: a trigger function is not callable.
 *
 * Policies (layers 4–5; with no tenant context every predicate is NULL ⇒ zero rows):
 *   SELECT  `organisation_id = core.current_org() AND core.ai_actor_eligible()` — only the CEO and the CURRENT Initial
 *           Manager read skill text (conflict C8, P4-D5); other managers, venue managers and staff read 0 rows;
 *   INSERT  the organisation AND `core.ai_settings_writer()` (the CEO) AND `created_by = updated_by = core.current_uid()`;
 *   UPDATE  USING the organisation AND writer; WITH CHECK the same AND `updated_by = core.current_uid()` (no forged author);
 *   DELETE  the organisation AND writer AND `NOT is_system` (a built-in's row is switched, never removed).
 * A custom role carrying `ai.settings` grants nothing to a non-CEO here (P4-D3).
 *
 * Grants to `crewflow_app` (least privilege): SELECT; DELETE; INSERT (organisation_id, name, is_system, label,
 * description, content, is_active, created_by, updated_by, reason); UPDATE (label, description, content, is_active,
 * updated_by, reason, updated_at). No UPDATE of `name`, `is_system`, `organisation_id`, `created_by` or `created_at`; no
 * TRUNCATE. A post-condition refuses to record the migration on drift (FORCE, owner, policies, grants, CHECKs, trigger,
 * no BYPASSRLS on the runtime role).
 *
 * Not production-approved (N1, production-migration-approval.ts). Dev number 1786720500000; renumbered to 1786721000000
 * by Agent 9 at the integration merge (file, class and `name` together; nothing here depends on the number).
 */
const TABLE = 'core.ai_skill';
const ORG = `organisation_id = core.current_org()`;
const WRITER = `${ORG} AND core.ai_settings_writer()`;

/** Frozen copy of AI_BUILTIN_SKILL_NAMES at this migration (a unit test pins the two equal; a later change is a new migration). */
export const AI_SKILL_SCHEMA_BUILTIN_NAMES: readonly string[] = ['coverage-report', 'crewflow-help', 'rota-building', 'shift-filling', 'timesheet-review', 'venue-onboarding'];
/** Mirrors AI_SKILL_LIMITS.maxCustomPerOrganisation at this migration. */
export const AI_SKILL_SCHEMA_MAX_CUSTOM = 50;

export class AiSkillSchema1786721000000 implements MigrationInterface {
  name = 'AiSkillSchema1786721000000';

  async up(runner: QueryRunner): Promise<void> {
    const builtins = AI_SKILL_SCHEMA_BUILTIN_NAMES.map((n) => `'${n}'`).join(', ');
    await runner.query(`
      CREATE TABLE ${TABLE} (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        name            text        NOT NULL,
        is_system       boolean     NOT NULL DEFAULT false,
        label           text,
        description     text,
        content         text,
        is_active       boolean     NOT NULL DEFAULT true,
        created_by      uuid        NOT NULL,
        updated_by      uuid        NOT NULL,
        reason          text        NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_skill_organisation_name_key UNIQUE (organisation_id, name),
        CONSTRAINT ai_skill_name_check CHECK (name ~ '^[a-z][a-z0-9-]{1,47}$'),
        CONSTRAINT ai_skill_builtin_name_check CHECK ((is_system AND name IN (${builtins})) OR (NOT is_system AND name NOT IN (${builtins}))),
        CONSTRAINT ai_skill_system_has_no_text_check CHECK (NOT is_system OR (label IS NULL AND description IS NULL AND content IS NULL)),
        CONSTRAINT ai_skill_custom_text_check CHECK (
          is_system OR (
            label IS NOT NULL AND length(label) BETWEEN 1 AND 80
            AND description IS NOT NULL AND length(description) BETWEEN 1 AND 300
            AND content IS NOT NULL AND length(content) BETWEEN 1 AND 20000
          )
        ),
        CONSTRAINT ai_skill_reason_check CHECK (length(reason) BETWEEN 3 AND 500)
      );
    `);
    // Owner: crewflow, like every ordinary FORCE-RLS tenant table (phase-B migrations run as the bootstrap superuser, so
    // ownership is stated explicitly — migration-object-ownership.spec).
    await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app;`);

    await runner.query(`CREATE POLICY ai_skill_eligible_read ON ${TABLE} FOR SELECT USING (${ORG} AND core.ai_actor_eligible());`);
    await runner.query(`CREATE POLICY ai_skill_ceo_insert ON ${TABLE} FOR INSERT WITH CHECK (${WRITER} AND created_by = core.current_uid() AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY ai_skill_ceo_update ON ${TABLE} FOR UPDATE USING (${WRITER}) WITH CHECK (${WRITER} AND updated_by = core.current_uid());`);
    await runner.query(`CREATE POLICY ai_skill_ceo_delete ON ${TABLE} FOR DELETE USING (${WRITER} AND NOT is_system);`);

    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT INSERT (organisation_id, name, is_system, label, description, content, is_active, created_by, updated_by, reason) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT UPDATE (label, description, content, is_active, updated_by, reason, updated_at) ON ${TABLE} TO crewflow_app;`);
    await runner.query(`GRANT DELETE ON ${TABLE} TO crewflow_app;`);

    // ── 50 custom skills per organisation (database backstop of the service's clean 409) ────────────────────────────
    await runner.query(`
      CREATE FUNCTION core.ai_skill_limit_guard()
      RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        n integer;
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_skill:' || NEW.organisation_id::text, 0));
        SELECT count(*) INTO n FROM core.ai_skill s WHERE s.organisation_id = NEW.organisation_id AND NOT s.is_system;
        IF n >= ${AI_SKILL_SCHEMA_MAX_CUSTOM} THEN
          RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_skill_custom_limit',
            MESSAGE = 'ai_skill: at most ${AI_SKILL_SCHEMA_MAX_CUSTOM} custom skills per organisation';
        END IF;
        RETURN NEW;
      END
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.ai_skill_limit_guard() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_skill_limit_guard() FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.ai_skill_limit_guard() FROM crewflow_app;`);
    await runner.query(`CREATE TRIGGER ai_skill_limit BEFORE INSERT ON ${TABLE} FOR EACH ROW WHEN (NOT NEW.is_system) EXECUTE FUNCTION core.ai_skill_limit_guard();`);

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = 'ai_skill') AS forced,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_skill')::int AS policies,
         (SELECT count(*) FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c')::int AS checks,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS app_select,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         has_table_privilege('crewflow_app', '${TABLE}', 'INSERT') AS app_table_insert,
         has_table_privilege('crewflow_app', '${TABLE}', 'UPDATE') AS app_table_update,
         has_table_privilege('crewflow_app', '${TABLE}', 'REFERENCES') AS app_references,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRIGGER') AS app_trigger,
         has_column_privilege('crewflow_app', '${TABLE}', 'content', 'INSERT') AS app_insert_content,
         has_column_privilege('crewflow_app', '${TABLE}', 'id', 'INSERT') AS app_insert_id,
         has_column_privilege('crewflow_app', '${TABLE}', 'created_at', 'INSERT') AS app_insert_created_at,
         has_column_privilege('crewflow_app', '${TABLE}', 'content', 'UPDATE') AS app_update_content,
         has_column_privilege('crewflow_app', '${TABLE}', 'name', 'UPDATE') AS app_update_name,
         has_column_privilege('crewflow_app', '${TABLE}', 'is_system', 'UPDATE') AS app_update_is_system,
         has_column_privilege('crewflow_app', '${TABLE}', 'organisation_id', 'UPDATE') AS app_update_org,
         has_column_privilege('crewflow_app', '${TABLE}', 'created_by', 'UPDATE') AS app_update_created_by,
         has_column_privilege('crewflow_app', '${TABLE}', 'created_at', 'UPDATE') AS app_update_created_at,
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = '${TABLE}'::regclass AND t.tgname = 'ai_skill_limit' AND t.tgenabled = 'O' AND NOT t.tgisinternal)::int AS limit_trigger,
         (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname = 'ai_skill_limit_guard') AS guard_definer,
         (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname = 'ai_skill_limit_guard') AS guard_owner,
         has_function_privilege('crewflow_app', 'core.ai_skill_limit_guard()', 'EXECUTE') AS app_guard_execute,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean | string>>;
    if (
      check.forced !== true || check.policies !== 4 || check.checks !== 5 || check.app_select !== true || check.app_delete !== true ||
      check.app_truncate || check.app_table_insert || check.app_table_update || check.app_references || check.app_trigger ||
      check.app_insert_content !== true || check.app_insert_id || check.app_insert_created_at || check.app_update_content !== true ||
      check.app_update_name || check.app_update_is_system || check.app_update_org || check.app_update_created_by || check.app_update_created_at ||
      check.limit_trigger !== 1 || check.guard_definer || check.guard_owner !== 'crewflow' || check.app_guard_execute || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    // Drops the table, its policies, grants and trigger; then the trigger function.
    await runner.query(`DROP TABLE IF EXISTS ${TABLE};`);
    await runner.query(`DROP FUNCTION IF EXISTS core.ai_skill_limit_guard();`);
  }
}
