// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * M-T1 (Twenty Mode Option A, owner decisions D8 / "M-T1 approved as a new forward migration"):
 * PreAuthTablesForceOwnerOnly1786721400000. The exact SQL, kept in one place for the migration, its spec, the boot gate
 * (boot-checks/twenty-role-posture.ts), tools/check-rls-coverage.ts and the posture golden.
 *
 * WHY. Before M-T1 these 16 tables were ENABLE ROW LEVEL SECURITY but NOT FORCE (the old NOT_FORCED_ALLOWLIST plus
 * `organisation` / `platform_admin`): their pre-auth SECURITY DEFINER lookups run as the table owner `rab_secure_owner` and
 * relied on the owner bypassing RLS. In separated mode no LOGIN role ever has the owner's privileges, so NOT FORCE was
 * harmless. Under Option A the runtime login `crewflow_owner` INHERITS rab_secure_owner, so every query it runs on these
 * tables bypassed RLS: a missing tenant filter — a logic bug, no injection — returned every tenant's password hashes,
 * TOTP ciphertext and token hashes (G-01, CRITICAL).
 *
 * WHAT. For each table: one PERMISSIVE policy FOR ALL TO rab_secure_owner USING / WITH CHECK
 * (CURRENT_USER = 'rab_secure_owner'::name) — the precedent is core.worker_dispatch_pointer_definer and the
 * deployment_identity definer policies — and FORCE ROW LEVEL SECURITY. Effect:
 *   - inside a rab_secure_owner SECURITY DEFINER function CURRENT_USER is rab_secure_owner: the new policy admits every row,
 *     so every pre-auth lookup (login, registration, password reset, sessions / refresh, MFA, account switching,
 *     invitations, handoff, host labels, due-work timers, organisation bootstrap, platform-admin bootstrap) sees exactly
 *     what it saw before;
 *   - a session that merely INHERITS rab_secure_owner (crewflow_owner, or the separated-mode migration identity acting as
 *     itself) now gets the existing tenant policies only: zero rows without tenant context, the bound tenant's rows with it;
 *   - foreign-key checks and cascades are unaffected (PostgreSQL runs them as the owner with SECURITY_NOFORCE_RLS);
 *   - crewflow_app, crewflow_worker and crewflow are NOT the owner and never were: FORCE does not change what they see, and
 *     a TO rab_secure_owner policy never applies to them (they are not members). Separated-mode runtime behaviour is
 *     unchanged; the integration spec proves it as crewflow_app.
 *   - superusers bypass RLS entirely, FORCE or not (unchanged).
 *
 * WHAT IT DOES NOT DO. It protects normal code paths only. An injected statement as crewflow_owner can `SET ROLE
 * rab_secure_owner`, `set_config('role', …)`, `ALTER TABLE … NO FORCE` or `DROP POLICY` (G-02/G-03, owner-accepted). The
 * semantic posture monitor (posture-drift/*) detects the last two afterwards; nothing prevents them.
 *
 * CONSEQUENCE for every LATER migration or operator script that reads or writes one of these tables as a non-superuser
 * member of rab_secure_owner (the separated migration identity; crewflow_owner): it must `SET LOCAL ROLE
 * rab_secure_owner` (or go through a definer) or it sees zero rows. An "is this database empty?" check that counts rows
 * in these tables as crewflow_owner would wrongly answer "empty" — use the migration ledger, or count as rab_secure_owner.
 */

/** The 16 tables (14 former NOT_FORCED_ALLOWLIST entries + organisation + platform_admin), all owned by rab_secure_owner. */
export const PREAUTH_FORCE_TABLES: readonly string[] = Object.freeze([
  'account_invite',
  'email_change_request',
  'login_handoff',
  'login_history',
  'manager_workspace',
  'member_invitation',
  'organisation',
  'organisation_invitation',
  'password_reset_token',
  'platform_admin',
  'refresh_token',
  'released_host_label',
  'user',
  'user_auth_identity',
  'user_session',
  'worker_due_work',
]);

/** As pg_get_expr prints it (and as the worker_dispatch_pointer / deployment_identity owner-only policies print). */
export const PREAUTH_DEFINER_EXPRESSION = `(CURRENT_USER = 'rab_secure_owner'::name)`;

export function preauthDefinerPolicyName(table: string): string {
  return `${table}_secure_owner_definer`;
}

const qualified = (table: string) => `core."${table}"`;

/** up(): policy first, then FORCE (the order is irrelevant inside one transaction; it reads as the precedent does). */
export const PREAUTH_FORCE_UP_SQL: readonly string[] = PREAUTH_FORCE_TABLES.flatMap((t) => [
  `CREATE POLICY ${preauthDefinerPolicyName(t)} ON ${qualified(t)} AS PERMISSIVE FOR ALL TO rab_secure_owner
     USING (CURRENT_USER = 'rab_secure_owner'::name) WITH CHECK (CURRENT_USER = 'rab_secure_owner'::name)`,
  `ALTER TABLE ${qualified(t)} FORCE ROW LEVEL SECURITY`,
]);

/** down(): exactly the previous state (ENABLE, NOT FORCE, no definer policy). */
export const PREAUTH_FORCE_DOWN_SQL: readonly string[] = PREAUTH_FORCE_TABLES.flatMap((t) => [
  `ALTER TABLE ${qualified(t)} NO FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${preauthDefinerPolicyName(t)} ON ${qualified(t)}`,
]);

/**
 * PLATFORM-ADMIN RECURSION GUARD (fixed in place 2026-11-04, owner decision; found on PR #72 as "stack depth limit
 * exceeded" in core.is_active_platform_admin()). core.platform_admin's three policies apply TO PUBLIC and call
 * core.is_active_platform_admin(), a SECURITY DEFINER function owned by rab_secure_owner that reads core.platform_admin.
 * Before FORCE the owner bypassed RLS, so that read never evaluated the policies. Under FORCE it does: policy -> function
 * -> read -> policy -> ... until the stack limit, as soon as the table holds a row that is not the caller's own.
 *
 * Fix: for rab_secure_owner the three policies are false, behind CASE so the function is never called there (CASE fixes
 * the evaluation order; the function is STABLE, never constant-folded). rab_secure_owner keeps every row through
 * platform_admin_secure_owner_definer. For every other role the predicate is exactly the previous one. A static scan of
 * the other 15 tables found no policy calling a definer that reads its own table, and no cycle across tables.
 * Applied BEFORE FORCE, so the recursive form never coexists with FORCE, not even inside the migration's transaction.
 */
export const PLATFORM_ADMIN_GUARDED_POLICIES: readonly string[] = Object.freeze(['platform_admin_select', 'platform_admin_update', 'platform_admin_write']);

const ownerGuard = (predicate: string) => `CASE WHEN CURRENT_USER = 'rab_secure_owner'::name THEN false ELSE (${predicate}) END`;

export const PLATFORM_ADMIN_GUARD_UP_SQL: readonly string[] = Object.freeze([
  `ALTER POLICY platform_admin_select ON core.platform_admin
     USING (${ownerGuard('user_id = core.current_uid() OR core.is_active_platform_admin()')})`,
  `ALTER POLICY platform_admin_write ON core.platform_admin
     WITH CHECK (${ownerGuard('core.is_active_platform_admin()')})`,
  `ALTER POLICY platform_admin_update ON core.platform_admin
     USING (${ownerGuard('core.is_active_platform_admin()')})
     WITH CHECK (${ownerGuard('core.is_active_platform_admin()')})`,
]);

/** down(): exactly the expressions of PlatformAdminGlobalRedesign1786669400000 (never altered since). */
export const PLATFORM_ADMIN_GUARD_DOWN_SQL: readonly string[] = Object.freeze([
  `ALTER POLICY platform_admin_select ON core.platform_admin USING (user_id = core.current_uid() OR core.is_active_platform_admin())`,
  `ALTER POLICY platform_admin_write ON core.platform_admin WITH CHECK (core.is_active_platform_admin())`,
  `ALTER POLICY platform_admin_update ON core.platform_admin USING (core.is_active_platform_admin()) WITH CHECK (core.is_active_platform_admin())`,
]);

/** The three policies as PostgreSQL prints them. */
export const PLATFORM_ADMIN_POLICY_SQL = `
SELECT p.polname::text AS name, p.polroles = '{0}'::oid[] AS to_public,
       coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') AS qual,
       coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') AS chk
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = 'core.platform_admin'::regclass AND p.polname = ANY ($1::name[])
 ORDER BY 1`;

export interface PlatformAdminPolicyRow {
  name: string;
  to_public: boolean;
  qual: string;
  chk: string;
}

const GUARD_PREFIX = `CASE WHEN (CURRENT_USER = 'rab_secure_owner'::name) THEN false`;

/**
 * 'start': the three policies exist TO PUBLIC, call is_active_platform_admin and carry no guard yet.
 * 'end': every expression they have (USING and / or WITH CHECK) starts with the guard.
 */
export function platformAdminPolicyProblems(rows: PlatformAdminPolicyRow[], phase: 'start' | 'end'): string[] {
  const p: string[] = [];
  for (const name of PLATFORM_ADMIN_GUARDED_POLICIES) {
    const r = rows.find((x) => x.name === name);
    if (!r) {
      p.push(`core.platform_admin policy ${name} is missing`);
      continue;
    }
    if (!r.to_public) p.push(`core.platform_admin policy ${name} no longer applies TO PUBLIC (unexpected)`);
    const exprs = [r.qual, r.chk].filter(Boolean);
    if (phase === 'start') {
      if (!exprs.some((e) => e.includes('is_active_platform_admin'))) p.push(`${name} does not call is_active_platform_admin (unexpected starting state)`);
      if (exprs.some((e) => e.includes('rab_secure_owner'))) p.push(`${name} already carries the rab_secure_owner guard`);
    } else if (!exprs.length || !exprs.every((e) => e.startsWith(GUARD_PREFIX))) {
      p.push(`${name} is not guarded for rab_secure_owner: using=${r.qual || '-'} check=${r.chk || '-'}`);
    }
  }
  return p;
}

/** Preflight facts: who runs it and whether every table is in the expected starting state. */
export const PREAUTH_FORCE_PREFLIGHT_SQL = `
SELECT current_user::text AS who,
       coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS owner_usage,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'SET') AS owner_set,
       (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad`;

/** Per table: present, owner, ENABLE, FORCE, whether the definer policy exists. */
export const PREAUTH_FORCE_STATE_SQL = `
SELECT t.name AS tbl, c.oid IS NOT NULL AS present, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
       EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = t.name || '_secure_owner_definer') AS has_policy
  FROM pg_catalog.unnest($1::text[]) AS t(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('core.' || pg_catalog.quote_ident(t.name))
 ORDER BY 1`;

export interface PreauthForceState {
  tbl: string;
  present: boolean;
  owner: string | null;
  enabled: boolean | null;
  forced: boolean | null;
  has_policy: boolean;
}

/** Problems with the starting state (before up). Empty = safe to apply. */
export function preauthForceStartProblems(rows: PreauthForceState[]): string[] {
  const p: string[] = [];
  for (const t of PREAUTH_FORCE_TABLES) {
    const r = rows.find((x) => x.tbl === t);
    if (!r?.present) p.push(`core.${t} is missing`);
    else {
      if (r.owner !== 'rab_secure_owner') p.push(`core.${t} is owned by ${r.owner}, not rab_secure_owner`);
      if (r.enabled !== true) p.push(`core.${t} does not have ROW LEVEL SECURITY enabled`);
      if (r.forced === true) p.push(`core.${t} is already FORCE (unexpected starting state)`);
      if (r.has_policy) p.push(`core.${t} already has ${preauthDefinerPolicyName(t)}`);
    }
  }
  return p;
}

/** Problems with the end state (after up). Empty = all 16 are ENABLE + FORCE with their definer policy. */
export function preauthForceEndProblems(rows: PreauthForceState[]): string[] {
  const p: string[] = [];
  for (const t of PREAUTH_FORCE_TABLES) {
    const r = rows.find((x) => x.tbl === t);
    if (!r?.present || r.enabled !== true || r.forced !== true || !r.has_policy) {
      p.push(`core.${t}: enabled=${String(r?.enabled)} forced=${String(r?.forced)} definer_policy=${String(r?.has_policy)}`);
    }
  }
  return p;
}

/**
 * Functional self-check: the number of rows rab_secure_owner sees in each table (run with `SET LOCAL ROLE
 * rab_secure_owner`). Before FORCE that is every row (owner bypass); after FORCE it must still be every row (the definer
 * policy). Equal counts prove no definer lost visibility.
 */
export const PREAUTH_FORCE_COUNTS_SQL = PREAUTH_FORCE_TABLES.map((t) => `SELECT '${t}' AS tbl, pg_catalog.count(*)::bigint AS n FROM ${qualified(t)}`).join(
  '\nUNION ALL\n',
);
