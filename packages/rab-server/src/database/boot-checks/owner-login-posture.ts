// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * Owner-login architecture (owner's final decision 2026-11-04, Option A, PERMANENT — no mode switch): the ONE
 * schema-owning login `crewflow_owner` serves the API, the Worker, the CLI and the migration child. The former rules
 * ("the runtime login owns nothing and is a member of no owner role") are false by design now; these checks REPLACE them
 * in place (the boot gates, the runtime-role assertion, tools/check-rls-coverage.ts and the periodic posture monitor all
 * call these functions — there is no second validator). The legacy roles rab_owner, rab_app, rab_secure_owner, crewflow,
 * crewflow_app and crewflow_worker remain as SCHEMA roles (historical migrations and definers need them); none of them is
 * a runtime login any more. Every difference from the former restricted-login behaviour is in the behaviour-change
 * catalogue (owner-login-behaviour-catalogue.ts, THREAT-MODEL.md PT-01).
 *
 * What they prove (each a refusal, never a warning):
 *  1. login shape  — current_user = session_user = crewflow_owner; NOSUPERUSER, NOBYPASSRLS, NOREPLICATION, NOCREATEDB.
 *                    CREATEROLE is EXPECTED (the bootstrap creates the role layout); `ALTER ROLE crewflow_owner
 *                    NOCREATEROLE` after install is accepted (M0 §5.1 optional hardening).
 *  2. reachability — a walk over pg_auth_members from the login with MEMBER semantics: every edge counts, whatever its
 *                    INHERIT / SET / ADMIN options (an ADMIN-only edge lets the login grant itself SET later: G-12), direct
 *                    and indirect. Cross-checked with pg_has_role(…, 'MEMBER') over every role (catches implicit
 *                    memberships the walk cannot see). No reached role may be SUPERUSER, BYPASSRLS, CREATEDB or
 *                    REPLICATION, a dangerous predefined role (data, server files, program execution, backend signals,
 *                    subscriptions, maintain) or a known provider administrator role.
 *  3. inventory    — the exact Option A role layout (M0 §3.1 / §5.2, the rolemaker bootstrap): which roles the login is a
 *                    member of, who else is a member of rab_secure_owner / crewflow / rab_owner / rab_app / crewflow_app /
 *                    crewflow_worker / crewflow_owner, no unexpected LOGIN role able to act as any of them, and NOLOGIN
 *                    where expected (rab_owner, rab_app, rab_secure_owner — G-04 "re-enabling NOLOGIN roles").
 *  4. objects      (ownerLoginObjectPostureProblems, after the schema gate) — FORCE on every core tenant table, on the 16
 *                    pre-auth tables (M-T1) with their exact owner-only definer policy, and on the deployment-identity
 *                    tables; expected ownership (core schema rab_secure_owner, core objects rab_secure_owner or crewflow,
 *                    workspace schemas rab_secure_owner / tables crewflow), and nothing outside the expected schemas owned
 *                    by the login or the owner roles.
 *
 * What they do NOT prove (owner-accepted, THREAT-MODEL PT-01 / G-01…G-13): an injected statement runs with the login's
 * full ownership and can rewrite anything these checks read AFTER they ran. They are boot-time and periodic integrity
 * checks for an owner login, not a privilege boundary. Passwords of the expected LOGIN roles (crewflow, crewflow_app,
 * crewflow_worker) are not readable without superuser (pg_authid), so a password set on one of them is NOT detected here.
 */

import { PREAUTH_DEFINER_EXPRESSION, PREAUTH_FORCE_TABLES, preauthDefinerPolicyName } from '../typeorm/core/preauth-force-sql';

export const OWNER_LOGIN_ROLE = 'crewflow_owner';

