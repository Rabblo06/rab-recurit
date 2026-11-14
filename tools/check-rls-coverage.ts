/**
 * CI gate (rab-workforce-architecture.md §5.7, §5.6): every table in schema
 * `core` with an `organisation_id` column must have Row-Level Security
 * enabled AND forced, and no schema role may have BYPASSRLS. Run with
 * PG_DATABASE_URL = the owner login crewflow_owner (the one runtime login).
 *
 * Owner-login architecture (2026-11-04): the runtime login now OWNS the tables
 * (through rab_secure_owner / crewflow), so RLS binds it only where FORCE is
 * set. That is why every tenant table AND (since M-T1) every pre-auth table must
 * be FORCE, and why this gate also proves the login's role / object posture.
 */
import {
  OWNER_LOGIN_ROLE,
  ownerLoginObjectPostureProblems,
  ownerLoginRolePostureProblems,
  PREAUTH_DEFINER_POLICY_SQL,
  preauthDefinerPolicyProblems,
} from '../packages/rab-server/src/database/boot-checks/owner-login-posture';
import { createPgClient, resolvePgEnvironment } from '../packages/rab-server/src/database/postgres';
import { PREAUTH_FORCE_TABLES } from '../packages/rab-server/src/database/typeorm/core/preauth-force-sql';
import { dispatchTriggerProblems } from '../packages/rab-server/src/database/typeorm/core/worker-dispatch-pointer-sql';
import { dispatchNotifySettingProblems } from '../packages/rab-server/src/database/typeorm/core/security-posture';
import type { Client } from 'pg';

// P2/P3 Checkpoint 2 (restricted runtime role): the application login is now `crewflow_app`, a
// separate, ownerless role — `crewflow` (the P1C.2 single-credential identity) is demoted to
// migration/bootstrap authority and now owns the tables this check protects, so checking ITS
// rolbypassrls would no longer prove what this check needs: that the connection actually serving
// requests has no owner-level bypass. `rab_app` (pre-P1C.2) remains retired, NOLOGIN, zero grants.
const APP_ROLE = process.env.RAB_APP_ROLE ?? 'crewflow_app';

/**
 * Tables deliberately not FORCEd. EMPTY since M-T1 (PreAuthTablesForceOwnerOnly1786721400000, Twenty Mode Option A,
 * owner-approved 2026-11-04). Every table with an organisation_id must now be ENABLE + FORCE.
 *
 * History (kept so the reasoning is not lost): until M-T1 this held the 14 pre-auth tables whose SECURITY DEFINER lookups
 * run as the table owner rab_secure_owner before any tenant context exists — user, login_history, refresh_token,
 * password_reset_token, manager_workspace, worker_due_work, account_invite, user_session, user_auth_identity,
 * member_invitation, email_change_request, released_host_label, login_handoff, organisation_invitation — each with a
 * SECURITY TRADE-OFF note at its migration; `organisation` and `platform_admin` (no organisation_id) were the same class,
 * checked separately. FORCE would have bound the owner inside those definers and hidden the rows. M-T1 FORCEs all 16 and
 * adds ONE owner-only PERMISSIVE policy per table (TO rab_secure_owner USING / WITH CHECK CURRENT_USER =
 * 'rab_secure_owner'), so a definer still sees every row while a session that merely INHERITS the owner (Twenty mode's
 * crewflow_owner; the separated migration identity acting as itself) is bound by the tenant policies like everyone else.
 * The authoritative list is PREAUTH_FORCE_TABLES (preauth-force-sql.ts); this set must stay empty unless a reviewed
 * migration re-introduces an exemption with its own SECURITY TRADE-OFF note.
 */
const NOT_FORCED_ALLOWLIST = new Set<string>([]);

/**
 * M-T1: the 16 pre-auth tables (14 with organisation_id + `organisation` and `platform_admin`, which have none and so are
 * invisible to the per-table scan below). Each must be ENABLE + FORCE AND carry its exact owner-only definer policy
 * (`<table>_secure_owner_definer`, PERMISSIVE, FOR ALL, TO rab_secure_owner, USING / WITH CHECK
 * (CURRENT_USER = 'rab_secure_owner'::name)). A drift back to NOT FORCE (the `organisation` incident class, in the other
 * direction now), a dropped or rewritten definer policy, or a missing table fails this gate.
 */
