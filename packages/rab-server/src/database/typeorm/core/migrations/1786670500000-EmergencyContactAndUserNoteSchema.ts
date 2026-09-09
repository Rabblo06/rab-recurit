import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two additive pieces for the Staff Detail panel rebuild:
 *
 * 1. `staff_profile` gains 3 nullable emergency-contact columns — a small,
 *    justified schema gap-fill (the panel spec asked for this field group
 *    explicitly; nothing else in this schema already represents it, so
 *    there is no duplicate source of truth to worry about).
 *
 * 2. `core.user_note` — one small table shared by BOTH the Staff and
 *    Manager detail panels' "Note" tab, keyed by `subject_user_id` (the
 *    underlying `core.user.id`, not `staff_profile.id`/`manager_profile.id`)
 *    so one entity/service covers both call sites rather than two
 *    near-identical tables. Visibility is enforced at the service layer —
 *    whichever service already gates access to the Staff/Manager record
 *    itself (`StaffService.assertOwned` / Manager's org-wide visibility)
 *    gates access to that person's notes too, exactly the same way the
 *    Timeline tab reuses `audit_log` rather than inventing a parallel
 *    per-record event table.
 */
export class EmergencyContactAndUserNoteSchema1786670500000 implements MigrationInterface {
  name = 'EmergencyContactAndUserNoteSchema1786670500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD COLUMN emergency_contact_name text,
        ADD COLUMN emergency_contact_relationship text,
        ADD COLUMN emergency_contact_phone text;
    `);

    await queryRunner.query(`
      CREATE TABLE core.user_note (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        subject_user_id  uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        author_user_id   uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        body             text NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX user_note_subject_idx ON core.user_note (subject_user_id, created_at DESC);`);

    await queryRunner.query(`ALTER TABLE core.user_note ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.user_note FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY user_note_tenant ON core.user_note
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_note;`);
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        DROP COLUMN IF EXISTS emergency_contact_name,
        DROP COLUMN IF EXISTS emergency_contact_relationship,
        DROP COLUMN IF EXISTS emergency_contact_phone;
    `);
  }
}