/** The roles the Option A bootstrap creates (M0 §5.2). */
export const OWNER_SCHEMA_ROLES: readonly string[] = ['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow'];
export const LAYOUT_SCHEMA_ROLES: readonly string[] = [...OWNER_SCHEMA_ROLES, 'crewflow_app', 'crewflow_worker'];
/** Must stay NOLOGIN (G-04: an owner role turned into a password login is persistence that survives rotation). */
export const NOLOGIN_SCHEMA_ROLES: readonly string[] = ['rab_owner', 'rab_app', 'rab_secure_owner'];
/**
 * LOGIN roles that MAY exist in the layout (an allow-list, not a requirement). Since BC-17 was mitigated (owner decision
 * 2026-11-05, Agent 1) `crewflow` and `crewflow_app` are NOLOGIN with no password; `crewflow_worker` stays LOGIN with no
 * password (residual: only non-password authentication, which the provider's pg_hba must not grant).
 */
export const EXPECTED_LOGIN_ROLES: readonly string[] = [OWNER_LOGIN_ROLE, 'crewflow', 'crewflow_app', 'crewflow_worker'];

/**
 * Predefined roles that confer data access beyond RLS, server file / program access, backend signalling, outbound
 * subscriptions or table maintenance. The first six are the M0 list; `pg_create_subscription` (PG16) and `pg_maintain`
 * (PG17+) are stricter additions. Matched by name: a role that does not exist on this major is simply never reached.
 */
export const DANGEROUS_PREDEFINED_ROLES: readonly string[] = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_signal_backend',
  'pg_create_subscription',
  'pg_maintain',
];

/**
 * Managed-provider administrator roles (M0 §3.5 / E): none of them may be reachable from the app login. Their dangerous
 * attributes are usually also caught by rule 2 (BYPASSRLS / REPLICATION / CREATEDB), but some are plain NOLOGIN roles that
 * carry predefined-role memberships or provider hooks, so they are refused by name as well.
 */
export const PROVIDER_ADMIN_ROLES: readonly string[] = [
  'neon_superuser',
  'rds_superuser',
  'rds_replication',
  'rds_password',
  'rdsadmin',
  'rds_ad',
  'cloudsqlsuperuser',
  'cloudsqladmin',
  'cloudsqlreplica',
  'azure_pg_admin',
  'azure_superuser',
  'azuresu',
  'supabase_admin',
  'supabase_replication_admin',
  'supabase_storage_admin',
  'supabase_auth_admin',
  'doadmin',
];

const sqlList = (names: readonly string[]) => names.map((n) => `'${n}'`).join(', ');
const LAYOUT_AND_LOGIN = [OWNER_LOGIN_ROLE, ...LAYOUT_SCHEMA_ROLES];

/** Rule 1: the login itself. */
export const OWNER_LOGIN_FACTS_SQL = `
SELECT current_user::text AS who, session_user::text AS login,
       r.rolsuper AS super, r.rolbypassrls AS bypassrls, r.rolreplication AS replication, r.rolcreatedb AS createdb,
       r.rolcreaterole AS createrole, r.rolcanlogin AS canlogin, r.rolinherit AS inherit
  FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`;

/**
 * Rule 2: every role reachable from the LOGIN (session_user) with MEMBER semantics. The recursive walk follows every
 * pg_auth_members edge (any INHERIT / SET / ADMIN option); the second branch adds anything pg_has_role(…, 'MEMBER')
 * reports that the walk did not reach (implicit memberships such as pg_database_owner for the database owner).
 * `path` is the shortest walk path, `role>role>…`, or `(implicit)`.
 */
