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
 * Verified safe on local Postgres and the Neon dev database (as `rab_owner`,
 * so RLS on the NOT-FORCEd `staff_profile`/`manager_profile` doesn't hide
 * rows) before writing this — zero orphaned `workspace_id` values on every
 * one of these tables. But the first deploy of this migration crashed
 * Render's production boot with Postgres error 42704 (undefined_object) from
 * `VALIDATE CONSTRAINT` — proof that production's actual database has at
 * least one of these twelve constraints in a different state (missing,
 * renamed, or already validated some other way) than either database this
 * was tested against. Rather than re-guess which one and hardcode around it
 * (the same mistake that caused the crash), this checks `pg_constraint`
 * itself before touching each one:
 *   - constraint doesn't exist under this exact name on this table → skip,
 *     log a notice. Nothing to validate; the original per-environment
 *     schema drift is a separate, disclosed finding, not something this
 *     migration should paper over by pretending success.
 *   - exists and already `convalidated` → skip silently (idempotent — a
 *     retried or already-partially-applied run does nothing extra).
 *   - exists and NOT VALID → `VALIDATE CONSTRAINT`, same as before. This
 *     still fails the boot loudly if real violating rows exist — that
 *     safety property from the original migration is unchanged; only the
 *     "assume the constraint exists at all" assumption was wrong.
 *
 * `VALIDATE CONSTRAINT` takes only `SHARE UPDATE EXCLUSIVE` (blocks other
 * DDL, never blocks concurrent reads/writes) and is a full-table scan —
 * negligible at the row counts seen on every database checked so far.
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
      const rows: Array<{ convalidated: boolean }> = await queryRunner.query(
        `
          SELECT c.convalidated
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'core' AND t.relname = $1 AND c.conname = $2 AND c.contype = 'f'
        `,
        [table, constraint],
      );

      if (rows.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[WorkspaceForeignKeysValidate] core.${table}.${constraint} does not exist on this database — ` +
            'skipping. This database\'s schema has drifted from the one this migration was written against; ' +
            'investigate separately, this migration only validates constraints that are actually present.',
        );
        continue;
      }

      if (rows[0]!.convalidated) continue; // Already validated — idempotent no-op.

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