const PREAUTH_FORCED_TABLES = new Set<string>(PREAUTH_FORCE_TABLES);

/**
 * Phase B / B3 (DeploymentIdentity1786721230000): tables with NO `organisation_id` (not tenant data — the deployment
 * identity marker and its insert-only history) that must nevertheless be ENABLE + FORCE. Invisible to the per-table scan
 * above (it only finds tables with organisation_id), so asserted explicitly: a missing table, RLS disabled or FORCE dropped
 * fails this gate. FORCE matters here because the owner rab_secure_owner is reached by SET ROLE from its members; with
 * FORCE the owner-only policies (CURRENT_USER = rab_secure_owner) still apply to it, and the runtime logins are denied by a
 * RESTRICTIVE policy on top of holding no privilege. They are never on NOT_FORCED_ALLOWLIST: no pre-auth lookup reads them.
 */
const FORCED_NON_TENANT_TABLES = ['deployment_identity', 'deployment_identity_history', 'upgrade_migration'] as const;

/**
 * F4 (Wave 1 lane S): every physical workspace schema (`^workspace_[0-9a-f]{32}$`, Hyper Workspace V1) is checked too —
 * before this, the gate only looked at `core`, so a workspace-schema migration that forgot FORCE or a policy passed CI and
 * became exploitable the moment `HWS_RUNTIME_ENABLED` was on. Workspace tables have NO pre-auth exemption: every one must
 * be ENABLE + FORCE. The full exact model (every policy text, FK action, grant line) is the posture golden snapshot's job
 * (security-posture.ts `ws|` lines); this gate enforces the invariants that must hold whatever the template version:
 *  - schema owned by rab_secure_owner; schema ACL only rab_secure_owner / crewflow / crewflow_app; no PUBLIC; the runtime
 *    role has USAGE only (never CREATE);
 *  - only tables and their indexes in the schema (no view, sequence, foreign table or function — a view would bypass RLS);
 *  - every table: ENABLE + FORCE, owned by crewflow, at least one policy, every policy with USING where the command reads
 *    rows and WITH CHECK where it writes them;
 *  - every table's grants (table AND column ACLs, any grantee) identical to its `core` counterpart's — an extra grant on
 *    one workspace, or a workspace table with no core counterpart, fails;
 *  - with no tenant context bound, the runtime role reads zero rows from every workspace table (fail closed).
 */
const WORKSPACE_SCHEMA_PATTERN = '^workspace_[0-9a-f]{32}$';

/**
 * Phase D (WorkerDispatchPointer1786721300000, owner-approved 2026-11-01): the Worker's own login. Checked whenever the role exists,
 * and REQUIRED once core.worker_dispatch_pointer exists (the migration refuses to run without it):
 *  - its shape: LOGIN, no SUPERUSER / BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION, a member of exactly crewflow_app
 *    (WITH INHERIT TRUE, SET FALSE, no ADMIN), no member of its own (a member — the API login above all — would inherit
 *    the Worker-only claim grants), owns nothing;
 *  - the pointer table: no table privilege for crewflow / crewflow_app / crewflow_worker, and the connected runtime role's
 *    own read of it is refused (fail closed: permission denied, never rows);
 *  - the claim / release functions: EXECUTE crewflow_worker only.
 */
const WORKER_ROLE = 'crewflow_worker';

/**
 * Owner-login architecture (owner's final decision 2026-11-04, PERMANENT): the one runtime login is crewflow_owner, which
 * INHERITS the owner roles by design. Updated in place: the connection must BE crewflow_owner and its role / object
 * posture must be the reviewed owner-login layout (owner-login-posture.ts, the boot gate's own functions); the
 * pointer-table probe now expects zero rows (the RESTRICTIVE deny policy TO crewflow applies to crewflow_owner through its
 * crewflow membership) instead of a permission error (catalogue BC-10). APP_ROLE (crewflow_app) remains the SCHEMA role
 * whose grants and BYPASSRLS attribute are still checked: definers and historical grants reference it.
 */