export const OWNER_LOGIN_REACHABILITY_SQL = `
WITH RECURSIVE walk(oid, path) AS (
  SELECT r.oid, ARRAY[r.rolname::text] FROM pg_catalog.pg_roles r WHERE r.rolname = session_user
  UNION ALL
  SELECT g.oid, w.path || g.rolname::text
    FROM walk w
    JOIN pg_catalog.pg_auth_members m ON m.member = w.oid
    JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
   WHERE NOT (g.rolname::text = ANY (w.path)) AND pg_catalog.cardinality(w.path) < 16
),
reached AS (
  SELECT oid, pg_catalog.min(pg_catalog.array_to_string(path, '>')) AS path FROM walk GROUP BY oid
  UNION ALL
  SELECT r.oid, '(implicit)' FROM pg_catalog.pg_roles r
   WHERE pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER') AND r.oid NOT IN (SELECT w.oid FROM walk w)
)
SELECT r.rolname::text AS role, x.path, r.rolsuper AS super, r.rolbypassrls AS bypassrls, r.rolcreatedb AS createdb,
       r.rolreplication AS replication, r.rolcanlogin AS canlogin, (r.rolname = session_user) AS is_login
  FROM reached x JOIN pg_catalog.pg_roles r ON r.oid = x.oid
 ORDER BY 1`;

/**
 * Rule 3 facts: every membership row that involves the login or a layout role (PG16+ grant options; run after the version
 * gate), with the role's own LOGIN attribute so an administered backdoor login is visible.
 */
export const OWNER_LOGIN_MEMBERSHIPS_SQL = `
SELECT r.rolname::text AS role, r.rolcanlogin AS role_login, m.rolname::text AS member, m.rolcanlogin AS member_login,
       m.rolsuper AS member_super, a.admin_option AS admin, a.inherit_option AS inherit, a.set_option AS set
  FROM pg_catalog.pg_auth_members a
  JOIN pg_catalog.pg_roles r ON r.oid = a.roleid
  JOIN pg_catalog.pg_roles m ON m.oid = a.member
 WHERE r.rolname IN (${sqlList(LAYOUT_AND_LOGIN)}) OR m.rolname = session_user
 ORDER BY 1, 3`;

/** Rule 3: attributes of the layout roles (missing roles are reported by name). */
export const LAYOUT_SCHEMA_ROLES_SQL = `
SELECT r.rolname::text AS role, r.rolcanlogin AS canlogin, r.rolsuper AS super, r.rolbypassrls AS bypassrls,
       r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolreplication AS replication
  FROM pg_catalog.pg_roles r WHERE r.rolname IN (${sqlList(LAYOUT_SCHEMA_ROLES)}) ORDER BY 1`;

/**
 * Rule 3: LOGIN roles, other than the expected ones and superusers (the platform, which nothing here can constrain), that
 * can USE or SET ROLE to the login or a layout role — a backdoor login granted into the layout (G-04).
 */
export const OWNER_LOGIN_FOREIGN_LOGINS_SQL = `
SELECT DISTINCT l.rolname::text AS login, o.rolname::text AS reaches
  FROM pg_catalog.pg_roles l CROSS JOIN pg_catalog.pg_roles o
 WHERE l.rolcanlogin AND NOT l.rolsuper AND l.oid <> o.oid
   AND o.rolname IN (${sqlList(LAYOUT_AND_LOGIN)})
   AND l.rolname NOT IN (${sqlList(EXPECTED_LOGIN_ROLES)})
   AND (pg_catalog.pg_has_role(l.oid, o.oid, 'USAGE') OR pg_catalog.pg_has_role(l.oid, o.oid, 'SET'))
 ORDER BY 1, 2`;

export type Row = Record<string, unknown>;
export type PostureQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

const yes = (v: unknown) => v === true;

/** Rule 1 (pure). */
export function ownerLoginProblems(row: Row | undefined): string[] {
  if (!row) return ['the connecting login could not be read'];
  const p: string[] = [];
  if (row.login !== OWNER_LOGIN_ROLE) p.push(`the database login is "${String(row.login)}", expected "${OWNER_LOGIN_ROLE}"`);
  if (row.who !== row.login) p.push(`the session acts as "${String(row.who)}" through SET ROLE; connect as "${OWNER_LOGIN_ROLE}" itself`);
  if (yes(row.super)) p.push(`"${String(row.login)}" is SUPERUSER`);
  if (yes(row.bypassrls)) p.push(`"${String(row.login)}" has BYPASSRLS`);
  if (yes(row.replication)) p.push(`"${String(row.login)}" has REPLICATION`);
  if (yes(row.createdb)) p.push(`"${String(row.login)}" has CREATEDB`);
  return p;
}

