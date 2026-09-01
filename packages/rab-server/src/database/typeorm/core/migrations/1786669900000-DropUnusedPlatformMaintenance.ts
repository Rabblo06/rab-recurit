import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `WorkspaceIdExpand1786667600000` split maintenance-mode state out of
 * `platform_config` into this new global singleton, per its own docstring's
 * stated intent — but no application code was ever updated to read or write
 * it. Confirmed by a full repository search: `platform_maintenance`/
 * `PlatformMaintenance` appears in exactly one place, the migration that
 * creates it. `MaintenanceModeGuard`, `PlatformConfig` (the entity), and
 * `AdminPanelService` all still read/write `platform_config.maintenance_
 * mode_enabled`/`maintenance_mode_message` directly — confirmed live when a
 * real request through `MaintenanceModeGuard` failed with `column
 * PlatformConfig.maintenance_mode_enabled does not exist` against a
 * from-scratch schema build that (correctly, per the historical migration's
 * own stated intent) had followed the split.
 *
 * Decision: keep maintenance configuration on `platform_config`
 * permanently — that is what the real application actually depends on —
 * and abandon the unfinished split rather than carry two competing sources
 * of truth. `WorkspaceIdExpand` is not edited (CLAUDE.md: migrations are
 * never edited after merge, and this table has already been applied
 * wherever that migration has run, including local dev); this is a new,
 * forward-only migration that drops the genuinely dead table.
 *
 * `platform_config.maintenance_mode_enabled`/`maintenance_mode_message`
 * are untouched by this migration — they already exist on every database
 * that has run `SettingsSchema1786666500000`, and nothing here changes them.
 */
export class DropUnusedPlatformMaintenance1786669900000 implements MigrationInterface {
  name = 'DropUnusedPlatformMaintenance1786669900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.platform_maintenance;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.platform_maintenance (
        id          boolean PRIMARY KEY DEFAULT true CHECK (id),
        enabled     boolean NOT NULL DEFAULT false,
        message     text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid NOT NULL REFERENCES core."user"(id)
      );
    `);
  }
}
