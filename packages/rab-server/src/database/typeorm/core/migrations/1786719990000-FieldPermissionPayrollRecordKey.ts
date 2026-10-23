import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Waves 4+5 integration — the DATA lane's schema request (WAVE5_LANE_DATA_REPORT.md §3.1). Dev/test only: NOT in
 * production-migration-approval.ts (N1).
 *
 * `FieldPolicyService` (modules/identity/member-access/field-policy.{registry,service}.ts) reads custom-member field rules
 * for the object `payroll_record` (`workedTime`, `payRate`, `amount`) from `core.role_field_permission`, but the
 * `object_key` CHECK widened by FieldPermissionObjects1786719970000 does not list that key, so no such rule could ever be
 * stored and the registry defaults (money hidden) always applied.
 *
 * This widens ONLY `core.role_field_permission_object_key_check` by `payroll_record`. `core.role_object_permission` is
 * deliberately left unchanged: `payroll_record` is a field-policy object, not a member object (the Roles editor must never
 * be able to materialise a payroll "See" grant — field-policy.registry.ts header). No row, grant, policy or catalogue
 * entry changes; the table stays ENABLE + FORCE with its workspace policies.
 *
 * down() restores the 1786719970000 key list and refuses while any row uses `payroll_record` (narrowing would otherwise
 * fail half way or need to delete rules). Run down() as the bootstrap superuser: FORCE RLS hides rows from a bound session.
 */
const PREVIOUS_KEYS = ['staff', 'venue', 'shift', 'attendance', 'offer', 'shift_report'];
const NEW_KEYS = [...PREVIOUS_KEYS, 'payroll_record'];
const keys = (k: readonly string[]) => `ARRAY[${k.map((x) => `'${x}'::text`).join(', ')}]`;

export class FieldPermissionPayrollRecordKey1786719990000 implements MigrationInterface {
  name = 'FieldPermissionPayrollRecordKey1786719990000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.role_field_permission DROP CONSTRAINT role_field_permission_object_key_check`);
    await queryRunner.query(
      `ALTER TABLE core.role_field_permission ADD CONSTRAINT role_field_permission_object_key_check CHECK (object_key = ANY (${keys(NEW_KEYS)}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = await queryRunner.query(
      `SELECT count(*)::int AS n FROM core.role_field_permission WHERE NOT (object_key = ANY (${keys(PREVIOUS_KEYS)}))`,
    );
    if (Number(n) !== 0) {
      throw new Error(`${this.name}: ${n} core.role_field_permission row(s) use 'payroll_record'; refusing to narrow the CHECK`);
    }
    await queryRunner.query(`ALTER TABLE core.role_field_permission DROP CONSTRAINT role_field_permission_object_key_check`);
    await queryRunner.query(
      `ALTER TABLE core.role_field_permission ADD CONSTRAINT role_field_permission_object_key_check CHECK (object_key = ANY (${keys(PREVIOUS_KEYS)}))`,
    );
  }
}
