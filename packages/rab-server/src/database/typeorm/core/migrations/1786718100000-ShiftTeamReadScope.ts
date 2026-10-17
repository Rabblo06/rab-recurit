import { MigrationInterface, QueryRunner } from 'typeorm';
import { shiftTeamPolicy } from '../../workspace-schema/v1/shift-team-policy';

/** Additive read policy only. Existing own-profile rules and all writes unchanged. */
export class ShiftTeamReadScope1786718100000 implements MigrationInterface {
  name = 'ShiftTeamReadScope1786718100000';
  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'staff_profile'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map(row => row.schema_name);
  }
  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(shiftTeamPolicy(schema));
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      await runner.query(`DROP POLICY IF EXISTS staff_profile_shift_team_select ON "${schema}".staff_profile`);
    }
  }
}
