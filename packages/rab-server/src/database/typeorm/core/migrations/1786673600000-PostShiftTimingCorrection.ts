import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PHASE 7.1 — product-rule correction: the post-shift display lifecycle's
 * two milestones move from `clockOutAt + 2h` (Complete) / `clockOutAt + 6h`
 * (Expired) to `clockOutAt + 1h` / `clockOutAt + 2h`. See `@rab/shared`'s
 * `POST_SHIFT_COMPLETE_HOURS`/`POST_SHIFT_EXPIRED_HOURS` (the new
 * application-level source of truth) and that constant file's own doc
 * comment for why the CHECK constraint below is a necessarily-separate,
 * manually-kept-in-sync copy of the same two numbers — Postgres has no way
 * to reference an application constant from a CHECK expression.
 *
 * Existing rows: `post_shift_completed_at`/`post_shift_expired_at` are pure
 * mechanical projections of `clock_out_at` (never an independently-recorded
 * real-world event, unlike `clock_in_at`/`clock_out_at` themselves) — the
 * OLD constraint required them to equal `clock_out_at + interval '2/6
 * hours'` exactly, so every already-populated value would violate a
 * straight `ADD CONSTRAINT` under the new 1h/2h formula. Backfilled here to
 * what `PostShiftLifecycleService.advance()` would itself compute right now
 * under the corrected thresholds — the same "recompute the display
 * milestone from its one real input" the worker already does going
 * forward, applied once to historical rows so the constraint stays a
 * genuine, uniformly-enforced invariant rather than being weakened or
 * dropped. This does not touch `clock_in_at`/`clock_out_at`/worked
 * minutes/pay — no payroll-relevant data changes.
 */
export class PostShiftTimingCorrection1786673600000 implements MigrationInterface {
  name = 'PostShiftTimingCorrection1786673600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // An ACCESS EXCLUSIVE lock for the whole migration transaction — this
    // table is live-written by the running worker's own post-shift-lifecycle
    // job on its normal cadence; without this lock, a concurrent write
    // landing between the backfill UPDATE below and the new CHECK constraint
    // could still be computed under the OLD 2h/6h formula, violating the
    // NEW constraint the instant it's added.
    await queryRunner.query(`LOCK TABLE core.attendance IN ACCESS EXCLUSIVE MODE;`);
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_post_shift_order;`);
    // `core.attendance` carries FORCE ROW LEVEL SECURITY and `rab_owner` (the
    // role every migration runs as) is NOT exempted from it — confirmed live:
    // without this, the backfill UPDATE below silently matches zero rows
    // (RLS-filtered to nothing, since this migration session has no tenant
    // context bound), leaving every real row's OLD 2h/6h-formula value in
    // place to then violate the NEW constraint the instant it's added — this
    // is exactly what happened on this environment's own shared dev database
    // before this line was added. Same disable/enable dance every worker job
    // already uses for its own owner-connection discovery scans.
    await queryRunner.query(`ALTER TABLE core.attendance DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      UPDATE core.attendance
      SET post_shift_completed_at = CASE WHEN clock_out_at + interval '1 hour' <= now() THEN clock_out_at + interval '1 hour' ELSE NULL END,
          post_shift_expired_at = CASE WHEN clock_out_at + interval '2 hours' <= now() THEN clock_out_at + interval '2 hours' ELSE NULL END
      WHERE clock_out_at IS NOT NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      ALTER TABLE core.attendance
      ADD CONSTRAINT attendance_post_shift_order CHECK (
        (post_shift_completed_at IS NULL OR (clock_out_at IS NOT NULL AND post_shift_completed_at = clock_out_at + interval '1 hour'))
        AND (post_shift_expired_at IS NULL OR (post_shift_completed_at IS NOT NULL AND post_shift_expired_at = clock_out_at + interval '2 hours'))
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`LOCK TABLE core.attendance IN ACCESS EXCLUSIVE MODE;`);
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_post_shift_order;`);
    await queryRunner.query(`ALTER TABLE core.attendance DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      UPDATE core.attendance
      SET post_shift_completed_at = CASE WHEN clock_out_at + interval '2 hours' <= now() THEN clock_out_at + interval '2 hours' ELSE NULL END,
          post_shift_expired_at = CASE WHEN clock_out_at + interval '6 hours' <= now() THEN clock_out_at + interval '6 hours' ELSE NULL END
      WHERE clock_out_at IS NOT NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      ALTER TABLE core.attendance
      ADD CONSTRAINT attendance_post_shift_order CHECK (
        (post_shift_completed_at IS NULL OR (clock_out_at IS NOT NULL AND post_shift_completed_at = clock_out_at + interval '2 hours'))
        AND (post_shift_expired_at IS NULL OR (post_shift_completed_at IS NOT NULL AND post_shift_expired_at = clock_out_at + interval '6 hours'))
      );
    `);
  }
}
