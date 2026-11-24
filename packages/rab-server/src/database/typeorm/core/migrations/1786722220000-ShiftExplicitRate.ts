import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  SHIFT_EXPLICIT_RATE_DOWN_SQL,
  SHIFT_EXPLICIT_RATE_DOWN_UNFORCE_SQL,
  SHIFT_EXPLICIT_RATE_OWNERSHIP_SQL,
  SHIFT_EXPLICIT_RATE_PREFLIGHT_SQL,
  SHIFT_EXPLICIT_RATE_ROWS_SQL,
  SHIFT_EXPLICIT_RATE_SECURITY_SQL,
  SHIFT_EXPLICIT_RATE_STATE_SQL,
  SHIFT_EXPLICIT_RATE_TABLE_SQL,
  ShiftExplicitRateTableState,
  shiftExplicitRateStateProblems,
} from '../shift-explicit-rate-sql';

/**
 * Lane C, owner decision 41 (DRAFT — owner SQL review FIRST, run only on throwaway databases until approved): the marker of
 * a shift whose pay rate was typed explicitly, so an explicit shift rate wins over a staff role rate at confirmation.
 * Creates core.shift_explicit_rate (ENABLE + FORCE RLS, two policies with USING / WITH CHECK, SELECT + INSERT grants and
 * three grant-parity triggers) in THIS migration. Exact SQL and reasoning: ../shift-explicit-rate-sql.ts.
 * Not read before authentication (no NOT-FORCE exception); tools/check-rls-coverage.ts finds it through organisation_id.
 * Self-check before commit; down() refuses while any marker exists.
 */
export class ShiftExplicitRate1786722220000 implements MigrationInterface {
  name = 'ShiftExplicitRate1786722220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    await queryRunner.query(SHIFT_EXPLICIT_RATE_TABLE_SQL);
    for (const sql of SHIFT_EXPLICIT_RATE_SECURITY_SQL)
      await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of SHIFT_EXPLICIT_RATE_OWNERSHIP_SQL)
        await queryRunner.query(sql);
    });
    const [state] = (await queryRunner.query(
      SHIFT_EXPLICIT_RATE_STATE_SQL,
    )) as ShiftExplicitRateTableState[];
    const problems = shiftExplicitRateStateProblems(state);
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
    await queryRunner.query(SHIFT_EXPLICIT_RATE_DOWN_UNFORCE_SQL);
    const [{ n }] = (await queryRunner.query(
      SHIFT_EXPLICIT_RATE_ROWS_SQL,
    )) as Array<{ n: number }>;
    if (Number(n) !== 0)
      throw new Error(
        `${this.name}: refusing down(): core.shift_explicit_rate holds ${n} row(s). Nothing was dropped.`,
      );
    await queryRunner.query(SHIFT_EXPLICIT_RATE_DOWN_SQL);
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
      SHIFT_EXPLICIT_RATE_PREFLIGHT_SQL,
    )) as Array<{
      table_present: boolean;
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
      if (direction === 'up' && f.table_present)
        problems.push('core.shift_explicit_rate already exists');
      if (direction === 'down' && !f.table_present)
        problems.push('core.shift_explicit_rate does not exist');
    }
    if (problems.length)
      throw new Error(
        `${this.name}: refusing to run ${direction}: ${problems.join('; ')}.`,
      );
  }
}
