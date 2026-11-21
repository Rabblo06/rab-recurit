import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { PROVISION_PREDECESSOR_SQL } from '../../workspace-schema/structure-level-24';
import { composeServerPathTemplateLevel25 } from '../../workspace-schema/structure-level-25';
import {
  composeServerPathTemplateLevel26,
  CORE_CORRECTION_APP_GRANTS_SQL,
  CORE_CORRECTION_GUARD_STATE_SQL,
  coreCorrectionGuardProblems,
  LEVEL_26_WORKSPACES_SQL,
} from '../../workspace-schema/structure-level-26';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { ATTENDANCE_STAFF_SCOPE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import {
  ATTENDANCE_CORRECTION_INSERT_ONLY,
  attendanceCorrectionInsertOnlyDownSql,
  attendanceCorrectionInsertOnlySql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

const LEVEL = 26;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11 / architecture §5.7, owner decision 2026-11-21; release 0.7.0,
 * structure level 26; depends on level 25 and #243 / #177 / #175). The core half of workspace structure level 26; the
 * workspace half is `0.7.0_AttendanceCorrectionInsertOnly_1786722110000`
 * (upgrade-commands/0-7/attendance-correction-insert-only.ts), applied per existing READY workspace by the runner.
 *
 * In ONE transaction:
 *  1. core.attendance_correction (the HWS-off copy): `REVOKE UPDATE, DELETE ... FROM crewflow_app` and three statement-level
 *     BEFORE UPDATE / DELETE / TRUNCATE triggers calling the existing core.owner_login_grant_parity_guard() (unchanged): the
 *     runtime login gets 42501, definers / FK actions (table owner) / superusers pass. The end state is checked (triggers,
 *     tgtype, function, crewflow_app keeps SELECT + INSERT and holds no UPDATE / DELETE).
 *  2. core.provision_workspace re-created (guarded v3 body) over template(20) + levels 21-25 + the level-26 statements,
 *     recording module_version 26 and checking the declared level-26 v2 fingerprint of this server's major;
 *  3. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change: core.provision_workspace must be the level-25 body (up) or this level-26 body (down).
 * No table, column, policy or data change. down(): drops the core triggers, restores crewflow_app's UPDATE / DELETE and the
 * level-25 provision body; refused while any workspace carries the level-26 triggers.
 */
export class AttendanceCorrectionInsertOnly1786722110000 implements MigrationInterface {
  name = 'AttendanceCorrectionInsertOnly1786722110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = ATTENDANCE_CORRECTION_INSERT_ONLY.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      await this.assertProvisionPredecessor(queryRunner, 'up', ATTENDANCE_STAFF_SCOPE.structure!.provisionFunctionLiteral!, structure.provisionFunctionLiteral!);
      await queryRunner.query(attendanceCorrectionInsertOnlySql('core'));
      const rows = (await queryRunner.query(CORE_CORRECTION_GUARD_STATE_SQL)) as Array<{ name: string; enabled: string; tgtype: number; fn: string }>;
      const [grants] = (await queryRunner.query(CORE_CORRECTION_APP_GRANTS_SQL)) as Array<{ can_update: boolean; can_delete: boolean; can_insert: boolean; can_select: boolean }>;
      const problems = coreCorrectionGuardProblems(rows, grants);
      if (problems.length) throw new Error(`${this.name}: unexpected core state after up() (rolled back):\n  ${problems.join('\n  ')}`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel26(), modules20(), LEVEL, expected, structure.provisionFunctionLiteral));
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
      const [{ n }] = (await queryRunner.query(LEVEL_26_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 26 (their attendance_correction carries the insert-only triggers). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) drop the three attendance_correction_insert_only_* triggers, restore ' +
            'GRANT UPDATE, DELETE ... TO crewflow_app and set core.workspace_schema_registry.module_version back to 25, then run down() again.',
        );
      }
      const s25 = ATTENDANCE_STAFF_SCOPE.structure!;
      await this.assertProvisionPredecessor(queryRunner, 'down', ATTENDANCE_CORRECTION_INSERT_ONLY.structure!.provisionFunctionLiteral!, s25.provisionFunctionLiteral!);
      await queryRunner.query(attendanceCorrectionInsertOnlyDownSql('core'));
      const fp25 = s25.fingerprints[workspaceFingerprintMajor()];
      if (!fp25) throw new Error(`${this.name}: no level-25 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel25(), modules20(), 25, fp25, s25.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s25.provisionFunctionLiteral!);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  /** `present` must be in core.provision_workspace's body and `absent` must not; anything else is refused before any change. */
  private async assertProvisionPredecessor(queryRunner: QueryRunner, direction: 'up' | 'down', present: string, absent: string): Promise<void> {
    const [row] = (await queryRunner.query(PROVISION_PREDECESSOR_SQL, [present, absent])) as Array<{ ok: boolean }>;
    if (row?.ok !== true) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: core.provision_workspace is not the expected predecessor body (want ${present}, not ${absent}). Nothing was changed.`,
      );
    }
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    const [g] = (await queryRunner.query(
      `SELECT pg_catalog.to_regprocedure('core.workspace_schema_fingerprint_v2(uuid)') IS NOT NULL AS v2,
              pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS guard`,
    )) as Array<{ v2: boolean; guard: boolean }>;
    if (!g?.v2) problems.push('core.workspace_schema_fingerprint_v2(uuid) does not exist (WorkspaceStaffMemberSelect1786721480000 first)');
    if (!g?.guard) problems.push('core.owner_login_grant_parity_guard() does not exist (OwnerLoginGrantParityGuards1786721420000 first)');
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
