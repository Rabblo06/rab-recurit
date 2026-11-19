import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §10 S-2 / PR-2, Q3; owner decision 2026-11-18; DRAFT — owner
 * SQL review FIRST): the `data_model.manage` permission — change the workspace's data model (custom objects and fields).
 * The owner's "DATA_MODEL" is `PermissionFlag.DATA_MODEL_MANAGE` = `data_model.manage`.
 *
 *  1. Adds `data_model.manage` to the permission catalogue (`core.permission`, the schema contract
 *     permission-catalogue.spec enforces: every PermissionFlag ships with a migration).
 *  2. Grants it as a default of the organisation-level SYSTEM roles `ceo` and `manager` (Internal and Initial Managers) of
 *     every existing organisation, bumping each changed role's `permission_version` (cached authorisation snapshots die) —
 *     the AiUsePermissionDefault1786720210000 mechanism. New organisations get it from `ROLE_DEFS` (manager.service.ts).
 *     `venue_manager` and `staff` never get it. A custom workspace-member role can never carry it: the member allowlist
 *     trigger (WorkspaceMemberRoles1786714500000) is deliberately NOT changed (owner decision 2026-11-18).
 *  3. Post-condition, per organisation under that organisation's own RLS binding: every `ceo` / `manager` system role
 *     holds it, and no other role does.
 *
 * Organisations are listed through the existing `core.worker_list_organisations` SECURITY DEFINER keyset function (the
 * EmailOutboxSecretBodyScrub1786719710000 pattern), NOT `SELECT id FROM core.organisation`: since M-T1
 * (PreAuthTablesForceOwnerOnly1786721400000) `core.organisation` is FORCE RLS, so the owner-login migration identity
 * (crewflow_owner, no tenant bound) would read zero organisations and silently grant nothing to existing ones. Writes and
 * checks then run per organisation under the real `role` / `role_permission` policies. Review #252 (M): a lister that
 * returns NOTHING while organisations exist would still be a silent zero-organisation grant, so both directions refuse
 * when they saw zero organisations but a second source says rows exist (the zero-organisation guard: the
 * statistics' live-tuple count of core.organisation, or any workspace from the separate definer lister
 * core.worker_list_workspaces). A fresh, empty database is the only legitimate zero.
 *
 * The flag alone grants nothing in release 1: no route or job uses it until the metadata API (release 2). The service
 * re-check is `DataModelAuthorityService` (layer 2); payroll and attendance objects stay locked whatever a role holds.
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786721630000: Readonly<Record<string, readonly string[]>> = {
  ceo: ['data_model.manage'],
  manager: ['data_model.manage'],
};

export const DATA_MODEL_MANAGE_CATALOGUE_SQL =
  "INSERT INTO core.permission (key, resource, action) VALUES ('data_model.manage', 'data_model', 'manage') ON CONFLICT (key) DO NOTHING";

export const DATA_MODEL_MANAGE_GRANT_SQL = `DO $grant$
DECLARE
  o record;
  v_perm uuid;
  v_after uuid := NULL;
  v_page integer;
  v_orgs integer := 0;
  v_rows integer;
  v_granted integer := 0;
  v_missing integer;
  v_other integer;
BEGIN
  SELECT p.id INTO v_perm FROM core.permission p WHERE p.key = 'data_model.manage';
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'DataModelManagePermission1786721630000: permission data_model.manage missing';
  END IF;
  LOOP
    v_page := 0;
    FOR o IN SELECT l.organisation_id FROM core.worker_list_organisations(v_after, 100) l LOOP
      v_page := v_page + 1;
      v_orgs := v_orgs + 1;
      v_after := o.organisation_id;
      PERFORM pg_catalog.set_config('rab.organisation_id', o.organisation_id::text, true);
      PERFORM pg_catalog.set_config('rab.workspace_id', '', true);
      WITH ins AS (
        INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
        SELECT r.id, v_perm, r.organisation_id FROM core.role r
         WHERE r.organisation_id = o.organisation_id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')
           AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
        RETURNING role_id
      )
      UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT ins.role_id FROM ins);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_granted := v_granted + v_rows;
      -- Post-condition for this organisation: every ceo / manager system role holds it ...
      SELECT pg_catalog.count(*)::int INTO v_missing FROM core.role r
       WHERE r.organisation_id = o.organisation_id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')
         AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm);
      -- ... and no other role does (role_permission reads are organisation-wide, so a holder whose role this binding cannot
      -- see, e.g. a workspace role, is counted too).
      SELECT pg_catalog.count(*)::int INTO v_other FROM core.role_permission x
       WHERE x.organisation_id = o.organisation_id AND x.permission_id = v_perm
         AND NOT EXISTS (SELECT 1 FROM core.role r
                          WHERE r.id = x.role_id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager'));
      IF v_missing <> 0 OR v_other <> 0 THEN
        RAISE EXCEPTION 'DataModelManagePermission1786721630000: post-condition failed in one organisation (missing %, other holders %)', v_missing, v_other;
      END IF;
    END LOOP;
    EXIT WHEN v_page < 100;
  END LOOP;
  -- Review #252 (M): never a silent zero-organisation run. Zero organisations is legitimate only on an empty database.
  IF v_orgs = 0 AND (pg_catalog.pg_stat_get_live_tuples('core.organisation'::pg_catalog.regclass) > 0
                     OR EXISTS (SELECT 1 FROM core.worker_list_workspaces(NULL, 1))) THEN
    RAISE EXCEPTION 'DataModelManagePermission1786721630000: the organisation lister returned no organisation, but core.organisation has rows (refusing a silent zero-organisation run)';
  END IF;
  PERFORM pg_catalog.set_config('rab.organisation_id', '', true);
  PERFORM pg_catalog.set_config('rab.workspace_id', '', true);
  RAISE NOTICE 'DataModelManagePermission1786721630000: % organisation(s) checked, % system role(s) granted data_model.manage', v_orgs, v_granted;
END
$grant$`;

