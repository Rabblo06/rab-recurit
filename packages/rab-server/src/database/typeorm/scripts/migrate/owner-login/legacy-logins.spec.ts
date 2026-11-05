import { readFileSync } from 'fs';
import { join } from 'path';

import { goldenForLayout, SEPARATED_LAYOUT_ROLE_LINES } from '../../../core/security-posture';
import { LEGACY_LOGIN_FACTS_SQL, legacyLoginPlan } from './legacy-logins';

/** BC-17 (owner decision 2026-11-05, MITIGATE): the legacy logins lose their login ability on owner-login databases. */
describe('BC-17: legacy logins on an owner-login database', () => {
  it('fresh install: crewflow and crewflow_app become NOLOGIN with no password; crewflow_worker keeps LOGIN (reported)', () => {
    const plan = legacyLoginPlan([
      { name: 'crewflow', login: true, admin: true },
      { name: 'crewflow_app', login: true, admin: true },
      { name: 'crewflow_worker', login: true, admin: false },
    ]);
    expect(plan.statements).toEqual(['ALTER ROLE crewflow NOLOGIN PASSWORD NULL', 'ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL']);
    expect(plan.warnings).toEqual([]);
    expect(plan.info.join(' ')).toMatch(/crewflow_worker keeps its LOGIN attribute .* no password/);
  });

  it('idempotent: already NOLOGIN does nothing; LOGIN without ADMIN is a warning naming the provider-admin statement, never silent', () => {
    expect(legacyLoginPlan([{ name: 'crewflow', login: false, admin: true }, { name: 'crewflow_app', login: false, admin: false }])).toEqual({ statements: [], warnings: [], info: [] });
    const plan = legacyLoginPlan([{ name: 'crewflow_app', login: true, admin: false }]);
    expect(plan.statements).toEqual([]);
    expect(plan.warnings).toEqual([expect.stringMatching(/crewflow_app is still LOGIN .* "ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL" as the provider admin/)]);
  });

  it('ADMIN is read for the session login (crewflow_owner), never assumed', () => {
    expect(LEGACY_LOGIN_FACTS_SQL).toMatch(/a\.member = \(SELECT s\.oid FROM pg_catalog\.pg_roles s WHERE s\.rolname = session_user\)/);
    expect(LEGACY_LOGIN_FACTS_SQL).toMatch(/AND a\.admin_option/);
  });

  it('the committed golden is the owner-login posture; a separated-layout database is compared with exactly two lines swapped', () => {
    const golden = readFileSync(join(__dirname, '..', '..', '..', 'core', 'security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
    expect(golden).toContain('role|crewflow|super=false|bypassrls=false|login=false|member_of=');
    expect(golden).toContain('role|crewflow_app|super=false|bypassrls=false|login=false|member_of=');
    expect(golden.find((l) => l.startsWith('role|crewflow_worker|'))).toMatch(/\|login=true\|/);
    expect(goldenForLayout(golden, true)).toEqual(golden);
    const separated = goldenForLayout(golden, false);
    const changed = separated.filter((l, i) => l !== golden[i]);
    expect(changed.sort()).toEqual(Object.values(SEPARATED_LAYOUT_ROLE_LINES).sort());
  });

  it('the transition SQL removes the legacy logins after granting crewflow_owner, and keeps crewflow_worker LOGIN without a password', () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'rab-docker', 'postgres-init', 'owner-login', 'transition-from-separated.sql'), 'utf8');
    const grant = sql.indexOf('GRANT rab_owner, rab_app, rab_secure_owner, crewflow TO crewflow_owner');
    expect(grant).toBeGreaterThan(0);
    for (const stmt of ['ALTER ROLE crewflow NOLOGIN PASSWORD NULL;', 'ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL;', 'ALTER ROLE crewflow_worker PASSWORD NULL;']) {
      expect(sql.indexOf(stmt)).toBeGreaterThan(grant);
    }
    expect(sql).not.toMatch(/ALTER ROLE crewflow_worker NOLOGIN/);
    // crewflow_migrator (an old login too): NOLOGIN without a password, guarded so a deployment without it does not fail.
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'crewflow_migrator'\) THEN\s+ALTER ROLE crewflow_migrator NOLOGIN PASSWORD NULL;\s+END IF;/);
    expect(sql.indexOf('ALTER ROLE crewflow_migrator NOLOGIN PASSWORD NULL;')).toBeGreaterThan(grant);
  });
});
