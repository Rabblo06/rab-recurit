import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  ATTENDANCE_TENANT_HASH,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_SCOPE_HASH,
  CORE_CORRECTION_POLICY_SQL,
  CORE_CORRECTION_SCOPE_HASH,
} from '../../workspace-schema/attendance-staff-scope-sql';
import {
  attendanceCorrectionScopeSql,
  attendanceCorrectionTenantOnlySql,
  attendanceStaffScopeSql,
  attendanceTenantOnlySql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

interface PolicyStep {
  label: string;
  stateSql: string;
  scopeHash: string;
  upSql: string;
  downSql: string;
}

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §11 LOW finding, owner decision 2026-11-21; security review of #305). The
 * fifth enforcement layer on the core copies every request uses while HWS is off (production today):
 *  1. `ALTER POLICY attendance_tenant ON core.attendance USING (P) WITH CHECK (P)`, P = the tenant binding AND (the worker marker
 *     OR a non-venue manager of the workspace OR the caller's own staff profile OR a Venue Manager of the shift's venue);
 *  2. `ALTER POLICY attendance_correction_tenant ON core.attendance_correction USING (Q) WITH CHECK (Q)`, Q = the tenant binding
 *     AND the parent attendance is visible to the caller (the sub-select runs under policy 1, so a correction has exactly its
 *     attendance's readers; before, staff could read each other's corrections).
 * Predicates and reasoning: upgrade-commands/0-7/attendance-staff-scope.ts. The workspace-schema copies (HWS on) get the same
 * predicates from a 0.7.0 workspace command once the 0.7.0 release chain (#175 / #177 / #243) is on main.
 * Merge order: after #241 (the worker marker is bound only through the tenant-context binder).
 *
 * In ONE transaction, per policy: only a known pair of expressions is replaced (tenant-only, or this migration's own on a
 * re-run; semantic-golden hashes on BOTH expressions), PERMISSIVE / FOR ALL / TO PUBLIC checked before and after; then the
 * secure-owner invariants. No table, grant, function or data change; the policy count is unchanged.
 * down(): both tenant-only predicates back (correction first, same checks).
 */
export class AttendanceStaffScopeRls1786722100000 implements MigrationInterface {
  name = 'AttendanceStaffScopeRls1786722100000';

  private readonly steps: readonly PolicyStep[] = [
    { label: "core.attendance's attendance_tenant", stateSql: CORE_ATTENDANCE_POLICY_SQL, scopeHash: CORE_ATTENDANCE_SCOPE_HASH, upSql: attendanceStaffScopeSql('core'), downSql: attendanceTenantOnlySql('core') },
    {
      label: "core.attendance_correction's attendance_correction_tenant",
      stateSql: CORE_CORRECTION_POLICY_SQL,
      scopeHash: CORE_CORRECTION_SCOPE_HASH,
      upSql: attendanceCorrectionScopeSql('core'),
      downSql: attendanceCorrectionTenantOnlySql('core'),
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      for (const step of this.steps) await this.alterCorePolicy(queryRunner, step, 'up');
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      for (const step of [...this.steps].reverse()) await this.alterCorePolicy(queryRunner, step, 'down');
    });
  }

  private async inTransaction(queryRunner: QueryRunner, body: () => Promise<void>): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      // This session resolves names in pg_catalog only; every object named here is core-qualified.
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

  /** Only a known pair of expressions is replaced; the policy's other properties must not move. */
  private async alterCorePolicy(queryRunner: QueryRunner, step: PolicyStep, direction: 'up' | 'down'): Promise<void> {
    const known = [ATTENDANCE_TENANT_HASH, step.scopeHash];
    const want = direction === 'up' ? step.scopeHash : ATTENDANCE_TENANT_HASH;
    const before = await this.corePolicy(queryRunner, step.stateSql);
    if (!before.shapeOk || !before.using || before.using !== before.check || !known.includes(before.using)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: ${step.label} is not a known policy (USING hash ${before.using ?? 'none'}, ` +
          `WITH CHECK hash ${before.check ?? 'none'}, PERMISSIVE / FOR ALL / TO PUBLIC: ${before.shapeOk}; expected one of ${known.join(', ')} on both). Nothing was changed.`,
      );
    }
    await queryRunner.query(direction === 'up' ? step.upSql : step.downSql);
    const after = await this.corePolicy(queryRunner, step.stateSql);
    if (!after.shapeOk || after.using !== want || after.check !== want) {
      throw new Error(
        `${this.name}: ${step.label} after ${direction}: USING hash ${after.using ?? 'none'}, WITH CHECK hash ${after.check ?? 'none'} ` +
          `(expected ${want} on both), shape ${after.shapeOk} (rolled back).`,
      );
    }
  }

  private async corePolicy(queryRunner: QueryRunner, sql: string): Promise<{ using: string | null; check: string | null; shapeOk: boolean }> {
    const [p] = (await queryRunner.query(sql)) as Array<{ using_hash: string | null; check_hash: string | null; permissive: boolean; cmd: string; to_public: boolean }>;
    return { using: p?.using_hash ?? null, check: p?.check_hash ?? null, shapeOk: p?.permissive === true && p?.cmd === '*' && p?.to_public === true };
  }
}
