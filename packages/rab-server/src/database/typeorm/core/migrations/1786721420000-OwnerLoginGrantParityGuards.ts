import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  GRANT_PARITY_FACTS_SQL,
  GRANT_PARITY_FUNCTION_SQL,
  GRANT_PARITY_TARGETS,
  GRANT_PARITY_TRIGGERS_SQL,
  GrantParityFacts,
  grantParityEndProblems,
  grantParityTriggerSql,
  triggerName,
} from '../grant-parity-guard-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';

/**
 * PAY-1 (owner-login architecture): BEFORE INSERT / UPDATE / DELETE / TRUNCATE guards that give the owner login exactly
 * crewflow_app's write privileges on normal code paths, on the crewflow-owned core tables whose invariants depended on a
 * missing grant (payroll immutability, definer-only AI / registry / ledger writes, outbox / event retention). Exact SQL,
 * the reviewed target list and the reasoning: ../grant-parity-guard-sql.ts. Injection is NOT covered (BC-01, owner-accepted).
 *
 * Identity: the CF-41 bootstrap identity (the owner login, or a superuser on a disposable cluster). The guard function is
 * created inside withCrewflowCoreCreate and handed to crewflow (no LOGIN role owns a core object).
 * Self-checks (rolled back on failure): the target list still matches crewflow_app's grants (a mismatch refuses — never a
 * silent guard), every trigger exists, is enabled and calls the guard; secure-owner invariants hold.
 * down(): drops the triggers and the function.
 */
export class OwnerLoginGrantParityGuards1786721420000 implements MigrationInterface {
  name = 'OwnerLoginGrantParityGuards1786721420000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    const tables = Object.keys(GRANT_PARITY_TARGETS);
    const facts = (await queryRunner.query(GRANT_PARITY_FACTS_SQL, [tables])) as GrantParityFacts[];
    const ddl: string[] = [];
    for (const [table, ops] of Object.entries(GRANT_PARITY_TARGETS)) {
      try {
        ddl.push(...grantParityTriggerSql(table, ops, facts.find((f) => f.tbl === table)));
      } catch (error) {
        throw new Error(`${this.name}: ${(error as Error).message} (nothing changed)`);
      }
    }
    await withCrewflowCoreCreate(queryRunner, async () => {
      await queryRunner.query(GRANT_PARITY_FUNCTION_SQL);
      await queryRunner.query(`ALTER FUNCTION core.owner_login_grant_parity_guard() OWNER TO crewflow`);
    });
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.owner_login_grant_parity_guard() FROM PUBLIC`);
    for (const sql of ddl) await queryRunner.query(sql);

    const rows = (await queryRunner.query(GRANT_PARITY_TRIGGERS_SQL)) as Array<{ tbl: string; trg: string; enabled: string; fn: string }>;
    const problems = grantParityEndProblems(rows);
    if (problems.length) throw new Error(`${this.name}: self-check failed (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    for (const [table, ops] of Object.entries(GRANT_PARITY_TARGETS)) {
      for (const op of ops) await queryRunner.query(`DROP TRIGGER IF EXISTS ${triggerName(table, op)} ON core."${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.owner_login_grant_parity_guard()`);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
