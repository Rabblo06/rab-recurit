import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  METADATA_MIGRATION_DOWN_SQL,
  METADATA_MIGRATION_DOWN_UNFORCE_SQL,
  METADATA_MIGRATION_GONE_SQL,
  METADATA_MIGRATION_OWNERSHIP_SQL,
  METADATA_MIGRATION_PREFLIGHT_SQL,
  METADATA_MIGRATION_ROWS_SQL,
  METADATA_MIGRATION_STATE_SQL,
  METADATA_MIGRATION_UP_SQL,
  metadataMigrationStateProblems,
} from '../metadata-migration-log-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §10 S-1 / PR-3, OB-1; DRAFT — owner SQL review FIRST; run
 * only on throwaway databases until approved): the runtime data-model change log `core.metadata_migration`, insert-only,
 * ENABLE + FORCE RLS with its tenant policy in this same migration (CLAUDE.md). The exact SQL and its reasoning live in
 * ../metadata-migration-log-sql.ts. Owner decisions 2026-11-18: the log is deleted with its workspace (ON DELETE CASCADE);
 * a deleted user's rows keep their history and lose only the actor id (ON DELETE SET NULL).
 *
 * Nothing writes it yet: release 1 ships the table with the metadata API off; the change runner (M2-PLAN PR-8) is its
 * only writer, from release 2. Runs after MetadataVersionState1786721560000, whose version row the guard checks.
 *
 * Self-check before commit: the exact owner / RLS / ACL / policy / trigger / foreign-key / function state, and
 * secureOwnerInvariantViolations() empty; anything else raises and rolls back. down() refuses while any row exists.
 */
export class MetadataMigrationLog1786721640000 implements MigrationInterface {
  name = 'MetadataMigrationLog1786721640000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of METADATA_MIGRATION_UP_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of METADATA_MIGRATION_OWNERSHIP_SQL) await queryRunner.query(sql);
    });
    const [state] = (await queryRunner.query(METADATA_MIGRATION_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = metadataMigrationStateProblems(state);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    await queryRunner.query(METADATA_MIGRATION_DOWN_UNFORCE_SQL);
    const [count] = (await queryRunner.query(METADATA_MIGRATION_ROWS_SQL)) as Array<{ n: number }>;
    if (Number(count?.n) !== 0) {
      throw new Error(`${this.name}: refusing down(): core.metadata_migration holds ${Number(count?.n)} change-log row(s) (rolled back).`);
    }
    for (const sql of METADATA_MIGRATION_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(METADATA_MIGRATION_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: the change-log table or its guard remain after down() (rolled back).`);
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(METADATA_MIGRATION_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act_secure: boolean;
      can_act_crewflow: boolean;
      roles: number;
      core_owner: string;
      tenant_functions: boolean;
      fk_targets: boolean;
      version_state: boolean;
      pg16_or_later: boolean;
      table_present: boolean;
      guard_present: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !(f.can_act_secure && f.can_act_crewflow)) problems.push('it cannot act as rab_secure_owner and crewflow (migration identity required)');
      if (Number(f.roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (!f.tenant_functions) problems.push('core.current_org(), core.current_workspace() and core.current_uid() must exist');
      if (!f.fk_targets) problems.push('core.manager_workspace and core."user" must exist');
      if (!f.version_state) problems.push('core.workspace_metadata_state (MetadataVersionState1786721560000) must exist');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
      if (direction === 'up' && (f.table_present || f.guard_present)) problems.push('core.metadata_migration or its guard already exists');
      if (direction === 'down' && !(f.table_present && f.guard_present)) problems.push('core.metadata_migration or its guard does not exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
