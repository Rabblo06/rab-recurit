import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { BusinessTablesError, businessTables, SEARCH_PATH_TRAP_VAR } from '../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessSchema } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Part C2-0 (HWS-AUDIT-C2-SIZING.md §5/§7) on REAL PostgreSQL, through the real TenantContextService of the AppModule, in
 * whichever HWS mode this job runs (workspace schema with HWS on, the core copies with it off):
 *   - businessTables(manager) names exactly the schema the binder routed the transaction to, and a `${t.<table>}` query reads
 *     and writes the same rows an unqualified one does today (search_path is still bound: behaviour identical);
 *   - the binding never outlives its transaction;
 *   - the test-only trap (CREWFLOW_TEST_SEARCH_PATH_TRAP=true, NODE_ENV=test) binds search_path '' — a qualified name still
 *     works, an unqualified business table fails with 42P01 (undefined_table) instead of resolving through routing, and
 *     built-ins (pg_catalog) keep working.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

// The trap may also be on for the whole run (the non-required C2 trap CI job): this file restores whatever it found, never
// deletes it, because --runInBand suites share one process.env.
const TRAP_AT_START = process.env[SEARCH_PATH_TRAP_VAR];
const restoreTrap = () => {
  if (TRAP_AT_START === undefined) delete process.env[SEARCH_PATH_TRAP_VAR];
  else process.env[SEARCH_PATH_TRAP_VAR] = TRAP_AT_START;
};

const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ACCEPTED',
    (e: { code?: string; driverError?: { code?: string } }) => e.driverError?.code ?? e.code ?? 'NO-CODE',
  );

describeIfDb('C2-0 businessTables(manager) and the search_path trap (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let orgId: string;
  let mgr: TestIdentity;

  const ctx = () => ({ organisationId: orgId, workspaceId: mgr.workspaceId!, userId: mgr.userId, role: '' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const org = await factory.createOrganisation('c2-0-bt');
    orgId = org.id;
    mgr = await factory.createInternalManager(org, { label: 'c2-0-bt' });
  });

  afterEach(restoreTrap);

  afterAll(async () => {
    restoreTrap();
    await app?.close();
    await adminDataSource?.destroy();
  });

  it('names the routed schema; a ${t.venue} write is read back by the unqualified (search_path) query, and vice versa', async () => {
    delete process.env[SEARCH_PATH_TRAP_VAR]; // trap off for this case (restored after each test)
    const schema = businessSchema(mgr.workspaceId!);
    const result = await tenantContext.runInWorkspaceContext(ctx(), async (m, bound) => {
      const t = businessTables(m);
      const [path] = await m.query<Array<{ schemas: string }>>(`SELECT current_schemas(false)::text AS schemas`);
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO ${t.venue} (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, 'C2-0 qualified venue', mgr.userId, mgr.workspaceId],
      );
      const viaPath = await m.query<Array<{ id: string }>>(`SELECT id FROM venue WHERE id = $1`, [row!.id]);
      const viaQualified = await m.query<Array<{ id: string }>>(`SELECT id FROM ${t.venue} WHERE id = $1`, [row!.id]);
      return { bound, venue: t.venue, schemas: path!.schemas, viaPath: viaPath.length, viaQualified: viaQualified.length, id: row!.id };
    });
    expect(result.bound).toBe(schema);
    expect(result.venue).toBe(`"${schema}"."venue"`);
    expect(result.schemas).toBe(`{${schema}}`); // search_path still bound to exactly that schema (trap off)
    expect(result.viaPath).toBe(1);
    expect(result.viaQualified).toBe(1);
    // The row is physically in that schema (superuser fixture connection, no routing involved).
    const physical = (await adminDataSource.query(`SELECT 1 FROM "${schema}"."venue" WHERE id = $1`, [result.id])) as unknown[];
    expect(physical).toHaveLength(1);
  });

  it('the binding never outlives its transaction (the manager, and a kept `t`)', async () => {
    let kept: { m: EntityManager; t: ReturnType<typeof businessTables> } | undefined;
    await tenantContext.runInWorkspaceContext(ctx(), async (m) => {
      kept = { m, t: businessTables(m) };
      await m.query(`SELECT count(*) FROM ${kept.t.shift}`);
    });
    expect(() => businessTables(kept!.m)).toThrow(BusinessTablesError);
    expect(() => kept!.t.shift).toThrow(BusinessTablesError);
  });

  it('a workspace-less tenant context is bound to "core"', async () => {
    const names = await tenantContext.runInTenantContext({ ...ctx(), workspaceId: null }, async (m) => {
      const t = businessTables(m);
      await m.query(`SELECT count(*) FROM ${t.shift_assignment}`);
      return t.shift_assignment;
    });
    expect(names).toBe('"core"."shift_assignment"');
  });

  it('trap on: search_path is empty, qualified names and built-ins work, an unqualified business table is 42P01', async () => {
    process.env[SEARCH_PATH_TRAP_VAR] = 'true';
    const schema = businessSchema(mgr.workspaceId!);
    const inside = await tenantContext.runInWorkspaceContext(ctx(), async (m) => {
      const t = businessTables(m);
      const [path] = await m.query<Array<{ schemas: string }>>(`SELECT current_schemas(false)::text AS schemas`);
      const [count] = await m.query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${t.venue} WHERE organisation_id = $1`, [orgId]);
      const [builtin] = await m.query<Array<{ ok: boolean }>>(`SELECT length(md5('x')) = 32 AS ok`);
      return { venue: t.venue, schemas: path!.schemas, venues: count!.n, builtin: builtin!.ok };
    });
    expect(inside.venue).toBe(`"${schema}"."venue"`);
    expect(inside.schemas).toBe('{}');
    expect(inside.venues).toBeGreaterThanOrEqual(1);
    expect(inside.builtin).toBe(true);

    // The unqualified form fails loudly (its own transaction: the error aborts it).
    expect(await codeOf(tenantContext.runInWorkspaceContext(ctx(), (m) => m.query(`SELECT 1 FROM venue LIMIT 1`)))).toBe('42P01');
    expect(await codeOf(tenantContext.runInTenantContext({ ...ctx(), workspaceId: null }, (m) => m.query(`SELECT 1 FROM shift LIMIT 1`)))).toBe('42P01');
  });

  it('trap off: the unqualified form resolves through search_path exactly as before', async () => {
    delete process.env[SEARCH_PATH_TRAP_VAR];
    expect(await codeOf(tenantContext.runInWorkspaceContext(ctx(), (m) => m.query(`SELECT 1 FROM venue LIMIT 1`)))).toBe('ACCEPTED');
  });
});