const CONNECT_ROLE = OWNER_LOGIN_ROLE;
const WORKER_CALLABLE = [
  'core.worker_claim_email_dispatch(integer)',
  'core.worker_claim_push_dispatch(integer)',
  'core.worker_claim_realtime_publish(integer)',
  'core.worker_claim_statement_dispatch(integer)',
  'core.worker_release_dispatch_claim(text, uuid, uuid, integer)',
] as const;

/**
 * Phase D, review finding E-5: the pointer triggers are what keeps global dispatch complete (present, ENABLED, reviewed
 * function on every source table). The check itself lives in worker-dispatch-pointer-sql.ts (dispatchTriggerProblems) so
 * the integration suite can run the SAME code inside a rolled-back transaction (a DISABLEd / dropped / re-pointed trigger).
 */
async function checkDispatchTriggers(client: Client): Promise<string[]> {
  return dispatchTriggerProblems(async (sql, params) => (await client.query(sql, params as unknown[] | undefined)).rows);
}

async function checkWorkerRole(client: Client): Promise<string[]> {
  const problems: string[] = [];
  const { rows: roleRows } = await client.query<{
    super: boolean; bypassrls: boolean; createrole: boolean; createdb: boolean; replication: boolean; login: boolean;
    member_of: string | null; members: number; owns: number;
  }>(
    `SELECT r.rolsuper AS super, r.rolbypassrls AS bypassrls, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
            r.rolreplication AS replication, r.rolcanlogin AS login,
            (SELECT string_agg(pg_get_userbyid(m.roleid) || ':inherit=' || m.inherit_option || ':set=' || m.set_option || ':admin=' || m.admin_option, ',' ORDER BY pg_get_userbyid(m.roleid))
               FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS members,
            (SELECT count(*)::int FROM pg_shdepend d WHERE d.refobjid = r.oid AND d.deptype = 'o') AS owns
       FROM pg_roles r WHERE r.rolname = $1`,
    [WORKER_ROLE],
  );
  const { rows: tableRows } = await client.query<{ present: boolean }>(`SELECT to_regclass('core.worker_dispatch_pointer') IS NOT NULL AS present`);
  const pointerTable = Boolean(tableRows[0]?.present);
  const role = roleRows[0];
  if (!role) {
    if (pointerTable) problems.push(`role ${WORKER_ROLE} does not exist, but core.worker_dispatch_pointer does`);
    return problems;
  }
  if (!role.login || role.super || role.bypassrls || role.createrole || role.createdb || role.replication) {
    problems.push(`${WORKER_ROLE} must be LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION (${JSON.stringify(role)})`);
  }
  if (role.member_of !== 'crewflow_app:inherit=true:set=false:admin=false') {
    problems.push(`${WORKER_ROLE} must be a member of exactly crewflow_app WITH INHERIT TRUE, SET FALSE (found ${role.member_of ?? 'none'})`);
  }
  if (role.members !== 0) problems.push(`${role.members} role(s) are members of ${WORKER_ROLE}: they would inherit the Worker-only claim grants`);
  if (role.owns !== 0) problems.push(`${WORKER_ROLE} owns ${role.owns} object(s); a runtime login owns nothing`);
  if (!pointerTable) return problems;

  const { rows: privRows } = await client.query<{ line: string }>(
    `SELECT r.rolname || ' ' || p.priv AS line
       FROM pg_roles r CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
      WHERE r.rolname IN ('crewflow', 'crewflow_app', $1) AND has_table_privilege(r.oid, 'core.worker_dispatch_pointer', p.priv)`,
    [WORKER_ROLE],
  );
  for (const r of privRows) problems.push(`core.worker_dispatch_pointer: ${r.line} granted (no login may touch the pointer table directly)`);
  for (const fn of WORKER_CALLABLE) {
    const { rows } = await client.query<{ rolname: string; can: boolean }>(
      `SELECT r.rolname, has_function_privilege(r.oid, to_regprocedure($1), 'EXECUTE') AS can
         FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app', $2) AND to_regprocedure($1) IS NOT NULL`,
      [fn, WORKER_ROLE],
    );
    if (rows.length === 0) problems.push(`${fn} is missing`);
    for (const r of rows) {
      if (r.can !== (r.rolname === WORKER_ROLE)) problems.push(`${fn}: EXECUTE for ${r.rolname} is ${r.can}, expected ${r.rolname === WORKER_ROLE}`);
    }
  }
  problems.push(...(await checkDispatchTriggers(client)));
  // Fail closed for the connected runtime login on normal paths. Before the owner login a read was refused outright (no
  // privilege, 42501). crewflow_owner reaches the owner's privilege, so the read is no longer refused (catalogue BC-10,
  // PENDING OWNER APPROVAL); the RESTRICTIVE deny policy (TO crewflow, inherited) must still answer zero rows. A
  // `SET ROLE rab_secure_owner` (injection) reads every pointer: owner-accepted (final prompt section 2), not detectable here.
  await client.query('BEGIN READ ONLY');
  try {
    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer');
    if (rows[0]!.n !== 0) problems.push(`core.worker_dispatch_pointer: ${rows[0]!.n} row(s) visible to ${CONNECT_ROLE} (expected 0: restrictive deny)`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    problems.push(`core.worker_dispatch_pointer: probe failed with ${code ?? 'error'} as ${CONNECT_ROLE}, expected 0 rows`);
  } finally {
    await client.query('ROLLBACK');
  }
  return problems;
}
const WORKSPACE_SCHEMA_ACL_ROLES = new Set(['rab_secure_owner', 'crewflow', 'crewflow_app']);
const WORKSPACE_TABLE_OWNER = 'crewflow';
const WORKSPACE_SCHEMA_OWNER = 'rab_secure_owner';

interface WorkspaceCoverage {
  schemas: number;
  tables: number;
  problems: string[];
}

const GRANTS_VS_CORE_SQL = `
WITH w AS (SELECT $1::oid AS oid), k AS (SELECT to_regclass(format('core.%I', $2::text))::oid AS oid),
acl AS (
  SELECT src, array_agg(x ORDER BY x) AS items FROM (
    SELECT 'w' AS src, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type || ':' || a.is_grantable AS x
      FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = (SELECT oid FROM w)
    UNION ALL
    SELECT 'k', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type || ':' || a.is_grantable
      FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = (SELECT oid FROM k)
  ) s GROUP BY src
),
cols AS (
  SELECT src, array_agg(x ORDER BY x) AS items FROM (
    SELECT 'w' AS src, at.attname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type AS x
      FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE at.attrelid = (SELECT oid FROM w) AND at.attacl IS NOT NULL
    UNION ALL
    SELECT 'k', at.attname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type
      FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE at.attrelid = (SELECT oid FROM k) AND at.attacl IS NOT NULL
  ) s GROUP BY src
)
SELECT (SELECT oid FROM k) IS NOT NULL AS core_exists,
       coalesce((SELECT items FROM acl WHERE src = 'w'), ARRAY[]::text[]) AS ws_acl,
       coalesce((SELECT items FROM acl WHERE src = 'k'), ARRAY[]::text[]) AS core_acl,
       coalesce((SELECT items FROM cols WHERE src = 'w'), ARRAY[]::text[]) AS ws_cols,
       coalesce((SELECT items FROM cols WHERE src = 'k'), ARRAY[]::text[]) AS core_cols`;

async function checkWorkspaceSchemas(client: Client): Promise<WorkspaceCoverage> {
  const problems: string[] = [];
  const { rows: schemas } = await client.query<{ oid: number; nspname: string; owner: string }>(
    `SELECT oid, nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname ~ $1 ORDER BY nspname`,
    [WORKSPACE_SCHEMA_PATTERN],
  );
  let tables = 0;
  for (const ws of schemas) {
    const where = ws.nspname;
    if (ws.owner !== WORKSPACE_SCHEMA_OWNER) problems.push(`${where}: schema owned by "${ws.owner}", expected ${WORKSPACE_SCHEMA_OWNER}`);
    const { rows: schemaAcl } = await client.query<{ grantee: string; privilege_type: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee, a.privilege_type
         FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.oid = $1`,
      [ws.oid],
    );
    for (const a of schemaAcl) {
      if (!WORKSPACE_SCHEMA_ACL_ROLES.has(a.grantee)) problems.push(`${where}: schema grants ${a.privilege_type} to ${a.grantee}`);
      if (a.grantee === APP_ROLE && a.privilege_type !== 'USAGE') problems.push(`${where}: ${APP_ROLE} has ${a.privilege_type} on the schema (USAGE only)`);
    }
    const { rows: odd } = await client.query<{ what: string }>(
      `SELECT c.relkind::text || ' ' || c.relname AS what FROM pg_class c WHERE c.relnamespace = $1 AND c.relkind NOT IN ('r', 'i')
       UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = $1 ORDER BY 1`,
      [ws.oid],
    );
    for (const o of odd) problems.push(`${where}: unexpected object (${o.what}); a workspace schema holds only tables and their indexes`);

    const { rows: rels } = await client.query<{ oid: number; relname: string; owner: string; rls: boolean; force: boolean }>(
      `SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c WHERE c.relnamespace = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [ws.oid],
    );
    if (rels.length === 0) problems.push(`${where}: schema has no tables (an empty or partial workspace schema)`);
    for (const t of rels) {
      tables += 1;
      const name = `${where}.${t.relname}`;
      if (!t.rls || !t.force) problems.push(`${name}: rowsecurity=${t.rls} forceRowSecurity=${t.force}; needs ENABLE + FORCE ROW LEVEL SECURITY`);
      if (t.owner !== WORKSPACE_TABLE_OWNER) problems.push(`${name}: owned by "${t.owner}", expected ${WORKSPACE_TABLE_OWNER}`);
      const { rows: pols } = await client.query<{ policyname: string; cmd: string; has_using: boolean; has_check: boolean }>(
        `SELECT policyname, cmd, qual IS NOT NULL AS has_using, with_check IS NOT NULL AS has_check FROM pg_policies
          WHERE schemaname = $1 AND tablename = $2`,
        [where, t.relname],
      );
      if (pols.length === 0) problems.push(`${name}: no RLS policy`);
      for (const p of pols) {
        const needsUsing = p.cmd !== 'INSERT';
        const needsCheck = p.cmd === 'INSERT' || p.cmd === 'UPDATE' || p.cmd === 'ALL';
        if (needsUsing && !p.has_using) problems.push(`${name}: policy ${p.policyname} (${p.cmd}) has no USING`);
        if (needsCheck && !p.has_check) problems.push(`${name}: policy ${p.policyname} (${p.cmd}) has no WITH CHECK`);
      }
      // Grants: exactly what the core counterpart grants (table and column ACLs, any grantee).
      const { rows: grantRows } = await client.query<{ core_exists: boolean; ws_acl: string[]; core_acl: string[]; ws_cols: string[]; core_cols: string[] }>(
        GRANTS_VS_CORE_SQL,
        [t.oid, t.relname],
      );
      const g = grantRows[0]!;
      if (!g.core_exists) {
        problems.push(`${name}: no core.${t.relname} counterpart to verify its grants against`);
      } else {
        const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
        for (const x of minus(g.ws_acl, g.core_acl)) problems.push(`${name}: extra grant ${x} (not granted on core.${t.relname})`);
        for (const x of minus(g.core_acl, g.ws_acl)) problems.push(`${name}: missing grant ${x} (granted on core.${t.relname})`);
        for (const x of minus(g.ws_cols, g.core_cols)) problems.push(`${name}: extra column grant ${x}`);
        for (const x of minus(g.core_cols, g.ws_cols)) problems.push(`${name}: missing column grant ${x}`);
      }
    }

    // Fail closed: with no tenant context bound the runtime role reads zero rows from every table.
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(
        `SELECT set_config('rab.organisation_id', '', true), set_config('rab.workspace_id', '', true), set_config('rab.user_id', '', true), set_config('rab.role', '', true)`,
      );
      for (const t of rels) {
        await client.query('SAVEPOINT probe');
        try {
          const { rows: countRows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${where}"."${t.relname}"`);
          if (countRows[0]!.n !== 0) problems.push(`${where}.${t.relname}: ${countRows[0]!.n} row(s) visible with NO tenant context bound`);
        } catch (error) {
          problems.push(`${where}.${t.relname}: no-context probe failed (${(error as { code?: string }).code ?? 'error'})`);
          await client.query('ROLLBACK TO SAVEPOINT probe');
        }
      }
    } finally {
      await client.query('ROLLBACK');
    }
  }
  return { schemas: schemas.length, tables, problems };
}

interface UnprotectedTable {
  table: string;
  rowsecurity: boolean;
  forced: boolean;
}

interface DriftedExemptTable {
  table: string;
  rowsecurity: boolean;
  forced: boolean;
}

async function main(): Promise<void> {
  // Phase B: the connection factory (PG_DATABASE_URL; the deprecated DATABASE_URL outside production — CI still passes
  // DATABASE_URL="$TEST_DATABASE_URL"). Explicit TLS and target; a refused configuration names variables only.
  const client = createPgClient(resolvePgEnvironment(process.env, { processRole: 'cli' }), { purpose: 'check-rls' });
  await client.connect();

  try {
    // Waves 4+5 lane DB5 (finding DB5-1): read the catalog, NOT information_schema.columns. information_schema only lists
    // columns of tables the CONNECTED role holds some privilege on, so a tenant table the runtime role has no grant on at
    // all (e.g. core.user_mfa_recovery_code, core.login_handoff, core.released_host_label) was silently skipped — the gate
    // reported "all protected" without ever looking at it. pg_catalog is readable by every role and lists every table.
    const tenantTables = await client.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organisation_id' AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p')`,
    );

    const unprotected: UnprotectedTable[] = [];
    for (const row of tenantTables.rows) {
      const { rows } = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE oid = $1::regclass`,
        [`core."${row.table_name}"`],
      );
      const status = rows[0];
      const requiresForce = !NOT_FORCED_ALLOWLIST.has(row.table_name);
      const isProtected = Boolean(status?.relrowsecurity) && (!requiresForce || Boolean(status?.relforcerowsecurity));
      if (!isProtected) {
        unprotected.push({
          table: row.table_name,
          rowsecurity: Boolean(status?.relrowsecurity),
          forced: Boolean(status?.relforcerowsecurity),
        });
      }
    }

    const drifted: DriftedExemptTable[] = [];
    for (const table of PREAUTH_FORCED_TABLES) {
      const { rows } = await client.query<{ relrowsecurity: boolean | null; relforcerowsecurity: boolean | null }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM (SELECT 1) one LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass($1)`,
        [`core."${table}"`],
      );
      const status = rows[0];
      const correct = Boolean(status?.relrowsecurity) && Boolean(status?.relforcerowsecurity);
      if (!correct) {
        drifted.push({ table, rowsecurity: Boolean(status?.relrowsecurity), forced: Boolean(status?.relforcerowsecurity) });
      }
    }
    const definerPolicyProblems = preauthDefinerPolicyProblems(
      (await client.query(PREAUTH_DEFINER_POLICY_SQL, [[...PREAUTH_FORCED_TABLES]])).rows as Array<Record<string, unknown>>,
    );

    const forcedNonTenant: DriftedExemptTable[] = [];
    for (const table of FORCED_NON_TENANT_TABLES) {
      const { rows } = await client.query<{ present: boolean; relrowsecurity: boolean | null; relforcerowsecurity: boolean | null }>(
        `SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present, c.relrowsecurity, c.relforcerowsecurity
           FROM (SELECT 1) one LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass($1)`,
        [`core."${table}"`],
      );
      const status = rows[0];
      if (!status?.present || !status.relrowsecurity || !status.relforcerowsecurity) {
        forcedNonTenant.push({ table, rowsecurity: Boolean(status?.relrowsecurity), forced: Boolean(status?.relforcerowsecurity) });
      }
    }

    const roleResult = await client.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );
    const appRoleBypassesRls = roleResult.rows[0]?.rolbypassrls ?? null;

    // The check above only proves the *named* role rab_app is safe — it says
    // nothing about whether DATABASE_URL (what the running app/worker
    // actually authenticate as) is that role. A table owner connecting with
    // this exact same DATABASE_URL bypasses every non-FORCEd policy above
    // silently — this is the gap a live audit found: the app connecting as
    // rab_owner instead of rab_app on the five NOT_FORCED_ALLOWLIST tables.
    const { rows: currentUserRows } = await client.query<{ current_user: string }>(
      'SELECT current_user',
    );
    const connectedAs = currentUserRows[0]?.current_user;

    let failed = false;

    if (connectedAs !== CONNECT_ROLE) {
      failed = true;
      console.error(
        `RLS coverage FAILED: PG_DATABASE_URL connects as "${connectedAs}", not the owner login "${CONNECT_ROLE}". ` +
          `Every process connects as the owner login; the legacy logins are schema roles.\n`,
      );
    } else {
      // The connection IS the owner login by design; prove it is the reviewed owner-login shape (the boot gate's functions).
      const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params as unknown[] | undefined)).rows as Array<Record<string, unknown>>;
      const ownerProblems = [...(await ownerLoginRolePostureProblems(q)), ...(await ownerLoginObjectPostureProblems(q))];
      if (ownerProblems.length > 0) {
        failed = true;
        console.error(`RLS coverage FAILED: the owner-login role / object posture drifted:\n`);
        for (const p of ownerProblems) console.error(`  ${p}`);
        console.error('');
      }
    }

    if (unprotected.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — tenant tables missing full RLS protection:\n`);
      for (const t of unprotected) {
        console.error(
          `  core.${t.table}: rowsecurity=${t.rowsecurity} forceRowSecurity=${t.forced}` +
            ` — needs ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY + a policy`,
        );
      }
      console.error('');
    }

    if (drifted.length > 0 || definerPolicyProblems.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — the M-T1 pre-auth tables are not ENABLE + FORCE with their owner-only definer policy:\n`);
      for (const t of drifted) {
        console.error(
          `  core.${t.table}: rowsecurity=${t.rowsecurity} forceRowSecurity=${t.forced}` +
            ` — expected rowsecurity=true forceRowSecurity=true (PreAuthTablesForceOwnerOnly1786721400000; a missing table counts as not forced)`,
        );
      }
      for (const p of definerPolicyProblems) console.error(`  ${p}`);
      console.error('');
    }

    if (forcedNonTenant.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — non-tenant tables that must be ENABLE + FORCE are missing or not forced:
`);
      for (const t of forcedNonTenant) {
        console.error(
          `  core.${t.table}: rowsecurity=${t.rowsecurity} forceRowSecurity=${t.forced}` +
            ` — expected rowsecurity=true forceRowSecurity=true (DeploymentIdentity1786721230000; a missing table counts as not forced)`,
        );
      }
      console.error('');
    }

    if (appRoleBypassesRls === null) {
      console.warn(
        `Role "${APP_ROLE}" does not exist yet in this database — skipping the BYPASSRLS check ` +
          `(expected before the M1 role-bootstrap is wired into this environment).`,
      );
    } else if (appRoleBypassesRls) {
      failed = true;
      console.error(
        `RLS coverage FAILED — role "${APP_ROLE}" has BYPASSRLS. The app must connect as a role ` +
          `with NOBYPASSRLS or every policy above is decoration.\n`,
      );
    }

    const workerProblems = await checkWorkerRole(client);
    if (workerProblems.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — the Worker login / dispatch pointer boundary drifted:
`);
      for (const p of workerProblems) console.error(`  ${p}`);
      console.error('');
    }

    // Phase D wave 3 (owner-approved): no persistent database- or role-level crewflow.dispatch_notify (event-mode NOTIFY
    // must come only from the runtime pool's per-session option; in event mode a NOTIFY failure fails the producer's COMMIT).
    const notifySettings = await dispatchNotifySettingProblems(async (sql) => (await client.query(sql)).rows);
    if (notifySettings.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — persistent crewflow.dispatch_notify setting(s):
`);
      for (const p of notifySettings) console.error(`  ${p}`);
      console.error('');
    }

    const workspaces = await checkWorkspaceSchemas(client);
    if (workspaces.problems.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — workspace schema(s) drifted from the V1 security model:\n`);
      for (const p of workspaces.problems) console.error(`  ${p}`);
      console.error('');
    }

    if (failed) {
      process.exit(1);
    }

    console.log(
      `RLS coverage OK (connected as the owner login ${CONNECT_ROLE}) — ${tenantTables.rows.length} tenant table(s) checked, all protected; ` +
        `${PREAUTH_FORCED_TABLES.size} pre-auth table(s) FORCE with their owner-only definer policy; ` +
        `${FORCED_NON_TENANT_TABLES.length} non-tenant FORCE table(s) (${FORCED_NON_TENANT_TABLES.join(', ')}) forced; ` +
        `${workspaces.schemas} workspace schema(s), ${workspaces.tables} workspace table(s) checked.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('check-rls-coverage crashed:', error);
  process.exit(1);
});
