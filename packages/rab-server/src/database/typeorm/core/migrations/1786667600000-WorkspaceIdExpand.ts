import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 1 of the Private Workspace migration (see the approved
 * migration plan — not reproduced here). Purely additive: nullable
 * `workspace_id` columns + non-validated FKs on every Category-A table,
 * the `platform_config`/`platform_maintenance` split, and the
 * `admin_inspect_session` legacy-column rename. Zero behavior change —
 * nothing reads or writes these columns yet (that starts at
 * WorkspaceTrustedWrites). FKs are added `NOT VALID` deliberately: an
 * instant, lock-free `ADD CONSTRAINT`, validated later in
 * WorkspaceForeignKeysValidate once backfill is confirmed complete —
 * standard safe-migration practice for tables with thousands of rows.
 */
export class WorkspaceIdExpand1786667600000 implements MigrationInterface {
  name = 'WorkspaceIdExpand1786667600000';

  private readonly workspaceOwnedTables = [
    'staff_profile',
    'venue',
    'venue_role_rate',
    'manager_venue',
    'job_role',
    'shift',
    'shift_assignment',
    'job_offer',
    'attendance',
    'manager_profile',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.workspaceOwnedTables) {
      await queryRunner.query(`ALTER TABLE core.${table} ADD COLUMN workspace_id uuid;`);
      await queryRunner.query(`
        ALTER TABLE core.${table}
          ADD CONSTRAINT ${table}_workspace_id_fkey FOREIGN KEY (workspace_id)
          REFERENCES core.manager_workspace(id) NOT VALID;
      `);
      await queryRunner.query(`CREATE INDEX ${table}_workspace_id_idx ON core.${table}(workspace_id);`);
    }

    // platform_config split: SMTP fields stay on this table and gain
    // workspace_id (Category A); maintenance-mode fields move to a new
    // global singleton (platform_maintenance) with no tenant column at
    // all, structurally guaranteed to hold exactly one row via
    // `PRIMARY KEY DEFAULT true` + `CHECK (id)`.
    await queryRunner.query(`ALTER TABLE core.platform_config ADD COLUMN workspace_id uuid;`);
    await queryRunner.query(`
      ALTER TABLE core.platform_config
        ADD CONSTRAINT platform_config_workspace_id_fkey FOREIGN KEY (workspace_id)
        REFERENCES core.manager_workspace(id) NOT VALID;
    `);
    await queryRunner.query(`CREATE INDEX platform_config_workspace_id_idx ON core.platform_config(workspace_id);`);

    await queryRunner.query(`
      CREATE TABLE core.platform_maintenance (
        id          boolean PRIMARY KEY DEFAULT true CHECK (id),
        enabled     boolean NOT NULL DEFAULT false,
        message     text NULL,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid NOT NULL REFERENCES core."user"(id)
      );
    `);
    // Global, non-sensitive operational state — readable by any
    // authenticated request (the maintenance-mode guard needs to check it
    // on every request), writable only through a platform-admin-gated
    // service. No RLS: there is no tenant dimension to restrict by, and
    // restricting SELECT here would break the very guard that needs to
    // read it before any workspace/user context is necessarily bound.

    // admin_inspect_session: the existing `organisation_id` values are a
    // DIFFERENT UUID space than the workspace ids being introduced —
    // renaming the column in place would silently reinterpret every
    // historical row. Preserve it under a new name, add a nullable
    // workspace_id alongside; backfill (WorkspaceBackfill) only resolves
    // rows where the target user's workspace is deterministic.
    await queryRunner.query(`
      ALTER TABLE core.admin_inspect_session RENAME COLUMN organisation_id TO legacy_organisation_id;
    `);
    await queryRunner.query(`ALTER TABLE core.admin_inspect_session ADD COLUMN workspace_id uuid;`);
    await queryRunner.query(`
      ALTER TABLE core.admin_inspect_session
        ADD CONSTRAINT admin_inspect_session_workspace_id_fkey FOREIGN KEY (workspace_id)
        REFERENCES core.manager_workspace(id) NOT VALID;
    `);
    await queryRunner.query(
      `CREATE INDEX admin_inspect_session_workspace_id_idx ON core.admin_inspect_session(workspace_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.admin_inspect_session_workspace_id_idx;`);
    await queryRunner.query(`ALTER TABLE core.admin_inspect_session DROP COLUMN workspace_id;`);
    await queryRunner.query(`
      ALTER TABLE core.admin_inspect_session RENAME COLUMN legacy_organisation_id TO organisation_id;
    `);

    await queryRunner.query(`DROP TABLE core.platform_maintenance;`);

    await queryRunner.query(`DROP INDEX IF EXISTS core.platform_config_workspace_id_idx;`);
    await queryRunner.query(`ALTER TABLE core.platform_config DROP COLUMN workspace_id;`);

    for (const table of [...this.workspaceOwnedTables].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS core.${table}_workspace_id_idx;`);
      await queryRunner.query(`ALTER TABLE core.${table} DROP COLUMN workspace_id;`);
    }
  }
}
