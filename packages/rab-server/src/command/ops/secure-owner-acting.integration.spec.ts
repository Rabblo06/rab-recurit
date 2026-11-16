import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { DataSource, QueryRunner } from 'typeorm';

import { setPgProcessRole } from '../../database/postgres/pg-config';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource, createCrewflowOwnerProbeDataSource } from '../../__tests__/integration/helpers/admin-datasource';
import { inSecureOwnerTransaction, withSecureOwner } from './secure-owner-acting';

const describeIfDb = integrationTestDatabaseReady() ? describe : describe.skip;

/**
 * O-2 review: the owner-acting step proved on ONE held connection. A pooled check cannot fail, because the pool's acquire
 * hook runs RESET ROLE on every checkout (session-role-reset.ts); a QueryRunner keeps one connection for every statement
 * below, so a role left behind by the step would be visible here. The negative control shows the probe does see a
 * session-level role that survives COMMIT.
 */
describeIfDb('withSecureOwner on one held crewflow_owner connection (O-2)', () => {
  let owner: DataSource;
  let admin: DataSource;
  let qr: QueryRunner;
  let orgSlug: string;

  const actingOn = async (runner: QueryRunner): Promise<string> => ((await runner.query(`SELECT current_user::text AS u`)) as Array<{ u: string }>)[0]!.u;

  beforeAll(async () => {
    owner = createCrewflowOwnerProbeDataSource();
    await owner.initialize();
    admin = createAdminDataSource();
    await admin.initialize();
    orgSlug = `o2-held-${randomUUID().slice(0, 8)}`;
    await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2)`, [orgSlug, orgSlug]);
    setPgProcessRole('cli');
  });

  beforeEach(async () => {
    qr = owner.createQueryRunner();
    await qr.connect();
  });

  afterEach(async () => {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    await qr.query('RESET ROLE');
    await qr.release();
    setPgProcessRole('cli');
  });

  afterAll(async () => {
    setPgProcessRole('api');
    await owner.destroy();
    await admin.destroy();
  });

  it('the held connection is crewflow_owner, not superuser, and sees no organisation acting as itself', async () => {
    const [who] = await qr.query(`SELECT current_user AS u, r.rolsuper AS su, r.rolbypassrls AS b FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
    expect(who).toEqual({ u: 'crewflow_owner', su: false, b: false });
    expect(await qr.query(`SELECT 1 FROM core.organisation WHERE slug = $1`, [orgSlug])).toHaveLength(0);
  });

  it('negative control: a session-level SET ROLE survives COMMIT on this connection, so the probe below can see a leak', async () => {
    await qr.startTransaction();
    await qr.query('SET ROLE rab_secure_owner');
    await qr.commitTransaction();
    expect(await actingOn(qr)).toBe('rab_secure_owner');
  });

  it('inside fn the session is rab_secure_owner and sees the row; after fn, still in the transaction, it is the login; after COMMIT too', async () => {
    await qr.startTransaction();
    const seen = await withSecureOwner(qr.manager, async (m) => ({
      acting: ((await m.query(`SELECT current_user::text AS u`)) as Array<{ u: string }>)[0]!.u,
      rows: ((await m.query(`SELECT 1 FROM core.organisation WHERE slug = $1`, [orgSlug])) as unknown[]).length,
    }));
    expect(seen).toEqual({ acting: 'rab_secure_owner', rows: 1 });
    expect(await actingOn(qr)).toBe('crewflow_owner');
    await qr.commitTransaction();
    expect(await actingOn(qr)).toBe('crewflow_owner');
  });

  it('when fn fails, ROLLBACK alone ends the narrowing on this connection', async () => {
    await qr.startTransaction();
    await expect(withSecureOwner(qr.manager, (m) => m.query('SELECT 1/0'))).rejects.toThrow(/division by zero/);
    await qr.rollbackTransaction();
    expect(await actingOn(qr)).toBe('crewflow_owner');
  });

  it('refuses on the API process role (same login): nothing is narrowed', async () => {
    setPgProcessRole('api');
    await qr.startTransaction();
    await expect(withSecureOwner(qr.manager, async () => 'ran')).rejects.toThrow(/process is "api", not the CLI/);
    expect(await actingOn(qr)).toBe('crewflow_owner');
  });

  it('refuses outside a transaction', async () => {
    await expect(withSecureOwner(qr.manager, async () => 'ran')).rejects.toThrow(/no open transaction/);
    expect(await actingOn(qr)).toBe('crewflow_owner');
  });

  it('a READ ONLY owner transaction refuses writes even as the table owner', async () => {
    await expect(
      inSecureOwnerTransaction(owner, { readOnly: true }, (m) => m.query(`UPDATE core.organisation SET name = name WHERE slug = $1`, [orgSlug])),
    ).rejects.toMatchObject({ code: '25006' });
  });
});
