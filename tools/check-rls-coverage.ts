/**
 * CI gate (rab-workforce-architecture.md §5.7, §5.6): every table in schema
 * `core` with an `organisation_id` column must have Row-Level Security
 * enabled AND forced, and the application role (rab_app) must not have
 * BYPASSRLS. Run with a connection that can read `pg_class`/`pg_roles` —
 * DATABASE_URL is sufficient (no elevated grants needed for these reads).
 *
 * If the app ever connected as the table owner, RLS would be silently
 * skipped for every query it runs — this check is what makes that regressed
 * state fail CI instead of shipping quietly.
 */
import { Client } from 'pg';

// P2/P3 Checkpoint 2 (restricted runtime role): the application login is now `crewflow_app`, a
// separate, ownerless role — `crewflow` (the P1C.2 single-credential identity) is demoted to
// migration/bootstrap authority and now owns the tables this check protects, so checking ITS
// rolbypassrls would no longer prove what this check needs: that the connection actually serving
// requests has no owner-level bypass. `rab_app` (pre-P1C.2) remains retired, NOLOGIN, zero grants.
const APP_ROLE = process.env.RAB_APP_ROLE ?? 'crewflow_app';

/**
 * Tables deliberately not FORCEd — each needs a SECURITY TRADE-OFF note at
 * its migration explaining why (see IdentitySchema1786665800000 for
 * `organisation`/`user`: pre-auth login lookups can't satisfy a forced
 * tenant policy because no tenant context exists yet). Still must have
 * `rowsecurity = true` — this only relaxes the FORCE requirement, never the
 * "RLS enabled at all" one.
 */
const NOT_FORCED_ALLOWLIST = new Set([
  'user',
  'login_history',
  'refresh_token',
  'password_reset_token',
  // Added by the Private Workspace migration (Stage 2A) — a SECURITY
  // DEFINER function (workspace_subdomain_taken) needs owner-privilege
  // visibility across every workspace for the cross-tenant subdomain
  // uniqueness check, the same reason every other table on this list is
  // exempt. `rab_app` is never affected either way — it isn't the owner.
  'manager_workspace',
  // worker_due_work (WorkerDueWork1786676800000): timer discovery must see due pointers across every tenant, and the SECURITY DEFINER
  // claim/complete/reschedule functions run as the table owner. A FORCE policy would hide the rows from them. rab_app is not the owner and is
  // fully bound by the tenant policy. SECURITY TRADE-OFF, recorded in the migration's own comment. Pointers carry no business data.
  'worker_due_work',
  // staff_profile and manager_profile were exempted by ResolveWorkspaceForUserPreAuthExemption1786668400000 for the retired
  // resolve_workspace_for_user(). That function was retired (RetireResolveWorkspaceForUser1786675400000), so the exemption no longer
  // applies. Both tables now FORCE (StaffProfileForceRls1786675800000, ManagerProfileForceRls1786675810000). Not listed here.
  // Added by AccountInviteSchema1786670100000 — auth_find_account_invite_org
  // is the pre-auth lookup /auth/activate-account needs (resolve which org a
  // bare presented token belongs to, before any tenant context exists),
  // exactly the same reasoning as password_reset_token above.
  'account_invite',
  // Added by WebSessionCookieAuthentication1786681000000 (P1C.1C), owner-approved — cookie-first
  // browser authentication needs a pre-auth lookup (resolve a validated cookie's SHA-256 hash to
  // the owning session's user/org/application-target, before any tenant context can exist — that
  // context is literally what this lookup establishes) via
  // `core.auth_find_session_by_web_token_hash`, a narrow SECURITY DEFINER function. Same
  // reasoning as every other table on this list, including the most recent entry
  // (`user_auth_identity`) whose own comment documents exactly why FORCE would silently break a
  // SECURITY DEFINER pre-auth function. `rab_app` is never the owner and remains fully bound by
  // `user_session_select`/`_insert`/`_update` regardless of this flag.
  'user_session',
  // Added by UserAuthIdentity1786680200000 (P1C.1B) — the ORIGINAL migration
  // comment claimed a SECURITY DEFINER function alone would make FORCE safe
  // for the pre-auth `auth_find_user_by_provider_identity` lookup (resolve
  // which Crewflow user a validated Google/Microsoft identity belongs to,
  // before any tenant context exists). That was wrong, caught by this
  // table's own integration test, not assumed correct: FORCE binds the
  // table OWNER too, including inside SECURITY DEFINER execution (the exact
  // `core.user_session`/`count_user_session_backfill_status` lesson this
  // codebase already learned once, UserSession1786678000000's own doc
  // comment) — a SECURITY DEFINER function is not a bypass by itself, only
  // NOT FORCE is. Same reasoning as password_reset_token/account_invite above.
  'user_auth_identity',
  // Added by MemberInvitationSchema1786715000000 — the public invitation-acceptance endpoint resolves which
  // organisation/workspace a bare presented token belongs to through `core.auth_find_member_invitation`, a
  // SECURITY DEFINER function running as the table owner, before any tenant context exists. Identical
  // reasoning to account_invite above. `crewflow_app` is not the owner and stays bound by
  // `member_invitation_scope` (organisation AND workspace) regardless of this flag.
  'member_invitation',
  // Added by EmailChangeRequest1786717800000 (CF-04) — the public email-change confirmation endpoint resolves which
  // organisation a bare presented token belongs to through `core.auth_find_email_change_request`, before any tenant
  // context exists. Same reasoning as password_reset_token / account_invite above; crewflow_app stays bound by the policy.
  'email_change_request',
  // Added by HostLabelNamespace1786719820000 (Wave 2/3 lane S2) — `core.resolve_released_host_label` is a PRE-AUTH lookup
  // (an old host label → its workspace's current label, for a redirect) that must find the row before any tenant context
  // exists, and the subdomain write triggers must see other organisations' live quarantines to refuse a claim. Both are
  // SECURITY DEFINER functions owned by the table owner (rab_secure_owner, NOLOGIN); FORCE would bind the owner too.
  // crewflow_app and crewflow hold NO privilege on this table at all. SECURITY TRADE-OFF note in the migration's SQL
  // (host-label-namespace-sql.ts). The sibling `host_label_claim` and `workspace_schema_migration` ARE forced.
  'released_host_label',
  // Added by LoginHandoff1786719910000 (Waves 4+5 lane DB5) — `core.login_handoff_consume` is a PRE-AUTH lookup on the
  // target workspace host: it must find the single-use handoff by its token hash before any tenant context exists
  // (establishing that context is its purpose). It runs as the table owner rab_secure_owner (NOLOGIN); FORCE would bind the
  // owner to the tenant policy and hide the row. crewflow_app and crewflow hold NO privilege on the table; access is only
  // through login_handoff_create / _consume / _cleanup. SECURITY TRADE-OFF note in login-handoff-sql.ts. (Its sibling
  // core.user_mfa_recovery_code IS forced: MFA functions run with the server-derived tenant bound.)
  'login_handoff',
  // Added by OrganisationCeoInvitation1786720010000 (owner correction 2026-10-23: email-only CEO invitations) —
  // `core.organisation_invitation_peek` / `_complete` are PRE-AUTH lookups by token hash (the invited CEO has no account,
  // session or organisation yet; establishing them is the purpose). Both run as the table owner rab_secure_owner (NOLOGIN);
  // FORCE would bind the owner to the platform-admin policy and hide the row. crewflow and crewflow_app hold NO privilege
  // on the table; every other operation goes through functions that re-check the platform-administrator claim. No
  // organisation_id column (not tenant data — like platform_admin), so only this ENABLE-but-NOT-FORCE check covers it.
  'organisation_invitation',
]);

