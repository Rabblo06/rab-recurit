import { MigrationInterface, QueryRunner } from 'typeorm';

import { ATTENDANCE_MONEY_CHECKS, attendanceMoneyChecksSql, attendanceMoneyPrecheckSql } from '../../workspace-schema/v1/attendance-money-checks';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceFunctionSql } from '../../workspace-schema/v1/provision-workspace-function';
import { provisionWorkspaceFunctionV2Sql } from '../../workspace-schema/v1/provision-workspace-function-v2';
import { composeServerPathTemplateV1AttendanceMoney } from '../../workspace-schema/v1/server-path-template-attendance-money';
import { composeServerPathTemplateV1PayrollRestrict } from '../../workspace-schema/v1/server-path-template-payroll-restrict';
import { WorkspaceSchemaMigrator } from '../../workspace-schema/workspace-schema-migrator';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';

const THROUGH_VERSION = 15;

/**
 * Wave 2 lane S2 (C1/C2 money CHECKs; the first module delivered through the WorkspaceSchemaMigrator, B3). Dev/test only:
 * deliberately NOT in production-migration-approval.ts.
 *
 *  1. core.attendance gets `attendance_earned_pence_non_negative` (earned_pence >= 0) and
 *     `attendance_worked_minutes_non_negative` (worked_minutes >= 0): a pre-check counts violating rows and refuses if
 *     any exist (never "fixes" data), then ADD … NOT VALID + VALIDATE CONSTRAINT. Idempotent.
 *  2. `core.provision_workspace(uuid)` is re-created (CREATE OR REPLACE, same owner/DEFINER/search_path/ACL — re-verified)
 *     with the v15 composition and the ledger-aware v2 body, so new server-path workspaces are built at module 15 and
 *     record their ledger rows and fingerprint.
 *  3. Every existing READY workspace is migrated to module 15 by WorkspaceSchemaMigrator, one transaction per schema
 *     (advisory lock + lock_timeout), with the same pre-check. A schema that fails is rolled back and recorded (FAILED or
 *     REFUSED ledger row) and the others still migrate; the migration then throws so it is NOT recorded as applied, and
 *     re-running it resumes from the ledger (steps 1–2 are idempotent).
 *
 * `transaction = false`: steps 1–2 run in their own transaction; step 3 needs one transaction PER SCHEMA so that one
 * failing schema cannot roll back the others.
 */
export class AttendanceMoneyChecks1786719810000 implements MigrationInterface {
  name = 'AttendanceMoneyChecks1786719810000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const expected = EXPECTED_WORKSPACE_FINGERPRINTS[THROUGH_VERSION];
    if (!expected) throw new Error(`${this.name}: no expected fingerprint for module version ${THROUGH_VERSION}`);

    await queryRunner.query('BEGIN');
    try {
      await this.assertAuthority(queryRunner);
      const existing: Array<{ conname: string }> = await queryRunner.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'core.attendance'::regclass AND conname = ANY($1::text[])`,
        [ATTENDANCE_MONEY_CHECKS.map((c) => c.name)],
      );
      if (existing.length === 0) {
        const [{ n }] = await queryRunner.query(attendanceMoneyPrecheckSql('core'));
        if (Number(n) !== 0) {
          throw new Error(`${this.name}: ${n} core.attendance row(s) have a negative earned_pence or worked_minutes; refusing (no data is changed)`);
        }
        await queryRunner.query(attendanceMoneyChecksSql('core'));
      } else if (existing.length !== ATTENDANCE_MONEY_CHECKS.length) {
        throw new Error(`${this.name}: core.attendance has only some of the money CHECKs; refusing to guess`);
      }

      const modules = modulesThrough(THROUGH_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await queryRunner.query(
        provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1AttendanceMoney(), 'CREATE OR REPLACE', modules, expected, `db:provision_workspace@${this.name}`),
      );
      await this.verifyFunction(queryRunner);
      await queryRunner.query('COMMIT');
    } catch (error) {
      await queryRunner.query('ROLLBACK');
      throw error;
    }

    const outcomes = await new WorkspaceSchemaMigrator(queryRunner).migrateAll({
      throughVersion: THROUGH_VERSION,
      txMode: 'own',
      appVersion: `migration:${this.name}`,
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
   * Restores the 1786719700000 function body and drops the core CHECKs. Workspace schemas keep module 15 (the ledger is
   * append-only history; dropping two CHECKs per schema is a forward migration's job, not a silent rollback).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('BEGIN');
    try {
      await this.assertAuthority(queryRunner);
      await queryRunner.query(provisionWorkspaceFunctionSql(composeServerPathTemplateV1PayrollRestrict(), 'CREATE OR REPLACE'));
      for (const c of ATTENDANCE_MONEY_CHECKS) await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT IF EXISTS ${c.name}`);
      await this.verifyFunction(queryRunner);
      await queryRunner.query('COMMIT');
    } catch (error) {
      await queryRunner.query('ROLLBACK');
      throw error;
    }
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') THEN
          RAISE EXCEPTION 'AttendanceMoneyChecks1786719810000 must run as crewflow or the bootstrap identity; refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }

  /** Same privilege shape as 1786719500000 created: crewflow-owned DEFINER, pinned search_path, EXECUTE crewflow + crewflow_app only. */
  private async verifyFunction(queryRunner: QueryRunner): Promise<void> {
    const [row] = await queryRunner.query(`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
             'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])) AS path_ok,
             coalesce((SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END ORDER BY 1)
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY[]::text[]) AS executors
        FROM pg_proc p WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure`);
    const executors = (row?.executors ?? []) as string[];
    if (!row || row.definer !== true || row.owner !== 'crewflow' || row.path_ok !== true || executors.join(',') !== 'crewflow,crewflow_app') {
      throw new Error(`${this.name}: core.provision_workspace lost its privilege shape: ${JSON.stringify(row)}`);
    }
  }
}
