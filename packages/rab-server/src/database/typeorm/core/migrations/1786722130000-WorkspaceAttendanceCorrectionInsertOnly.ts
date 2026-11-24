import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { PROVISION_PREDECESSOR_SQL } from '../../workspace-schema/structure-level-24';
import { composeServerPathTemplateLevel25 } from '../../workspace-schema/structure-level-25';
import { composeServerPathTemplateLevel26, LEVEL_26_WORKSPACES_SQL } from '../../workspace-schema/structure-level-26';
import {
  CORE_CORRECTION_APP_GRANTS_SQL,
  CORE_CORRECTION_GUARD_STATE_SQL,
  CorrectionAppGrants,
  CorrectionGuardRow,
  coreCorrectionGuardProblems,
} from '../../workspace-schema/attendance-correction-insert-only-sql';
import { CORE_CORRECTION_FK_STATE_SQL, CorrectionFkRow, correctionFkProblems } from '../../workspace-schema/attendance-correction-evidence-restrict-sql';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { ATTENDANCE_STAFF_SCOPE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { ATTENDANCE_CORRECTION_INSERT_ONLY } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

const LEVEL = 26;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11 + owner decision 46, the workspace-schema copies; release 0.7.0,
 * structure level 26 by lead allocation; depends on #300 (level 25) and #306). The core half of workspace structure level 26;
 * the workspace half is `0.7.0_AttendanceCorrectionInsertOnly_1786722130000` (upgrade-commands/0-7/attendance-correction-insert-
 * only.ts), applied per existing READY workspace by the workspace command runner after level 25.
 *
 * Read-only first: core.attendance_correction must already carry #306's three guard triggers and its RESTRICT key. Then, in ONE
 * transaction:
 *  1. `REVOKE UPDATE, DELETE ON core.attendance_correction FROM crewflow_app` (cosmetic for the owner-login runtime, which the
 *     triggers bind; done in the same release as the workspace REVOKE so tools/check-rls-coverage.ts's "workspace grants =
 *     core grants" holds); crewflow_app keeps SELECT and INSERT (checked);
 *  2. core.provision_workspace re-created (guarded v3 body) over template(20) + levels 21-25 + the level-26 statements,
 *     recording module_version 26 and checking the declared level-26 v2 fingerprint of this server's major;
 *  3. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change: core.provision_workspace must be the level-25 body (up) or this level-26 body (down).
 * down(): refused while any workspace carries the level-26 triggers; otherwise GRANT UPDATE, DELETE back to crewflow_app and
 * the level-25 provision body restored (the core triggers and key stay: they are #306's).
 */
export class WorkspaceAttendanceCorrectionInsertOnly1786722130000 implements MigrationInterface {
  name = 'WorkspaceAttendanceCorrectionInsertOnly1786722130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = ATTENDANCE_CORRECTION_INSERT_ONLY.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const fp: string = expected;
    const literal: string = structure.provisionFunctionLiteral;
    await this.inTransaction(queryRunner, async () => {
      await this.assertCoreCorrectionState(queryRunner);
      await this.assertProvisionPredecessor(queryRunner, 'up', ATTENDANCE_STAFF_SCOPE.structure!.provisionFunctionLiteral!, literal);
      await queryRunner.query('REVOKE UPDATE, DELETE ON core.attendance_correction FROM crewflow_app');
      const [grants] = (await queryRunner.query(CORE_CORRECTION_APP_GRANTS_SQL)) as CorrectionAppGrants[];
      if (!grants || grants.can_update || grants.can_delete || !grants.can_insert || !grants.can_select) {
        throw new Error(`${this.name}: crewflow_app privileges on core.attendance_correction after the REVOKE: ${JSON.stringify(grants)} (rolled back).`);
      }
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel26(), modules20(), LEVEL, fp, literal));
      await this.verifyProvisionFunction(queryRunner, literal);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [{ n }] = (await queryRunner.query(LEVEL_26_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 26 (their attendance_correction carries the insert-only triggers). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) drop the three triggers, put the key back to CASCADE, GRANT UPDATE, DELETE to ' +
            'crewflow_app and set core.workspace_schema_registry.module_version back to 25, then run down() again.',
        );
      }
      const s25 = ATTENDANCE_STAFF_SCOPE.structure!;
      await this.assertProvisionPredecessor(queryRunner, 'down', ATTENDANCE_CORRECTION_INSERT_ONLY.structure!.provisionFunctionLiteral!, s25.provisionFunctionLiteral!);
      await queryRunner.query('GRANT UPDATE, DELETE ON core.attendance_correction TO crewflow_app');
      const fp25 = s25.fingerprints[workspaceFingerprintMajor()];
      if (!fp25) throw new Error(`${this.name}: no level-25 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel25(), modules20(), 25, fp25, s25.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s25.provisionFunctionLiteral!);
    });
  }

  private async inTransaction(queryRunner: QueryRunner, body: () => Promise<void>): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
      const problems = bootstrapIdentityProblems(f);
      if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
      await body();
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  /** Read-only: #306's core triggers and RESTRICT key must be in place (AttendanceCorrectionInsertOnly / EvidenceRestrict ran). */
  private async assertCoreCorrectionState(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(CORE_CORRECTION_GUARD_STATE_SQL)) as CorrectionGuardRow[];
    const [grants] = (await queryRunner.query(CORE_CORRECTION_APP_GRANTS_SQL)) as CorrectionAppGrants[];
    const [fk] = (await queryRunner.query(CORE_CORRECTION_FK_STATE_SQL)) as CorrectionFkRow[];
    const problems = [...coreCorrectionGuardProblems(rows, grants), ...correctionFkProblems(fk, 'r')];
    if (problems.length) throw new Error(`${this.name}: refusing: core.attendance_correction is not in #306's state (nothing changed):\n  ${problems.join('\n  ')}`);
  }

  private async assertProvisionPredecessor(queryRunner: QueryRunner, direction: 'up' | 'down', present: string, absent: string): Promise<void> {
    const [row] = (await queryRunner.query(PROVISION_PREDECESSOR_SQL, [present, absent])) as Array<{ ok: boolean }>;
    if (row?.ok !== true) {
      throw new Error(`${this.name}: refusing to run ${direction}: core.provision_workspace is not the expected predecessor body (want ${present}, not ${absent}). Nothing was changed.`);
    }
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
