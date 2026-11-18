import { MigrationInterface, QueryRunner } from 'typeorm';

import { PROVISION_WORKSPACE_PRIVILEGE_SHAPE, PROVISION_WORKSPACE_STATE_SQL } from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { workspaceFingerprintMajor } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionLevelSql } from '../../workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel23 } from '../../workspace-schema/structure-level-23';
import {
  composeServerPathTemplateLevel24,
  CORE_SHIFT_TEAM_POLICY_SQL,
  CORE_SHIFT_TEAM_USING_HASH_EQUALITY,
  CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP,
  LEVEL_24_WORKSPACES_SQL,
  PROVISION_PREDECESSOR_SQL,
} from '../../workspace-schema/structure-level-24';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import {
  STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE,
  shiftTeamSelectMultiRoleSql,
  shiftTeamSelectSingleRoleSql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';

const LEVEL = 24;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (#205, release 0.7.0, structure level 24; depends on #175 and #177). The core half
 * of workspace structure level 24; the workspace half is `0.7.0_ShiftTeamSelectMultiRole_1786721600000`
 * (upgrade-commands/0-7/staff-profile-shift-team-multi-role.ts), applied per existing READY workspace by the workspace command
 * runner after level 23, on the same locked start.
 *
 * In ONE transaction:
 *  1. `ALTER POLICY staff_profile_shift_team_select ON core.staff_profile USING (...)`: the HWS-off copy (installed by
 *     ShiftTeamReadScope1786718100000) gets the same predicate change: `'staff' = ANY (string_to_array(rab.role, ','))` instead
 *     of `rab.role = 'staff'`. Only a known current expression is replaced (the 1786718100000 one, or this migration's own on
 *     a re-run; semantic-golden USING hash); anything else is refused. PERMISSIVE, FOR SELECT, TO PUBLIC and no WITH CHECK are
 *     checked before and after.
 *  2. core.provision_workspace re-created (guarded v3 body) over template(20) + level 21 + level 22 + level 23 + the level-24
 *     ALTER POLICY, recording module_version 24 and checking the declared level-24 v2 fingerprint of this server's major;
 *  3. privilege shape, body literal and the secure-owner invariants re-verified.
 * Before any change (DB review): core.provision_workspace must be #177's level-23 body (up) or this level-24 body (down).
 * core.verify_workspace_schema_v1 is unchanged (it counts policies, not their expressions). No table changes.
 * down(): restores the level-23 provision body and the 1786718100000 core predicate; refused while any workspace is at level 24.
 */
export class StaffShiftTeamMultiRole1786721600000 implements MigrationInterface {
  name = 'StaffShiftTeamMultiRole1786721600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const structure = STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!;
    const expected = structure.fingerprints[workspaceFingerprintMajor()];
    if (structure.level !== LEVEL || !expected || !/^[0-9a-f]{64}$/.test(expected) || structure.provisionFunctionLiteral !== `db:provision_workspace@${this.name}`) {
      throw new Error(`${this.name}: the level-${LEVEL} command declares no v2 fingerprint for PostgreSQL ${workspaceFingerprintMajor()} (or a different level / literal); refusing.`);
    }
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await pinSearchPath(queryRunner);
      await this.preflight(queryRunner);
      // Before any change: the provision body replaced must be #177's level-23 one (never a later or hand-altered body).
      await this.assertProvisionPredecessor(queryRunner, 'up', STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure!.provisionFunctionLiteral!, structure.provisionFunctionLiteral!);
      await this.alterCorePolicy(queryRunner, 'up');
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel24(), modules20(), LEVEL, expected, structure.provisionFunctionLiteral));
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
      const [{ n }] = (await queryRunner.query(LEVEL_24_WORKSPACES_SQL)) as Array<{ n: number }>;
      if (Number(n) > 0) {
        throw new Error(
          `${this.name}: down() refused: ${Number(n)} workspace schema(s) are at structure level 24 (their staff_profile_shift_team_select is not the level-23 equality predicate). ` +
            'Nothing was changed. To roll back, first (owner-run, per workspace) restore the 1786718100000 predicate with ALTER POLICY and set ' +
            'core.workspace_schema_registry.module_version back to 23, then run down() again.',
        );
      }
      const s23 = STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure!;
      // Before any change: the provision body replaced must be this migration's level-24 one.
      await this.assertProvisionPredecessor(queryRunner, 'down', STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!.provisionFunctionLiteral!, s23.provisionFunctionLiteral!);
      await this.alterCorePolicy(queryRunner, 'down');
      const fp23 = s23.fingerprints[workspaceFingerprintMajor()];
      if (!fp23) throw new Error(`${this.name}: no level-23 fingerprint for this major`);
      await queryRunner.query(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel23(), modules20(), 23, fp23, s23.provisionFunctionLiteral!));
      await this.verifyProvisionFunction(queryRunner, s23.provisionFunctionLiteral!);
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

  /** The core copy of the policy: only a known USING expression is replaced; the policy's other properties must not move. */
  private async alterCorePolicy(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const known = [CORE_SHIFT_TEAM_USING_HASH_EQUALITY, CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP];
    const want = direction === 'up' ? CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP : CORE_SHIFT_TEAM_USING_HASH_EQUALITY;
    const before = await this.corePolicy(queryRunner);
    if (!before.shapeOk || !before.hash || !known.includes(before.hash)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: core.staff_profile's staff_profile_shift_team_select is not a known policy (USING hash ${before.hash ?? 'none'}, ` +
          `PERMISSIVE / FOR SELECT / TO PUBLIC / no WITH CHECK: ${before.shapeOk}; expected one of ${known.join(', ')}).`,
      );
    }
    await queryRunner.query(direction === 'up' ? shiftTeamSelectMultiRoleSql('core') : shiftTeamSelectSingleRoleSql('core'));
    const after = await this.corePolicy(queryRunner);
    if (!after.shapeOk || after.hash !== want) {
      throw new Error(`${this.name}: core.staff_profile's staff_profile_shift_team_select after ${direction}: USING hash ${after.hash ?? 'none'} (expected ${want}), shape ${after.shapeOk} (rolled back).`);
    }
  }

  private async corePolicy(queryRunner: QueryRunner): Promise<{ hash: string | null; shapeOk: boolean }> {
    const [p] = (await queryRunner.query(CORE_SHIFT_TEAM_POLICY_SQL)) as Array<{ using_hash: string | null; permissive: boolean; cmd: string; to_public: boolean; no_check: boolean }>;
    return { hash: p?.using_hash ?? null, shapeOk: p?.permissive === true && p?.cmd === 'r' && p?.to_public === true && p?.no_check === true };
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
