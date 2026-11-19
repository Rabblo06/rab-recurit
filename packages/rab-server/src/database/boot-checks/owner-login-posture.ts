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
 *                    CREATEROLE is accepted HERE (the bootstrap creates the role layout); since owner decision 2026-11-18
 *                    db-setup removes it once the schema is complete, and the boot gate refuses it in production unless
 *                    the role carries OWNER_CREATEROLE_PENDING_COMMENT (database-boot-gate-rules.ts assertCreateRoleGate).
 *  2. reachability — a walk over pg_auth_members from the login with MEMBER semantics: every edge counts, whatever its
 *                    INHERIT / SET / ADMIN options (an ADMIN-only edge lets the login grant itself SET later: G-12), direct
 *                    and indirect. Cross-checked with pg_has_role(…, 'MEMBER') over every role (catches implicit
 *                    memberships the walk cannot see). No reached role may be SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE
 *                    or REPLICATION, a dangerous predefined role (data, server files, program execution, backend signals,
 *                    subscriptions, maintain) or a known provider administrator role. CREATEROLE on a REACHED role is
 *                    refused since owner decision 2026-11-19 (a member that can SET ROLE to it, or grant itself that,
 *                    administers roles); the login's OWN CREATEROLE keeps its mark rule (assertCreateRoleGate).
 *                    Ownership of the current database (directly, through a role, or as pg_database_owner) is refused
 *                    in production by the boot gate (database-boot-gate-rules.ts assertDatabaseOwnershipGate), not here:
 *                    development and test databases are owned by rab_owner (postgres-init/01-roles.sql).
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

import { DANGEROUS_PREDEFINED_ROLES, PROVIDER_ADMIN_ROLES } from '../owner-login/privileged-roles';
import { PREAUTH_DEFINER_EXPRESSION, PREAUTH_FORCE_TABLES, preauthDefinerPolicyName } from '../typeorm/core/preauth-force-sql';

export const OWNER_LOGIN_ROLE = 'crewflow_owner';

/**
 * CREATEROLE after the schema bootstrap (owner decisions 2026-11-18, incl. M1 "auto-close plus a grace period"):
 * crewflow_owner needs CREATEROLE only for the first start (the migrate child creates the schema roles). An ADMIN marks the
 * role with the COMMENT `crewflow:createrole-until-schema-current:<unix expiry>` (db-setup, or by hand in mode c), the
 * expiry computed by the SERVER as now + OWNER_CREATEROLE_GRACE_SECONDS. COMMENT ON ROLE needs superuser, or CREATEROLE + ADMIN
 * OPTION on the role: crewflow_owner can neither set, clear nor extend it on itself (proved live, harness L4). db-harden (modes
 * a and b) removes CREATEROLE and the mark as soon as the schema is complete; in mode c the operator does. The boot gate
 * (database-boot-gate-rules.ts assertCreateRoleGate) refuses, in production, a CREATEROLE crewflow_owner WITHOUT a valid mark
 * (one never meant to keep it, or re-granted after the NOCREATEROLE step) and one whose mark has EXPIRED (by the server clock);
 * an unexpired mark is a warning. Fixed text, no quote character (interpolated into SQL text).
 */
export const OWNER_CREATEROLE_MARK_PREFIX = 'crewflow:createrole-until-schema-current:';
/** The grace period an admin's mark grants (24 h, owner decision M1). */
export const OWNER_CREATEROLE_GRACE_SECONDS = 86400;
/** A valid mark, as a POSIX regular expression for SQL (no quote character): the prefix and a 1-12 digit unix expiry. */
export const OWNER_CREATEROLE_MARK_SQL_RE = '^crewflow:createrole-until-schema-current:[0-9]{1,12}$';

/**
 * Re-review R2: an expiry further ahead than the grace period plus this slack (an admin's hand-written mark, a clock step)
 * is not a grace period: it counts as EXPIRED, so a mark cannot be made to last for weeks.
 */
export const OWNER_CREATEROLE_MARK_SLACK_SECONDS = 300;

/**
 * Two SQL column expressions over a role's COMMENT expression (`comment` is SQL text such as
 * `pg_catalog.shobj_description(o.oid, 'pg_authid')`, a code constant): is it a valid mark, and is it EXPIRED by the server
 * clock (its expiry has passed, OR it lies more than OWNER_CREATEROLE_GRACE_SECONDS + OWNER_CREATEROLE_MARK_SLACK_SECONDS in
 * the future: re-review R2). Both are never NULL. The expiry is parsed only when the mark matches, so a foreign comment never
 * fails the cast.
 */
