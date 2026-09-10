import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completes the follow-up WorkspaceIdExpand1786667600000 itself promised
 * ("validated later in WorkspaceForeignKeysValidate once backfill is
 * confirmed complete") but that was never actually written — a real,
 * confirmed drift found during the SEC-02 remediation pass, not a
 * hypothetical one. All twelve `*_workspace_id_fkey` constraints it created
 * have sat `NOT VALID` since Stage 2A step 1: new writes were already
 * checked (`NOT VALID` only skips validating pre-existing rows, never new
 * ones), but no pre-existing row was ever confirmed clean.
 *
 * Verified safe before writing this migration — a live query against both
 * local Postgres and the Neon dev database (as `rab_owner`, so RLS on the
 * NOT-FORCEd `staff_profile`/`manager_profile` doesn't hide rows) found
 * zero orphaned `workspace_id` values on every one of these tables,
 * including the two with real data (`staff_profile`: 368 rows, 2 legacy
 * NULL `workspace_id`; `manager_profile`: 677 rows, 151 legacy NULL) — a
 * NULL `workspace_id` is untouched by `VALIDATE CONSTRAINT` (Postgres's
 * default `MATCH SIMPLE` skips any row where a referencing column is
 * NULL), so those legacy rows validate trivially. `VALIDATE CONSTRAINT`
 * takes only `SHARE UPDATE EXCLUSIVE` (blocks other DDL, never blocks
 * concurrent reads/writes) and is a full-table scan — negligible here at
 * these row counts.
 */
export class WorkspaceForeignKeysValidate1786671000000 implements MigrationInterface {
  name = 'WorkspaceForeignKeysValidate1786671000000';

  private readonly constraints: Array<{ table: string; constraint: string }> = [
    { table: 'staff_profile', constraint: 'staff_profile_workspace_id_fkey' },
    { table: 'venue', constraint: 'venue_workspace_id_fkey' },
    { table: 'venue_role_rate', constraint: 'venue_role_rate_workspace_id_fkey' },
    { table: 'manager_venue', constraint: 'manager_venue_workspace_id_fkey' },
    { table: 'job_role', constraint: 'job_role_workspace_id_fkey' },
    { table: 'shift', constraint: 'shift_workspace_id_fkey' },
    { table: 'shift_assignment', constraint: 'shift_assignment_workspace_id_fkey' },
    { table: 'job_offer', constraint: 'job_offer_workspace_id_fkey' },
    { table: 'attendance', constraint: 'attendance_workspace_id_fkey' },
    { table: 'manager_profile', constraint: 'manager_profile_workspace_id_fkey' },
    { table: 'platform_config', constraint: 'platform_config_workspace_id_fkey' },
    { table: 'admin_inspect_session', constraint: 'admin_inspect_session_workspace_id_fkey' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, constraint } of this.constraints) {
      await queryRunner.query(`ALTER TABLE core.${table} VALIDATE CONSTRAINT ${constraint};`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op: VALIDATE CONSTRAINT only removes the `NOT VALID` marker on an
    // already-existing constraint, it doesn't change what's enforced going
    // forward (new writes were checked before this migration too). There is
    // no Postgres command to re-mark a validated FK as NOT VALID, and doing
    // so would provide no rollback value even if there were one.
  }
}
