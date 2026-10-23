import { MigrationInterface, QueryRunner } from 'typeorm';

import { ARCHIVABLE_WORKSPACE_TABLES, archiveColumnsSql } from '../../workspace-schema/v1/archive-columns';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionV2Sql } from '../../workspace-schema/v1/provision-workspace-function-v2';
import { SEARCH_PREREQUISITES_SQL, SEARCH_VECTOR_TABLES, searchVectorsSql, TRIGRAM_INDEXES, USER_SEARCH_SQL } from '../../workspace-schema/v1/search-vectors';
import { composeServerPathTemplateV1ArchiveSearch } from '../../workspace-schema/v1/server-path-template-archive-search';
import { composeServerPathTemplateV1AttendanceMoney } from '../../workspace-schema/v1/server-path-template-attendance-money';
import { VERIFY_WORKSPACE_SCHEMA_V1_VERSIONED_SQL } from '../../workspace-schema/v1/verify-workspace-schema-v1-versioned';
import { WorkspaceSchemaMigrator } from '../../workspace-schema/workspace-schema-migrator';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';

const THROUGH_VERSION = 17;
const PREVIOUS_VERSION = 15;
const PREVIOUS_APP_VERSION = 'db:provision_workspace@AttendanceMoneyChecks1786719810000';

/**
 * Waves 4+5 lane DB5 — archive/restore columns (F9) and search vectors (wave 5), in core and every workspace schema.
 * Dev/test only: deliberately NOT in production-migration-approval.ts (N1). Contract: docs/evidence/w45-db5/CONTRACT.md §3–4.
 * Pattern: AttendanceMoneyChecks1786719810000 (the module list is the single source of truth; WorkspaceSchemaMigrator).
 *
 *  1. (one transaction) `unaccent` + `pg_trgm` extensions and `core.immutable_unaccent(text)`; module-16 and module-17 SQL
 *     applied to `core` (venue, job_role, staff_profile, shift) plus the core-only parts: archive columns on
 *     `manager_profile`, `search_vector` + trigram on `core."user"` (names only — never email/phone) with a column grant;
 *     `core.verify_workspace_schema_v1` re-created version-aware (index count 90 / 94 / 100 by module version);
 *     `core.provision_workspace(uuid)` re-created with the v17 composition (same owner/DEFINER/search_path/ACL, re-verified).
 *  2. Every READY workspace migrated to module 17 by WorkspaceSchemaMigrator, one transaction per schema, ledger rows,
 *     fingerprint must equal the frozen v17 value. A failing schema is rolled back and recorded; the migration then throws
 *     (not recorded as applied) and a re-run resumes (step 1 is idempotent: it is skipped when already present).
 *
 * Generated STORED columns rewrite staff_profile / venue / shift / user under ACCESS EXCLUSIVE (measured on dev; see the
 * lane report). `transaction = false` for the per-schema transactions.
 */
export class ArchiveAndSearchSchema1786719920000 implements MigrationInterface {
  name = 'ArchiveAndSearchSchema1786719920000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const expected = EXPECTED_WORKSPACE_FINGERPRINTS[THROUGH_VERSION];
    if (!expected) throw new Error(`${this.name}: no expected fingerprint for module version ${THROUGH_VERSION}`);
    // Normally runMigrations honours `transaction = false`; if a caller already holds a transaction, join it (savepoints).
    const outer = queryRunner.isTransactionActive;