/**
 * `organisation` itself is deliberately NOT FORCEd (IdentitySchema1786665800000
 * — the pre-auth org-lookup-by-slug/email flow can't satisfy a forced
 * `id = current_org()` policy before any tenant context exists), but it has
 * no `organisation_id` column (its own PK is `id`), so the scan above never
 * even looks at it — a live audit found it silently drifted to FORCEd
 * (breaking every org-bootstrap insert, `rab_owner` included) with this
 * checker still reporting "OK" throughout, since it was entirely out of
 * scope. Checked explicitly here, alongside every other table on
 * NOT_FORCED_ALLOWLIST, so a repeat of that drift — on `organisation` or any
 * of the others — fails this gate instead of failing silently.
 *
 * `platform_admin` (Stage 2A Phase 2) is the same class of gap as
 * `organisation` — genuinely global, no `organisation_id` column at all, so
 * it's equally invisible to the scan above. NOT FORCEd deliberately: the
 * bootstrap CLI (`grant-platform-admin`, connects as `rab_owner`) must be
 * able to write the very first row when zero admins exist yet, which a
 * self-referential `WITH CHECK` (requiring the caller already be an active
 * admin) can never satisfy for any `rab_app` session by design.
 */
const PRE_AUTH_EXEMPT_TABLES = new Set(['organisation', 'platform_admin', ...NOT_FORCED_ALLOWLIST]);

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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run check-rls-coverage');
  }

  const client = new Client({ connectionString: databaseUrl });
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
    for (const table of PRE_AUTH_EXEMPT_TABLES) {
      const { rows } = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
        [`core."${table}"`],
      );
      const status = rows[0];
      const correct = Boolean(status?.relrowsecurity) && !status?.relforcerowsecurity;
      if (!correct) {
        drifted.push({ table, rowsecurity: Boolean(status?.relrowsecurity), forced: Boolean(status?.relforcerowsecurity) });
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

    if (connectedAs !== APP_ROLE) {
      failed = true;
      console.error(
        `RLS coverage FAILED — DATABASE_URL connects as "${connectedAs}", not "${APP_ROLE}". ` +
          `Any table in NOT_FORCED_ALLOWLIST (${[...NOT_FORCED_ALLOWLIST].join(', ')}) is fully ` +
          `unscoped for every query run over this connection, regardless of tenant context.\n`,
      );
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

    if (drifted.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — pre-auth-exempt tables drifted from ENABLE-but-NOT-FORCE:\n`);
      for (const t of drifted) {
        console.error(
          `  core.${t.table}: rowsecurity=${t.rowsecurity} forceRowSecurity=${t.forced}` +
            ` — expected rowsecurity=true forceRowSecurity=false (see SECURITY TRADE-OFF note at its migration)`,
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
      `RLS coverage OK — ${tenantTables.rows.length} tenant table(s) checked, all protected; ` +
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
