import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 6a, M6.1 (docs/ai/PHASE6_TWENTY_PLAN.md §3, P6-D12): the `ai.agents.manage` permission — defining AI agents and
 * their triggers in Settings → AI → Agents. STORAGE ONLY until the owner approves EX-3: nothing this flag reaches can
 * enable a trigger, schedule a fire or run an agent.
 *
 *  1. Adds `ai.agents.manage` to the permission catalogue (`core.permission`, the schema contract permission-catalogue.spec
 *     enforces: every PermissionFlag ships with a migration).
 *  2. Grants it as a default of the organisation-level SYSTEM role `ceo` of every existing organisation, bumping each
 *     changed role's `permission_version` (cached authorisation snapshots die) — the same mechanism as
 *     AiSettingsPermission1786720240000. New organisations get it from `ROLE_DEFS` (manager.service.ts). The `manager`
 *     system role (Initial + every Internal Manager) does NOT get it (P6-D12: "CEO only by default"); venue_manager and
 *     staff never do. A custom workspace-member role can never carry it either (the member allowlist trigger,
 *     WorkspaceMemberRoles1786714500000, unchanged).
 *
 * The flag alone is NOT sufficient: `AiAgentAuthority` (layer 2) and the RLS writer predicate `core.ai_agent_writer()`
 * (AiAgentSchema1786721050000, layers 4–5) also require the bound user to be the organisation's CEO.
 *
 * OWNED BY AGENT 9 (AI_CONTRACTS §2.4: the flag, its catalogue migration and ROLE_DEFS are never an integration request).
 * Re-created at the p6 merge from Agent 6's draft after review: the same mechanism as AiSettingsPermission1786720240000,
 * with a STRICTER post-condition (no system role but `ceo` AND no workspace role may hold the flag). Renumbered from the
 * dev id 1786720600000. Catalogue and role grants only. Not production-approved (N1, production-migration-approval.ts).
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786721030000: Readonly<Record<string, readonly string[]>> = {
  ceo: ['ai.agents.manage'],
};

export class AiAgentsPermission1786721030000 implements MigrationInterface {
  name = 'AiAgentsPermission1786721030000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`INSERT INTO core.permission (key, resource, action) VALUES ('ai.agents.manage', 'ai', 'agents') ON CONFLICT (key) DO NOTHING`);
    await runner.query(`
      DO $grant$
      DECLARE o record; v_perm uuid;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'ai.agents.manage';
        IF v_perm IS NULL THEN RAISE EXCEPTION 'AiAgentsPermission1786721030000: permission ai.agents.manage missing'; END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, v_perm, r.organisation_id FROM core.role r
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = 'ceo'
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM ins);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;`);
    // Post-condition: the flag exists, no system role other than `ceo` holds it, and no workspace (custom) role holds it.
    const [check] = (await runner.query(
      `SELECT (SELECT count(*) FROM core.permission WHERE key = 'ai.agents.manage')::int AS perm,
              (SELECT count(*) FROM core.role_permission rp JOIN core.role r ON r.id = rp.role_id JOIN core.permission p ON p.id = rp.permission_id
                WHERE p.key = 'ai.agents.manage' AND (NOT r.is_system OR r.key <> 'ceo'))::int AS non_ceo`,
    )) as Array<{ perm: number; non_ceo: number }>;
    if (check.perm !== 1 || check.non_ceo !== 0) throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $revoke$
      DECLARE o record;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH del AS (
            DELETE FROM core.role_permission rp USING core.role r, core.permission p
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'ai.agents.manage' AND r.organisation_id = o.id
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;`);
    // user_permission_override rows (if any) cascade from core.permission (IdentitySchema1786665800000).
    await runner.query(`DELETE FROM core.permission WHERE key = 'ai.agents.manage'`);
  }
}
