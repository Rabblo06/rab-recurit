import { MigrationInterface, QueryRunner } from 'typeorm';

import { ATTENDANCE_DEVICE_KEY_SQL } from '../attendance-device-key-sql';
import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  CORE_BREAKS_RECEIPTS_DATA_SQL,
  CORE_BREAKS_RECEIPTS_DOWN_SQL,
  CORE_BREAKS_RECEIPTS_STATE_SQL,
  CoreStateRow,
  coreBreaksReceiptsProblems,
} from '../../workspace-schema/attendance-breaks-receipts-sql';
import {
  ATTENDANCE_BREAK_TIME_GUARD_FUNCTION_SQL,
  attendanceBreaksReceiptsSql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §13 PR 2: Appendix A with the owner's A.7 changes; "[after 0.7.0
 * cutover]", owner decision 44). The core half: the copies every request uses while HWS is off, plus the core-only objects.
 * Statements and reasoning: upgrade-commands/0-7/attendance-breaks-receipts.ts (the same builder makes the workspace copies,
 * structure level 27, WorkspaceAttendanceBreaksReceipts1786722150000) and core/attendance-device-key-sql.ts.
 *
 * In ONE transaction (CREATE on core held by crewflow only inside the scoped window, core-schema-create-scope.ts):
 *  1. core.attendance_break_time_guard() (the ±2 minute rule for staff-sourced break times; A.7), owner crewflow, no PUBLIC
 *     EXECUTE;
 *  2. attendanceBreaksReceiptsSql('core'): attendance / shift_assignment / venue columns (A.2), core.attendance_break (A.3),
 *     core.attendance_sync_receipt (A.4), their FORCE RLS, policies, guard triggers and crewflow_app grants;
 *  3. core.attendance_device_key (A.5) with its own-row policy and its column guard;
 *  4. the end state checked exactly (tables FORCE'd and owned by crewflow, every policy, every trigger with its tgtype and
 *     function, crewflow_app privileges, the function's owner and ACL) and the secure-owner invariants.
 * down(): refused while any evidence row exists (a break, a receipt, a device key, or a non-default new column value);
 * otherwise everything above is dropped (the state before).
 */
export class AttendanceBreaksReceipts1786722140000 implements MigrationInterface {
  name = 'AttendanceBreaksReceipts1786722140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [g] = (await queryRunner.query(`SELECT pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS guard`)) as Array<{ guard: boolean }>;
      if (!g?.guard) throw new Error(`${this.name}: core.owner_login_grant_parity_guard() does not exist (OwnerLoginGrantParityGuards1786721420000 first); refusing.`);
      await withCrewflowCoreCreate(queryRunner, async () => {
        await queryRunner.query(ATTENDANCE_BREAK_TIME_GUARD_FUNCTION_SQL);
        await queryRunner.query('REVOKE ALL ON FUNCTION core.attendance_break_time_guard() FROM PUBLIC');
        await queryRunner.query(attendanceBreaksReceiptsSql('core'));
        for (const sql of ATTENDANCE_DEVICE_KEY_SQL) await queryRunner.query(sql);
      });
      const rows = (await queryRunner.query(CORE_BREAKS_RECEIPTS_STATE_SQL)) as CoreStateRow[];
      const problems = coreBreaksReceiptsProblems(rows);
      if (problems.length) throw new Error(`${this.name}: unexpected state after up() (rolled back):\n  ${problems.join('\n  ')}`);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [d] = (await queryRunner.query(CORE_BREAKS_RECEIPTS_DATA_SQL)) as Array<Record<string, number>>;
      const held = Object.entries(d ?? {}).filter(([, n]) => Number(n) > 0);
      if (held.length) {
        throw new Error(
          `${this.name}: down() refused: pay evidence exists (${held.map(([k, n]) => `${k}=${n}`).join(', ')}). Nothing was changed. ` +
            'Breaks, receipts and device keys are never dropped with data in them (A11: anonymise, retain).',
        );
      }
      for (const sql of CORE_BREAKS_RECEIPTS_DOWN_SQL) await queryRunner.query(sql);
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
}