/** Rule 2 (pure). The login's own row is judged by rule 1, every other reached role here. */
export function ownerLoginReachabilityProblems(rows: Row[]): string[] {
  const p: string[] = [];
  for (const r of rows) {
    if (yes(r.is_login)) continue;
    const name = String(r.role);
    const via = `reachable from ${OWNER_LOGIN_ROLE} (${String(r.path)})`;
    const attrs = [yes(r.super) && 'SUPERUSER', yes(r.bypassrls) && 'BYPASSRLS', yes(r.createdb) && 'CREATEDB', yes(r.replication) && 'REPLICATION'].filter(Boolean);
    if (attrs.length) p.push(`role "${name}" has ${attrs.join('/')} and is ${via}`);
    if (DANGEROUS_PREDEFINED_ROLES.includes(name)) p.push(`predefined role "${name}" is ${via}`);
    if (PROVIDER_ADMIN_ROLES.includes(name)) p.push(`provider administrator role "${name}" is ${via}`);
  }
  return p;
}

const shape = (m: Row) => `admin=${yes(m.admin)} inherit=${yes(m.inherit)} set=${yes(m.set)}`;
const adminOnly = (m: Row) => yes(m.admin) && !yes(m.inherit) && !yes(m.set);

/** Rule 3 (pure). */
export function ownerLoginInventoryProblems(memberships: Row[], layoutRoles: Row[], foreignLogins: Row[]): string[] {
  const p: string[] = [];
  const login = OWNER_LOGIN_ROLE;

  for (const role of LAYOUT_SCHEMA_ROLES) {
    const r = layoutRoles.find((x) => x.role === role);
    if (!r) {
      p.push(`layout role "${role}" does not exist`);
      continue;
    }
    if (yes(r.super) || yes(r.bypassrls) || yes(r.createrole) || yes(r.createdb) || yes(r.replication)) {
      p.push(`layout role "${role}" has SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION`);
    }
    if (NOLOGIN_SCHEMA_ROLES.includes(role) && yes(r.canlogin)) p.push(`owner role "${role}" is LOGIN (must stay NOLOGIN)`);
  }

  for (const m of memberships) {
    const role = String(m.role);
    const member = String(m.member);
    if (member === login) {
      if (role === login) continue; // cannot happen in PG16 (no self-membership); listed for completeness
      if (!['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app'].includes(role)) {
        p.push(`${login} is a member of "${role}" (${shape(m)}${yes(m.role_login) ? ', a LOGIN role it administers' : ''}): not in the owner-login layout`);
      } else if (role === 'crewflow_app' && !adminOnly(m)) {
        p.push(`${login} is a member of crewflow_app with ${shape(m)}: only the implicit ADMIN-only creator row is expected`);
      }
      continue;
    }
    if (role === login) {
      if (!adminOnly(m)) p.push(`"${member}" can act as ${login} (${shape(m)}): only ADMIN-only creator rows are expected`);
      continue;
    }
    if (OWNER_SCHEMA_ROLES.includes(role)) {
      p.push(`"${member}" is a member of owner role "${role}" (${shape(m)}): only ${login} may be`);
    } else if (role === 'crewflow_app') {
      const worker = member === 'crewflow_worker' && !yes(m.admin) && yes(m.inherit) && !yes(m.set);
      if (!worker) p.push(`"${member}" is a member of crewflow_app (${shape(m)}): only crewflow_worker (inherit, no set, no admin) is expected`);
    } else if (role === 'crewflow_worker') {
      p.push(`"${member}" is a member of crewflow_worker (${shape(m)}): it must have zero members`);
    }
  }

  for (const f of foreignLogins) p.push(`unexpected LOGIN role "${String(f.login)}" can act as "${String(f.reaches)}"`);
  return p;
}