    if (!outer) await queryRunner.query('BEGIN');
    try {
      await this.assertBootstrap(queryRunner);
      const [{ present }] = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'core.venue'::regclass AND attname = 'archived_at' AND NOT attisdropped) AS present`,
      );
      if (!present) {
        await queryRunner.query(SEARCH_PREREQUISITES_SQL);
        await queryRunner.query(archiveColumnsSql('core'));
        await queryRunner.query(`
          ALTER TABLE core.manager_profile
            ADD COLUMN archived_at timestamptz,
            ADD COLUMN archived_by uuid,
            ADD CONSTRAINT manager_profile_archived_pair_check CHECK ((archived_at IS NULL) = (archived_by IS NULL));
          CREATE INDEX manager_profile_archived_idx ON core.manager_profile (organisation_id, archived_at DESC) WHERE archived_at IS NOT NULL;
        `);
        await queryRunner.query(searchVectorsSql('core'));
        await queryRunner.query(USER_SEARCH_SQL);
      }
      await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_VERSIONED_SQL);
      const modules = modulesThrough(THROUGH_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(
        provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1ArchiveSearch(), 'CREATE OR REPLACE', modules, expected, `db:provision_workspace@${this.name}`),
      );
      await this.verifyFunctions(queryRunner);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }

    const outcomes = await new WorkspaceSchemaMigrator(queryRunner).migrateAll({
      throughVersion: THROUGH_VERSION,
      txMode: outer ? 'savepoint' : 'own',
      appVersion: `migration:${this.name}`,
      lockTimeoutMs: 10_000,
    });
    const bad = outcomes.filter((o) => o.status === 'FAILED' || o.status === 'REFUSED');
    // eslint-disable-next-line no-console
    console.log(
      `[${this.name}] workspaces: ${outcomes.filter((o) => o.status === 'MIGRATED').length} migrated, ` +
        `${outcomes.filter((o) => o.status === 'UP_TO_DATE' || o.status === 'BASELINED').length} already current, ` +
        `${outcomes.filter((o) => o.status === 'SKIPPED').length} skipped (not READY), ${bad.length} failed/refused`,
    );
    if (bad.length) {
      throw new Error(
        `${this.name}: ${bad.length} workspace schema(s) did not reach module ${THROUGH_VERSION}: ` +
          bad.map((o) => `${o.schemaName} ${o.status} ${o.errorClass} at ${o.moduleId}`).join('; ') +
          '. Each is rolled back and recorded in core.workspace_schema_migration; the others are migrated. Fix and re-run (resumes).',
      );
    }
  }

  /**
   * Restores the 1786719810000 provision_workspace body (module 15) and removes the core columns, indexes and grant.
   * Kept on purpose:
   *  - workspace schemas keep modules 16/17 (the ledger is append-only history; undoing them is a forward migration's job,
   *    exactly like 1786719810000's own down());
   *  - the version-aware verify_workspace_schema_v1 (it behaves identically to the previous body for v1..15 schemas and is
   *    the only body under which the kept v16/v17 schemas still verify);
   *  - `core.immutable_unaccent` and the two extensions while any workspace generated column depends on them.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // `migration:revert` always opens a transaction (TypeORM ignores `transaction = false` on revert): join it.
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      await this.assertBootstrap(queryRunner);
      const previous = EXPECTED_WORKSPACE_FINGERPRINTS[PREVIOUS_VERSION]!;
      const modules = modulesThrough(PREVIOUS_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(
        provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1AttendanceMoney(), 'CREATE OR REPLACE', modules, previous, PREVIOUS_APP_VERSION),
      );
      await queryRunner.query(`
        DROP INDEX IF EXISTS core.user_name_trgm_idx;
        DROP INDEX IF EXISTS core.user_search_vector_idx;
        ALTER TABLE core."user" DROP COLUMN IF EXISTS search_vector;
        DROP INDEX IF EXISTS core.manager_profile_archived_idx;
        ALTER TABLE core.manager_profile DROP CONSTRAINT IF EXISTS manager_profile_archived_pair_check,
          DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by;
      `);
      for (const t of TRIGRAM_INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS core.${t.name}`);
      for (const v of SEARCH_VECTOR_TABLES) {
        await queryRunner.query(`DROP INDEX IF EXISTS core.${v.table}_search_vector_idx`);
        await queryRunner.query(`ALTER TABLE core.${v.table} DROP COLUMN IF EXISTS search_vector`);
      }
      for (const t of ARCHIVABLE_WORKSPACE_TABLES) {
        await queryRunner.query(`DROP INDEX IF EXISTS core.${t}_archived_idx`);
        const extra = t === 'shift' ? ', DROP CONSTRAINT IF EXISTS shift_archived_draft_only_check' : '';
        await queryRunner.query(
          `ALTER TABLE core.${t} DROP CONSTRAINT IF EXISTS ${t}_archived_pair_check${extra}, DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by`,
        );
      }
      const [{ dependents }] = await queryRunner.query(`
        SELECT count(*)::int AS dependents FROM pg_depend d
         WHERE d.refobjid = 'core.immutable_unaccent(text)'::regprocedure AND d.deptype = 'n'`);
      if (Number(dependents) === 0) {
        await queryRunner.query('DROP FUNCTION core.immutable_unaccent(text)');
        await queryRunner.query('DROP EXTENSION IF EXISTS pg_trgm');
        await queryRunner.query('DROP EXTENSION IF EXISTS unaccent');
      }
      await this.verifyFunctions(queryRunner);
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'ArchiveAndSearchSchema1786719920000 must run as the bootstrap identity (it alters rab_secure_owner-owned core."user"); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }

  /** Same privilege shapes as before: provision_workspace crewflow-owned DEFINER, EXECUTE crewflow + crewflow_app; verify not for the runtime role. */
  private async verifyFunctions(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ fn: string; definer: boolean; owner: string; path_ok: boolean; executors: string[] }> = await queryRunner.query(`
      SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
             'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])) AS path_ok,
             coalesce((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END ORDER BY 1)
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY[]::text[]) AS executors
        FROM pg_proc p
       WHERE p.oid IN ('core.provision_workspace(uuid)'::regprocedure, 'core.verify_workspace_schema_v1(uuid)'::regprocedure)
       ORDER BY 1`);
    const provision = rows.find((r) => r.fn === 'core.provision_workspace(uuid)');
    const verify = rows.find((r) => r.fn === 'core.verify_workspace_schema_v1(uuid)');
    if (
      !provision || provision.definer !== true || provision.owner !== 'crewflow' || provision.path_ok !== true ||
      provision.executors.join(',') !== 'crewflow,crewflow_app'
    ) {
      throw new Error(`${this.name}: core.provision_workspace lost its privilege shape: ${JSON.stringify(provision)}`);
    }
    if (!verify || verify.definer !== false || verify.owner !== 'crewflow' || verify.path_ok !== true || verify.executors.includes('crewflow_app') || verify.executors.includes('PUBLIC')) {
      throw new Error(`${this.name}: core.verify_workspace_schema_v1 lost its privilege shape: ${JSON.stringify(verify)}`);
    }
  }
}