export function createRoleMarkColumnsSql(comment: string, pendingAlias: string, expiredAlias: string): string {
  const expiry = `pg_catalog.split_part(${comment}, ':', 3)::bigint`;
  const now = `pg_catalog.date_part('epoch', pg_catalog.now())::bigint`;
  return (
    `COALESCE(${comment} OPERATOR(pg_catalog.~) '${OWNER_CREATEROLE_MARK_SQL_RE}', false) AS ${pendingAlias},\n` +
    `       COALESCE(CASE WHEN ${comment} OPERATOR(pg_catalog.~) '${OWNER_CREATEROLE_MARK_SQL_RE}'\n` +
    `                     THEN ${expiry} <= ${now} OR ${expiry} > ${now} + ${OWNER_CREATEROLE_GRACE_SECONDS + OWNER_CREATEROLE_MARK_SLACK_SECONDS} END,\n` +
    `                false) AS ${expiredAlias}`
  );
}

/**
 * Re-review R3: the session login's CREATEROLE and its mark, for the periodic posture monitor (a long-running API / Worker
 * must not keep running silently on a CREATEROLE whose grace period has expired). Read-only.
 */
// sql-injection-reviewed: the only interpolation is createRoleMarkColumnsSql over a fixed column expression and quote-free code constants.
export const OWNER_LOGIN_CREATEROLE_MARK_SQL = `
SELECT r.rolcreaterole AS createrole,
       ${createRoleMarkColumnsSql("pg_catalog.shobj_description(r.oid, 'pg_authid')", 'mark_pending', 'mark_expired')}
  FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`;

/** Re-review R3 (pure): a problem line when the login has CREATEROLE and its mark has expired; otherwise none. */
export function ownerLoginCreateRoleExpiryProblems(row: Row | undefined): string[] {
  if (!row || row.createrole !== true || row.mark_expired !== true) return [];
  return [
    `${OWNER_LOGIN_ROLE} still has CREATEROLE and its grace period (the admin's mark) has expired: as the admin run ALTER ROLE ${OWNER_LOGIN_ROLE} NOCREATEROLE; COMMENT ON ROLE ${OWNER_LOGIN_ROLE} IS NULL;`,
  ];
}

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
 * The roles refused by name (predefined and managed-provider administrator roles) live in ONE shared module,
 * owner-login/privileged-roles.ts, which db-setup uses too. Re-exported here for the existing importers.
 */
export { DANGEROUS_PREDEFINED_ROLES, PROVIDER_ADMIN_ROLES } from '../owner-login/privileged-roles';

const sqlList = (names: readonly string[]) => names.map((n) => `'${n}'`).join(', ');
const LAYOUT_AND_LOGIN = [OWNER_LOGIN_ROLE, ...LAYOUT_SCHEMA_ROLES];

/**
 * Owner decision 2026-11-19: the login must not own the CURRENT database, neither directly (datdba), nor through a role it
 * is a member of (pg_has_role MEMBER: any membership, whatever its INHERIT / SET / ADMIN options), nor as a member of
 * pg_database_owner (which PostgreSQL grants implicitly to exactly the database owner's members). A database owner can
 * ALTER DATABASE (SET search_path / session settings for every role), grant CONNECT / CREATE / TEMPORARY to anyone and drop
 * the database. Three read-only columns, NULL-free (COALESCE false only where the row legitimately cannot exist).
 * Shared by rule 1 (OWNER_LOGIN_FACTS_SQL, the posture monitor too) and the boot gate (BOOT_FACTS_SQL).
 */
export const DATABASE_OWNERSHIP_COLUMNS_SQL = `(SELECT d.datdba OPERATOR(pg_catalog.=) s.oid FROM pg_catalog.pg_database d, pg_catalog.pg_roles s
         WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database() AND s.rolname OPERATOR(pg_catalog.=) session_user) AS owns_database,
       (SELECT pg_catalog.pg_has_role(session_user, d.datdba, 'MEMBER') FROM pg_catalog.pg_database d
         WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) AS member_of_database_owner,
       COALESCE((SELECT pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER') FROM pg_catalog.pg_roles o
                  WHERE o.rolname OPERATOR(pg_catalog.=) 'pg_database_owner'), false) AS database_owner_role,
       (SELECT pg_catalog.pg_get_userbyid(d.datdba)::text FROM pg_catalog.pg_database d
         WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) AS database_owner`;

/**
 * Pure: the problems the ownership columns describe. Fail closed: a column that is not exactly false (NULL, missing) counts
 * as ownership, so a row this rule cannot read is refused rather than passed.
 */
export function ownerLoginDatabaseOwnershipProblems(row: Row | undefined): string[] {
  if (!row) return ['the database ownership of the connecting login could not be read'];
  const login = String(row.login ?? OWNER_LOGIN_ROLE);
  const owner = row.database_owner === null || row.database_owner === undefined ? '(unknown)' : `"${String(row.database_owner)}"`;
  const p: string[] = [];
  if (row.owns_database !== false) p.push(`"${login}" owns the current database`);
  else if (row.member_of_database_owner !== false) p.push(`"${login}" is a member of ${owner}, the owner of the current database`);
  if (row.database_owner_role !== false) p.push(`"${login}" is a member of pg_database_owner (it owns the current database, directly or through a role)`);
  if (p.length) p.push(`the database must be owned by your admin, never by the app login: as the admin run ALTER DATABASE <database> OWNER TO <admin>`);
  return p;
}

