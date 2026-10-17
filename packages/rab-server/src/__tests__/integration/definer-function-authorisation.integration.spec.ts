import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-13 / CF-30 / CF-12 (October 15 audit), at the database layer, as the real runtime role `crewflow_app` with SQL an
 * application bug or an injection could run. SECURITY DEFINER functions bypass RLS as their owner, so each must authorise
 * the caller itself. Every case binds a tenant context exactly the way TenantContextService does.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-13 SECURITY DEFINER in-function authorisation (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let a: TestIdentity;
  let b: TestIdentity;
  let admin: TestIdentity;
  const { appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  /** One transaction as crewflow_app with the given identity bound (same GUCs as TenantContextService). */
  async function asApp<T>(bind: { org: string | null; uid: string | null; ws?: string | null }, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`, [
        bind.org ?? '',
        bind.uid ?? '',
        bind.ws ?? '',
      ]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf13a' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf13b' })).managers[0]!;
    admin = (await factory.createOrganisationWithManagers(1, { permissions: 'production', firstIsPlatformAdmin: true, workspace: true, label: 'cf13p' })).managers[0]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('auth_find_password_hash_by_user_id answers only for the bound user in the bound organisation', async () => {
    const own = await asApp({ org: a.organisationId, uid: a.userId }, (c) => c.query(`SELECT * FROM core.auth_find_password_hash_by_user_id($1)`, [a.userId]));
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0].passwordHash).toEqual(expect.any(String));
    // Another organisation's user, from A's context: nothing (previously the hash).
    expect((await asApp({ org: a.organisationId, uid: a.userId }, (c) => c.query(`SELECT * FROM core.auth_find_password_hash_by_user_id($1)`, [b.userId]))).rows).toEqual([]);
    // Even with B's organisation bound, asking for B while acting as A: nothing.
    expect((await asApp({ org: b.organisationId, uid: a.userId }, (c) => c.query(`SELECT * FROM core.auth_find_password_hash_by_user_id($1)`, [b.userId]))).rows).toEqual([]);
    // No context at all: nothing.
    expect((await asApp({ org: null, uid: null }, (c) => c.query(`SELECT * FROM core.auth_find_password_hash_by_user_id($1)`, [a.userId]))).rows).toEqual([]);
  });

  it('list_organisations_for_admin returns rows only to an active platform administrator', async () => {
    expect((await asApp({ org: a.organisationId, uid: a.userId }, (c) => c.query(`SELECT id FROM core.list_organisations_for_admin()`))).rows).toEqual([]);
    expect((await asApp({ org: null, uid: null }, (c) => c.query(`SELECT id FROM core.list_organisations_for_admin()`))).rows).toEqual([]);
    const forAdmin = await asApp({ org: admin.organisationId, uid: admin.userId }, (c) => c.query(`SELECT id FROM core.list_organisations_for_admin()`));
    expect(forAdmin.rows.map((r) => r.id)).toEqual(expect.arrayContaining([a.organisationId, b.organisationId]));
  });

  it('create_organisation refuses anyone but an active platform administrator', async () => {
    await expect(
      asApp({ org: a.organisationId, uid: a.userId }, (c) => c.query(`SELECT core.create_organisation('Forged', 'forged-cf13')`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asApp({ org: null, uid: null }, (c) => c.query(`SELECT core.create_organisation('Forged', 'forged-cf13b')`))).rejects.toMatchObject({ code: '42501' });
  });

  it('mark_workspace_schema_superseded cannot touch another organisation’s workspace (reads as not found)', async () => {
    await expect(
      asApp({ org: a.organisationId, uid: a.userId }, (c) => c.query(`SELECT core.mark_workspace_schema_superseded($1, 'forged')`, [b.workspaceId])),
    ).rejects.toMatchObject({ code: 'P0002' });
    const [ws] = await owner.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [b.workspaceId]);
    expect(ws.schema_status).not.toBe('SUPERSEDED');
  });

  it('CF-30: a session bound to workspace B cannot delete a role assignment of a role it cannot see', async () => {
    // A's canonical role assignment lives in organisation A; from organisation B (or a foreign workspace) nothing is deleted.
    const [before] = await owner.query(`SELECT count(*)::int AS n FROM core.user_role WHERE user_id = $1`, [a.userId]);
    const deleted = await asApp({ org: b.organisationId, uid: b.userId, ws: b.workspaceId }, (c) => c.query(`DELETE FROM core.user_role WHERE user_id = $1`, [a.userId]));
    expect(deleted.rowCount).toBe(0);
    const [after] = await owner.query(`SELECT count(*)::int AS n FROM core.user_role WHERE user_id = $1`, [a.userId]);
    expect(after.n).toBe(before.n);
  });

  it('CF-12 / CF-58: no SECURITY DEFINER function resolves core before pg_catalog, and none leaves pg_temp unpinned', async () => {
    const rows = await owner.query(
      `SELECT p.oid::regprocedure::text AS fn, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p
        WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=pg_catalog%')`,
    );
    expect(rows).toEqual([]);
  });
});
