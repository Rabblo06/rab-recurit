import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel22 } from '../../workspace-schema/structure-level-22';
import { composeServerPathTemplateLevel23, LEVEL_23_WORKSPACES_SQL } from '../../workspace-schema/structure-level-23';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';

const LEVEL = 23;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (OWNER-DB-ULTIMATE Part C3, owner decision Q3, 2026-11-15; SQL-DRAFTS.md §6.7 and
 * the Q3 draft PR). The core half of workspace structure level 23; the workspace half is
 * `0.7.0_ValidateStaffProfileWorkspaceRequired_1786721595000` (upgrade-commands/0-7/staff-profile-workspace-required-validate.ts),
 * applied per existing READY workspace by the workspace command runner after this release's instance commands (the HWS
 * cutover), on the same locked start.
 *
 * In ONE transaction:
 *  1. core.provision_workspace re-created (guarded v3 body) over template(20) + level 21 + level 22 + the level-23 VALIDATE,
 *     recording module_version 23 and checking the declared level-23 v2 fingerprint of this server's PostgreSQL major;
 *  2. privilege shape, body literal and the secure-owner invariants re-verified.
 * core.verify_workspace_schema_v1 is unchanged (it never reads convalidated). No core table changes.
 * down(): restores the level-22 provision body; refused while any workspace is at level 23 (its constraint already VALID).
 */
export class WorkspaceStaffProfileWorkspaceRequiredValidated1786721595000 implements MigrationInterface {
  name = 'WorkspaceStaffProfileWorkspaceRequiredValidated1786721595000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel23(), modules20(), LEVEL, expected, structure.provisionFunctionLiteral));
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
      const [{ n }] = (await queryRunner.query(LEVEL_23_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 23 (staff_profile_workspace_required already VALID). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) drop and re-add the constraint as ' +
            '`CHECK ((workspace_id IS NOT NULL)) NOT VALID` and set core.workspace_schema_registry.module_version back to 22, then run down() again.',
        );
      }
      const s22 = WORKSPACE_CORE_FK_REMOVAL.structure!;
      const fp22 = s22.fingerprints[workspaceFingerprintMajor()];
      if (!fp22) throw new Error(`${this.name}: no level-22 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel22(), modules20(), 22, fp22, s22.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s22.provisionFunctionLiteral!);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    const [g] = (await queryRunner.query(`SELECT pg_catalog.to_regprocedure('core.workspace_schema_fingerprint_v2(uuid)') IS NOT NULL AS v2`)) as Array<{ v2: boolean }>;
    if (!g?.v2) problems.push('core.workspace_schema_fingerprint_v2(uuid) does not exist (WorkspaceStaffMemberSelect1786721480000 first)');
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

function modules20() {
  return modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
