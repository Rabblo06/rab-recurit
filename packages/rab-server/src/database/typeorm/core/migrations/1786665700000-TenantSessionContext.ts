import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Session-context helper functions backing Row-Level Security policies
 * (rab-workforce-architecture.md §5.7). Fail-closed by construction: when
 * `rab.organisation_id` is unset, `current_org()` returns NULL, and every
 * `organisation_id = core.current_org()` predicate evaluates to NULL — the
 * row is filtered out. Unset context yields zero rows, never all rows.
 *
 * `TenantContextService` (engine/core-modules/tenant/) binds these via
 * `set_config(..., true)` inside a transaction (`SET LOCAL` semantics) on
 * every request, once auth exists (M1). No RLS policy exists yet — those
 * land per-table, in the same migration that creates each tenant table.
 */
export class TenantSessionContext1786665700000 implements MigrationInterface {
  name = 'TenantSessionContext1786665700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.current_org() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('rab.organisation_id', true), '')::uuid
      $$;
    `);
    await queryRunner.query(`
      CREATE FUNCTION core.current_uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('rab.user_id', true), '')::uuid
      $$;
    `);
    await queryRunner.query(`
      CREATE FUNCTION core.current_role_name() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('rab.role', true), ''), 'NONE')
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.current_role_name()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.current_uid()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.current_org()`);
  }
}
