import { MigrationInterface, QueryRunner } from 'typeorm';

import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionV2Sql } from '../../workspace-schema/v1/provision-workspace-function-v2';
import { composeServerPathTemplateV1ArchiveSearch } from '../../workspace-schema/v1/server-path-template-archive-search';
import { composeServerPathTemplateV1VenueTeamAdmin } from '../../workspace-schema/v1/server-path-template-venue-team-admin';
import { venueTeamOrgAdminSql } from '../../workspace-schema/v1/venue-team-org-admin';
import { VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL } from '../../workspace-schema/v1/verify-workspace-schema-v1-policy-aware';
import { WorkspaceSchemaMigrator } from '../../workspace-schema/workspace-schema-migrator';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';

const THROUGH_VERSION = 18;
const PREVIOUS_VERSION = 17;
const PREVIOUS_APP_VERSION = 'db:provision_workspace@ArchiveAndSearchSchema1786719920000';

/**
 * Owner decision 2026-10-28 — organisation administrators (holders of `manager.manage`: the CEO by default, a platform
 * admin only through their own role in the organisation) may view, add and remove the Staff a Venue Manager can see, in
 * any workspace of their own organisation, and may see that workspace's Staff while choosing them ("picker only").
 * The workspace owner's existing path (`venue_manager_staff_owner`) is unchanged. Initial Managers keep exactly their
 * current, own-workspace path (owner decision: no change for them).
 *
 * Module v1.018 (`v1/venue-team-org-admin.ts`), in core and every workspace schema:
 *   - venue_manager_staff_org_admin   FOR ALL, staff_profile_org_admin_picker FOR SELECT; both require the bound org and
 *     workspace, `rab.admin_scope = 'venue_team'` (bound only by VenueManagerService's org-admin team methods) and
 *     `manager.manage` in the bound organisation (the MANAGE_IN_ORG predicate of 1786717300000). No policy is dropped or
 *     loosened for anyone else; FORCE / ENABLE are untouched; no grant changes.
 *
 * Pattern: ArchiveAndSearchSchema1786719920000 / AttendanceMoneyChecks1786719810000 (the module list is the single source
 * of truth; WorkspaceSchemaMigrator).
 *  1. (one transaction) module-18 SQL applied to `core`; `core.verify_workspace_schema_v1` re-created policy-aware (39 for
 *     v1..17, 41 at v18+); `core.provision_workspace(uuid)` re-created with the v18 composition (same owner / DEFINER /
 *     search_path / ACL, re-verified).
 *  2. Every READY workspace migrated to module 18 by WorkspaceSchemaMigrator, one transaction per schema, ledger rows,
 *     fingerprint must equal the frozen v18 value. A failing schema is rolled back and recorded; the migration then throws
 *     (not recorded as applied) and a re-run resumes (step 1 is idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE).
 *
 * Dev/test only: deliberately NOT in production-migration-approval.ts (N1). `transaction = false` for the per-schema
 * transactions.
 */
export class VenueTeamOrgAdmin1786721090000 implements MigrationInterface {
  name = 'VenueTeamOrgAdmin1786721090000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const expected = EXPECTED_WORKSPACE_FINGERPRINTS[THROUGH_VERSION];
    if (!expected) throw new Error(`${this.name}: no expected fingerprint for module version ${THROUGH_VERSION}`);
    // Normally runMigrations honours `transaction = false`; if a caller already holds a transaction, join it (savepoints).
    const outer = queryRunner.isTransactionActive;

