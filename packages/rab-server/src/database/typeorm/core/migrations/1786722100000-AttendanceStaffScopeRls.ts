import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel24, PROVISION_PREDECESSOR_SQL } from '../../workspace-schema/structure-level-24';
import {
  ATTENDANCE_TENANT_HASH,
  composeServerPathTemplateLevel25,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_SCOPE_HASH,
  LEVEL_25_WORKSPACES_SQL,
} from '../../workspace-schema/structure-level-25';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import {
  ATTENDANCE_STAFF_SCOPE,
  attendanceStaffScopeSql,
  attendanceTenantOnlySql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

const LEVEL = 25;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §11 LOW finding, owner decision 2026-11-21; release 0.7.0, structure
 * level 25; depends on #175, #177 and #243). The core half of workspace structure level 25; the workspace half is
 * `0.7.0_AttendanceStaffScope_1786722100000` (upgrade-commands/0-7/attendance-staff-scope.ts), applied per existing READY
 * workspace by the workspace command runner after level 24, on the same locked start.
 *
 * In ONE transaction:
 *  1. `ALTER POLICY attendance_tenant ON core.attendance USING (...) WITH CHECK (...)`: the HWS-off copy gets the same
 *     predicate: tenant AND (worker OR the caller's own staff profile OR a non-venue manager of the workspace OR a Venue
 *     Manager of the shift's venue). Only a known current expression is replaced (tenant-only, or this migration's own on a
 *     re-run; semantic-golden hashes on BOTH expressions); anything else is refused. PERMISSIVE, FOR ALL and TO PUBLIC are
 *     checked before and after.
 *  2. core.provision_workspace re-created (guarded v3 body) over template(20) + levels 21-24 + the level-25 ALTER POLICY,
 *     recording module_version 25 and checking the declared level-25 v2 fingerprint of this server's major;
 *  3. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change: core.provision_workspace must be #243's level-24 body (up) or this level-25 body (down).
 * core.verify_workspace_schema_v1 is unchanged (it counts policies, not their expressions). No table or data changes.
 * down(): restores the level-24 provision body and the tenant-only core predicate; refused while any workspace is at level 25.
 */
export class AttendanceStaffScopeRls1786722100000 implements MigrationInterface {
  name = 'AttendanceStaffScopeRls1786722100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = ATTENDANCE_STAFF_SCOPE.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      await this.assertProvisionPredecessor(queryRunner, 'up', STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!.provisionFunctionLiteral!, structure.provisionFunctionLiteral!);
      await this.alterCorePolicy(queryRunner, 'up');
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel25(), modules20(), LEVEL, expected, structure.provisionFunctionLiteral));
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
      const [{ n }] = (await queryRunner.query(LEVEL_25_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 25 (their attendance_tenant is not the tenant-only predicate). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) restore the tenant-only predicate with ALTER POLICY and set ' +
            'core.workspace_schema_registry.module_version back to 24, then run down() again.',
        );
      }
      const s24 = STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!;
      await this.assertProvisionPredecessor(queryRunner, 'down', ATTENDANCE_STAFF_SCOPE.structure!.provisionFunctionLiteral!, s24.provisionFunctionLiteral!);
      await this.alterCorePolicy(queryRunner, 'down');
      const fp24 = s24.fingerprints[workspaceFingerprintMajor()];
      if (!fp24) throw new Error(`${this.name}: no level-24 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel24(), modules20(), 24, fp24, s24.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s24.provisionFunctionLiteral!);
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

  /** The core copy of the policy: only a known pair of expressions is replaced; the policy's other properties must not move. */
  private async alterCorePolicy(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const known = [ATTENDANCE_TENANT_HASH, CORE_ATTENDANCE_SCOPE_HASH];
    const want = direction === 'up' ? CORE_ATTENDANCE_SCOPE_HASH : ATTENDANCE_TENANT_HASH;
    const before = await this.corePolicy(queryRunner);
    if (!before.shapeOk || !before.using || before.using !== before.check || !known.includes(before.using)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: core.attendance's attendance_tenant is not a known policy (USING hash ${before.using ?? 'none'}, ` +
          `WITH CHECK hash ${before.check ?? 'none'}, PERMISSIVE / FOR ALL / TO PUBLIC: ${before.shapeOk}; expected one of ${known.join(', ')} on both).`,
      );
    }
    await queryRunner.query(direction === 'up' ? attendanceStaffScopeSql('core') : attendanceTenantOnlySql('core'));
    const after = await this.corePolicy(queryRunner);
    if (!after.shapeOk || after.using !== want || after.check !== want) {
      throw new Error(
        `${this.name}: core.attendance's attendance_tenant after ${direction}: USING hash ${after.using ?? 'none'}, WITH CHECK hash ${after.check ?? 'none'} ` +
          `(expected ${want} on both), shape ${after.shapeOk} (rolled back).`,
      );
    }
  }

  private async corePolicy(queryRunner: QueryRunner): Promise<{ using: string | null; check: string | null; shapeOk: boolean }> {
    const [p] = (await queryRunner.query(CORE_ATTENDANCE_POLICY_SQL)) as Array<{ using_hash: string | null; check_hash: string | null; permissive: boolean; cmd: string; to_public: boolean }>;
    return { using: p?.using_hash ?? null, check: p?.check_hash ?? null, shapeOk: p?.permissive === true && p?.cmd === '*' && p?.to_public === true };
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