/** Rules 1–3 over one connection. Run AFTER the version gate (PG16 pg_auth_members columns). Empty = the posture holds. */
export async function ownerLoginRolePostureProblems(query: PostureQuery): Promise<string[]> {
  const [login] = await query(OWNER_LOGIN_FACTS_SQL);
  return [
    ...ownerLoginProblems(login),
    ...ownerLoginReachabilityProblems(await query(OWNER_LOGIN_REACHABILITY_SQL)),
    ...ownerLoginInventoryProblems(await query(OWNER_LOGIN_MEMBERSHIPS_SQL), await query(LAYOUT_SCHEMA_ROLES_SQL), await query(OWNER_LOGIN_FOREIGN_LOGINS_SQL)),
  ];
}

// --------------------------------------------------------------------------------------------- rule 4: objects

const FORCED_NON_TENANT = ['deployment_identity', 'deployment_identity_history'];
const WORKSPACE_RE = '^workspace_[0-9a-f]{32}$';

/** One `kind|object|detail` row per problem. $1 = the tables that must be FORCE besides every tenant table. */
export const OWNER_LOGIN_OBJECT_POSTURE_SQL = `
WITH must_force AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p')
     AND (c.relname = ANY ($1::text[])
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organisation_id' AND a.attnum > 0 AND NOT a.attisdropped))
),
ext_member AS (
  SELECT d.objid FROM pg_catalog.pg_depend d WHERE d.deptype = 'e'
)
SELECT kind || '|' || object || '|' || detail AS line FROM (
  SELECT 'not-forced' AS kind, 'core.' || f.relname AS object, 'enable=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity AS detail
    FROM must_force f JOIN pg_catalog.pg_class c ON c.oid = f.oid WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  SELECT 'missing-table', 'core.' || t.name, 'expected to exist and be FORCE'
    FROM pg_catalog.unnest($1::text[]) AS t(name) WHERE pg_catalog.to_regclass('core.' || pg_catalog.quote_ident(t.name)) IS NULL
  UNION ALL
  SELECT 'core-schema-owner', 'core', pg_catalog.pg_get_userbyid(n.nspowner)::text
    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core' AND pg_catalog.pg_get_userbyid(n.nspowner) <> 'rab_secure_owner'
  UNION ALL
  SELECT 'core-relation-owner', 'core.' || c.relname, pg_catalog.pg_get_userbyid(c.relowner)::text
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND pg_catalog.pg_get_userbyid(c.relowner) NOT IN ('rab_secure_owner', 'crewflow')
  UNION ALL
  SELECT 'core-function-owner', 'core.' || p.proname || '/' || p.pronargs, pg_catalog.pg_get_userbyid(p.proowner)::text
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'core'::regnamespace AND p.oid NOT IN (SELECT objid FROM ext_member)
     AND pg_catalog.pg_get_userbyid(p.proowner) NOT IN ('rab_secure_owner', 'crewflow')
  UNION ALL
  SELECT 'workspace-schema-owner', n.nspname, pg_catalog.pg_get_userbyid(n.nspowner)::text
    FROM pg_catalog.pg_namespace n WHERE n.nspname ~ '${WORKSPACE_RE}' AND pg_catalog.pg_get_userbyid(n.nspowner) <> 'rab_secure_owner'
  UNION ALL
  SELECT 'workspace-table-owner', n.nspname || '.' || c.relname, pg_catalog.pg_get_userbyid(c.relowner)::text
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname ~ '${WORKSPACE_RE}' AND c.relkind IN ('r', 'p') AND pg_catalog.pg_get_userbyid(c.relowner) <> 'crewflow'
  UNION ALL
  SELECT 'unexpected-schema', n.nspname, pg_catalog.pg_get_userbyid(n.nspowner)::text
    FROM pg_catalog.pg_namespace n
   WHERE pg_catalog.pg_get_userbyid(n.nspowner) IN (${sqlList(LAYOUT_AND_LOGIN)})
     AND n.nspname NOT IN ('core', 'public') AND n.nspname !~ '${WORKSPACE_RE}' AND n.nspname !~ '^pg_'
  UNION ALL
  SELECT 'public-object', 'public.' || c.relname, pg_catalog.pg_get_userbyid(c.relowner)::text
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.oid NOT IN (SELECT objid FROM ext_member)
     AND pg_catalog.pg_get_userbyid(c.relowner) IN (${sqlList(LAYOUT_AND_LOGIN)})
  UNION ALL
  SELECT 'public-function', 'public.' || p.proname || '/' || p.pronargs, pg_catalog.pg_get_userbyid(p.proowner)::text
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid NOT IN (SELECT objid FROM ext_member)
     AND pg_catalog.pg_get_userbyid(p.proowner) IN (${sqlList(LAYOUT_AND_LOGIN)})
) problems
ORDER BY 1`;

