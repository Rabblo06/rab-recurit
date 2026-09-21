import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.shift_report` — one row per Shift, the Venue Manager attendance
 * Report (Parts 38-51). RLS mirrors `core.attendance`'s own CURRENT policy
 * exactly (verified live, not assumed from its original migration — the
 * real shape was updated later by `PlatformAdminGlobalRedesign1786669400000`):
 * org + workspace match, OR a Venue Manager reached via `manager_venue`
 * through the parent Shift's venue. Joined through `shift_id` the same way
 * `shift_request_staff_tenant` (`ShiftRequestStaffSelection1786671500000`)
 * already does for its own Shift-joined table — that migration's own doc
 * comment is the precedent this copies.
 */
export class ReportSchema1786672200000 implements MigrationInterface {
  name = 'ReportSchema1786672200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.shift_report (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id             uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id                uuid REFERENCES core.manager_workspace(id),
        shift_id                    uuid NOT NULL UNIQUE REFERENCES core.shift(id) ON DELETE CASCADE,
        status                      text NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'ready', 'finalised')),
        pre_shift_pdf_generated_at  timestamptz,
        pre_shift_pdf_sent_at       timestamptz,
        finalised_at                timestamptz,
        finalised_by                uuid REFERENCES core."user"(id),
        final_pdf_sent_at           timestamptz,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX shift_report_status_idx ON core.shift_report (status);`);

    await queryRunner.query(`ALTER TABLE core.shift_report ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.shift_report FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY shift_report_tenant ON core.shift_report
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_report.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.shift_report`);
  }
}
