import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M9 load test (Lane F, 2026-11-21; packages/rab-docker/docs/hardening/LOAD-TEST.md §5): two indexes for the worst list
 * statements of the console at 5,000 staff / 50,000 shifts (one workspace, HWS off, as production).
 *
 *  - attendance_workspace_clock_in_idx `(workspace_id, clock_in_at DESC, id DESC)`: GET /attendance (AttendanceService.list)
 *    orders by `a.clock_in_at DESC, a.id DESC LIMIT 50`. With no index on that order, the plan joined and RLS-checked EVERY
 *    attendance row of the workspace (90,180) and sorted them to keep 50: 598 ms per page with JIT off, 2.0 s with JIT on
 *    (11 s under the peak). workspace_id leads because RLS adds `workspace_id = core.current_workspace()` (STABLE SQL,
 *    inlined, usable as the Index Cond); the planner then walks the index in order and stops after 50 rows: 1.5 ms for
 *    the PAGE statement only. list() also runs an unindexed `count(*)` over the same five joins (attendance.service.ts
 *    list(), ~120 ms at this size), which this index does not change; the regression spec EXPLAINs a simplified
 *    statement with the same ORDER BY under the same RLS. HWS switch-on blocker: the workspace-schema template
 *    (workspace-schema-v1.sql, attendance indexes) needs the same index before business rows move to workspace schemas.
 *  - email_outbox_attachment_file_idx `(attachment_file_id) WHERE attachment_file_id IS NOT NULL`: the shift-report list
 *    (ShiftReportService.listReports, GET /attendance/report/shifts, console and Venue Manager app) runs a LATERAL count
 *    of the e-mails that carried each report's final timesheet, `WHERE eo.attachment_file_id = b.final_file_id`, once per
 *    finalised report. Without an index every probe is a sequential scan of the outbox: 44,887 scans per page here (with
 *    only 153 outbox rows: ~620 ms of the 1.08 s statement), and quadratic as the outbox grows (outbox retention is off in
 *    production). Partial: most outbox rows carry no attachment. 1.08 s -> 0.46 s per page; the rest is the
 *    per-shift aggregation, a query change proposed separately (attendance module).
 *
 * Both measured as crewflow_owner (NOBYPASSRLS, FORCE RLS) with the production tenant GUCs, PostgreSQL 16.16.
 * core only: with HWS on, business tables live in the workspace schemas, whose template is not changed here (no other
 * core-only business-table index is mirrored there either, e.g. payroll_record_workspace_status_idx); the workspace copy
 * is a follow-up for the HWS switch-on.
 *
 * Same CONCURRENTLY / INVALID-retry handling and `transaction = false` as OutboxClaimIndexes1786721440000: an INVALID leftover
 * of a failed concurrent build is dropped (CONCURRENTLY) and rebuilt; the build must end VALID or the migration throws (and
 * stays unrecorded, so the next run retries). up() REFUSES to run inside a transaction (no plain-CREATE fallback: it would
 * block clock-in / clock-out for the build); only down() keeps the plain locking DROP when TypeORM forces a transaction
 * (migration:revert). Listed in NON_TRANSACTIONAL_MIGRATIONS. No table, column, RLS, FORCE, grant, ownership, function or template change.
 * Not in production-migration-approval.ts: production approval is a separate owner gate.
 */
const INDEXES: ReadonlyArray<{ name: string; definition: string }> = Object.freeze([
  { name: 'attendance_workspace_clock_in_idx', definition: 'ON core.attendance (workspace_id, clock_in_at DESC, id DESC)' },
  { name: 'email_outbox_attachment_file_idx', definition: 'ON core.email_outbox (attachment_file_id) WHERE attachment_file_id IS NOT NULL' },
]);
/** Owner of core.attendance / core.email_outbox. */
const TABLE_OWNER = 'crewflow';

export class LoadTestListIndexes1786722700000 implements MigrationInterface {
  name = 'LoadTestListIndexes1786722700000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Never the plain locking form here: inside a forced transaction (e.g. a CLI run with `-t all`) CREATE INDEX would hold
    // a SHARE lock on core.attendance for the whole build and block every clock-in / clock-out. Refuse instead; the
    // migration stays unrecorded and the normal (non-transactional) run builds it CONCURRENTLY.
    if (queryRunner.isTransactionActive) {
      throw new Error(`${this.name} must run outside a transaction (CREATE INDEX CONCURRENTLY); refusing the locking form on core.attendance`);
    }
    await this.assertAuthority(queryRunner);
    const cc = 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      for (const index of INDEXES) {
        if ((await this.state(queryRunner, index.name)) === 'INVALID') await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
        if ((await this.state(queryRunner, index.name)) === 'ABSENT') {
          await queryRunner.query(`CREATE INDEX ${cc}IF NOT EXISTS ${index.name} ${index.definition}`);
        }
        if ((await this.state(queryRunner, index.name)) !== 'VALID') throw new Error(`${this.name}: ${index.name} is not valid after the build`);
      }
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    for (const index of [...INDEXES].reverse()) await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
  }

  private async state(queryRunner: QueryRunner, name: string): Promise<'ABSENT' | 'VALID' | 'INVALID'> {
    const rows: Array<{ valid: boolean; ready: boolean }> = await queryRunner.query(
      `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = $1`,
      [name],
    );
    if (rows.length === 0) return 'ABSENT';
    return rows[0]!.valid && rows[0]!.ready ? 'VALID' : 'INVALID';
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, $1, 'USAGE') AS ok`, [TABLE_OWNER]);
    if (!ok) throw new Error(`${this.name} must run as ${TABLE_OWNER} or the migration identity (owner of attendance / email_outbox)`);
  }
}
