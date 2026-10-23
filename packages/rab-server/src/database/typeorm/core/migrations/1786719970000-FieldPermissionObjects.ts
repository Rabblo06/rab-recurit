import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Waves 4+5 lane DB5 — schema for the DATA lane's field permissions on payroll-adjacent objects
 * (CREWFLOW_ULTIMATE_PARITY_PHASE0_REPORT.md row 8: attendance `earnedPence`/`workedMinutes`, offer `payRatePence`/
 * `estimatedPayPence`, shift_report). Dev/test only: NOT in production-migration-approval.ts.
 * Contract: docs/evidence/w45-db5/CONTRACT.md §8.
 *
 * Widens the `object_key` CHECK of `core.role_field_permission` and `core.role_object_permission` from
 * (staff, venue, shift) to (staff, venue, shift, attendance, offer, shift_report). It only allows new rows: no row changes,
 * no permission catalogue entries, no grant or policy change (both tables stay ENABLE + FORCE with their workspace
 * policies). down() refuses while any row uses a new key (narrowing would otherwise fail half way or need to delete grants).
 */
const NEW_KEYS = ['staff', 'venue', 'shift', 'attendance', 'offer', 'shift_report'];
const OLD_KEYS = ['staff', 'venue', 'shift'];
const TABLES = ['role_field_permission', 'role_object_permission'] as const;
const keys = (k: readonly string[]) => `ARRAY[${k.map((x) => `'${x}'::text`).join(', ')}]`;

export class FieldPermissionObjects1786719970000 implements MigrationInterface {
  name = 'FieldPermissionObjects1786719970000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const t of TABLES) {
      await queryRunner.query(`ALTER TABLE core.${t} DROP CONSTRAINT ${t}_object_key_check`);
      await queryRunner.query(`ALTER TABLE core.${t} ADD CONSTRAINT ${t}_object_key_check CHECK (object_key = ANY (${keys(NEW_KEYS)}))`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of TABLES) {
      // Run as the bootstrap superuser (no tenant context): FORCE RLS would hide rows from any bound session.
      const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM core.${t} WHERE NOT (object_key = ANY (${keys(OLD_KEYS)}))`);
      if (Number(n) !== 0) throw new Error(`${this.name}: ${n} core.${t} row(s) use a new object key; refusing to narrow the CHECK`);
    }
    for (const t of TABLES) {
      await queryRunner.query(`ALTER TABLE core.${t} DROP CONSTRAINT ${t}_object_key_check`);
      await queryRunner.query(`ALTER TABLE core.${t} ADD CONSTRAINT ${t}_object_key_check CHECK (object_key = ANY (${keys(OLD_KEYS)}))`);
    }
  }
}
