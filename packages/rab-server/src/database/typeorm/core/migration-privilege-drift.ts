import { secureOwnerInvariantViolations } from './secure-owner-invariants';

/**
 * M2 (Phase 0b follow-up): catalog facts that NO migration may change silently for the runtime logins, compared before and
 * after a migration. Used by the restricted-migrator CI harness (scripts/migration-security-check.ts) for every migration
 * after Phase 0b, and by `migration-security.integration.spec.ts`. This is the authoritative check for the
 * `withCrewflowCoreCreate` rule; the source scan (migration-source-rules.ts) is only an early warning.
 *
 * Drift = any difference in these lines. A migration that legitimately changes one of them (a reviewed role or ownership
 * change) must update this check in the same pull request, so the change is visible to review instead of passing quietly.
 *   - CREATE on schema `core` / `public` for crewflow and crewflow_app (crewflow must stay without CREATE on core);
 *   - database-level CREATE / TEMPORARY for crewflow and crewflow_app;
 *   - role attributes of crewflow, crewflow_app and rab_secure_owner (LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB);
 *   - every role crewflow or crewflow_app is a member of, with its ADMIN / INHERIT / SET options;
 *   - per-role settings (rolconfig) and database/role settings (pg_db_role_setting) of those roles;
 *   - every default privilege (pg_default_acl);
 *   - every RLS policy on a core table: command, permissive flag, roles, USING and WITH CHECK expressions;
 *   - the owner of schema `core` and of the database;
 *   - the number of objects crewflow_app owns in any catalog (pg_shdepend; always 0: the runtime role owns nothing).
 * Table, column and function grants are compared by the golden posture snapshot at the end of every harness scenario.
 * pg_get_expr output qualifies names relative to the session search_path: compare snapshots taken with the same settings.
 * Afterwards the Phase 0b secure-owner invariants must still hold.
 *
 * Read-only catalog queries, schema-qualified, independent of the session search_path. No secrets are read or printed.
 */
export const PRIVILEGE_DRIFT_SNAPSHOT_SQL = `
SELECT line FROM (
  SELECT 'schema-create|' || n.nspname || '|' || r.rolname || '|' || pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE') AS line
    FROM pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_roles r
   WHERE n.nspname IN ('core', 'public') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'database|' || r.rolname || '|create=' || pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE')
         || '|temp=' || pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY')
    FROM pg_catalog.pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'role|' || r.rolname || '|login=' || r.rolcanlogin || '|super=' || r.rolsuper || '|bypassrls=' || r.rolbypassrls
         || '|createrole=' || r.rolcreaterole || '|createdb=' || r.rolcreatedb
    FROM pg_catalog.pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app', 'rab_secure_owner')
  UNION ALL
  SELECT 'member|' || pg_catalog.pg_get_userbyid(m.member) || '|of|' || pg_catalog.pg_get_userbyid(m.roleid)
         || '|admin=' || m.admin_option || '|inherit=' || m.inherit_option || '|set=' || m.set_option
    FROM pg_catalog.pg_auth_members m
   WHERE pg_catalog.pg_get_userbyid(m.member) IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'role-config|' || r.rolname || '|' || COALESCE(pg_catalog.array_to_string(r.rolconfig, ','), '')
    FROM pg_catalog.pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app', 'rab_secure_owner')
  UNION ALL
  SELECT 'db-role-config|' || COALESCE(pg_catalog.pg_get_userbyid(NULLIF(s.setrole, 0)), '*') || '|'
         || pg_catalog.array_to_string(s.setconfig, ',')
    FROM pg_catalog.pg_db_role_setting s
   WHERE s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
     AND (s.setrole = 0 OR pg_catalog.pg_get_userbyid(s.setrole) IN ('crewflow', 'crewflow_app', 'rab_secure_owner'))
  UNION ALL
  SELECT 'default-acl|' || pg_catalog.pg_get_userbyid(a.defaclrole) || '|' || COALESCE(n.nspname, '*') || '|'
         || a.defaclobjtype::text || '|' || a.defaclacl::text
    FROM pg_catalog.pg_default_acl a LEFT JOIN pg_catalog.pg_namespace n ON n.oid = a.defaclnamespace
  UNION ALL
  SELECT 'policy|' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|permissive=' || p.polpermissive
         || '|roles=' || COALESCE((SELECT pg_catalog.string_agg(q.n, ',' ORDER BY q.n)
                                     FROM (SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END AS n
                                             FROM pg_catalog.unnest(p.polroles) r) q), '')
         || '|using=' || COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
         || '|check=' || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'core')
  UNION ALL
  SELECT 'owner|schema|core|' || pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core'
  UNION ALL
  SELECT 'owner|database|' || pg_catalog.pg_get_userbyid(d.datdba) FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
  UNION ALL
  SELECT 'crewflow_app-owns|' || (
           SELECT pg_catalog.count(*) FROM pg_catalog.pg_shdepend d
            WHERE d.refobjid = r.oid AND d.deptype = 'o'
              AND d.dbid IN (0, (SELECT x.oid FROM pg_catalog.pg_database x WHERE x.datname = pg_catalog.current_database())))
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_app'
) s ORDER BY 1`;

type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

export async function privilegeDriftSnapshot(query: Query): Promise<string[]> {
  return (await query(PRIVILEGE_DRIFT_SNAPSHOT_SQL)).map((r) => String(r.line));
}

/** Lines that differ (`- before` / `+ after`); empty when nothing changed. */
export function privilegeDrift(before: readonly string[], after: readonly string[]): string[] {
  const b = new Set(before);
  const a = new Set(after);
  return [...before.filter((l) => !a.has(l)).map((l) => `- ${l}`), ...after.filter((l) => !b.has(l)).map((l) => `+ ${l}`)];
}

/**
 * Everything wrong after a migration: privilege drift against `before`, a crewflow CREATE grant on core (even when it was
 * already there before — post-Phase-0b it must never exist), and any secure-owner invariant violation.
 */
export async function postMigrationPrivilegeProblems(query: Query, before: readonly string[]): Promise<string[]> {
  const after = await privilegeDriftSnapshot(query);
  const problems = privilegeDrift(before, after).map((l) => `privilege-drift ${l}`);
  if (after.includes('schema-create|core|crewflow|true')) problems.push('crewflow holds CREATE on schema core');
  for (const v of await secureOwnerInvariantViolations(query)) problems.push(`secure-owner-invariant ${v}`);
  return problems;
}
