/**
 * Test helper (never built into dist): answers the owner-login posture queries (database/boot-checks/owner-login-posture.ts)
 * exactly as a healthy database built with the M0 §5.2 bootstrap answers them (verified on disposable PG16.15: Agent A
 * replay B, twa-sec replay), so unit specs of the boot gates and the runtime-role assertion can run without PostgreSQL.
 * `mutate` lets a spec plant one deviation (a backdoor login, a reachable predefined role, a missing FORCE, ...).
 */
import {
  LAYOUT_SCHEMA_ROLES_SQL,
  OWNER_LOGIN_FACTS_SQL,
  OWNER_LOGIN_FOREIGN_LOGINS_SQL,
  OWNER_LOGIN_MEMBERSHIPS_SQL,
  OWNER_LOGIN_OBJECT_POSTURE_SQL,
  OWNER_LOGIN_REACHABILITY_SQL,
  PREAUTH_DEFINER_POLICY_SQL,
} from '../../database/boot-checks/owner-login-posture';
import { PREAUTH_DEFINER_EXPRESSION, PREAUTH_FORCE_TABLES, preauthDefinerPolicyName } from '../../database/typeorm/core/preauth-force-sql';

type Row = Record<string, unknown>;

export interface OwnerLoginPostureFixture {
  login: Row;
  reach: Row[];
  memberships: Row[];
  layout: Row[];
  foreignLogins: Row[];
  objectLines: string[];
  definerPolicies: Row[];
}

const member = (role: string, admin: boolean, inherit: boolean, set: boolean, who = 'crewflow_owner', roleLogin = false): Row => ({
  role,
  role_login: roleLogin,
  member: who,
  member_login: true,
  member_super: false,
  admin,
  inherit,
  set,
});

export function healthyOwnerLoginPosture(): OwnerLoginPostureFixture {
  const ownerRoles = ['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow'];
  return {
    login: { who: 'crewflow_owner', login: 'crewflow_owner', super: false, bypassrls: false, replication: false, createdb: false, createrole: true, canlogin: true, inherit: true },
    reach: [
      { role: 'crewflow_owner', path: 'crewflow_owner', super: false, bypassrls: false, createdb: false, replication: false, canlogin: true, is_login: true },
      ...[...ownerRoles, 'crewflow_app'].map((role) => ({
        role,
        path: `crewflow_owner>${role}`,
        super: false,
        bypassrls: false,
        createdb: false,
        replication: false,
        canlogin: role === 'crewflow' || role === 'crewflow_app',
        is_login: false,
      })),
    ],
    memberships: [
      // The PG16 implicit creator rows (ADMIN only) and the bootstrap's explicit INHERIT + SET grants.
      ...ownerRoles.flatMap((r) => [member(r, true, false, false, 'crewflow_owner', r === 'crewflow'), member(r, false, true, true, 'crewflow_owner', r === 'crewflow')]),
      member('crewflow_app', true, false, false, 'crewflow_owner', true),
      { ...member('crewflow_app', false, true, false, 'crewflow_worker', true) },
    ],
    layout: ['crewflow', 'crewflow_app', 'crewflow_worker', 'rab_app', 'rab_owner', 'rab_secure_owner'].map((role) => ({
      role,
      canlogin: ['crewflow', 'crewflow_app', 'crewflow_worker'].includes(role),
      super: false,
      bypassrls: false,
      createrole: false,
      createdb: false,
      replication: false,
    })),
    foreignLogins: [],
    objectLines: [],
    definerPolicies: PREAUTH_FORCE_TABLES.map((tbl) => ({
      tbl,
      policy: preauthDefinerPolicyName(tbl),
      permissive: true,
      cmd: '*',
      roles: ['rab_secure_owner'],
      qual: PREAUTH_DEFINER_EXPRESSION,
      with_check: PREAUTH_DEFINER_EXPRESSION,
    })),
  };
}

/** Rows for one of the posture queries, or undefined when `sql` is not one of them (the caller answers it). */
export function ownerLoginPostureAnswer(sql: string, fixture: OwnerLoginPostureFixture = healthyOwnerLoginPosture()): Row[] | undefined {
  if (sql === OWNER_LOGIN_FACTS_SQL) return [fixture.login];
  if (sql === OWNER_LOGIN_REACHABILITY_SQL) return fixture.reach;
  if (sql === OWNER_LOGIN_MEMBERSHIPS_SQL) return fixture.memberships;
  if (sql === LAYOUT_SCHEMA_ROLES_SQL) return fixture.layout;
  if (sql === OWNER_LOGIN_FOREIGN_LOGINS_SQL) return fixture.foreignLogins;
  if (sql === OWNER_LOGIN_OBJECT_POSTURE_SQL) return fixture.objectLines.map((line) => ({ line }));
  if (sql === PREAUTH_DEFINER_POLICY_SQL) return fixture.definerPolicies;
  return undefined;
}