    if (!outer) await queryRunner.query('BEGIN');
    try {
      await this.assertBootstrap(queryRunner);
      await queryRunner.query(venueTeamOrgAdminSql('core'));
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL);
      const modules = modulesThrough(THROUGH_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(
        provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1VenueTeamAdmin(), 'CREATE OR REPLACE', modules, expected, `db:provision_workspace@${this.name}`),
      );
      await this.verifyFunctions(queryRunner);
      await this.verifyCorePolicies(queryRunner, true);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }

    const outcomes = await new WorkspaceSchemaMigrator(queryRunner).migrateAll({
      throughVersion: THROUGH_VERSION,
      txMode: outer ? 'savepoint' : 'own',
      appVersion: `migration:${this.name}`,
      lockTimeoutMs: 10_000,
    });
    const bad = outcomes.filter((o) => o.status === 'FAILED' || o.status === 'REFUSED');
    // eslint-disable-next-line no-console
    console.log(
      `[${this.name}] workspaces: ${outcomes.filter((o) => o.status === 'MIGRATED').length} migrated, ` +
        `${outcomes.filter((o) => o.status === 'UP_TO_DATE' || o.status === 'BASELINED').length} already current, ` +
        `${outcomes.filter((o) => o.status === 'SKIPPED').length} skipped (not READY), ${bad.length} failed/refused`,
    );
    if (bad.length) {
      throw new Error(
        `${this.name}: ${bad.length} workspace schema(s) did not reach module ${THROUGH_VERSION}: ` +
          bad.map((o) => `${o.schemaName} ${o.status} ${o.errorClass} at ${o.moduleId}`).join('; ') +
          '. Each is rolled back and recorded in core.workspace_schema_migration; the others are migrated. Fix and re-run (resumes).',
      );
    }
  }

  /**
   * Restores the 1786719920000 provision_workspace body (module 17) and removes the two core policies. Kept on purpose,
   * exactly like 1786719920000's own down():
   *  - workspace schemas keep module 18 (the ledger is append-only history; undoing it is a forward migration's job). Its
   *    two policies are inert once this down() runs on an image that predates it: nothing binds `rab.admin_scope`;
   *  - the policy-aware verify_workspace_schema_v1 (identical to the previous body for v1..17 schemas, and the only body
   *    under which the kept v18 schemas still verify).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // `migration:revert` always opens a transaction (TypeORM ignores `transaction = false` on revert): join it.
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await this.assertBootstrap(queryRunner);
      const previous = EXPECTED_WORKSPACE_FINGERPRINTS[PREVIOUS_VERSION]!;
      const modules = modulesThrough(PREVIOUS_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(
        provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1ArchiveSearch(), 'CREATE OR REPLACE', modules, previous, PREVIOUS_APP_VERSION),
      );
      await queryRunner.query(`
        DROP POLICY IF EXISTS venue_manager_staff_org_admin ON core.venue_manager_staff;
        DROP POLICY IF EXISTS staff_profile_org_admin_picker ON core.staff_profile;
      `);
      await this.verifyFunctions(queryRunner);
      await this.verifyCorePolicies(queryRunner, false);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'VenueTeamOrgAdmin1786721090000 must run as the bootstrap identity (it re-creates crewflow-owned policies and functions and migrates rab_secure_owner-owned workspace schemas); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }

  /** Same privilege shapes as before: provision_workspace crewflow-owned DEFINER, EXECUTE crewflow + crewflow_app; verify not for the runtime role. */
  private async verifyFunctions(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ fn: string; definer: boolean; owner: string; path_ok: boolean; executors: string[] }> = await queryRunner.query(`
      SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
             'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])) AS path_ok,
             coalesce((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END ORDER BY 1)
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY[]::text[]) AS executors
        FROM pg_proc p
       WHERE p.oid IN ('core.provision_workspace(uuid)'::regprocedure, 'core.verify_workspace_schema_v1(uuid)'::regprocedure)
       ORDER BY 1`);
    const provision = rows.find((r) => r.fn === 'core.provision_workspace(uuid)');
    const verify = rows.find((r) => r.fn === 'core.verify_workspace_schema_v1(uuid)');
    if (
      !provision || provision.definer !== true || provision.owner !== 'crewflow' || provision.path_ok !== true ||
      provision.executors.join(',') !== 'crewflow,crewflow_app'
    ) {
      throw new Error(`${this.name}: core.provision_workspace lost its privilege shape: ${JSON.stringify(provision)}`);
    }
    if (!verify || verify.definer !== false || verify.owner !== 'crewflow' || verify.path_ok !== true || verify.executors.includes('crewflow_app') || verify.executors.includes('PUBLIC')) {
      throw new Error(`${this.name}: core.verify_workspace_schema_v1 lost its privilege shape: ${JSON.stringify(verify)}`);
    }
  }

  /** The two core policies exist (up) or are gone (down); FORCE/ENABLE on both tables is unchanged either way. */
  private async verifyCorePolicies(queryRunner: QueryRunner, present: boolean): Promise<void> {
    const [row]: Array<{ n: number; forced: number }> = await queryRunner.query(`
      SELECT (SELECT count(*)::int FROM pg_policy
                WHERE (polrelid = 'core.venue_manager_staff'::regclass AND polname = 'venue_manager_staff_org_admin')
                   OR (polrelid = 'core.staff_profile'::regclass AND polname = 'staff_profile_org_admin_picker')) AS n,
             (SELECT count(*)::int FROM pg_class
                WHERE oid IN ('core.venue_manager_staff'::regclass, 'core.staff_profile'::regclass)
                  AND relrowsecurity AND relforcerowsecurity) AS forced`);
    if (row!.n !== (present ? 2 : 0) || row!.forced !== 2) {
      throw new Error(`${this.name}: core policy state is not as expected (policies=${row!.n}, forced tables=${row!.forced})`);
    }
  }
}
