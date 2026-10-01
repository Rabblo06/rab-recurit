import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8 — extends the structural workspace-consistency guarantee
 * `CompositeWorkspaceForeignKeys1786669500000` already gives the core
 * Venue->Shift->Assignment->Offer->Attendance chain to two tables added
 * after that migration: `shift_report` and `replacement_request`. Both
 * already have a NOT NULL `shift_id` FK and a nullable `workspace_id`; both
 * reference `core.shift`, which already carries `UNIQUE(id, workspace_id)`
 * from that same migration, so no new UNIQUE constraint is needed on the
 * parent side.
 *
 * Same NULL-tolerant `MATCH SIMPLE` semantics as the original migration: a
 * NULL `workspace_id` child row is unconstrained on this dimension, never
 * rejected. Proven safe before writing this — a live read-only query
 * (local dev DB) across both relationships found zero rows where both
 * sides' `workspace_id` were non-null and disagreed:
 *
 *   SELECT count(*) FROM core.shift_report sr JOIN core.shift s ON s.id = sr.shift_id
 *     WHERE sr.workspace_id IS NOT NULL AND s.workspace_id IS NOT NULL AND sr.workspace_id <> s.workspace_id;
 *   -- 0
 *   SELECT count(*) FROM core.replacement_request rr JOIN core.shift s ON s.id = rr.shift_id
 *     WHERE rr.workspace_id IS NOT NULL AND s.workspace_id IS NOT NULL AND rr.workspace_id <> s.workspace_id;
 *   -- 0
 *
 * `stored_file` (the third table the Phase 8 audit named) is deliberately
 * NOT given an equivalent constraint here: it is a polymorphic resource
 * store (`resource_type` + `resource_id` can point at many different parent
 * tables depending on the row), so there is no single parent table a
 * composite FK could reference — a structural constraint is not possible,
 * not merely deferred. Its workspace consistency remains an
 * application-only invariant (`FileService` always derives `workspaceId`
 * from the caller's own server-resolved `AuthContext`, never from client
 * input) — see the Phase 8 report for the full per-table reasoning.
 */
export class ShiftReportReplacementRequestWorkspaceFks1786673800000 implements MigrationInterface {
  name = 'ShiftReportReplacementRequestWorkspaceFks1786673800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.shift_report ADD CONSTRAINT shift_report_shift_workspace_fkey
        FOREIGN KEY (shift_id, workspace_id) REFERENCES core.shift (id, workspace_id);
    `);
    await queryRunner.query(`
      ALTER TABLE core.replacement_request ADD CONSTRAINT replacement_request_shift_workspace_fkey
        FOREIGN KEY (shift_id, workspace_id) REFERENCES core.shift (id, workspace_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.replacement_request DROP CONSTRAINT replacement_request_shift_workspace_fkey;`);
    await queryRunner.query(`ALTER TABLE core.shift_report DROP CONSTRAINT shift_report_shift_workspace_fkey;`);
  }
}