/** Rule 1: the login itself. */
export const OWNER_LOGIN_FACTS_SQL = `
SELECT current_user::text AS who, session_user::text AS login,
       r.rolsuper AS super, r.rolbypassrls AS bypassrls, r.rolreplication AS replication, r.rolcreatedb AS createdb,
       r.rolcreaterole AS createrole, r.rolcanlogin AS canlogin, r.rolinherit AS inherit,
       ${DATABASE_OWNERSHIP_COLUMNS_SQL}
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
       r.rolcreaterole AS createrole, r.rolreplication AS replication, r.rolcanlogin AS canlogin, (r.rolname = session_user) AS is_login
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

export interface OwnerLoginPostureOptions {
  /**
   * Refuse ownership of the current database (ownerLoginDatabaseOwnershipProblems). True in production; development and
   * test databases are owned by rab_owner (postgres-init/01-roles.sql), which the owner login is a member of.
   */
  refuseDatabaseOwnership?: boolean;
}

/** Rule 1 (pure). */
export function ownerLoginProblems(row: Row | undefined, options: OwnerLoginPostureOptions = {}): string[] {
  if (!row) return ['the connecting login could not be read'];
  const p: string[] = [];
  if (row.login !== OWNER_LOGIN_ROLE) p.push(`the database login is "${String(row.login)}", expected "${OWNER_LOGIN_ROLE}"`);
  if (row.who !== row.login) p.push(`the session acts as "${String(row.who)}" through SET ROLE; connect as "${OWNER_LOGIN_ROLE}" itself`);
  if (yes(row.super)) p.push(`"${String(row.login)}" is SUPERUSER`);
  if (yes(row.bypassrls)) p.push(`"${String(row.login)}" has BYPASSRLS`);
  if (yes(row.replication)) p.push(`"${String(row.login)}" has REPLICATION`);
  if (yes(row.createdb)) p.push(`"${String(row.login)}" has CREATEDB`);
  if (options.refuseDatabaseOwnership) p.push(...ownerLoginDatabaseOwnershipProblems(row));
  return p;
}

/**
 * Security review L-2 (PR #257): the roles the owner login may reach, CLOSED WORLD. Anything else reached (any edge, any
 * depth) is refused by name, whatever its attributes: a deny-list cannot know every provider's administrator role.
 * pg_database_owner is reached implicitly by the database owner's members; it is allowed only when database ownership is
 * not refused (outside production: dev and test databases are owned by rab_owner, postgres-init/01-roles.sql).
 */
export const OWNER_LOGIN_REACHABLE_ROLES: readonly string[] = Object.freeze(['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app']);

/**
 * Rule 2 (pure). The login's own row is judged by rule 1, every other reached role here. Fail closed (review I-3): the walk
 * starts AT the login, so a result without the login's own row is refused, never read as "reaches nothing".
 */
export function ownerLoginReachabilityProblems(rows: Row[], options: OwnerLoginPostureOptions = {}): string[] {
  const p: string[] = [];
  if (!rows.some((r) => yes(r.is_login))) p.push(`the role walk from ${OWNER_LOGIN_ROLE} returned no row for the login itself; the reachable roles could not be read`);
  for (const r of rows) {
    if (yes(r.is_login)) continue;
    const name = String(r.role);
    const via = `reachable from ${OWNER_LOGIN_ROLE} (${String(r.path)})`;
    const expected = OWNER_LOGIN_REACHABLE_ROLES.includes(name) || (name === 'pg_database_owner' && !options.refuseDatabaseOwnership);
    const named = DANGEROUS_PREDEFINED_ROLES.includes(name) || PROVIDER_ADMIN_ROLES.includes(name);
    if (!expected && !named) {
      p.push(`role "${name}" is ${via}; only ${OWNER_LOGIN_REACHABLE_ROLES.join(', ')} may be. Revoke it (REVOKE "${name}" FROM <the member on the path>, as its administrator)`);
    }
    const attrs = [
      yes(r.super) && 'SUPERUSER',
      yes(r.bypassrls) && 'BYPASSRLS',
      yes(r.createdb) && 'CREATEDB',
      yes(r.createrole) && 'CREATEROLE',
      yes(r.replication) && 'REPLICATION',
    ].filter(Boolean);
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
export async function ownerLoginRolePostureProblems(query: PostureQuery, options: OwnerLoginPostureOptions = {}): Promise<string[]> {
  const [login] = await query(OWNER_LOGIN_FACTS_SQL);
  return [
    ...ownerLoginProblems(login, options),
    ...ownerLoginReachabilityProblems(await query(OWNER_LOGIN_REACHABILITY_SQL), options),
    ...ownerLoginInventoryProblems(await query(OWNER_LOGIN_MEMBERSHIPS_SQL), await query(LAYOUT_SCHEMA_ROLES_SQL), await query(OWNER_LOGIN_FOREIGN_LOGINS_SQL)),
  ];
}

// --------------------------------------------------------------------------------------------- rule 4: objects

const FORCED_NON_TENANT = ['deployment_identity', 'deployment_identity_history', 'upgrade_migration'];
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
