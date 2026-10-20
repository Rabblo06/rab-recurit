import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal sidebar layout ("Your navigation"), saved through the draft/Save/Cancel editor (2026-10-20).
 *
 * One row per (organisation, workspace, user): the user's own shortcut list for one workspace, with an optimistic
 * `revision` (a stale Save is a 409, never a silent overwrite) and the `last_request_id` of the save that produced it
 * (a retried request after a lost response is recognised, never applied twice).
 *
 * Scope is PERSONAL only. There is deliberately no shared/workspace layout here: no Crewflow permission or ownership rule
 * authorises one user to change another's navigation (see LAYOUT_CUSTOMIZATION_SAVE_CANCEL_SECURITY_REPORT.md).
 *
 * Isolation (all three layers in the database, not just the service):
 *  - Composite FKs bind user AND workspace to the same organisation (no cross-organisation reference can be stored).
 *  - RLS ENABLE + FORCE: a row is visible/writable only when organisation, workspace AND user all equal the
 *    transaction-local tenant context (`core.current_org()`, `core.current_workspace()`, `core.current_uid()`); with no
 *    context bound every predicate is NULL → zero rows, writes refused.
 *  - Runtime roles get SELECT/INSERT/UPDATE only (no DELETE/TRUNCATE): removing every shortcut is an empty list.
 * `items` is bounded JSON (array, ≤ 32 KB); its contents are validated by the API on every save (allowlisted kinds,
 * targets, icons, lengths, folder depth) and never interpreted by the database.
 *
 * Additive only: no existing table or row changes. Rollback (down) drops just this table.
 */
export class NavigationLayout1786718600000 implements MigrationInterface {
  name = 'NavigationLayout1786718600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.navigation_layout (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid NOT NULL,
        user_id          uuid NOT NULL,
        revision         integer NOT NULL DEFAULT 0,
        items            jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_request_id  uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT navigation_layout_user_fkey FOREIGN KEY (user_id, organisation_id)
          REFERENCES core."user"(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT navigation_layout_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
          REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT navigation_layout_one_per_user_workspace UNIQUE (organisation_id, workspace_id, user_id),
        CONSTRAINT navigation_layout_revision_check CHECK (revision >= 0),
        CONSTRAINT navigation_layout_items_shape CHECK (jsonb_typeof(items) = 'array' AND pg_column_size(items) <= 32768)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.navigation_layout ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.navigation_layout FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY navigation_layout_own ON core.navigation_layout
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND user_id = core.current_uid())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND user_id = core.current_uid());
    `);
    await queryRunner.query(`REVOKE ALL ON core.navigation_layout FROM PUBLIC;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.navigation_layout TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.navigation_layout;`);
  }
}
