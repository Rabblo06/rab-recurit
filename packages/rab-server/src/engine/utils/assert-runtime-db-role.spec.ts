import { DataSource } from 'typeorm';

import { healthyOwnerLoginPosture, OwnerLoginPostureFixture, ownerLoginPostureAnswer } from '../../__tests__/helpers/owner-login-posture-fake';
import { acceptedRuntimeDbRoles, assertRuntimeDbRole, RUNTIME_IDENTITY_SQL, runtimeDbIdentityFor, WORKER_CONNECTION_LABELS } from './assert-runtime-db-role';

/**
 * Runtime identity assertion under the owner-login architecture (owner's final decision 2026-11-04), over a mocked
 * connection. Every process — API, Worker (either claim mode, every Worker connection label), CLI — must be the owner
 * login crewflow_owner itself, with the reviewed role posture (the boot gate's own function, owner-login-posture.ts).
 * What changed is catalogued (owner-login-behaviour-catalogue.ts): BC-01 (owner-role membership is expected, no longer
 * refused) and BC-02 (crewflow_app / crewflow_worker are schema roles; connecting as them is refused). The real-database
 * counterpart is src/__tests__/integration/owner-login-guards.integration.spec.ts.
 */
function fakeSource(facts: { who: string; login?: string; super?: boolean; version?: number; posture?: OwnerLoginPostureFixture }): DataSource {
  const posture = facts.posture ?? healthyOwnerLoginPosture();
  const query = jest.fn(async (sql: string) => {
    if (sql === 'SELECT current_user') return [{ current_user: facts.who }];
    if (sql.startsWith('SELECT rolbypassrls, rolsuper')) return [{ rolbypassrls: false, rolsuper: facts.super === true }];
    if (sql === RUNTIME_IDENTITY_SQL) return [{ session_user: facts.login ?? facts.who, session_super: false, version: facts.version ?? 160015 }];
    const answer = ownerLoginPostureAnswer(sql, posture);
    if (answer) return answer;
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  return { query } as unknown as DataSource;
}

describe('assertRuntimeDbRole — the owner login', () => {
  it('the accepted login is one code constant for every identity; an unknown claim mode accepts none (fail closed)', () => {
    expect(acceptedRuntimeDbRoles()).toEqual(['crewflow_owner']);
    expect(acceptedRuntimeDbRoles({ process: 'api' })).toEqual(['crewflow_owner']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'per_scope' })).toEqual(['crewflow_owner']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'global' })).toEqual(['crewflow_owner']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'bogus' as never })).toEqual([]);
  });

  it('accepts the owner login with the healthy layout, for the API and every Worker identity', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner' }), 'API server')).resolves.toBeUndefined();
    for (const claimMode of ['per_scope', 'global'] as const) {
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner' }), 'worker', { process: 'worker', claimMode })).resolves.toBeUndefined();
    }
  });

  it('BC-02: refuses the legacy logins (schema roles now) with an actionable message', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), 'API server')).rejects.toThrow(/connects as "crewflow_worker", a schema role/);
    for (const who of ['crewflow_app', 'crewflow']) {
      await expect(assertRuntimeDbRole(fakeSource({ who }), 'API server')).rejects.toThrow(new RegExp(`connects as "${who}", not "crewflow_owner".*schema roles now`));
    }
  });

  it('refuses SET ROLE, SUPERUSER / BYPASSRLS and PostgreSQL below 16', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', login: 'someone' }), 'worker')).rejects.toThrow(/SET ROLE is not accepted/);
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', super: true }), 'worker')).rejects.toThrow(/BYPASSRLS\/SUPERUSER/);
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', version: 150008 }), 'API server')).rejects.toThrow(/PostgreSQL 16 or later/);
  });

  it('refuses a drifted role posture (the boot gate rules): a backdoor login, a reachable BYPASSRLS role, a member of crewflow_worker', async () => {
    const backdoor = healthyOwnerLoginPosture();
    backdoor.foreignLogins = [{ login: 'pg_monitor_agent', reaches: 'crewflow' }];
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', posture: backdoor }), 'API server')).rejects.toThrow(/unexpected LOGIN role "pg_monitor_agent"/);
    const bypass = healthyOwnerLoginPosture();
    bypass.reach.push({ role: 'x_bypass', path: 'crewflow_owner>x_bypass', super: false, bypassrls: true, createdb: false, replication: false, is_login: false });
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', posture: bypass }), 'API server')).rejects.toThrow(/"x_bypass" has BYPASSRLS/);
    const workerMember = healthyOwnerLoginPosture();
    workerMember.memberships.push({ role: 'crewflow_worker', role_login: true, member: 'crewflow_owner', member_login: true, member_super: false, admin: false, inherit: true, set: false });
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner', posture: workerMember }), 'worker')).rejects.toThrow(/not in the owner-login layout/);
  });

  describe('Worker connection labels (worker, worker-direct, worker-scan-lock, worker-wake-listener)', () => {
    const saved = process.env.WORKER_CLAIM_MODE;
    afterEach(() => {
      if (saved === undefined) delete process.env.WORKER_CLAIM_MODE;
      else process.env.WORKER_CLAIM_MODE = saved;
    });

    it('the labels are exact code constants; anything else is the API identity', () => {
      expect(WORKER_CONNECTION_LABELS).toEqual(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener']);
      expect(runtimeDbIdentityFor('API server', { WORKER_CLAIM_MODE: 'global' })).toEqual({ process: 'api' });
      expect(runtimeDbIdentityFor('worker-x', {})).toEqual({ process: 'api' });
      expect(runtimeDbIdentityFor('worker', {})).toEqual({ process: 'worker', claimMode: 'per_scope' });
      expect(runtimeDbIdentityFor('worker-wake-listener', { WORKER_CLAIM_MODE: 'global' })).toEqual({ process: 'worker', claimMode: 'global' });
    });

    it.each(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener'])('%s accepts the owner login in both claim modes and refuses the legacy logins', async (label) => {
      for (const mode of [undefined, 'global']) {
        if (mode === undefined) delete process.env.WORKER_CLAIM_MODE;
        else process.env.WORKER_CLAIM_MODE = mode;
        await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner' }), label)).resolves.toBeUndefined();
        await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), label)).rejects.toThrow(/schema role/);
        await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), label)).rejects.toThrow(/not "crewflow_owner"/);
      }
    });

    it('an invalid WORKER_CLAIM_MODE accepts no role on a Worker label (fail closed)', async () => {
      process.env.WORKER_CLAIM_MODE = 'GLOBAL';
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_owner' }), 'worker')).rejects.toThrow(/no accepted role/);
    });
  });
});
