import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { healthyOwnerLoginPosture } from '../../__tests__/helpers/owner-login-posture-fake';
import { NEEDS_OWNER_APPROVAL_IDS, OWNER_LOGIN_BEHAVIOUR_CATALOGUE, PR9_TRACKED_ACCEPTED_IDS } from './owner-login-behaviour-catalogue';
import {
  DANGEROUS_PREDEFINED_ROLES,
  OWNER_LOGIN_REACHABILITY_SQL,
  ownerLoginInventoryProblems,
  ownerLoginProblems,
  ownerLoginReachabilityProblems,
  preauthDefinerPolicyProblems,
  PROVIDER_ADMIN_ROLES,
} from './owner-login-posture';

/**
 * Pure rules of the owner-login posture (owner-login-posture.ts). The same rules run against real catalogs in
 * src/__tests__/integration/owner-login-guards.integration.spec.ts (planted backdoors on a disposable PG16 / PG18).
 */
describe('owner-login posture: rule 1 (login shape)', () => {
  const ok = healthyOwnerLoginPosture().login;
  it('the healthy login passes (CREATEROLE is expected)', () => expect(ownerLoginProblems(ok)).toEqual([]));
  it.each([
    [{ login: 'crewflow_app', who: 'crewflow_app' }, /expected "crewflow_owner"/],
    [{ who: 'rab_secure_owner' }, /acts as "rab_secure_owner" through SET ROLE/],
    [{ super: true }, /is SUPERUSER/],
    [{ bypassrls: true }, /has BYPASSRLS/],
    [{ replication: true }, /has REPLICATION/],
    [{ createdb: true }, /has CREATEDB/],
  ])('refuses %p', (over, pattern) => expect(ownerLoginProblems({ ...ok, ...over }).join('; ')).toMatch(pattern));
  it('NOCREATEROLE (M0 §5.1 optional hardening) is accepted', () => expect(ownerLoginProblems({ ...ok, createrole: false })).toEqual([]));
});

describe('owner-login posture: rule 2 (reachability, MEMBER semantics)', () => {
  const reach = healthyOwnerLoginPosture().reach;
  const extra = (over: Record<string, unknown>) => [...reach, { role: 'x', path: 'crewflow_owner>y>x', super: false, bypassrls: false, createdb: false, replication: false, is_login: false, ...over }];
  it('the healthy layout reaches nothing dangerous', () => expect(ownerLoginReachabilityProblems(reach)).toEqual([]));
  it.each([
    [{ super: true }, /"x" has SUPERUSER and is reachable from crewflow_owner \(crewflow_owner>y>x\)/],
    [{ bypassrls: true }, /BYPASSRLS/],
    [{ createdb: true }, /CREATEDB/],
    [{ replication: true }, /REPLICATION/],
  ])('refuses a reachable role with %p (indirect path named)', (over, pattern) => expect(ownerLoginReachabilityProblems(extra(over)).join()).toMatch(pattern));
  it.each([...DANGEROUS_PREDEFINED_ROLES])('refuses the predefined role %s', (role) => {
    expect(ownerLoginReachabilityProblems(extra({ role })).join()).toMatch(new RegExp(`predefined role "${role}"`));
  });
  it.each(['neon_superuser', 'rds_superuser', 'cloudsqlsuperuser', 'azure_pg_admin', 'supabase_admin'])('refuses the provider admin role %s', (role) => {
    expect(PROVIDER_ADMIN_ROLES).toContain(role);
    expect(ownerLoginReachabilityProblems(extra({ role })).join()).toMatch(/provider administrator role/);
  });
  it('the SQL walks every pg_auth_members edge (no INHERIT / SET / ADMIN filter) and cross-checks pg_has_role MEMBER', () => {
    expect(OWNER_LOGIN_REACHABILITY_SQL).toMatch(/JOIN pg_catalog\.pg_auth_members m ON m\.member = w\.oid/);
    expect(OWNER_LOGIN_REACHABILITY_SQL).not.toMatch(/inherit_option|set_option|admin_option/);
    expect(OWNER_LOGIN_REACHABILITY_SQL).toMatch(/pg_has_role\(session_user, r\.oid, 'MEMBER'\)/);
    expect(OWNER_LOGIN_REACHABILITY_SQL).not.toMatch(/'USAGE'|'SET'\)/);
  });
});

