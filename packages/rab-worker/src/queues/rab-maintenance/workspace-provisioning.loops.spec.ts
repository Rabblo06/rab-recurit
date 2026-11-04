import { EventEmitter } from 'node:events';
import { Client } from 'pg';

import { DatabaseReconnectDeferredError, ReconnectingPgClient } from '../../core/database/reconnecting-pg-client';
import { runtimeEnvRefusal } from '@rab/server/database/typeorm/core/never-in-runtime-env';
import { ProvisionerConfigError, resolveInProcessProvisioningInterval } from '../../workspace-provisioner.config';
import { actAsProvisioningRole, assertProvisioningIdentity, ProvisioningIdentityError } from './workspace-provisioning.loops';

/**
 * Owner-login architecture (T4): the in-process provisioner's session acts as crewflow (SET ROLE) on its own dedicated
 * connection, on every (re)connect; a login that cannot is refused before any cycle; an already-crewflow or superuser login
 * is untouched (the superseded provisioner and the test suites behave exactly as before).
 */
function identityClient(facts: { who: string; superuser?: boolean; can_set?: boolean; after?: string }) {
  const statements: string[] = [];
  let current = facts.who;
  return {
    statements,
    client: {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.startsWith('SET ROLE')) {
          current = facts.after ?? 'crewflow';
          return { rows: [] };
        }
        if (sql.includes('can_set')) return { rows: [{ who: facts.who, superuser: facts.superuser ?? false, can_set: facts.can_set ?? false }] };
        return { rows: [{ who: current }] };
      },
    } as unknown as Client,
  };
}

describe('actAsProvisioningRole (in-process provisioning identity)', () => {
  it('the owner login (SET on crewflow) → SET ROLE crewflow, verified', async () => {
    const h = identityClient({ who: 'crewflow_owner', can_set: true });
    await expect(actAsProvisioningRole(h.client)).resolves.toBe('set-role');
    expect(h.statements).toContain('SET ROLE crewflow');
    expect(h.statements.at(-1)).toBe('SELECT current_user::text AS who');
  });

  it('already crewflow (the superseded separate provisioner) or the bootstrap superuser (tests) → unchanged, no SET ROLE', async () => {
    for (const facts of [{ who: 'crewflow' }, { who: 'ci_bootstrap', superuser: true }]) {
      const h = identityClient(facts);
      await expect(actAsProvisioningRole(h.client)).resolves.toBe('unchanged');
      expect(h.statements.some((s) => s.startsWith('SET ROLE'))).toBe(false);
    }
  });

  it('a login that cannot SET crewflow (crewflow_app, crewflow_worker, any other) is refused, naming the login only', async () => {
    for (const who of ['crewflow_app', 'crewflow_worker', 'someone_else']) {
      const h = identityClient({ who, can_set: false });
      await expect(actAsProvisioningRole(h.client)).rejects.toThrow(ProvisioningIdentityError);
      await expect(actAsProvisioningRole(identityClient({ who, can_set: false }).client)).rejects.toThrow(new RegExp(`refuses the login "${who}": it cannot act as crewflow`));
      expect(h.statements.some((s) => s.startsWith('SET ROLE'))).toBe(false);
    }
  });

  it('SET ROLE that did not take effect is refused (never provision under the wrong identity)', async () => {
    await expect(actAsProvisioningRole(identityClient({ who: 'crewflow_owner', can_set: true, after: 'crewflow_owner' }).client)).rejects.toThrow(/did not take effect/);
  });
});

class FakeClient extends EventEmitter {
  ended = 0;
  async connect(): Promise<void> {}
  async end(): Promise<void> {
    this.ended += 1;
  }
}

describe('ReconnectingPgClient onConnect (the provisioning session identity is re-asserted on every reconnect)', () => {
  it('runs on each NEW connection before it is handed out; a failure counts as a failed connect (closed, backoff, rethrown)', async () => {
    let now = 1_000_000;
    const created: FakeClient[] = [];
    const seen: FakeClient[] = [];
    let fail = true;
    const holder = new ReconnectingPgClient(
      { connectionString: 'postgres://unused' },
      {
        label: 'provisioning',
        logger: { log: () => undefined, warn: () => undefined },
        initialBackoffMs: 1_000,
        now: () => now,
        createClient: () => {
          const c = new FakeClient();
          created.push(c);
          return c as unknown as Client;
        },
        onConnect: async (client) => {
          seen.push(client as unknown as FakeClient);
          if (fail) throw new ProvisioningIdentityError('cannot act as crewflow');
        },
      },
    );
    await expect(holder.acquire()).rejects.toThrow(ProvisioningIdentityError);
    expect(created[0]!.ended).toBe(1); // a connection whose setup failed is never used
    await expect(holder.acquire()).rejects.toThrow(DatabaseReconnectDeferredError); // backoff applies
    now += 1_000;
    fail = false;
    const client = await holder.acquire();
    expect(client).toBe(created[1]);
    expect(await holder.acquire()).toBe(client); // healthy: no new connection, no second onConnect
    expect(seen).toEqual([created[0], created[1]]);
    created[1]!.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' }));
    await holder.acquire(); // reconnect → onConnect again
    expect(seen).toHaveLength(3);
  });
});

