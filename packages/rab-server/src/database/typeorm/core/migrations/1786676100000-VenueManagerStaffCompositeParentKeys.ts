import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3 — step 1 of the venue_manager_staff composite-FK cutover.
 *
 * Creates the PARENT referenced keys and the CHILD lookup index the composite foreign keys need, without locking writes.
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this migration sets transaction = false. That requires the
 * DataSource to run migrations in mode 'each' (core.datasource.ts: migrationsTransactionMode), which is set alongside this file.
 *
 *   staff_profile      UNIQUE (id, organisation_id, workspace_id)   — superset of the existing (id, workspace_id) key
 *   manager_profile    UNIQUE (id, organisation_id, workspace_id)   — no equivalent key existed
 *   venue_manager_staff INDEX (staff_profile_id, organisation_id, workspace_id) — cascade and FK lookup support
 *
 * Manager side deliberately gets NO child index: the primary key (manager_profile_id, staff_profile_id) leads with the
 * manager column, which serves the composite FK's manager-side lookups.
 *
 * Restart safety. A CONCURRENTLY build that is cancelled, times out or loses its connection leaves an INVALID index under the
 * same deterministic name. up() therefore starts by removing ONLY the objects this migration owns (named below, nothing
 * else), so re-running after any failure is safe with no manual step. Final catalogue is identical either way.
 *
 * Lock behaviour. CONCURRENTLY builds are left unbounded on purpose: they wait for older transactions and must not be cut
 * short. The short ALTER TABLE statements take ACCESS EXCLUSIVE, so each runs with lock_timeout = 5s. If another session holds
 * the table, the migration fails closed and is simply re-run, rather than queueing and blocking all traffic on staff_profile.
 *
 * The pre-existing (id, workspace_id) unique key on staff_profile and the single-column FKs are NOT touched here.
 */
export class VenueManagerStaffCompositeParentKeys1786676100000 implements MigrationInterface {
  name = 'VenueManagerStaffCompositeParentKeys1786676100000';

  public readonly transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Clear leftovers from any earlier attempt. Constraints first: each owns its backing index, so dropping it removes the
    //    index too. Every name below is created only by this migration.
    await this.withLockTimeout(queryRunner, async () => {
      await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT IF EXISTS staff_profile_id_org_ws_key;`);
      await queryRunner.query(`ALTER TABLE core.manager_profile DROP CONSTRAINT IF EXISTS manager_profile_id_org_ws_key;`);
    });
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS core.staff_profile_id_org_ws_uidx;`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS core.manager_profile_id_org_ws_uidx;`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS core.venue_manager_staff_staff_org_ws_idx;`);

    // 2. Build. Each index must be VALID before it is attached; a failed build leaves INVALID, which the next run clears.
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY staff_profile_id_org_ws_uidx
        ON core.staff_profile (id, organisation_id, workspace_id);
    `);
    await this.assertValid(queryRunner, 'core.staff_profile_id_org_ws_uidx');
    await this.withLockTimeout(queryRunner, () =>
      queryRunner.query(`
        ALTER TABLE core.staff_profile
          ADD CONSTRAINT staff_profile_id_org_ws_key UNIQUE USING INDEX staff_profile_id_org_ws_uidx;
      `),
    );

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY manager_profile_id_org_ws_uidx
        ON core.manager_profile (id, organisation_id, workspace_id);
    `);
    await this.assertValid(queryRunner, 'core.manager_profile_id_org_ws_uidx');
    await this.withLockTimeout(queryRunner, () =>
      queryRunner.query(`
        ALTER TABLE core.manager_profile
          ADD CONSTRAINT manager_profile_id_org_ws_key UNIQUE USING INDEX manager_profile_id_org_ws_uidx;
      `),
    );

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY venue_manager_staff_staff_org_ws_idx
        ON core.venue_manager_staff (staff_profile_id, organisation_id, workspace_id);
    `);
    await this.assertValid(queryRunner, 'core.venue_manager_staff_staff_org_ws_idx');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order. Only objects this migration created. Constraint drops also drop their backing index.
    // NOT concurrent here, deliberately: TypeORM 0.3.31's undoLastMigration wraps down() in a transaction regardless of
    // `transaction = false`, and DROP INDEX CONCURRENTLY cannot run inside one. A plain DROP INDEX takes a brief ACCESS
    // EXCLUSIVE lock on venue_manager_staff. Acceptable for a rollback; the forward path stays concurrent.
    await queryRunner.query(`DROP INDEX IF EXISTS core.venue_manager_staff_staff_org_ws_idx;`);
    await queryRunner.query(`ALTER TABLE core.manager_profile DROP CONSTRAINT IF EXISTS manager_profile_id_org_ws_key;`);
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT IF EXISTS staff_profile_id_org_ws_key;`);
  }

  /** Runs `fn` with a bounded lock wait, then restores the session default. Only for statements that take ACCESS EXCLUSIVE. */
  private async withLockTimeout<T>(queryRunner: QueryRunner, fn: () => Promise<T>): Promise<T> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      return await fn();
    } finally {
      await queryRunner.query(`SET lock_timeout = 0`);
    }
  }

  /** Fails the migration if an index is not VALID, so an invalid index can never be attached as a constraint. */
  private async assertValid(queryRunner: QueryRunner, qualifiedIndex: string): Promise<void> {
    const [row] = await queryRunner.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass`, [qualifiedIndex]);
    if (!row || row.indisvalid !== true) {
      throw new Error(`${qualifiedIndex} is not VALID after CREATE INDEX CONCURRENTLY; re-run this migration`);
    }
  }
}
