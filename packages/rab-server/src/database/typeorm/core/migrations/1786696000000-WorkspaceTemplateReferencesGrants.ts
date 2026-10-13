import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker credential isolation checkpoint, item 1's standalone-process test — the fourth and last
 * layer of the same investigation. With discovery (`WorkerPendingWorkspaceSchemaDiscovery
 * 1786693000000`), the four lifecycle functions (`WorkspaceProvisionerLifecycleGrants
 * 1786694000000`), and the organisation lookup (`WorkerResolveWorkspaceOrganisation1786695000000`)
 * all fixed, the real standalone provisioner process finally reached `applyTemplate()` — and failed
 * there too, every time, with `SQLSTATE 42501` (insufficient_privilege).
 *
 * `applyTemplate()` runs the V1 schema template directly on the `crewflow` connection (not through
 * any SECURITY DEFINER function — the new tables are created, and need to be owned, by `crewflow`
 * itself). The template's `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES` statements
 * point at five `core` tables: `core."user"`, `core.organisation`, `core.manager_workspace`,
 * `core.manager_profile`, `core.stored_file`. Creating a foreign key requires the creating role to
 * hold `REFERENCES` on the REFERENCED table. `crewflow` already had it on `manager_profile` and
 * `stored_file` — confirmed missing on the other three (`user`, `organisation`, `manager_workspace`)
 * on BOTH p22 and an independently fresh bootstrap database never touched by this session's other
 * work, so this is not session drift, it is a genuine, universal gap: nothing has ever granted
 * `crewflow` `REFERENCES` on these three tables, and the V1 template has referenced all three since
 * it was written.
 *
 * `REFERENCES` is one of the three privileges (`TRIGGER`/`REFERENCES`/`TRUNCATE`) this codebase's
 * baseline default-privilege grant deliberately excludes from the ordinary runtime role
 * (`CrewflowAppRestrictedRuntimeRole1786687000000`'s own doc comment) — correctly, for
 * `crewflow_app`, which has no legitimate reason to create a foreign key. `crewflow`, the sole
 * DDL-performing provisioner identity, is a different case: creating these exact foreign keys is
 * its entire job description. This migration grants `REFERENCES` on these three tables to
 * `crewflow` only — `crewflow_app` is not touched, and nothing about the ordinary runtime role's own
 * restrictions changes.
 */
export class WorkspaceTemplateReferencesGrants1786696000000 implements MigrationInterface {
  name = 'WorkspaceTemplateReferencesGrants1786696000000';

  private readonly tables = ['core."user"', 'core.organisation', 'core.manager_workspace'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`GRANT REFERENCES ON ${table} TO crewflow;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`REVOKE REFERENCES ON ${table} FROM crewflow;`);
    }
  }
}
