import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel24, PROVISION_PREDECESSOR_SQL } from '../../workspace-schema/structure-level-24';
import { composeServerPathTemplateLevel25, LEVEL_25_WORKSPACES_SQL } from '../../workspace-schema/structure-level-25';
import {
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_SCOPE_HASH,
  CORE_CORRECTION_POLICY_SQL,
  CORE_CORRECTION_SCOPE_HASH,
} from '../../workspace-schema/attendance-staff-scope-sql';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { ATTENDANCE_STAFF_SCOPE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

const LEVEL = 25;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §11 LOW finding, the workspace-schema copies; release 0.7.0, structure
 * level 25 by lead allocation; depends on #175, #177, #243 and #305). The core half of workspace structure level 25; the
 * workspace half is `0.7.0_AttendanceStaffScope_1786722120000` (upgrade-commands/0-7/attendance-staff-scope.ts), applied per
 * existing READY workspace by the workspace command runner after level 24, on the same locked start.
 *
 * The CORE policies are NOT changed here: AttendanceStaffScopeRls1786722100000 (#305) did that. This migration only checks
 * (read-only) that both core policies already carry #305's predicates, then, in ONE transaction:
 *  1. core.provision_workspace re-created (guarded v3 body) over template(20) + levels 21-24 + the level-25 ALTER POLICY
 *     statements (attendance_tenant and attendance_correction_tenant), recording module_version 25 and checking the declared
 *     level-25 v2 fingerprint of this server's major;
 *  2. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change: core.provision_workspace must be #243's level-24 body (up) or this level-25 body (down).
 * down(): restores the level-24 provision body; refused while any workspace is at level 25. The core policies stay (#305).
 */
export class WorkspaceAttendanceStaffScope1786722120000 implements MigrationInterface {
  name = 'WorkspaceAttendanceStaffScope1786722120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = ATTENDANCE_STAFF_SCOPE.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const fp: string = expected;
    const literal: string = structure.provisionFunctionLiteral;
    await this.inTransaction(queryRunner, async () => {
      await this.assertCorePolicies(queryRunner);
      await this.assertProvisionPredecessor(queryRunner, 'up', STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!.provisionFunctionLiteral!, literal);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel25(), modules20(), LEVEL, fp, literal));
      await this.verifyProvisionFunction(queryRunner, literal);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [{ n }] = (await queryRunner.query(LEVEL_25_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 25 (their attendance or correction policy is not the tenant-only predicate). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) restore both tenant-only predicates with ALTER POLICY and set ' +
            'core.workspace_schema_registry.module_version back to 24, then run down() again.',
        );
      }
      const s24 = STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!;
      await this.assertProvisionPredecessor(queryRunner, 'down', ATTENDANCE_STAFF_SCOPE.structure!.provisionFunctionLiteral!, s24.provisionFunctionLiteral!);
      const fp24 = s24.fingerprints[workspaceFingerprintMajor()];
      if (!fp24) throw new Error(`${this.name}: no level-24 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel24(), modules20(), 24, fp24, s24.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s24.provisionFunctionLiteral!);
    });
  }

  private async inTransaction(queryRunner: QueryRunner, body: () => Promise<void>): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
      const problems = bootstrapIdentityProblems(f);
      const [g] = (await queryRunner.query(`SELECT pg_catalog.to_regprocedure('core.workspace_schema_fingerprint_v2(uuid)') IS NOT NULL AS v2`)) as Array<{ v2: boolean }>;
      if (!g?.v2) problems.push('core.workspace_schema_fingerprint_v2(uuid) does not exist (WorkspaceStaffMemberSelect1786721480000 first)');
      if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
      await body();
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  /** Read-only: both core policies must already carry #305's predicates (AttendanceStaffScopeRls1786722100000 ran first). */
  private async assertCorePolicies(queryRunner: QueryRunner): Promise<void> {
    for (const [label, sql, want] of [
      ['core.attendance attendance_tenant', CORE_ATTENDANCE_POLICY_SQL, CORE_ATTENDANCE_SCOPE_HASH],
      ['core.attendance_correction attendance_correction_tenant', CORE_CORRECTION_POLICY_SQL, CORE_CORRECTION_SCOPE_HASH],
    ] as const) {
      const [p] = (await queryRunner.query(sql)) as Array<{ using_hash: string | null; check_hash: string | null }>;
      if (p?.using_hash !== want || p?.check_hash !== want) {
        throw new Error(`${this.name}: refusing: ${label} is not the AttendanceStaffScopeRls1786722100000 predicate (USING ${p?.using_hash ?? 'none'}, WITH CHECK ${p?.check_hash ?? 'none'}, expected ${want}). Nothing was changed.`);
      }
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
