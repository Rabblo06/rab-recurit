import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Parts 5–6 — stored_file is decoupled from every physical business table.
 *
 * Before: stored_file_tenant admitted a `shift_report` file to ANY user in the organisation, through an EXISTS on
 * core.shift_report. That is a cross-workspace hole (a report file of Workspace B was readable from Workspace A's session)
 * and it names a table that moves to workspace_<id> later.
 *
 * After: the generic boundary is the file's OWN columns only.
 *   - workspace-owned file: organisation_id = current_org() AND workspace_id = current_workspace()
 *   - organisation-global file, ONLY for two explicitly justified categories, with NULL workspace:
 *       PROFILE_IMAGE of a user (an account's own avatar, shown inside its organisation), and
 *       ORGANISATION_LOGO of the organisation (branding for its members).
 *     Any other NULL-workspace file is invisible. NULL is never read as "every Manager in the organisation".
 *   Whether a given caller may read a particular report or file is still decided by the service-level policy
 *   (ReportFilePolicy: venue scope). RLS is the containment boundary, not the only check.
 *
 * Data repair (file METADATA only, no business row): the final timesheet PDF was registered against the SHIFT id by one
 * upload path, while every other path and ReportFilePolicy use the shift_report id. This repoints a final-timesheet file
 * to its report when, and only when, the mapping is unambiguous. Any ambiguity raises and the migration rolls back.
 * down() restores the previous (shift) pointer exactly for the rows it repointed.
 */
export class StoredFileWorkspacePolicy1786675700000 implements MigrationInterface {
  name = 'StoredFileWorkspacePolicy1786675700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE v_ambiguous bigint;
      BEGIN
        SELECT count(*) INTO v_ambiguous FROM core.stored_file f
         WHERE f.resource_type = 'shift_report' AND f.kind = 'FINAL_TIMESHEET_PDF'
           AND (SELECT count(*) FROM core.shift_report sr WHERE sr.shift_id = f.resource_id) > 1;
        IF v_ambiguous > 0 THEN
          RAISE EXCEPTION 'stored_file repair stopped: % final-timesheet file(s) map to more than one report', v_ambiguous
            USING ERRCODE = 'P0001';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      UPDATE core.stored_file f
         SET resource_id = sr.id
        FROM core.shift_report sr
       WHERE f.resource_type = 'shift_report' AND f.kind = 'FINAL_TIMESHEET_PDF'
         AND sr.shift_id = f.resource_id AND sr.organisation_id = f.organisation_id;
    `);

    await queryRunner.query(`DROP POLICY IF EXISTS stored_file_tenant ON core.stored_file;`);
    await queryRunner.query(`
      CREATE POLICY stored_file_tenant ON core.stored_file
        USING (
          organisation_id = core.current_org()
          AND (
            (workspace_id IS NOT NULL AND workspace_id = core.current_workspace())
            OR (workspace_id IS NULL AND kind = 'PROFILE_IMAGE' AND resource_type = 'user')
            OR (workspace_id IS NULL AND kind = 'ORGANISATION_LOGO' AND resource_type = 'organisation')
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (
            (workspace_id IS NOT NULL AND workspace_id = core.current_workspace())
            OR (workspace_id IS NULL AND kind = 'PROFILE_IMAGE' AND resource_type = 'user')
            OR (workspace_id IS NULL AND kind = 'ORGANISATION_LOGO' AND resource_type = 'organisation')
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS stored_file_tenant ON core.stored_file;`);
    await queryRunner.query(`
      CREATE POLICY stored_file_tenant ON core.stored_file
        USING (
          organisation_id = core.current_org()
          AND (
            workspace_id IS NULL
            OR workspace_id = core.current_workspace()
            OR (resource_type = 'shift_report' AND EXISTS (SELECT 1 FROM core.shift_report sr WHERE sr.id = stored_file.resource_id))
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        );
    `);
    await queryRunner.query(`
      UPDATE core.stored_file f
         SET resource_id = sr.shift_id
        FROM core.shift_report sr
       WHERE f.resource_type = 'shift_report' AND f.kind = 'FINAL_TIMESHEET_PDF'
         AND sr.id = f.resource_id AND sr.organisation_id = f.organisation_id;
    `);
  }
}
