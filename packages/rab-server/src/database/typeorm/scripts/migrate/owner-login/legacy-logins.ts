/**
 * BC-17 (owner decision 2026-11-05, MITIGATE): on an owner-login database the legacy logins lose their login ability.
 *
 *   - crewflow, crewflow_app: NOLOGIN, password removed, at the end of a FRESH install (the locked runner, owner login, after
 *     the chain and before the post-checks). crewflow_owner created both, so PostgreSQL 16+ gave it the ADMIN option it
 *     needs for ALTER ROLE. They stay schema roles (owners, grantees, SET ROLE targets). An existing database is moved by the
 *     provider admin instead (postgres-init/owner-login/transition-from-separated.sql), before the owner-login migrate.
 *   - crewflow_worker: KEEPS its LOGIN attribute. WorkerDispatchPointer1786721300000 and AccountInviteCleanupDefiner1786721340000
 *     assert that reviewed shape when they run, and crewflow_owner never administers it (zero members, M0 B3), so the owner
 *     login cannot change it. On a fresh install it never had a password (bootstrap.ts); the transition removes its password.
 *
 * Run UNCONDITIONALLY whenever crewflow_owner can (ADMIN on the role + CREATEROLE): the login attribute is visible but the
 * password is not (pg_authid needs superuser), and a later install on the same cluster re-runs the role migrations, which
 * set a fresh random password on a role that is ALREADY NOLOGIN (Agent 5, LOW: "NOLOGIN with a password" would survive and
 * come back with a later ALTER ROLE … LOGIN). The statement is idempotent. A LOGIN role crewflow_owner cannot alter is
 * reported (warning, with the one provider-admin statement), never silently skipped. Nothing here prints a password.
 */

/** The exact statements (constants: no identifier is ever interpolated). */
export const LEGACY_NOLOGIN_SQL: Readonly<Record<string, string>> = Object.freeze({
  crewflow: 'ALTER ROLE crewflow NOLOGIN PASSWORD NULL',
  crewflow_app: 'ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL',
});
export const LEGACY_NOLOGIN_ROLES: readonly string[] = Object.keys(LEGACY_NOLOGIN_SQL);

export const LEGACY_LOGIN_FACTS_SQL = `
SELECT r.rolname::text AS "name", r.rolcanlogin AS "login",
       EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a
                WHERE a.roleid = r.oid AND a.member = (SELECT s.oid FROM pg_catalog.pg_roles s WHERE s.rolname = session_user)
                  AND a.admin_option)
         AND (SELECT s.rolcreaterole FROM pg_catalog.pg_roles s WHERE s.rolname = session_user) AS "admin"
  FROM pg_catalog.pg_roles r
 WHERE r.rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker')
 ORDER BY 1`;

export interface LegacyLoginFacts {
  name: string;
  login: boolean;
  /** The session login (crewflow_owner) holds ADMIN on the role AND CREATEROLE: it may ALTER ROLE it (PostgreSQL 16+). */
  admin: boolean;
}

/** Pure: the statements to run and the warnings to log for these facts. */
export function legacyLoginPlan(facts: readonly LegacyLoginFacts[]): { statements: string[]; warnings: string[]; info: string[] } {
  const statements: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  for (const f of facts) {
    const sql = LEGACY_NOLOGIN_SQL[f.name];
    if (sql) {
      // Whenever crewflow_owner may: the password is invisible, so "already NOLOGIN" proves nothing about it.
      if (f.admin) statements.push(sql);
      else if (f.login) warnings.push(`legacy login ${f.name} is still LOGIN and crewflow_owner does not administer it: run "${sql}" as the provider admin (BC-17)`);
    } else if (f.name === 'crewflow_worker' && f.login) {
      info.push('crewflow_worker keeps its LOGIN attribute (its historical migrations assert it; crewflow_owner cannot administer it): it has no password on an owner-login install (BC-17)');
    }
  }
  return { statements, warnings, info };
}

/** Runs the plan on the locked migration session (owner login, fresh install only). */
export async function disableLegacyLogins(
  query: (sql: string) => Promise<unknown[]>,
  log: (line: string) => void,
): Promise<string[]> {
  const facts = (await query(LEGACY_LOGIN_FACTS_SQL)) as LegacyLoginFacts[];
  const plan = legacyLoginPlan(facts);
  for (const sql of plan.statements) {
    await query(sql);
    log(`BC-17: ${sql.replace(' PASSWORD NULL', '')} (password removed)`);
  }
  for (const w of plan.warnings) log(`WARNING: ${w}`);
  for (const i of plan.info) log(i);
  return plan.statements;
}
