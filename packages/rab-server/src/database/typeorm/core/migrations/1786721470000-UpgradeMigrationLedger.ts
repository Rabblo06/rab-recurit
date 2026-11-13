import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  UPGRADE_LEDGER_DOWN_SQL,
  UPGRADE_LEDGER_EXPECTED_STATE,
  UPGRADE_LEDGER_GONE_SQL,
  UPGRADE_LEDGER_PREFLIGHT_SQL,
  UPGRADE_LEDGER_ROWS_SQL,
  UPGRADE_LEDGER_STATE_SQL,
  UPGRADE_LEDGER_UP_SQL,
  UPGRADE_SCOPE_SETTING,
} from '../upgrade-migration-ledger-sql';

/**
 * OWNER-DB-ULTIMATE Part B (DRAFT — owner SQL review FIRST; run only on throwaway databases until approved): the upgrade
 * logbook `core.upgrade_migration`, Twenty's `core."upgradeMigration"` (twentyhq/twenty @ eedb0a73
 * `engine/core-modules/upgrade/upgrade-migration.entity.ts:14-69`). The exact SQL and its reasoning live in
 * ../upgrade-migration-ledger-sql.ts; the review text is docs/plans/phase-x3/UPGRADES-LEDGER-SQL.md "REVISED".
 *
 * RLS: the table has NO organisation_id (the upgrade history is instance data; its workspace rows are scoped through the
 * FK to core.manager_workspace and that table's own tenant RLS). It gets ENABLE + FORCE ROW LEVEL SECURITY in this
 * migration with policies keyed on the transaction-local `rab.upgrade_scope` (no SECURITY DEFINER function, owner
 * decision B2). tools/check-rls-coverage.ts asserts ENABLE + FORCE explicitly (FORCED_NON_TENANT_TABLES), as does the boot
 * gate (owner-login-posture.ts FORCED_NON_TENANT).
 *
 * Append-only: nobody holds UPDATE, DELETE or TRUNCATE (the owner keeps SELECT + INSERT); the workspace FK cascade is the
 * only delete path. Replaces draft #105 (ReleaseUpgradeLedger1786721460000, never merged).
 *
 * Self-check before commit: the exact owner / RLS / ACL / column / constraint / index / policy state, and
 * secureOwnerInvariantViolations() empty; anything else raises and rolls back. down() refuses while the logbook holds a row.
 */
export class UpgradeMigrationLedger1786721470000 implements MigrationInterface {
  name = 'UpgradeMigrationLedger1786721470000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of UPGRADE_LEDGER_UP_SQL) await queryRunner.query(sql);

    const [state] = (await queryRunner.query(UPGRADE_LEDGER_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = Object.entries(UPGRADE_LEDGER_EXPECTED_STATE)
      .filter(([key, expected]) => state?.[key] !== expected)
      .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(state?.[key])}`);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    // Retention: the logbook has no delete path, so down() never drops recorded history. The count runs through the
    // 'upgrade' read policy (no tenant bound in a migration), then the scope is cleared again.
    await queryRunner.query(`SELECT pg_catalog.set_config('${UPGRADE_SCOPE_SETTING}', 'upgrade', true)`);
    const [{ ledger_rows: rows }] = (await queryRunner.query(UPGRADE_LEDGER_ROWS_SQL)) as Array<{ ledger_rows: number }>;
    await queryRunner.query(`SELECT pg_catalog.set_config('${UPGRADE_SCOPE_SETTING}', '', true)`);
    if (Number(rows) !== 0) {
      throw new Error(`${this.name}: refusing down(): core.upgrade_migration holds ${rows} row(s), and the upgrade history is kept (no delete path). Nothing was dropped.`);
    }
    for (const sql of UPGRADE_LEDGER_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(UPGRADE_LEDGER_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: the logbook remains after down() (rolled back).`);
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(UPGRADE_LEDGER_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act: boolean;
      secure_bad: boolean | null;
      legacy_roles: number;
      core_owner: string;
      manager_workspace: string | null;
      current_org: boolean;
      pg16_or_later: boolean;
      exists_already: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !f.can_act) problems.push('it cannot act as rab_secure_owner (migration identity required)');
      if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
      if (Number(f.legacy_roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (f.manager_workspace !== 'rab_secure_owner:true') problems.push('core.manager_workspace must exist, owned by rab_secure_owner with FORCE ROW LEVEL SECURITY');
      if (!f.current_org) problems.push('core.current_org() must exist');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
      if (direction === 'up' && f.exists_already) problems.push('core.upgrade_migration already exists');
      if (direction === 'down' && !f.exists_already) problems.push('core.upgrade_migration does not exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