export const DATA_MODEL_MANAGE_CATALOGUE_CHECK_SQL =
  "SELECT pg_catalog.count(*)::int AS perm FROM core.permission WHERE key = 'data_model.manage' AND resource = 'data_model' AND action = 'manage'";

/**
 * down(): per organisation, delete every role grant of the flag and, when the organisation had any grant OR any per-user
 * override of it, bump the permission_version of every role visible under its binding (system and organisation-level roles),
 * so no cached authorisation snapshot keeps the flag. The override rows themselves are deleted afterwards by the
 * `user_permission_override.permission_id → core.permission ON DELETE CASCADE` foreign key when the catalogue row goes
 * (DATA_MODEL_MANAGE_CATALOGUE_DELETE_SQL). The same zero-organisation guard as up().
 */
export const DATA_MODEL_MANAGE_REVOKE_SQL = `DO $revoke$
DECLARE
  o record;
  v_after uuid := NULL;
  v_page integer;
  v_orgs integer := 0;
  v_rows integer;
  v_override boolean;
BEGIN
  LOOP
    v_page := 0;
    FOR o IN SELECT l.organisation_id FROM core.worker_list_organisations(v_after, 100) l LOOP
      v_page := v_page + 1;
      v_orgs := v_orgs + 1;
      v_after := o.organisation_id;
      PERFORM pg_catalog.set_config('rab.organisation_id', o.organisation_id::text, true);
      PERFORM pg_catalog.set_config('rab.workspace_id', '', true);
      WITH del AS (
        DELETE FROM core.role_permission rp USING core.role r, core.permission p
         WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'data_model.manage' AND r.organisation_id = o.organisation_id
        RETURNING rp.role_id
      )
      SELECT pg_catalog.count(*)::int INTO v_rows FROM del;
      SELECT EXISTS (SELECT 1 FROM core.user_permission_override upo JOIN core.permission p ON p.id = upo.permission_id
                      WHERE p.key = 'data_model.manage' AND upo.organisation_id = o.organisation_id) INTO v_override;
      IF v_rows > 0 OR v_override THEN
        UPDATE core.role SET permission_version = permission_version + 1 WHERE organisation_id = o.organisation_id;
      END IF;
    END LOOP;
    EXIT WHEN v_page < 100;
  END LOOP;
  -- Review #252 (M): never a silent zero-organisation run. Zero organisations is legitimate only on an empty database.
  IF v_orgs = 0 AND (pg_catalog.pg_stat_get_live_tuples('core.organisation'::pg_catalog.regclass) > 0
                     OR EXISTS (SELECT 1 FROM core.worker_list_workspaces(NULL, 1))) THEN
    RAISE EXCEPTION 'DataModelManagePermission1786721630000 down(): the organisation lister returned no organisation, but core.organisation has rows (refusing a silent zero-organisation run)';
  END IF;
  PERFORM pg_catalog.set_config('rab.organisation_id', '', true);
  PERFORM pg_catalog.set_config('rab.workspace_id', '', true);
END
$revoke$`;

/**
 * down(), last: the catalogue row. Its per-user overrides (`core.user_permission_override` rows for data_model.manage) are
 * deleted with it by the existing ON DELETE CASCADE foreign key (IdentitySchema1786665800000).
 */
export const DATA_MODEL_MANAGE_CATALOGUE_DELETE_SQL = "DELETE FROM core.permission WHERE key = 'data_model.manage'";

export class DataModelManagePermission1786721630000 implements MigrationInterface {
  name = 'DataModelManagePermission1786721630000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(DATA_MODEL_MANAGE_CATALOGUE_SQL);
    await runner.query(DATA_MODEL_MANAGE_GRANT_SQL);
    const [check] = (await runner.query(DATA_MODEL_MANAGE_CATALOGUE_CHECK_SQL)) as Array<{ perm: number }>;
    if (Number(check?.perm) !== 1) throw new Error(`${this.name}: post-condition failed: the catalogue row data_model.manage is missing or malformed`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(DATA_MODEL_MANAGE_REVOKE_SQL);
    await runner.query(DATA_MODEL_MANAGE_CATALOGUE_DELETE_SQL);
  }
}
