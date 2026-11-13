import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  RELEASE_UPGRADE_LEDGER_DOWN_SQL,
  RELEASE_UPGRADE_LEDGER_EXPECTED_STATE,
  RELEASE_UPGRADE_LEDGER_GONE_SQL,
  RELEASE_UPGRADE_LEDGER_PREFLIGHT_SQL,
  RELEASE_UPGRADE_LEDGER_STATE_SQL,
  RELEASE_UPGRADE_LEDGER_UP_SQL,
} from '../release-upgrade-ledger-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Phase X U-2 (DRAFT — owner SQL review FIRST; not wired into the migrate child yet): the append-only release-upgrade
 * attempt ledger `core.release_upgrade_event` and its one writer `core.release_upgrade_record(...)`. The exact SQL, the
 * reasoning and the boundary live in ../release-upgrade-ledger-sql.ts; the review document is
 * docs/plans/phase-x1/U-2-SQL-REVIEW.md.
 *
 * RLS: the table has NO organisation_id (release history is not tenant data). It still gets ENABLE + FORCE ROW LEVEL
 * SECURITY in this migration, owner-only permissive policies that additionally require CURRENT_USER = rab_secure_owner (true
 * only inside the definer), and a RESTRICTIVE deny-all for crewflow / crewflow_app. FORCE is safe: no pre-auth lookup reads
 * it. tools/check-rls-coverage.ts asserts ENABLE + FORCE explicitly (FORCED_NON_TENANT_TABLES; its per-table scan only
 * sees tables with organisation_id), as the boot gate does (owner-login-posture.ts FORCED_NON_TENANT).
 *
 * Insert-only: no privilege for PUBLIC / crewflow / crewflow_app; the owner keeps SELECT + INSERT only; no UPDATE / DELETE
 * policy exists.
 *
 * Authority: the migration identity (crewflow_owner in phase B of the owner-login chain, the restricted migrator, or a
 * superuser). No role, membership or runtime grant is created. Self-check before commit: the exact owner / RLS / ACL /
 * policy / function state, and secureOwnerInvariantViolations() must be empty; anything else raises and rolls back.
 *
 * down(): drops the function and the table (the recorded attempts go with them). Nothing reads the ledger to decide
 * anything, so a database without it behaves exactly as before this migration.
 */
export class ReleaseUpgradeLedger1786721460000 implements MigrationInterface {
  name = 'ReleaseUpgradeLedger1786721460000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of RELEASE_UPGRADE_LEDGER_UP_SQL) await queryRunner.query(sql);

    const [state] = (await queryRunner.query(RELEASE_UPGRADE_LEDGER_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = Object.entries(RELEASE_UPGRADE_LEDGER_EXPECTED_STATE)
      .filter(([key, expected]) => state?.[key] !== expected)
      .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(state?.[key])}`);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    for (const sql of RELEASE_UPGRADE_LEDGER_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(RELEASE_UPGRADE_LEDGER_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: ledger objects remain after down() (rolled back).`);
  }

  /** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(RELEASE_UPGRADE_LEDGER_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act: boolean;
      secure_bad: boolean | null;
      core_owner: string;
      exists_already: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !f.can_act) problems.push('it cannot act as rab_secure_owner (migration identity required)');
      if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (direction === 'up' && f.exists_already) problems.push('a release-upgrade ledger object already exists');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
