import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { CORE_BREAKS_RECEIPTS_STATE_SQL, CoreStateRow, coreBreaksReceiptsProblems } from '../../workspace-schema/attendance-breaks-receipts-sql';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { PROVISION_PREDECESSOR_SQL } from '../../workspace-schema/structure-level-24';
import { composeServerPathTemplateLevel26 } from '../../workspace-schema/structure-level-26';
import {
  composeServerPathTemplateLevel27,
  LEVEL_27_WORKSPACES_SQL,
  VERIFY_WORKSPACE_SCHEMA_V1_BEFORE_LEVEL_27_SQL,
  VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL,
} from '../../workspace-schema/structure-level-27';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { ATTENDANCE_BREAKS_RECEIPTS } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';
import { ATTENDANCE_CORRECTION_INSERT_ONLY } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

const LEVEL = 27;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §13 PR 2; "[after 0.7.0 cutover]", owner decision 44; structure level 27
 * by lead allocation, on top of #310's level 26). The core half of workspace structure level 27, the first level that adds
 * workspace tables; the workspace half is `0.7.0_AttendanceBreaksReceipts_1786722150000` (moves to 0.8.0 when that release
 * opens), applied per existing READY workspace by the workspace command runner after level 26.
 *
 * Read-only first: the core copies must already be AttendanceBreaksReceipts1786722140000's exact end state (the workspace
 * triggers call its core.attendance_break_write_guard()). Then, in ONE transaction:
 *  1. core.verify_workspace_schema_v1 re-created with the level-27 counts (structure-level-27.ts: 23 tables, 112 indexes,
 *     47 policies, 62 foreign keys, 23 bound CHECKs at level 27; every rule below level 27 unchanged);
 *  2. core.provision_workspace re-created (guarded v3 body) over template(20) + levels 21-26 + the level-27 statements,
 *     recording module_version 27 and checking the declared level-27 v2 fingerprint of this server's major;
 *  3. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change: core.provision_workspace must be the level-26 body (up) or this level-27 body (down).
 * down(): refused while any workspace schema has attendance_break or attendance_sync_receipt; otherwise the level-26
 * provision body and the level-22 verify body are restored (the core copies stay: they are AttendanceBreaksReceipts').
 */
export class WorkspaceAttendanceBreaksReceipts1786722150000 implements MigrationInterface {
  name = 'WorkspaceAttendanceBreaksReceipts1786722150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = ATTENDANCE_BREAKS_RECEIPTS.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const fp: string = expected;
    const literal: string = structure.provisionFunctionLiteral;
    await this.inTransaction(queryRunner, async () => {
      const rows = (await queryRunner.query(CORE_BREAKS_RECEIPTS_STATE_SQL)) as CoreStateRow[];
      const problems = coreBreaksReceiptsProblems(rows);
      if (problems.length) throw new Error(`${this.name}: refusing: the core copies are not AttendanceBreaksReceipts1786722140000's state (nothing changed):\n  ${problems.join('\n  ')}`);
      await this.assertProvisionPredecessor(queryRunner, 'up', ATTENDANCE_CORRECTION_INSERT_ONLY.structure!.provisionFunctionLiteral!, literal);
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel27(), modules20(), LEVEL, fp, literal));
      await this.verifyProvisionFunction(queryRunner, literal);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [{ n }] = (await queryRunner.query(LEVEL_27_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 27 (they have attendance_break / attendance_sync_receipt). ` +
            'Nothing was changed. Those tables hold pay evidence and are never dropped by a rollback; a level-26 provision body next to them would make the fleet inconsistent.',
        );
      }
      const s26 = ATTENDANCE_CORRECTION_INSERT_ONLY.structure!;
      await this.assertProvisionPredecessor(queryRunner, 'down', ATTENDANCE_BREAKS_RECEIPTS.structure!.provisionFunctionLiteral!, s26.provisionFunctionLiteral!);
      const fp26 = s26.fingerprints[workspaceFingerprintMajor()];
      if (!fp26) throw new Error(`${this.name}: no level-26 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel26(), modules20(), 26, fp26, s26.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s26.provisionFunctionLiteral!);
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_BEFORE_LEVEL_27_SQL);
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
