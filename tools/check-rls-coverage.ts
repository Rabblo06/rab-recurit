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
    const tenantTables = await client.query<{ table_name: string }>(
      `SELECT DISTINCT table_name
         FROM information_schema.columns
        WHERE table_schema = 'core' AND column_name = 'organisation_id'`,
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

    if (failed) {
      process.exit(1);
    }

    console.log(
      `RLS coverage OK — ${tenantTables.rows.length} tenant table(s) checked, all protected.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('check-rls-coverage crashed:', error);
  process.exit(1);
});
