import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  SHIFT_RESOLVED_RATE_DOWN_SQL,
  SHIFT_RESOLVED_RATE_DOWN_UNFORCE_SQL,
  SHIFT_RESOLVED_RATE_OWNERSHIP_SQL,
  SHIFT_RESOLVED_RATE_PREFLIGHT_SQL,
  SHIFT_RESOLVED_RATE_ROWS_SQL,
  SHIFT_RESOLVED_RATE_SECURITY_SQL,
  SHIFT_RESOLVED_RATE_STATE_SQL,
  SHIFT_RESOLVED_RATE_TABLE_SQL,
  ShiftResolvedRateTableState,
  shiftResolvedRateStateProblems,
} from '../shift-resolved-rate-sql';

/**
 * Lane C, owner decisions 41 and 97 (DRAFT — owner SQL review FIRST, run only on throwaway databases until approved): the
 * marker of a shift whose pay rate was RESOLVED (not typed) in its own creating transaction — the only shifts a staff role
 * rate may override. A typed rate (41) and every shift created before this migration (97) have no marker. Creates
 * core.shift_resolved_rate (ENABLE + FORCE RLS, two policies with USING / WITH CHECK, SELECT grant, four grant-parity
 * triggers) and its only writer, the crewflow-owned SECURITY DEFINER core.mark_shift_rate_resolved(uuid), in THIS migration.
 * Exact SQL and reasoning: ../shift-resolved-rate-sql.ts. Self-check before commit; down() refuses while any marker exists.
 */
export class ShiftResolvedRate1786722220000 implements MigrationInterface {
  name = 'ShiftResolvedRate1786722220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    await queryRunner.query(SHIFT_RESOLVED_RATE_TABLE_SQL);
    for (const sql of SHIFT_RESOLVED_RATE_SECURITY_SQL)
      await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of SHIFT_RESOLVED_RATE_OWNERSHIP_SQL)
        await queryRunner.query(sql);
    });
    const [state] = (await queryRunner.query(
      SHIFT_RESOLVED_RATE_STATE_SQL,
    )) as ShiftResolvedRateTableState[];
    const problems = shiftResolvedRateStateProblems(state);
    if (problems.length)
      throw new Error(
        `${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`,
      );
    const violations = await secureOwnerInvariantViolations((sql) =>
      queryRunner.query(sql),
    );
    if (violations.length)
      throw new Error(
        `${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`,
      );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'down');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    await queryRunner.query(SHIFT_RESOLVED_RATE_DOWN_UNFORCE_SQL);
    const [{ n }] = (await queryRunner.query(
      SHIFT_RESOLVED_RATE_ROWS_SQL,
    )) as Array<{ n: number }>;
    if (Number(n) !== 0)
      throw new Error(
        `${this.name}: refusing down(): core.shift_resolved_rate holds ${n} row(s). Nothing was dropped.`,
      );
    for (const sql of SHIFT_RESOLVED_RATE_DOWN_SQL)
      await queryRunner.query(sql);
  }

  private assertInTransaction(
    queryRunner: QueryRunner,
    direction: 'up' | 'down',
  ): void {
    if (!queryRunner.isTransactionActive) {
      throw new Error(
        `${this.name}: refusing to run ${direction} outside a transaction (transaction = false is never allowed here).`,
      );
    }
  }

  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`,
    );
  }

  private async preflight(
    queryRunner: QueryRunner,
    direction: 'up' | 'down',
  ): Promise<void> {
    const [f] = (await queryRunner.query(
      SHIFT_RESOLVED_RATE_PREFLIGHT_SQL,
    )) as Array<{
      table_present: boolean;
      function_present: boolean;
      parity_guard: boolean;
      roles: number;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the catalog');
    else {
      if (Number(f.roles) !== 2)
        problems.push('the roles crewflow and crewflow_app must exist');
      if (!f.parity_guard)
        problems.push('core.owner_login_grant_parity_guard() must exist');
      if (direction === 'up' && (f.table_present || f.function_present))
        problems.push(
          'core.shift_resolved_rate or core.mark_shift_rate_resolved(uuid) already exists',
        );
      if (direction === 'down' && !(f.table_present && f.function_present))
        problems.push(
          'core.shift_resolved_rate and core.mark_shift_rate_resolved(uuid) must exist',
        );
    }
    if (problems.length)
      throw new Error(
        `${this.name}: refusing to run ${direction}: ${problems.join('; ')}.`,
      );
  }
}