describe('owner-login posture: rule 3 (inventory)', () => {
  const f = healthyOwnerLoginPosture();
  const m = (role: string, member: string, admin: boolean, inherit: boolean, set: boolean, roleLogin = false) => ({ role, role_login: roleLogin, member, admin, inherit, set });
  it('the healthy bootstrap layout passes', () => expect(ownerLoginInventoryProblems(f.memberships, f.layout, [])).toEqual([]));
  it.each([
    ['a backdoor login granted rab_secure_owner', [m('rab_secure_owner', 'monitoring_agent', false, true, true)], /"monitoring_agent" is a member of owner role "rab_secure_owner"/],
    ['an ADMIN-only grant to another role (could self-grant later)', [m('crewflow', 'x', true, false, false)], /"x" is a member of owner role "crewflow"/],
    ['any member of crewflow_worker', [m('crewflow_worker', 'crewflow_owner', false, true, false)], /not in the owner-login layout/],
    ['an INHERIT membership of crewflow_app for the login', [m('crewflow_app', 'crewflow_owner', false, true, false)], /only the implicit ADMIN-only creator row/],
    ['another role that can act as the login', [m('crewflow_owner', 'someone', false, true, true)], /"someone" can act as crewflow_owner/],
    ['a LOGIN role the login created (ADMIN row)', [m('backdoor', 'crewflow_owner', true, false, false, true)], /a LOGIN role it administers/],
    ['a non-worker member of crewflow_app', [m('crewflow_app', 'x', false, true, false)], /only crewflow_worker/],
  ])('refuses %s', (_label, rows, pattern) => {
    expect(ownerLoginInventoryProblems([...f.memberships, ...rows], f.layout, []).join('; ')).toMatch(pattern);
  });
  it('the provider admin creator row on the login (ADMIN only) is accepted', () => {
    expect(ownerLoginInventoryProblems([...f.memberships, m('crewflow_owner', 'neondb_owner', true, false, false)], f.layout, [])).toEqual([]);
  });
  it('refuses an owner role turned LOGIN, a missing layout role and a foreign login', () => {
    const layout = f.layout.map((r) => (r.role === 'rab_owner' ? { ...r, canlogin: true } : r)).filter((r) => r.role !== 'crewflow_worker');
    const out = ownerLoginInventoryProblems(f.memberships, layout, [{ login: 'evil', reaches: 'crewflow' }]).join('; ');
    expect(out).toMatch(/owner role "rab_owner" is LOGIN/);
    expect(out).toMatch(/layout role "crewflow_worker" does not exist/);
    expect(out).toMatch(/unexpected LOGIN role "evil" can act as "crewflow"/);
  });
});

describe('owner-login posture: rule 4 (M-T1 definer policies)', () => {
  const rows = healthyOwnerLoginPosture().definerPolicies;
  it('the exact policies pass', () => expect(preauthDefinerPolicyProblems(rows)).toEqual([]));
  it.each([
    [{ policy: null }, /is missing/],
    [{ qual: 'true' }, /drifted/],
    [{ with_check: 'true' }, /drifted/],
    [{ roles: ['public'] }, /drifted/],
    [{ permissive: false }, /drifted/],
    [{ cmd: 'r' }, /drifted/],
  ])('a drifted user policy %p is reported', (over, pattern) => {
    expect(preauthDefinerPolicyProblems(rows.map((r) => (r.tbl === 'user' ? { ...r, ...over } : r))).join()).toMatch(pattern);
  });
});

describe('owner-login behaviour-change catalogue', () => {
  it('ids are unique and every entry carries a severity, a status and both sides of the change', () => {
    const ids = OWNER_LOGIN_BEHAVIOUR_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of OWNER_LOGIN_BEHAVIOUR_CATALOGUE) {
      expect(e.before.length).toBeGreaterThan(10);
      expect(e.after.length).toBeGreaterThan(10);
      expect(e.controls.length).toBeGreaterThan(2);
    }
  });

  it('only BC-17 still waits for the owner (the rest were accepted 2026-11-05); accepted entries carry the dated decision', () => {
    // Owner decisions 2026-11-05: BC-08, BC-10, BC-11, BC-12, BC-13, AI-1, COLGRANT-1, HL-1, PROV-1 accepted "like Twenty".
    // BC-17 becomes mitigated (legacy logins NOLOGIN after the transition, Agent 1) — then this list is empty.
    expect([...NEEDS_OWNER_APPROVAL_IDS].sort()).toEqual(['BC-17']);
    for (const id of ['BC-08', 'BC-10', 'BC-11', 'BC-12', 'BC-13', 'AI-1', 'COLGRANT-1', 'HL-1', 'PROV-1']) {
      const e = OWNER_LOGIN_BEHAVIOUR_CATALOGUE.find((x) => x.id === id)!;
      expect({ id, status: e.status, dated: e.refs.includes('owner decision 2026-11-05 (like Twenty)') }).toEqual({ id, status: 'accepted-owner', dated: true });
      expect(`${e.controls}`).not.toMatch(/NEEDS OWNER APPROVAL/);
    }
    expect(PR9_TRACKED_ACCEPTED_IDS).toContain('HL-1');
  });

  it('every catalogue id has its own reproducing test in the integration catalogue spec', () => {
    const spec = readFileSync(join(__dirname, '../../__tests__/integration/owner-login-behaviour-catalogue.integration.spec.ts'), 'utf8');
    for (const e of OWNER_LOGIN_BEHAVIOUR_CATALOGUE) {
      const titled = spec.includes(`it('${e.id}: `) || spec.includes(`it('${e.id} (NEEDS OWNER APPROVAL): `);
      expect({ id: e.id, titled }).toEqual({ id: e.id, titled: true });
    }
  });
});
