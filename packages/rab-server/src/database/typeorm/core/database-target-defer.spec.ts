/**
 * Phase B / B3 + CF-41 (M2 harness regression): the command target guard's read-only probe must not pre-empt CF-41's own
 * refusal of a migration login without its owner-role memberships. Such a login has no USAGE on schema core, so reading the
 * deployment identity marker fails with SQLSTATE 42501. With `deferUnreadableMarker` the probe reports `identityDeferred`
 * instead of refusing; the caller (GuardedMigrationDataSource, the locked runner) runs CF-41 and then
 * assertDeferredDeploymentIdentity on its own session, which ALWAYS refuses a login that still cannot read the marker.
 * Without the option nothing changes: 42501 is a refusal.
 */
type Row = Record<string, unknown>;
type Responder = (sql: string) => Row[] | Error;

let respond: Responder = () => [];

jest.mock('../../postgres', () => {
  const actual = jest.requireActual('../../postgres');
  return {
    ...actual,
    createPgClient: jest.fn(() => ({
      connect: async () => undefined,
      end: async () => undefined,
      query: async (sql: string) => {
        const result = respond(sql);
        if (result instanceof Error) throw result;
        return { rows: result };
      },
    })),
  };
});

import { createPgClient } from '../../postgres';
import { MARKER_PRESENT_SQL, MARKER_READ_SQL } from '../../deployment-identity/deployment-identity';
import { assertDbTarget, assertDeferredDeploymentIdentity, DbTargetError } from './database-target';

const LOCAL = 'postgres://crewflow_migrator:not-a-real-password@127.0.0.1:5432/rab';
const ENV = { DB_TARGET: 'test', PG_DATABASE_URL: LOCAL };
const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const privilegeError = () => Object.assign(new Error('permission denied for schema core'), { code: '42501' });
const BASE: Responder = (sql) => (sql.includes('pg_control_system') ? [{ db: 'rab', sid: '7300000000000000001' }] : []);

function scenario(marker: Responder): void {
  respond = (sql) => (sql.includes('pg_control_system') ? BASE(sql) : marker(sql));
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (createPgClient as jest.Mock).mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe('database-target: an unreadable marker (42501) and CF-41', () => {
  it('the probe is a factory client opened read-only for the migration identity (never a raw URL)', async () => {
    scenario((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: false, database: 'rab' }] : []));
    await assertDbTarget('migrations', ENV, {});
    const [, request] = (createPgClient as jest.Mock).mock.calls[0];
    expect(request).toMatchObject({ endpoint: 'primary', purpose: 'probe', readOnly: true });
    const [resolved] = (createPgClient as jest.Mock).mock.calls[0];
    expect(resolved.processRole).toBe('migrate');
  });

  it('without the option, 42501 on the presence check or on the marker read is a refusal (unchanged)', async () => {
    scenario(() => privilegeError());
    await expect(assertDbTarget('migrations', ENV, {})).rejects.toThrow(/deployment identity check failed \(SQLSTATE 42501\)/);
    scenario((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : privilegeError()));
    await expect(assertDbTarget('migrations', ENV, {})).rejects.toThrow(/marker exists but could not be read \(SQLSTATE 42501\)/);
  });

  it('with the option, 42501 is deferred (identityDeferred) — on the presence check and on the marker read', async () => {
    scenario(() => privilegeError());
    await expect(assertDbTarget('migrations', ENV, {}, { deferUnreadableMarker: true })).resolves.toMatchObject({ identityDeferred: true, target: 'test' });
    scenario((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : privilegeError()));
    await expect(assertDbTarget('migrations', ENV, {}, { deferUnreadableMarker: true })).resolves.toMatchObject({ identityDeferred: true });
  });

  it('the option defers ONLY 42501: a wrong or production-bound marker is still refused at once', async () => {
    scenario((sql) =>
      sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : sql === MARKER_READ_SQL ? [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'rab', bound_hosts: [new URL(LOCAL).hostname] }] : [],
    );
    await expect(assertDbTarget('migrations', ENV, {}, { deferUnreadableMarker: true })).rejects.toThrow(/bound to production/);
    scenario(() => Object.assign(new Error('boom'), { code: '57P01' }));
    await expect(assertDbTarget('migrations', ENV, {}, { deferUnreadableMarker: true })).rejects.toThrow(/SQLSTATE 57P01/);
  });

  it('a readable marker is never deferred', async () => {
    scenario((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: false, database: 'rab' }] : []));
    await expect(assertDbTarget('migrations', ENV, {}, { deferUnreadableMarker: true })).resolves.toMatchObject({ identityDeferred: false });
  });
});

describe('assertDeferredDeploymentIdentity (the check the caller owes after CF-41): never a pass for an unreadable marker', () => {
  const at = { label: 'PG_DATABASE_URL', host: '127.0.0.1', port: '5432', database: 'rab', endpointKey: '127.0.0.1:5432', pooled: false, remote: false };
  const target = { purpose: 'migrations', target: 'test' as const, app: at, admin: null, migrationEndpoint: 'primary' as const };
  const query = (responder: Responder) => async (sql: string) => {
    const result = responder(sql);
    if (result instanceof Error) throw result;
    return result;
  };

  it('still unreadable on the migration session → refused, naming the SQLSTATE', async () => {
    await expect(assertDeferredDeploymentIdentity(query(() => privilegeError()), target, {})).rejects.toBeInstanceOf(DbTargetError);
    await expect(assertDeferredDeploymentIdentity(query(() => privilegeError()), target, {})).rejects.toThrow(
      /cannot read the deployment identity marker \(SQLSTATE 42501\); a migration identity must be able to/,
    );
    const readDenied = query((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : privilegeError()));
    await expect(assertDeferredDeploymentIdentity(readDenied, target, {})).rejects.toThrow(/SQLSTATE 42501/);
  });

  it('readable on the migration session → the ordinary marker rules decide (pass, or refuse a production-bound database)', async () => {
    await expect(assertDeferredDeploymentIdentity(query((sql) => (sql === MARKER_PRESENT_SQL ? [{ present: false, database: 'rab' }] : [])), target, {})).resolves.toBeUndefined();
    const bound = query((sql) =>
      sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'rab', bound_hosts: ['127.0.0.1'] }],
    );
    await expect(assertDeferredDeploymentIdentity(bound, target, {})).rejects.toThrow(/bound to production/);
    // Owner decision A: a test-bound marker carried into another host (a restore elsewhere) refuses the migration session too.
    const elsewhere = query((sql) =>
      sql === MARKER_PRESENT_SQL ? [{ present: true, database: 'rab' }] : [{ environment: 'test', deployment_id: PROD_ID, bound_database: 'rab', bound_hosts: ['origin.example.internal'] }],
    );
    await expect(assertDeferredDeploymentIdentity(elsewhere, target, {})).rejects.toThrow(/bound at host "origin\.example\.internal"/);
    // Only the rebind command reads it (as a warning): that is its job.
    await expect(assertDeferredDeploymentIdentity(elsewhere, { ...target, purpose: 'db:bind-identity' }, {})).resolves.toBeUndefined();
  });
});