describe('per-cycle identity re-check (Agent 3): the session must still be crewflow, else the connection is reopened', () => {
  it('assertProvisioningIdentity: crewflow passes; anything else (a RESET ROLE left the owner login) is refused', async () => {
    const as = (who: string) => ({ query: async () => ({ rows: [{ who }] }) }) as unknown as Client;
    await expect(assertProvisioningIdentity(as('crewflow'))).resolves.toBeUndefined();
    for (const who of ['crewflow_owner', 'rab_secure_owner', 'crewflow_app']) {
      await expect(assertProvisioningIdentity(as(who))).rejects.toThrow(ProvisioningIdentityError);
      await expect(assertProvisioningIdentity(as(who))).rejects.toThrow(new RegExp(`the session is "${who}", not crewflow`));
    }
  });

  it('invalidate(): the next acquire opens a fresh connection and runs onConnect again (no backoff); a stale client is ignored', async () => {
    const created: FakeClient[] = [];
    let connects = 0;
    const holder = new ReconnectingPgClient(
      { connectionString: 'postgres://unused' },
      {
        label: 'provisioning',
        logger: { log: () => undefined, warn: () => undefined },
        createClient: () => {
          const c = new FakeClient();
          created.push(c);
          return c as unknown as Client;
        },
        onConnect: async () => void (connects += 1),
      },
    );
    const first = await holder.acquire();
    holder.invalidate(created[0] as unknown as Client, 'the session is no longer crewflow');
    const second = await holder.acquire();
    expect(second).not.toBe(first);
    expect(created[0]!.ended).toBe(1);
    expect(connects).toBe(2);
    holder.invalidate(first, 'stale'); // no longer the held client: no effect
    expect(await holder.acquire()).toBe(second);
  });
});

/**
 * Agent 5's review — in-process equivalents of the superseded provisioner process tests that need no database (the
 * database ones are in workspace-provisioning-owner-login.integration.spec.ts):
 *   opt-in 3a / 3b ("not enabled → exit 0 before any connection"): there is no on/off switch in-process; the replacement
 *     guarantee is that the switch itself is REFUSED on the Worker by the runtime guard, a pure check that runs before the
 *     Worker opens any connection (main.ts: assertRuntimeDatabaseIdentity before the identity probe);
 *   opt-in 4 ("an invalid switch or interval refuses, names the variable only, opens no connection"): the interval parser
 *     refuses before startWorkspaceProvisioningLoops is ever called.
 */
describe('in-process provisioning configuration (opt-in 3a / 3b / 4 equivalents)', () => {
  it('3a/3b: CREWFLOW_PROVISIONER_ENABLED (true, false, anything) is refused on the Worker by name, before any connection', () => {
    for (const value of ['true', 'false', 'yes']) {
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', CREWFLOW_PROVISIONER_ENABLED: value }, 'worker')?.name).toBe('CREWFLOW_PROVISIONER_ENABLED');
    }
    expect(runtimeEnvRefusal({ NODE_ENV: 'development', CREWFLOW_PROVISIONER_ENABLED: '' }, 'worker')).toBeNull();
  });

  it('4: an invalid WORKSPACE_PROVISIONER_INTERVAL_SECONDS refuses (ProvisionerConfigError), names the variable only', () => {
    for (const value of ['4', '121', '5s', '1e1', 'S3cret']) {
      let message = '';
      try {
        resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: value });
      } catch (error) {
        expect(error).toBeInstanceOf(ProvisionerConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/^WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120/);
      expect(message).not.toContain('S3cret');
    }
    expect(resolveInProcessProvisioningInterval({})).toEqual({ intervalSeconds: 60, intervalMs: 60_000 });
    expect(resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '5' })).toEqual({ intervalSeconds: 5, intervalMs: 5_000 });
  });
});
