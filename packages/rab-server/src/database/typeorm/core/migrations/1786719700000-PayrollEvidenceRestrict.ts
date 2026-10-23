import { MigrationInterface, QueryRunner } from 'typeorm';

import { PAYROLL_EVIDENCE_FKS, payrollEvidenceFksSql, payrollEvidenceRestrictSql } from '../../workspace-schema/v1/payroll-evidence-restrict';
import { provisionWorkspaceFunctionSql } from '../../workspace-schema/v1/provision-workspace-function';
import { composeServerPathTemplateV1 } from '../../workspace-schema/v1/server-path-template';
import { composeServerPathTemplateV1PayrollRestrict } from '../../workspace-schema/v1/server-path-template-payroll-restrict';

/**
 * Wave 1 lane S, finding F3 (owner-approved for the development TEST database; NOT approved for production — it is
 * deliberately absent from production-migration-approval.ts).
 *
 * Payroll evidence can no longer be deleted by deleting what it points at. `payroll_record`'s three parent FKs
 * (attendance, shift, staff_profile) change from `ON DELETE CASCADE` to `ON DELETE RESTRICT` in `core` and in EVERY
 * existing `workspace_<32 hex>` schema, and both provisioning paths build new workspaces the same way:
 *  - the TypeScript provisioner (provision-workspace-schema.ts) runs the same frozen step last;
 *  - `core.provision_workspace(uuid)` is re-created (CREATE OR REPLACE: same owner, DEFINER, search_path and ACL) with the
 *    frozen composition `composeServerPathTemplateV1PayrollRestrict()`.
 * See workspace-schema/v1/payroll-evidence-restrict.ts for the finding and why the rest of the payroll family needed no
 * change. No table, column, index, policy, grant or owner changes, so the security-posture golden snapshot and the V1
 * structural counts are unchanged.
 *
 * Existing data: the old FKs are verified VALID (convalidated) before anything changes, and re-adding each FK re-validates
 * every row; a violating row would abort the whole migration (one transaction) rather than be accepted. Legitimate deletion
 * workflows are unaffected: UserDeletionService already refuses to delete any account with operational history, and no
 * production code deletes shifts, attendance or staff profiles.
 *
 * Idempotent per schema: a schema whose three FKs are already RESTRICT is skipped. Workspace schemas without a
 * payroll_record table (an empty schema left by a failed provisioning attempt) are skipped; they get the new composition
 * when provisioning is retried.
 *
 * down() restores CASCADE everywhere and re-creates the function with the 1786719500000 composition.
 */
interface FkRow {
  conname: string;
  deltype: string;
  updtype: string;
  matchtype: string;
  validated: boolean;
  parent_ok: boolean;
  cols: string;
  pcols: string;
}

