import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL, provisionWorkspaceFunctionV3Sql } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { EXPECTED_WORKSPACE_FINGERPRINTS, workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { composeServerPathTemplateV1GrantParity } from '../../workspace-schema/v1/server-path-template-grant-parity';
import { VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL } from '../../workspace-schema/v1/verify-workspace-schema-v1-policy-aware';
import {
  composeServerPathTemplateLevel21,
  DROP_WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL,
  LEVEL_21_WORKSPACES_SQL,
  provisionWorkspaceFunctionLevelSql,
  VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL,
  WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL,
} from '../../workspace-schema/structure-level-21';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { STAFF_PROFILE_MEMBER_SELECT } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select';

const LEVEL = 21;
const PREVIOUS_APP_VERSION = 'db:provision_workspace@WorkspaceGrantParityGuards1786721430000';

/**
 * OWNER-DB-ULTIMATE Part D, owner decision 0b (2026-11-14): the core half of workspace structure level 21, the first
 * structure-changing release (D-RUNNER.md §5.3). The workspace half is the workspace upgrade command
 * `0.6.0_StaffProfileMemberSelect_1786721480000` (upgrade-commands/0-6/staff-profile-member-select.ts), which the workspace
 * command runner applies to every existing READY workspace after this migration, on the same locked start. Frozen SQL and
 * reasoning: ../../workspace-schema/structure-level-21.ts (owner review: WS-COMMANDS.md "FOR OWNER REVIEW — 0b release").
 *
 * In ONE transaction:
 *  1. fingerprint v2 (D-RUNNER.md §9.1, owner-approved to ship with this release): two new functions next to v1;
 *  2. core.verify_workspace_schema_v1 re-created: 42 policies at level 21+ (the runner bumps module_version BEFORE calling it);
 *  3. core.provision_workspace re-created (guarded v3 body) over template(20) + the level-21 command, recording
 *     module_version 21 and checking the declared level-21 v2 fingerprint of this server's PostgreSQL major;
 *  4. privilege shape, body literal and the secure-owner invariants re-verified.
 * No workspace schema is touched here (the runner does that, one transaction per workspace, with its post-step checks).
 * Refuses while the level-21 v2 fingerprint of this major is not declared on the command.
 * down(): REFUSES (nothing changed) while any workspace schema still carries staff_profile_member_select (security review F1);
 * otherwise restores the 1786721430000 provision_workspace body (module 20) and the VenueTeamOrgAdmin1786721090000 verify body
 * and drops the v2 functions. The per-workspace cleanup before a rollback is owner-run, not automated.
 */
export class WorkspaceStaffMemberSelect1786721480000 implements MigrationInterface {
  name = 'WorkspaceStaffMemberSelect1786721480000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = STAFF_PROFILE_MEMBER_SELECT.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      await queryRunner.query(WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL);
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL);
      const modules = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel21(), modules, LEVEL, expected, structure.provisionFunctionLiteral));
      await this.verifyProvisionFunction(queryRunner, structure.provisionFunctionLiteral);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      // Security review F1: never leave level-21 workspaces behind a level-20 verify body (it expects 41 policies; they would
      // all fail verification). Refuse BEFORE restoring anything while any workspace still carries the level-21 policy.
      const [{ n }] = (await queryRunner.query(LEVEL_21_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) still carry staff_profile_member_select (structure level 21). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) DROP POLICY staff_profile_member_select ON workspace_<32 hex>.staff_profile ' +
            'and set core.workspace_schema_registry.module_version back to 20 for it, then run down() again.',
        );
      }
      const previous = EXPECTED_WORKSPACE_FINGERPRINTS[20];
      if (!previous) throw new Error(`${this.name}: no expected fingerprint for module version 20`);
      const modules = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(provisionWorkspaceFunctionV3Sql(composeServerPathTemplateV1GrantParity(), modules, previous, PREVIOUS_APP_VERSION));
      await this.verifyProvisionFunction(queryRunner, PREVIOUS_APP_VERSION);
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL);
      await queryRunner.query(DROP_WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    const [g] = (await queryRunner.query(
      `SELECT pg_catalog.to_regprocedure('core.member_holds_workspace_permission(uuid, text)') IS NOT NULL AS helper,
              pg_catalog.to_regprocedure('core.workspace_schema_fingerprint_lines(uuid)') IS NOT NULL AS v1`,
    )) as Array<{ helper: boolean; v1: boolean }>;
    if (!g?.helper) problems.push('core.member_holds_workspace_permission(uuid, text) does not exist (WorkspaceMemberRoles1786714500000 first)');
    if (!g?.v1) problems.push('core.workspace_schema_fingerprint_lines(uuid) does not exist (WorkspaceSchemaMigrationLedger1786719800000 first)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }

  private async verifyProvisionFunction(queryRunner: QueryRunner, appVersion: string): Promise<void> {
    const [p] = (await queryRunner.query(PROVISION_WORKSPACE_STATE_SQL)) as Array<Record<string, unknown>>;
    const shapeOk = Object.entries(PROVISION_WORKSPACE_PRIVILEGE_SHAPE).every(([k, v]) => p?.[k] === v);
    const [body] = (await queryRunner.query(
      `SELECT pg_catalog.strpos(p.prosrc, $1) > 0 AS ours FROM pg_catalog.pg_proc p WHERE p.oid = 'core.provision_workspace(uuid)'::pg_catalog.regprocedure`,
      [appVersion],
    )) as Array<{ ours: boolean }>;
    if (!shapeOk || p?.has_guards !== true || body?.ours !== true) {
      throw new Error(`${this.name}: core.provision_workspace lost its privilege shape or body: ${JSON.stringify(p)}`);
    }
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
