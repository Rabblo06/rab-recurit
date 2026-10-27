import { QueryRunner } from 'typeorm';

/**
 * Post-condition shared by the C1 migrations (range 1786720900000–949999). Not in migrations/: TypeORM loads every
 * exported function of a migration file as a migration. Frozen: a later change is a new helper, never an edit, because
 * it is part of what these migrations asserted when they ran.
 */
export async function assertTenantTablePosture(
  runner: QueryRunner,
  migration: string,
  table: string,
  expect: { policies: number; insertColumn: string; updateColumn: string | null; delete: boolean },
): Promise<void> {
  const qualified = `core.${table}`;
  const [check] = (await runner.query(
    `SELECT
       (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = $1) AS forced,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'core' AND tablename = $1)::int AS policies,
       has_table_privilege('crewflow_app', $2, 'SELECT') AS app_select,
       has_table_privilege('crewflow_app', $2, 'DELETE') AS app_delete,
       has_table_privilege('crewflow_app', $2, 'TRUNCATE') AS app_truncate,
       has_table_privilege('crewflow_app', $2, 'INSERT') AS app_table_insert,
       has_table_privilege('crewflow_app', $2, 'UPDATE') AS app_table_update,
       has_column_privilege('crewflow_app', $2, $3, 'INSERT') AS app_insert_col,
       has_column_privilege('crewflow_app', $2, 'created_at', 'INSERT') AS app_insert_created,
       has_column_privilege('crewflow_app', $2, 'organisation_id', 'UPDATE') AS app_update_org,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    [table, qualified, expect.insertColumn],
  )) as Array<Record<string, number | boolean>>;
  let updateOk = true;
  if (expect.updateColumn) {
    const [u] = (await runner.query(`SELECT has_column_privilege('crewflow_app', $1, $2, 'UPDATE') AS ok`, [qualified, expect.updateColumn])) as Array<{ ok: boolean }>;
    updateOk = u?.ok === true;
  }
  if (
    check.forced !== true || check.policies !== expect.policies || check.app_select !== true || check.app_delete !== expect.delete ||
    check.app_truncate || check.app_table_insert || check.app_table_update || check.app_insert_col !== true || check.app_insert_created ||
    check.app_update_org || check.app_bypass || !updateOk
  ) {
    throw new Error(`${migration}: post-condition failed ${JSON.stringify(check)}`);
  }
}