export class PayrollEvidenceRestrict1786719700000 implements MigrationInterface {
  name = 'PayrollEvidenceRestrict1786719700000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'payroll_record' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
      ORDER BY (n.nspname <> 'core'), n.nspname
    `);
    return rows.map((r) => r.schema_name);
  }

  /**
   * Catalog facts of the three FKs, compared column by column (never through pg_get_constraintdef text, whose schema
   * qualification depends on the session search_path).
   */
  private async fks(runner: QueryRunner, schema: string): Promise<FkRow[]> {
    return runner.query(
      `SELECT k.conname, k.confdeltype::text AS deltype, k.confupdtype::text AS updtype, k.confmatchtype::text AS matchtype,
              k.convalidated AS validated, k.confrelid = format('%I.%I', $1::text, p.parent)::regclass AS parent_ok,
              (SELECT string_agg(a.attname, ', ' ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS cols,
              (SELECT string_agg(a.attname, ', ' ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS pcols
         FROM pg_constraint k
         JOIN unnest($2::text[], $3::text[]) AS p(name, parent) ON p.name = k.conname
        WHERE k.conrelid = format('%I.payroll_record', $1::text)::regclass AND k.contype = 'f'
        ORDER BY k.conname`,
      [schema, PAYROLL_EVIDENCE_FKS.map((f) => f.name), PAYROLL_EVIDENCE_FKS.map((f) => f.parent)],
    );
  }

  /** 'CASCADE' | 'RESTRICT' when all three FKs are exactly as expected for that action; throws otherwise. */
  private async state(runner: QueryRunner, schema: string): Promise<'CASCADE' | 'RESTRICT'> {
    const rows = await this.fks(runner, schema);
    const byName = new Map(rows.map((r) => [r.conname, r]));
    for (const [action, code] of [['CASCADE', 'c'], ['RESTRICT', 'r']] as const) {
      const ok = PAYROLL_EVIDENCE_FKS.every((f) => {
        const row = byName.get(f.name);
        return (
          row !== undefined && row.validated === true && row.parent_ok === true && row.deltype === code && row.updtype === 'a' &&
          row.matchtype === 's' && row.cols === f.columns && row.pcols === f.parentColumns
        );
      });
      if (ok) return action;
    }
    throw new Error(
      `${this.name}: ${schema}.payroll_record parent FKs are not in a known state (expected all three CASCADE or all three RESTRICT, ` +
        `validated, same columns and parents); refusing to guess. Found: ${JSON.stringify(rows)}`,
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);

    const schemas = await this.schemas(queryRunner);
    if (!schemas.includes('core')) throw new Error(`${this.name}: core.payroll_record is missing; refusing to run`);
    for (const schema of schemas) {
      if ((await this.state(queryRunner, schema)) === 'RESTRICT') continue;
      await queryRunner.query(payrollEvidenceRestrictSql(schema));
    }

    await queryRunner.query(provisionWorkspaceFunctionSql(composeServerPathTemplateV1PayrollRestrict(), 'CREATE OR REPLACE'));

    // Refuse to be recorded unless every schema is RESTRICT and the provisioning function kept its exact privilege shape.
    for (const schema of await this.schemas(queryRunner)) {
      if ((await this.state(queryRunner, schema)) !== 'RESTRICT') throw new Error(`${this.name}: ${schema} is not RESTRICT after up()`);
    }
    await this.verifyFunction(queryRunner, true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    for (const schema of await this.schemas(queryRunner)) {
      if ((await this.state(queryRunner, schema)) === 'CASCADE') continue;
      await queryRunner.query(payrollEvidenceFksSql(schema, 'CASCADE'));
    }
    await queryRunner.query(provisionWorkspaceFunctionSql(composeServerPathTemplateV1(), 'CREATE OR REPLACE'));
    await this.verifyFunction(queryRunner, false);
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') THEN
          RAISE EXCEPTION 'PayrollEvidenceRestrict1786719700000 must run as crewflow or the bootstrap identity (it alters crewflow-owned tables and re-creates a crewflow-owned function); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }

  private async verifyFunction(queryRunner: QueryRunner, restrict: boolean): Promise<void> {
    await queryRunner.query(`
      DO $verify$
      DECLARE v text;
      BEGIN
        SELECT string_agg(x, '; ') INTO v FROM (
          SELECT 'provision_workspace is not a crewflow-owned SECURITY DEFINER with search_path pg_catalog, pg_temp' AS x
            FROM pg_proc p
           WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure
             AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'crewflow'
                      AND 'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])))
          UNION ALL
          SELECT 'PUBLIC may EXECUTE core.provision_workspace'
           WHERE EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          UNION ALL
          SELECT 'crewflow_app cannot EXECUTE core.provision_workspace'
           WHERE NOT has_function_privilege('crewflow_app', 'core.provision_workspace(uuid)', 'EXECUTE')
          UNION ALL
          SELECT 'crewflow_app may EXECUTE core.verify_workspace_schema_v1'
           WHERE has_function_privilege('crewflow_app', 'core.verify_workspace_schema_v1(uuid)', 'EXECUTE')
          UNION ALL
          SELECT 'provision_workspace template has the wrong payroll_record delete action'
            FROM pg_proc p
           WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure
             AND (strpos(p.prosrc, 'payroll_record_staff_workspace_fkey FOREIGN KEY (staff_profile_id, workspace_id) REFERENCES "workspace_00000000000000000000000000000000".staff_profile(id, workspace_id) ON DELETE RESTRICT') > 0) <> ${restrict}
        ) problems;
        IF v IS NOT NULL THEN
          RAISE EXCEPTION 'PayrollEvidenceRestrict1786719700000 verification failed: %', v USING ERRCODE = 'invalid_grant_operation';
        END IF;
      END
      $verify$;
    `);
  }
}
