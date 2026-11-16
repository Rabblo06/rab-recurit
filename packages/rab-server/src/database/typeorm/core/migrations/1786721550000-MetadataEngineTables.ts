import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  METADATA_DOWN_UNFORCE_SQL,
  METADATA_FUNCTION_STATE_SQL,
  METADATA_GONE_SQL,
  METADATA_OWNERSHIP_SQL,
  METADATA_PREFLIGHT_SQL,
  METADATA_ROWS_SQL,
  METADATA_STATE_SQL,
  METADATA_TABLES_DOWN_SQL,
  METADATA_TABLES_UP_SQL,
  MetadataTableState,
  metadataStateProblems,
} from '../metadata-tables-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Metadata engine M1 / E1 (OWNER-METADATA-ENGINE.md §1 E1; DRAFT — owner SQL review FIRST, run only on throwaway databases
 * until approved; text in docs/plans/phase-x4/M1-SQL-FOR-OWNER.md § M1-meta): the five metadata tables
 * core.object_metadata, core.field_metadata, core.field_metadata_option, core.index_metadata, core.index_field_metadata,
 * re-implementing Twenty's objectMetadata / fieldMetadata / fieldMetadataOption / indexMetadata (twentyhq/twenty @ eedb0a73,
 * citations in ../metadata-tables-sql.ts). Relations are RELATION fields, as in Twenty.
 *
 * RLS: every table has organisation_id + workspace_id and gets ENABLE + FORCE ROW LEVEL SECURITY with one tenant policy
 * (USING + WITH CHECK on core.current_org() / core.current_workspace()) in THIS migration (CLAUDE.md; OWNER §0.1). None is
 * read before authentication, so none takes the NOT-FORCE exception. tools/check-rls-coverage.ts finds them through
 * organisation_id. Owner crewflow (handed over inside withCrewflowCoreCreate), crewflow_app SELECT / INSERT / UPDATE /
 * DELETE, nothing for PUBLIC.
 *
 * core.metadata_guard() (crewflow, SECURITY INVOKER) enforces in the database what the engine trusts: physical names, type,
 * kind flags and API names never change (OB-10); a lock never comes off; a standard / system object or a locked / system
 * field is never deleted directly (only the workspace / organisation / custom-object cascade removes it); no custom field
 * on an object that does not allow custom fields, and CURRENCY on custom objects only (§0.3 / §0.5); no TRUNCATE.
 * Identity split (security review #165): built-in and locked metadata (objects, fields, their options, index fields on
 * them) is written only as crewflow (the E2 sync takes SET LOCAL ROLE crewflow; the M2 executor is a crewflow-owned
 * definer), a rab_secure_owner definer or a superuser — the M-T2 allow-list. The request path (crewflow_owner) may change
 * only display columns of such rows. Index definitions and index fields never change. The seven payroll / attendance
 * tables are pinned to system objects by a CHECK; core reference objects only for the four known core tables.
 *
 * Self-check before commit: the exact owner / RLS / ACL / policy / trigger state of every table and of the function, and
 * secureOwnerInvariantViolations() empty; anything else raises and rolls back. down() refuses while any metadata row exists.
 */
export class MetadataEngineTables1786721550000 implements MigrationInterface {
  name = 'MetadataEngineTables1786721550000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of METADATA_TABLES_UP_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of METADATA_OWNERSHIP_SQL) await queryRunner.query(sql);
    });

    const rows = (await queryRunner.query(METADATA_STATE_SQL)) as MetadataTableState[];
    const [fn] = (await queryRunner.query(METADATA_FUNCTION_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = metadataStateProblems(rows, fn);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'down');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    // Retention: never drop recorded metadata. The count needs NO FORCE (a migration binds no tenant); a refusal rolls back.
    for (const sql of METADATA_DOWN_UNFORCE_SQL) await queryRunner.query(sql);
    const [{ metadata_rows: rows }] = (await queryRunner.query(METADATA_ROWS_SQL)) as Array<{ metadata_rows: number }>;
    if (Number(rows) !== 0) {
      throw new Error(`${this.name}: refusing down(): the metadata tables hold ${rows} row(s). Nothing was dropped.`);
    }
    for (const sql of METADATA_TABLES_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(METADATA_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: metadata objects remain after down() (rolled back).`);
  }

  /** Every statement (the set_config(..., true) pins, NO FORCE in down(), the post-condition) relies on ONE transaction. */
  private assertInTransaction(queryRunner: QueryRunner, direction: 'up' | 'down'): void {
    if (!queryRunner.isTransactionActive) {
      throw new Error(`${this.name}: refusing to run ${direction} outside a transaction (transaction = false is never allowed here).`);
    }
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(METADATA_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act_secure: boolean;
      can_act_crewflow: boolean;
      roles: number;
      core_owner: string;
      workspace_key: boolean;
      tenant_functions: boolean;
      pg16_or_later: boolean;
      tables_present: number;
      guard_present: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !(f.can_act_secure && f.can_act_crewflow)) problems.push('it cannot act as rab_secure_owner and crewflow (migration identity required)');
      if (Number(f.roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (!f.workspace_key) problems.push('core.manager_workspace must have a UNIQUE (id, organisation_id) key (the tenant FK target)');
      if (!f.tenant_functions) problems.push('core.current_org() and core.current_workspace() must exist');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
      if (direction === 'up' && (Number(f.tables_present) !== 0 || f.guard_present)) problems.push('a metadata table or core.metadata_guard() already exists');
      if (direction === 'down' && (Number(f.tables_present) !== 5 || !f.guard_present)) problems.push('the five metadata tables and core.metadata_guard() must exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
