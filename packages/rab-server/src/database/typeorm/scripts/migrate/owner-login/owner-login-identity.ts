/**
 * Owner-login architecture (owner decision 2026-11-04, PR 3 "fresh-install and migration lifecycle"): the migration identity rule of the owner login. One login, `crewflow_owner`, runs the API, the
 * Worker AND the migrations (owner decision D1 = A), so the CF-41 rule of separated mode ("a role that can act as both
 * owner roles, or a superuser") is replaced, for the owner login, by an exact rule:
 *
 *   - the session login and the current role are EXACTLY `crewflow_owner` (no SET ROLE at entry, no other login);
 *   - it is NOSUPERUSER, NOBYPASSRLS, NOREPLICATION (the M0 §5.1 admin step creates it that way);
 *   - CREATEROLE is required only while the bootstrap or a pre-split migration is still to run (an admin may drop it after
 *     the install, M0 §5.1 optional hardening);
 *   - no role it can reach through ANY membership edge (ADMIN-only edges included: ADMIN lets it grant the role to itself,
 *     G-12) is SUPERUSER, BYPASSRLS or REPLICATION, or a predefined `pg_*` role, or the Worker login `crewflow_worker`
 *     (whose zero-member invariant Phase D relies on).
 *
 * The locked runner dispatches on the session login: crewflow_owner gets this rule and the owner-login lifecycle; any other
 * login (the CF-41 superuser or restricted migrator) takes the LEGACY path, retained only until PR #9.
 */
import type { Query } from '../locked-migration-runner';
import { OWNER_LOGIN } from './bootstrap';

export class OwnerLoginIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerLoginIdentityError';
  }
}

export interface OwnerLoginIdentityFacts {
  sessionUser: string;
  currentUser: string;
  super: boolean;
  bypassrls: boolean;
  replication: boolean;
  createrole: boolean;
  /** Roles reachable from the login through pg_auth_members (any option), with the attributes that matter. */
  reachable: Array<{ role: string; super: boolean; bypassrls: boolean; replication: boolean }>;
}

export const OWNER_LOGIN_IDENTITY_FACTS_SQL = `
WITH RECURSIVE reach(oid) AS (
  SELECT a.roleid FROM pg_catalog.pg_auth_members a WHERE a.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)
  UNION
  SELECT a.roleid FROM pg_catalog.pg_auth_members a JOIN reach r ON a.member = r.oid
)
SELECT session_user::text AS "sessionUser", current_user::text AS "currentUser",
       me.rolsuper AS "super", me.rolbypassrls AS "bypassrls", me.rolreplication AS "replication", me.rolcreaterole AS "createrole",
       coalesce((SELECT json_agg(json_build_object('role', g.rolname, 'super', g.rolsuper, 'bypassrls', g.rolbypassrls, 'replication', g.rolreplication)
                                 ORDER BY g.rolname)
                   FROM reach JOIN pg_catalog.pg_roles g ON g.oid = reach.oid), '[]'::json) AS "reachable"
  FROM pg_catalog.pg_roles me WHERE me.rolname = session_user`;

/** Pure. Throws OwnerLoginIdentityError naming every problem. */
export function assertOwnerLoginMigrationIdentity(facts: OwnerLoginIdentityFacts, options: { needCreateRole: boolean; owner?: string }): void {
  const owner = options.owner ?? OWNER_LOGIN;
  const problems: string[] = [];
  if (facts.sessionUser !== owner) problems.push(`the login is "${facts.sessionUser}", not ${owner}`);
  if (facts.currentUser !== facts.sessionUser) problems.push(`the session runs as "${facts.currentUser}" (SET ROLE), not as the login itself`);
  if (facts.super) problems.push('the login is SUPERUSER');
  if (facts.bypassrls) problems.push('the login has BYPASSRLS');
  if (facts.replication) problems.push('the login has REPLICATION');
  if (options.needCreateRole && !facts.createrole) problems.push('the login lacks CREATEROLE, which the first install (bootstrap and role migrations) needs');
  for (const r of facts.reachable) {
    if (r.super || r.bypassrls || r.replication) problems.push(`reachable role ${r.role} is SUPERUSER, BYPASSRLS or REPLICATION`);
    else if (r.role.startsWith('pg_')) problems.push(`reachable predefined role ${r.role}`);
    else if (r.role === 'crewflow_worker') problems.push('crewflow_worker is reachable (it must have zero members)');
  }
  if (problems.length) {
    throw new OwnerLoginIdentityError(`the owner-login lifecycle migrates only as ${owner} (NOSUPERUSER NOBYPASSRLS NOREPLICATION, nothing privileged reachable): ${problems.join('; ')}. Refusing.`);
  }
}

export async function readOwnerLoginIdentityFacts(query: Query): Promise<OwnerLoginIdentityFacts> {
  const [row] = (await query(OWNER_LOGIN_IDENTITY_FACTS_SQL)) as OwnerLoginIdentityFacts[];
  if (!row) throw new OwnerLoginIdentityError('cannot read the connecting login. Refusing.');
  return row;
}