/** M-T1: each pre-auth table carries exactly its owner-only definer policy (name, PERMISSIVE, ALL, TO rab_secure_owner). */
export const PREAUTH_DEFINER_POLICY_SQL = `
SELECT t.name AS tbl, p.polname::text AS policy, p.polpermissive AS permissive, p.polcmd::text AS cmd,
       (SELECT pg_catalog.array_agg(pg_catalog.pg_get_userbyid(x) ORDER BY 1) FROM pg_catalog.unnest(p.polroles) x)::text[] AS roles,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
  FROM pg_catalog.unnest($1::text[]) AS t(name)
  LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = pg_catalog.to_regclass('core.' || pg_catalog.quote_ident(t.name))
       AND p.polname = t.name || '_secure_owner_definer'
 ORDER BY 1`;

export function preauthDefinerPolicyProblems(rows: Row[]): string[] {
  const p: string[] = [];
  for (const table of PREAUTH_FORCE_TABLES) {
    const r = rows.find((x) => x.tbl === table);
    const name = preauthDefinerPolicyName(table);
    if (!r || r.policy === null || r.policy === undefined) {
      p.push(`core.${table}: owner-only definer policy ${name} is missing`);
      continue;
    }
    const roles = Array.isArray(r.roles) ? (r.roles as string[]) : [];
    if (r.permissive !== true || r.cmd !== '*' || roles.join(',') !== 'rab_secure_owner' || r.qual !== PREAUTH_DEFINER_EXPRESSION || r.with_check !== PREAUTH_DEFINER_EXPRESSION) {
      p.push(
        `core.${table}: policy ${name} drifted (permissive=${String(r.permissive)} cmd=${String(r.cmd)} roles=${roles.join(',')} ` +
          `using=${String(r.qual)} check=${String(r.with_check)}); expected PERMISSIVE ALL TO rab_secure_owner USING/WITH CHECK ${PREAUTH_DEFINER_EXPRESSION}`,
      );
    }
  }
  return p;
}

/** Rule 4 over one connection (after the schema-compatibility gate: M-T1 must be applied). Empty = holds. */
export async function ownerLoginObjectPostureProblems(query: PostureQuery): Promise<string[]> {
  const mustForce = [...PREAUTH_FORCE_TABLES, ...FORCED_NON_TENANT];
  const objects = (await query(OWNER_LOGIN_OBJECT_POSTURE_SQL, [mustForce])).map((r) => String(r.line));
  return [...objects, ...preauthDefinerPolicyProblems(await query(PREAUTH_DEFINER_POLICY_SQL, [[...PREAUTH_FORCE_TABLES]]))];
}
