import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 6a, M6.2 (docs/ai/PHASE6_TWENTY_PLAN.md §3, conflict C5): agent-only roles, NARROWEST VERSION (blocker B10).
 *
 * WHAT CHANGES
 *  1. `core.role.assignable_to_agents boolean NOT NULL DEFAULT false` (Crewflow naming next to `assignable_to_members`;
 *     Twenty's `canBeAssignedToAgents`). CHECK `role_agent_shape`: an agent role is never a system role, always a workspace
 *     (custom_…) role, never assignable to members and never "read all objects". `role_member_key` is unchanged.
 *  2. `role_agent_kind_immutable` (new trigger + new function `core.guard_role_agent_kind()`): the flag can never flip
 *     after creation. `core.guard_role_identity()` is NOT redefined.
 *  3. A human can never hold an agent role, and an agent role can never carry object / field / record rules — enforced
 *     DECLARATIVELY, independent of RLS: `user_role`, `role_object_permission` and `role_field_permission` each get a
 *     constant column `role_is_agent boolean NOT NULL DEFAULT false CHECK (NOT role_is_agent)` and a composite FK
 *     `(role_id, role_is_agent) → role(id, assignable_to_agents)` (UNIQUE `role_id_agent_key`). Referential-integrity
 *     checks bypass row security, so this holds for every writer — the app, a SECURITY DEFINER function, a migration —
 *     unlike a trigger whose lookup of `core.role` would be filtered by FORCE RLS (and fail OPEN for an invisible role).
 *     The FKs cascade on role delete exactly like the existing `role_id` FKs.
 *
 * WHAT DOES NOT CHANGE (B10, AI_PARALLEL_EXECUTION_PLAN §10): `core.enforce_member_role_permission_allowlist()` — the
 * privilege-escalation backstop on `role_permission` — is NOT redefined. It caps EVERY workspace role, agent roles
 * included, at `staff.view, venue.view, schedule.view`. Agent roles therefore cannot carry `attendance.view`,
 * `payroll.view` or any write flag in 6a; widening the backstop for agent roles is a SECURITY TRADE-OFF left to Agent 9's
 * dedicated security review (C:\rab-ai-wt\handoff\ai\p6-agents\REQUEST.md, "B10"). The post-condition below refuses to
 * record this migration if the backstop's body differs from the one WorkspaceMemberRoles1786714500000 created.
 *
 * Not production-approved (N1, production-migration-approval.ts). Dev number in Agent 6's range; Agent 9 renumbers it
 * (file, class, `name` and the references in AiAgentSchema1786721050000 together) at the integration merge.
 */
/** md5 of `core.enforce_member_role_permission_allowlist()`'s body as created by 1786714500000 (CR stripped). */
export const MEMBER_ALLOWLIST_BACKSTOP_MD5 = '096abf0edec03fb2f7d15a87de6614e4';

const HUMAN_TABLES = ['user_role', 'role_object_permission', 'role_field_permission'] as const;

export class RoleAssignableToAgents1786721040000 implements MigrationInterface {
  name = 'RoleAssignableToAgents1786721040000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.role ADD COLUMN assignable_to_agents boolean NOT NULL DEFAULT false;`);
    await runner.query(`
      ALTER TABLE core.role
        ADD CONSTRAINT role_agent_shape CHECK (
          NOT assignable_to_agents
          OR (NOT is_system AND workspace_id IS NOT NULL AND NOT assignable_to_members AND NOT can_read_all_objects)
        ),
        ADD CONSTRAINT role_id_agent_key UNIQUE (id, assignable_to_agents);
    `);

    // ── The kind of a role never changes (a new trigger; guard_role_identity() is untouched) ────────────────────────
    await runner.query(`
      CREATE FUNCTION core.guard_role_agent_kind() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
      BEGIN
        RAISE EXCEPTION 'a role''s assignable_to_agents flag is immutable' USING ERRCODE = 'check_violation';
      END
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION core.guard_role_agent_kind() OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.guard_role_agent_kind() FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON FUNCTION core.guard_role_agent_kind() FROM crewflow_app;`);
    await runner.query(`
      CREATE TRIGGER role_agent_kind_immutable BEFORE UPDATE ON core.role
        FOR EACH ROW WHEN (OLD.assignable_to_agents IS DISTINCT FROM NEW.assignable_to_agents)
        EXECUTE FUNCTION core.guard_role_agent_kind();
    `);

    // ── Humans and object/field rules only ever reference NON-agent roles (declarative, RLS-independent) ────────────
    for (const table of HUMAN_TABLES) {
      await runner.query(`
        ALTER TABLE core.${table}
          ADD COLUMN role_is_agent boolean NOT NULL DEFAULT false,
          ADD CONSTRAINT ${table}_never_agent_role CHECK (NOT role_is_agent);
      `);
      await runner.query(`
        ALTER TABLE core.${table}
          ADD CONSTRAINT ${table}_role_not_agent_fkey FOREIGN KEY (role_id, role_is_agent)
            REFERENCES core.role (id, assignable_to_agents) ON DELETE CASCADE;
      `);
    }

    // ── Verification (refuse to record the migration on drift) ──────────────────────────────────────────────────────
    const [check] = (await runner.query(
      `SELECT
         (SELECT md5(replace(p.prosrc, E'\\r', '')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'core' AND p.proname = 'enforce_member_role_permission_allowlist') AS backstop_md5,
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'core' AND p.proname = 'enforce_member_role_permission_allowlist')::int AS backstop_count,
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'core.role_permission'::regclass AND t.tgname = 'role_permission_member_allowlist' AND t.tgenabled = 'O')::int AS backstop_trigger,
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'core.role'::regclass AND t.tgname = 'role_agent_kind_immutable' AND t.tgenabled = 'O')::int AS kind_trigger,
         (SELECT count(*) FROM pg_constraint WHERE conrelid = 'core.role'::regclass AND conname IN ('role_agent_shape', 'role_id_agent_key'))::int AS role_constraints,
         (SELECT count(*) FROM pg_constraint c WHERE c.conname IN ('user_role_role_not_agent_fkey', 'role_object_permission_role_not_agent_fkey', 'role_field_permission_role_not_agent_fkey')
             AND c.contype = 'f' AND c.convalidated AND c.confrelid = 'core.role'::regclass)::int AS human_fks,
         (SELECT count(*) FROM pg_constraint c WHERE c.conname IN ('user_role_never_agent_role', 'role_object_permission_never_agent_role', 'role_field_permission_never_agent_role') AND c.contype = 'c')::int AS human_checks,
         (SELECT count(*) FROM core.role WHERE assignable_to_agents)::int AS agent_roles,
         (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname = 'guard_role_agent_kind') AS kind_definer,
         has_function_privilege('crewflow_app', 'core.guard_role_agent_kind()', 'EXECUTE') AS app_kind_execute,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, number | boolean | string | null>>;
    if (
      check.backstop_md5 !== MEMBER_ALLOWLIST_BACKSTOP_MD5 || check.backstop_count !== 1 || check.backstop_trigger !== 1 || check.kind_trigger !== 1 ||
      check.role_constraints !== 2 || check.human_fks !== 3 || check.human_checks !== 3 || check.agent_roles !== 0 || check.kind_definer !== false ||
      check.app_kind_execute !== false || check.app_bypass !== false
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    // Refuse rather than lose data: agent roles must be removed by the operator first (AiAgentSchema's down() must have
    // run already, since ai_agent references them).
    await runner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM core.role WHERE assignable_to_agents) THEN
          RAISE EXCEPTION 'RoleAssignableToAgents1786721040000 down: agent roles exist; remove them before reverting';
        END IF;
      END $$;
    `);
    for (const table of HUMAN_TABLES) {
      await runner.query(`ALTER TABLE core.${table} DROP CONSTRAINT IF EXISTS ${table}_role_not_agent_fkey, DROP CONSTRAINT IF EXISTS ${table}_never_agent_role, DROP COLUMN IF EXISTS role_is_agent;`);
    }
    await runner.query(`DROP TRIGGER IF EXISTS role_agent_kind_immutable ON core.role;`);
    await runner.query(`DROP FUNCTION IF EXISTS core.guard_role_agent_kind();`);
    await runner.query(`ALTER TABLE core.role DROP CONSTRAINT IF EXISTS role_id_agent_key, DROP CONSTRAINT IF EXISTS role_agent_shape, DROP COLUMN IF EXISTS assignable_to_agents;`);
  }
}
