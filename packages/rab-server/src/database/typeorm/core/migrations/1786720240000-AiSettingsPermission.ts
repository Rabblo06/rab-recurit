import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 1 "real models only" (docs/ai/PHASE1_TWENTY_PLAN.md §2.1 M1, C12 / D6): the `ai.settings` permission —
 * choosing the organisation's AI model per tier in Settings → AI.
 *
 *  1. Adds `ai.settings` to the permission catalogue (`core.permission`), the schema contract `permission-catalogue.spec.ts`
 *     enforces (every PermissionFlag ships with a migration).
 *  2. Grants it as a default of the organisation-level SYSTEM role `ceo` of every existing organisation, bumping each
 *     changed role's `permission_version` (cached authorisation snapshots die) — the same mechanism as
 *     AiUsePermissionDefault1786720210000. New organisations get it from `ROLE_DEFS` (manager.service.ts). The `manager`
 *     system role (Initial + every Internal Manager) does NOT get it; venue_manager and staff never do.
 *
 * The flag alone is deliberately NOT sufficient: `AiModelSettingsService` (layer 2) and the RLS writer predicate
 * `core.ai_settings_writer()` on `core.organisation_ai_model_preference` (AiModelPreference1786720250000, layers 4–5)
 * additionally require the bound user to be the organisation's CEO, so a custom role carrying the flag grants nothing to
 * anyone else. Reusing `settings.edit` was rejected: it is broader and held by no tenant role (W6-E2E-04).
 *
 * Independent of the table migration (catalogue and role grants only). Not production-approved (N1,
 * production-migration-approval.ts).
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720240000: Readonly<Record<string, readonly string[]>> = {
  ceo: ['ai.settings'],
};

export class AiSettingsPermission1786720240000 implements MigrationInterface {
  name = 'AiSettingsPermission1786720240000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`INSERT INTO core.permission (key, resource, action) VALUES ('ai.settings', 'ai', 'settings') ON CONFLICT (key) DO NOTHING`);
    await runner.query(`
      DO $grant$
      DECLARE o record; v_perm uuid;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'ai.settings';
        IF v_perm IS NULL THEN RAISE EXCEPTION 'AiSettingsPermission1786720240000: permission ai.settings missing'; END IF;
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
    // Post-condition: the flag exists and no system role other than `ceo` holds it.
    const [check] = (await runner.query(
      `SELECT (SELECT count(*) FROM core.permission WHERE key = 'ai.settings')::int AS perm,
              (SELECT count(*) FROM core.role_permission rp JOIN core.role r ON r.id = rp.role_id JOIN core.permission p ON p.id = rp.permission_id
                WHERE p.key = 'ai.settings' AND r.is_system AND r.key <> 'ceo')::int AS non_ceo_system`,
    )) as Array<{ perm: number; non_ceo_system: number }>;
    if (check.perm !== 1 || check.non_ceo_system !== 0) throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
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
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'ai.settings' AND r.organisation_id = o.id
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;`);
    // user_permission_override rows (if any) cascade from core.permission (IdentitySchema1786665800000).
    await runner.query(`DELETE FROM core.permission WHERE key = 'ai.settings'`);
  }
}
