import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 1 (docs/ai/PHASE1_PLAN.md §3): the `ai.use` permission.
 *
 *  1. Adds `ai.use` to the permission catalogue (`core.permission`), the schema contract `permission-catalogue.spec.ts`
 *     enforces (every PermissionFlag ships with a migration).
 *  2. Grants it as a default of the organisation-level SYSTEM roles `ceo` and `manager` of every existing organisation,
 *     bumping each changed role's `permission_version` (cached authorisation snapshots die) — the same mechanism as
 *     SettingsViewLeadershipDefault1786720000000. New organisations get it from `ROLE_DEFS` (manager.service.ts).
 *
 * The owner decision is "CEO / organisation owner and the CURRENT Initial Manager only". The `manager` system role is
 * shared by the Initial Manager AND every additional Internal Manager, so the flag alone is deliberately NOT sufficient:
 * `AiAccessService` (service layer) and `core.ai_actor_eligible()` (the RLS WITH CHECK on every AI insert,
 * AiPhase1Schema1786720200000) additionally require the bound user to be the organisation's CEO or its current Initial
 * Manager (`manager_profile.is_initial_manager AND superseded_at IS NULL`) — exactly the payroll-calendar precedent
 * (ManagerMarkPaidInitialManagerCalendar1786719300000). venue_manager and staff never receive it.
 *
 * Independent of the AI schema migration (it touches only the catalogue and role grants), so it can be applied alone.
 * Not production-approved (N1, production-migration-approval.ts).
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720210000: Readonly<Record<string, readonly string[]>> = {
  ceo: ['ai.use'],
  manager: ['ai.use'],
};

export class AiUsePermissionDefault1786720210000 implements MigrationInterface {
  name = 'AiUsePermissionDefault1786720210000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`INSERT INTO core.permission (key, resource, action) VALUES ('ai.use', 'ai', 'use') ON CONFLICT (key) DO NOTHING`);
    await runner.query(`
      DO $grant$
      DECLARE o record; v_perm uuid;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'ai.use';
        IF v_perm IS NULL THEN RAISE EXCEPTION 'AiUsePermissionDefault1786720210000: permission ai.use missing'; END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, v_perm, r.organisation_id FROM core.role r
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM ins);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;`);
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
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'ai.use' AND r.organisation_id = o.id
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;`);
    // user_permission_override rows (if any) cascade from core.permission (IdentitySchema1786665800000).
    await runner.query(`DELETE FROM core.permission WHERE key = 'ai.use'`);
  }
}
