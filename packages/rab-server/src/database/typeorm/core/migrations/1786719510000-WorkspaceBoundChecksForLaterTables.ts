import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * APPROVED for the development database by the owner (2026-10-22, development only). Found while rehearsing the dev
 * cutover on a RESTORED COPY of rab-devdb (2026-10-22): every workspace schema provisioned BEFORE these six tables were
 * added to the V1 template got the tables from their own migrations (ShiftReviewSignoff1786718300000,
 * PayrollRecord1786718800000, PayrollCalendarRunsPayslips1786719200000) but NOT the per-table
 * `<table>_workspace_bound CHECK (workspace_id IS NOT NULL AND workspace_id = '<owning workspace>')` that the provisioner
 * (TypeScript bindWorkspace / core.provision_workspace) adds to every table of a freshly provisioned schema. RLS still
 * binds those tables; this restores the schema-level defence-in-depth binding so an existing workspace is structurally
 * identical to a new one (and passes core.verify_workspace_schema_v1).
 *
 * Idempotent: adds the constraint only where it is missing, NOT VALID first, then VALIDATE (a row from another workspace
 * would fail the migration rather than be silently accepted). The workspace id comes from the schema's own registry row
 * (core.workspace_schema_registry), never from the name alone; a schema without a registry row is refused.
 *
 * down(): intentionally a no-op. Dropping these constraints would also strip them from workspaces provisioned after this
 * migration, which have them by construction; there is no safe way to tell the two apart and no reason to weaken either.
 */
const LATER_TABLES = ['shift_staff_review', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document'];

export class WorkspaceBoundChecksForLaterTables1786719510000 implements MigrationInterface {
  name = 'WorkspaceBoundChecksForLaterTables1786719510000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $bind$
      DECLARE
        r record;
        v_table text;
        v_ws uuid;
      BEGIN
        FOR r IN SELECT n.nspname FROM pg_namespace n WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' ORDER BY 1 LOOP
          SELECT g.workspace_id INTO v_ws FROM core.workspace_schema_registry g WHERE g.schema_name = r.nspname;
          IF v_ws IS NULL THEN
            RAISE EXCEPTION 'schema % has no workspace_schema_registry row; refusing to guess its workspace', r.nspname;
          END IF;
          IF r.nspname <> 'workspace_' || replace(v_ws::text, '-', '') THEN
            RAISE EXCEPTION 'schema % does not match its registry workspace %', r.nspname, v_ws;
          END IF;
          FOREACH v_table IN ARRAY ARRAY[${LATER_TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
            IF to_regclass(format('%I.%I', r.nspname, v_table)) IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(format('%I.%I', r.nspname, v_table))
                                  AND k.conname = v_table || '_workspace_bound') THEN
              EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (workspace_id IS NOT NULL AND workspace_id = %L::uuid) NOT VALID',
                             r.nspname, v_table, v_table || '_workspace_bound', v_ws::text);
              EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', r.nspname, v_table, v_table || '_workspace_bound');
            END IF;
          END LOOP;
        END LOOP;
      END
      $bind$;
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op; see the class comment.
  }
}
