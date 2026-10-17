import { Client } from 'pg';

/**
 * Database security posture: who owns every `core` object and what `crewflow` / `crewflow_app` may do with it.
 *
 * Why (CF-09, CF-41, CF-48): grant and ownership drift went unnoticed because tests ran on a long-lived database with
 * hand-applied grants. A database built only from migrations returned 503 on every cookie request. This module reads
 * the effective model (not the migration text) so a fresh build, an upgraded build and the golden snapshot can be
 * compared line by line.
 *
 * Read-only: a single READ ONLY transaction, catalog functions only.
 */
export const POSTURE_QUERY = `
SELECT line FROM (
  SELECT 'owner|table|' || c.relname || '|' || pg_get_userbyid(c.relowner) AS line
    FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT 'owner|function|' || replace(p.oid::regprocedure::text, 'core.', '') || '|' || pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef
         || CASE WHEN p.prosecdef THEN '|' || coalesce((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), 'search_path=<unset>') ELSE '' END
    FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace
  UNION ALL
  SELECT 'owner|schema|core|' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'core'
  UNION ALL
  SELECT 'rls|' || c.relname || '|enable=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'table|' || c.relname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN 'S' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'INSERT') THEN 'I' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'UPDATE') THEN 'U' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'DELETE') THEN 'D' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRUNCATE') THEN 'T' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'REFERENCES') THEN 'R' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRIGGER') THEN 'G' END)
    FROM pg_class c CROSS JOIN pg_roles r
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'S') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'column|' || c.relname || '.' || a.attname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT') THEN 'S' END,
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT') THEN 'I' END,
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE') THEN 'U' END)
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped CROSS JOIN pg_roles r
   WHERE c.relnamespace = 'core'::regnamespace AND c.relname IN ('user', 'user_session', 'refresh_token') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'execute|' || replace(p.oid::regprocedure::text, 'core.', '') || '|' || r.rolname || '|' || has_function_privilege(r.oid, p.oid, 'EXECUTE')
    FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace = 'core'::regnamespace AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'execute|' || replace(p.oid::regprocedure::text, 'core.', '') || '|PUBLIC|'
         || (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'))
    FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
  UNION ALL
  SELECT 'schema|core|' || r.rolname || '|usage=' || has_schema_privilege(r.oid, 'core', 'USAGE') || '|create=' || has_schema_privilege(r.oid, 'core', 'CREATE')
    FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'role|' || r.rolname || '|super=' || r.rolsuper || '|bypassrls=' || r.rolbypassrls || '|login=' || r.rolcanlogin
         || '|member_of=' || coalesce((SELECT string_agg(b.rolname, ',' ORDER BY b.rolname) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid), '')
    FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app', 'rab_secure_owner')
) posture
ORDER BY line`;

export async function readSecurityPosture(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query<{ line: string }>(POSTURE_QUERY);
    await client.query('ROLLBACK');
    return rows.map((r) => r.line);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Lines present on one side only. Empty means the posture matches exactly. */
export function diffPosture(expected: string[], actual: string[]): { missing: string[]; unexpected: string[] } {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: expected.filter((l) => !have.has(l)),
    unexpected: actual.filter((l) => !want.has(l)),
  };
}
