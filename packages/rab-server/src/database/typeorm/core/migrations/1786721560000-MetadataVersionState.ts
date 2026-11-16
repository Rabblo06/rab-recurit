import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  METADATA_VERSION_DOWN_SQL,
  METADATA_VERSION_GONE_SQL,
  METADATA_VERSION_OWNERSHIP_SQL,
  METADATA_VERSION_PREFLIGHT_SQL,
  METADATA_VERSION_STATE_SQL,
  METADATA_VERSION_UP_SQL,
  metadataVersionStateProblems,
} from '../metadata-version-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Metadata engine M1 / E5 (DRAFT — owner SQL review FIRST; run only on throwaway databases until approved): the metadata
 * version authority `core.workspace_metadata_state`, its in-transaction bump trigger on the five E1 tables and its
 * never-backwards guard. The exact SQL and its reasoning live in ../metadata-version-sql.ts; the review text is
 * docs/plans/phase-x4/M1-SQL-FOR-OWNER.md § M1-cache. Runs after MetadataEngineTables1786721550000 (M1-meta), whose
 * tables it attaches triggers to.
 *
 * Twenty keeps the version on the workspace row and bumps it after commit (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service.ts:25-58`); here it is
 * bumped in the same transaction as the change, by the database.
 *
 * No back-fill: a workspace without a version row is read through uncached by the cache (never served stale), and its
 * first metadata INSERT or UPDATE creates the row. down() needs no row check: the cache identity is (version, bump time),
 * so even a dropped and recreated version row can never make an old cached entry current again.
 *
 * Self-check before commit: the exact owner / RLS / ACL / policy / trigger / function state, and
 * secureOwnerInvariantViolations() empty; anything else raises and rolls back.
 */
export class MetadataVersionState1786721560000 implements MigrationInterface {
  name = 'MetadataVersionState1786721560000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of METADATA_VERSION_UP_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of METADATA_VERSION_OWNERSHIP_SQL) await queryRunner.query(sql);
    });
    const [state] = (await queryRunner.query(METADATA_VERSION_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = metadataVersionStateProblems(state);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    for (const sql of METADATA_VERSION_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(METADATA_VERSION_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: the version table or its functions remain after down() (rolled back).`);
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(METADATA_VERSION_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act_secure: boolean;
      can_act_crewflow: boolean;
      roles: number;
      core_owner: string;
      tenant_functions: boolean;
      pg16_or_later: boolean;
      versioned_tables: number;
      state_present: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !(f.can_act_secure && f.can_act_crewflow)) problems.push('it cannot act as rab_secure_owner and crewflow (migration identity required)');
      if (Number(f.roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (!f.tenant_functions) problems.push('core.current_org() and core.current_workspace() must exist');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
      if (Number(f.versioned_tables) !== 5) problems.push('the five metadata tables (MetadataEngineTables1786721550000) must exist');
      if (direction === 'up' && f.state_present) problems.push('core.workspace_metadata_state already exists');
      if (direction === 'down' && !f.state_present) problems.push('core.workspace_metadata_state does not exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
