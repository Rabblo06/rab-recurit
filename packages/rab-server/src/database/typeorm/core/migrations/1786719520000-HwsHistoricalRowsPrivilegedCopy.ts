import { MigrationInterface, QueryRunner } from 'typeorm';

import { runHwsPrivilegedCopy, undoHwsPrivilegedCopy } from '../../workspace-schema/backfill/privileged-copy';

/**
 * STAGED (one-off, owner decision 2026-10-22 "Option 1: one-off approved copy", development migration only).
 *
 * Copies the historical rows that the workspace tables' RUNTIME-ACTOR insert policies cannot accept — the payroll family
 * (payroll_run, payslip, payslip_document, payroll_record, payroll_run_line) and shift_staff_review — from core into each
 * workspace schema, then verifies ALL 21 workspace tables against core at full precision and records an audit_log row
 * (with the authoritative per-table counts) per workspace. See workspace-schema/backfill/privileged-copy.ts for the
 * complete contract. It adds NO policy, grant, function, role or GUC bypass: it runs as the approved migration identity
 * (must be SUPERUSER or BYPASSRLS — refuses otherwise) through the guarded migration runner.
 *
 * ORDER MATTERS: run it only AFTER `hws:backfill --apply` has copied the tool-owned tables. A workspace with core rows but
 * no backfill checkpoints is skipped (audited); a backfilled workspace that does not match core exactly raises and rolls
 * the migration back. Keep this file in proposed-migrations/ until the backfill apply has run, then move it into
 * migrations/ and run the guarded runner again.
 *
 * down(): removes only the copied deferred-table rows (core is never touched; audit rows are insert-only and stay).
 */
export class HwsHistoricalRowsPrivilegedCopy1786719520000 implements MigrationInterface {
  name = 'HwsHistoricalRowsPrivilegedCopy1786719520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const results = await runHwsPrivilegedCopy(queryRunner, { migrationName: this.name });
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[${this.name}] workspace=${r.workspaceId} outcome=${r.outcome} copied=${JSON.stringify(r.copied)}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await undoHwsPrivilegedCopy(queryRunner);
  }
}
