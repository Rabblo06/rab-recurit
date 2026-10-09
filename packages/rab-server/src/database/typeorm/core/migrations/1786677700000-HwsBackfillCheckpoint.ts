import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HWS backfill tool, Part 17 — the minimum persistent state the tool needs to be safely
 * restartable. One row per (workspace, table): what state it's in, how many rows were copied, when
 * it started/completed, and the last SAFE (fixed, non-sensitive) error if it failed or was blocked.
 *
 * Deliberately NOT layered onto `manager_workspace.schema_status` or `workspace_schema_registry`
 * (per the brief's own "do not overload workspace schema lifecycle status with per-table backfill
 * progress if that makes semantics ambiguous") — those two answer "is this workspace's PHYSICAL
 * SCHEMA ready," a yes/no/failed question about DDL; this table answers "has THIS table's DATA been
 * copied for THIS workspace yet," a per-table, resumable question about DML. Conflating them would
 * make a workspace's routability depend on backfill progress, which it must never do — a workspace
 * is routable the moment its schema is READY, backfill or not (HWS-RUNTIME-CUTOVER.md §8).
 *
 * `rab_app` gets SELECT/INSERT/UPDATE (the tool runs as `rab_app`, tenant-bound to the workspace
 * being backfilled — see `hws-backfill.command.ts`'s own doc comment for why no `rab_owner`
 * connection is needed) but never DELETE: a checkpoint row is a permanent record of what happened,
 * even a FAILED/BLOCKED one, never silently removed — the same append-only spirit as `audit_log`,
 * adapted here to allow in-place state transitions (pending → in_progress → completed/failed/
 * blocked) rather than insert-only, since that is what resumability actually requires.
 */
export class HwsBackfillCheckpoint1786677700000 implements MigrationInterface {
  name = 'HwsBackfillCheckpoint1786677700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.hws_backfill_checkpoint (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid NOT NULL,
        workspace_id     uuid NOT NULL,
        table_name       text NOT NULL,
        state            text NOT NULL DEFAULT 'pending',
        rows_copied      integer NOT NULL DEFAULT 0,
        verified         boolean NOT NULL DEFAULT false,
        started_at       timestamptz,
        completed_at     timestamptz,
        last_safe_error  text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT hws_backfill_checkpoint_workspace_org_fkey
          FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace (id, organisation_id) ON DELETE RESTRICT,
        CONSTRAINT hws_backfill_checkpoint_state_check
          CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
        CONSTRAINT hws_backfill_checkpoint_rows_copied_check
          CHECK (rows_copied >= 0),
        CONSTRAINT hws_backfill_checkpoint_error_length_check
          CHECK (last_safe_error IS NULL OR char_length(last_safe_error) <= 500),
        CONSTRAINT hws_backfill_checkpoint_workspace_table_uniq
          UNIQUE (workspace_id, table_name)
      );
    `);

    await queryRunner.query(`ALTER TABLE core.hws_backfill_checkpoint ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.hws_backfill_checkpoint FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY hws_backfill_checkpoint_tenant ON core.hws_backfill_checkpoint
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.hws_backfill_checkpoint TO rab_app;`);
    await queryRunner.query(`REVOKE DELETE ON core.hws_backfill_checkpoint FROM rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.hws_backfill_checkpoint;`);
  }
}
