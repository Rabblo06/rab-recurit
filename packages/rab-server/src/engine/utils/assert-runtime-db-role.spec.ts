import { DataSource } from 'typeorm';

import { acceptedRuntimeDbRoles, assertRuntimeDbRole, RUNTIME_IDENTITY_SQL, runtimeDbIdentityFor, WORKER_CONNECTION_LABELS } from './assert-runtime-db-role';

/**
 * Phase D (D2) runtime identity assertion over a mocked connection: the API keeps exactly crewflow_app and refuses the
 * Worker-only crewflow_worker login; a Worker connection accepts crewflow_app|crewflow_worker (per_scope) or
 * crewflow_worker only (global). The real-database counterpart (needs the crewflow_worker role) is
 * src/__tests__/integration/worker-identity-boot-gates.integration.spec.ts — written, NOT run.
 */
function fakeSource(facts: { who: string; login?: string; super?: boolean; ownerRoles?: string | null; workerMember?: boolean }): DataSource {
  const query = jest.fn(async (sql: string) => {
    if (sql === 'SELECT current_user') return [{ current_user: facts.who }];
    if (sql.startsWith('SELECT rolbypassrls, rolsuper')) return [{ rolbypassrls: false, rolsuper: facts.super === true }];
    if (sql === RUNTIME_IDENTITY_SQL) {
      return [{ session_user: facts.login ?? facts.who, session_super: false, owner_roles: facts.ownerRoles ?? null, worker_member: facts.workerMember ?? facts.who === 'crewflow_worker' }];
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  return { query } as unknown as DataSource;
}

describe('assertRuntimeDbRole — Phase D identities', () => {
  it('accepted roles are code constants per identity', () => {
    expect(acceptedRuntimeDbRoles()).toEqual(['crewflow_app']);
    expect(acceptedRuntimeDbRoles({ process: 'api' })).toEqual(['crewflow_app']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'per_scope' })).toEqual(['crewflow_app', 'crewflow_worker']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'global' })).toEqual(['crewflow_worker']);
    expect(acceptedRuntimeDbRoles({ process: 'worker', claimMode: 'bogus' as never })).toEqual([]);
  });

  it('the API (default identity) refuses crewflow_worker with a clear message', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), 'API server')).rejects.toThrow(
      /API server connects as "crewflow_worker", the Worker-only login .* must connect as crewflow_app/,
    );
  });

  it('the API refuses a crewflow_app login that is a member of crewflow_worker', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app', workerMember: true }), 'API server')).rejects.toThrow(/member of crewflow_worker/);
  });

  it('the API still accepts crewflow_app', async () => {
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), 'API server')).resolves.toBeUndefined();
  });

  it('a per_scope Worker accepts crewflow_app and crewflow_worker', async () => {
    const id = { process: 'worker', claimMode: 'per_scope' } as const;
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), 'worker', id)).resolves.toBeUndefined();
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), 'worker', id)).resolves.toBeUndefined();
  });

  it('a global Worker refuses crewflow_app and accepts crewflow_worker', async () => {
    const id = { process: 'worker', claimMode: 'global' } as const;
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), 'worker', id)).rejects.toThrow(/WORKER_CLAIM_MODE=global requires the worker to connect as "crewflow_worker"/);
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), 'worker', id)).resolves.toBeUndefined();
  });

  it('owner-role membership and SET ROLE refuse for the Worker login as for the API', async () => {
    const id = { process: 'worker', claimMode: 'per_scope' } as const;
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker', ownerRoles: 'crewflow' }), 'worker', id)).rejects.toThrow(/can act as crewflow/);
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker', login: 'crewflow' }), 'worker', id)).rejects.toThrow(/SET ROLE is not accepted/);
    await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow' }), 'worker', id)).rejects.toThrow(/Refusing to start: DATABASE_URL connects as "crewflow"/);
  });

  describe('Worker connection labels (B change request: worker, worker-direct, worker-scan-lock, worker-wake-listener)', () => {
    const saved = process.env.WORKER_CLAIM_MODE;
    afterEach(() => {
      if (saved === undefined) delete process.env.WORKER_CLAIM_MODE;
      else process.env.WORKER_CLAIM_MODE = saved;
    });

    it('the labels are exact code constants; anything else is the API identity', () => {
      expect(WORKER_CONNECTION_LABELS).toEqual(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener']);
      expect(runtimeDbIdentityFor('API server', { WORKER_CLAIM_MODE: 'global' })).toEqual({ process: 'api' });
      expect(runtimeDbIdentityFor('worker-x', {})).toEqual({ process: 'api' });
      expect(runtimeDbIdentityFor('Worker', {})).toEqual({ process: 'api' });
      expect(runtimeDbIdentityFor('worker', {})).toEqual({ process: 'worker', claimMode: 'per_scope' });
      expect(runtimeDbIdentityFor('worker-wake-listener', { WORKER_CLAIM_MODE: 'global' })).toEqual({ process: 'worker', claimMode: 'global' });
    });

    it.each(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener'])('%s accepts crewflow_worker (per_scope and global) and refuses crewflow_app in global', async (label) => {
      delete process.env.WORKER_CLAIM_MODE;
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), label)).resolves.toBeUndefined();
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), label)).resolves.toBeUndefined();
      process.env.WORKER_CLAIM_MODE = 'global';
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), label)).resolves.toBeUndefined();
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), label)).rejects.toThrow(/WORKER_CLAIM_MODE=global/);
    });

    it('an invalid WORKER_CLAIM_MODE accepts no role on a Worker label (fail closed)', async () => {
      process.env.WORKER_CLAIM_MODE = 'GLOBAL';
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), 'worker')).rejects.toThrow(/Refusing to start/);
      await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_app' }), 'worker')).rejects.toThrow(/Refusing to start/);
    });

    it('API labels refuse crewflow_worker whatever WORKER_CLAIM_MODE says', async () => {
      process.env.WORKER_CLAIM_MODE = 'global';
      for (const label of ['API server', 'api prestart check', 'storage reconciliation', 'AI worker (ai-e2e test boot)']) {
        await expect(assertRuntimeDbRole(fakeSource({ who: 'crewflow_worker' }), label)).rejects.toThrow(/Worker-only login/);
      }
    });
  });

  it('membership is tested with MEMBER for current_user and session_user (USAGE missed INHERIT FALSE, SET TRUE grants)', () => {
    expect(RUNTIME_IDENTITY_SQL).toMatch(/pg_has_role\(current_user, r\.oid, 'MEMBER'\) OR pg_has_role\(session_user, r\.oid, 'MEMBER'\)/);
    expect(RUNTIME_IDENTITY_SQL).not.toMatch(/'USAGE'/);
  });
});
