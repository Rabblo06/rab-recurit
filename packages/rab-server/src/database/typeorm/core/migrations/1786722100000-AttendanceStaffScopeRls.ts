import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { ATTENDANCE_TENANT_HASH, CORE_ATTENDANCE_POLICY_SQL, CORE_ATTENDANCE_SCOPE_HASH } from '../../workspace-schema/attendance-staff-scope-sql';
import { attendanceStaffScopeSql, attendanceTenantOnlySql } from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §11 LOW finding, owner decision 2026-11-21). The fifth enforcement layer
 * on `core.attendance`, the copy every request uses while HWS is off (production today):
 *   `ALTER POLICY attendance_tenant ON core.attendance USING (P) WITH CHECK (P)`, P = the tenant binding AND (the worker marker
 *   OR the caller's own staff profile OR a non-venue manager of the workspace OR a Venue Manager of the shift's venue).
 * The predicate and its reasoning: upgrade-commands/0-7/attendance-staff-scope.ts. The workspace-schema copies (HWS on) get
 * the same predicate from a 0.7.0 workspace command once the 0.7.0 release chain (#175 / #177 / #243) is on main; until then
 * staff isolation on workspace-schema attendance stays the service layer alone, exactly as before this migration.
 *
 * In ONE transaction: only a known pair of expressions is replaced (tenant-only, or this migration's own on a re-run;
 * semantic-golden hashes on BOTH expressions), PERMISSIVE / FOR ALL / TO PUBLIC are checked before and after, then the
 * secure-owner invariants. No table, grant, function or data change; the policy count is unchanged.
 * down(): the tenant-only predicate back (same checks).
 */
export class AttendanceStaffScopeRls1786722100000 implements MigrationInterface {
  name = 'AttendanceStaffScopeRls1786722100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      await this.alterCorePolicy(queryRunner, 'up');
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, () => this.alterCorePolicy(queryRunner, 'down'));
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
  private async alterCorePolicy(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const known = [ATTENDANCE_TENANT_HASH, CORE_ATTENDANCE_SCOPE_HASH];
    const want = direction === 'up' ? CORE_ATTENDANCE_SCOPE_HASH : ATTENDANCE_TENANT_HASH;
    const before = await this.corePolicy(queryRunner);
    if (!before.shapeOk || !before.using || before.using !== before.check || !known.includes(before.using)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: core.attendance's attendance_tenant is not a known policy (USING hash ${before.using ?? 'none'}, ` +
          `WITH CHECK hash ${before.check ?? 'none'}, PERMISSIVE / FOR ALL / TO PUBLIC: ${before.shapeOk}; expected one of ${known.join(', ')} on both). Nothing was changed.`,
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
}
