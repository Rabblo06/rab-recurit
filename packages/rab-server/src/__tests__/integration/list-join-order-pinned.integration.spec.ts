import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceService } from '../../modules/attendance/services/attendance.service';
import { OfferService } from '../../modules/offer/services/offer.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * W6-E2E-06 regression (MEDIUM, performance). The manager attendance list was planned as a venue × staff_profile cartesian
 * product merged against shift (3.6 M intermediate rows for 4.8 k attendance rows, 0.6–1.4 s) because RLS predicates on
 * `current_setting()` hide the tenant values from the planner. The fix pins the written, fact-table-first join order for
 * the count and the page of `AttendanceService.list` and `OfferService.list`.
 *
 * Asserts, through the real services and the real database: `join_collapse_limit` is 1 while the count and page queries
 * run, it is transaction-local (back to the server default afterwards on the same pool), and EXPLAIN of the recorded count
 * query starts from the fact table — no join of two dimension tables without it. (Before/after timings on a seeded
 * disposable stack: docs/evidence/w6-e2e-fixes/06.)
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('W6-E2E-06 list queries run with a pinned, fact-table-first join order (integration)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let owner: DataSource;
  let dataSource: DataSource;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    dataSource = moduleRef.get(DataSource);
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  /** Records every statement run through an EntityManager during `fn`, with the join_collapse_limit in force for the count. */
  async function record(fn: () => Promise<unknown>): Promise<Array<{ sql: string; params: unknown[] }>> {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const original = EntityManager.prototype.query;
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (this: EntityManager, sql: string, params?: unknown[]) {
      seen.push({ sql, params: [...(params ?? [])] }); // copied: the services push LIMIT/OFFSET onto the same array after the count
      if (/SELECT count\(\*\)::int AS count FROM (attendance a|job_offer o)/.test(sql)) {
        const [{ limit }] = (await original.call(this, `SELECT current_setting('join_collapse_limit') AS limit`)) as Array<{ limit: string }>;
        seen.push({ sql: `-- join_collapse_limit during count = ${limit}`, params: [] });
      }
      return original.call(this, sql, params);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it.each([
    ['attendance', 'attendance a', (m: { userId: string; organisationId: string; workspaceId: string | null }) => app.get(AttendanceService).list({ ...m, role: '' }, {})],
    ['offers', 'job_offer o', (m: { userId: string; organisationId: string; workspaceId: string | null }) => app.get(OfferService).list({ ...m, role: '' }, {})],
  ])('%s list: the count and the page run with join_collapse_limit = 1, set transaction-locally', async (_name, fact, call) => {
    const manager = await factory.createInternalManager(await factory.createOrganisation('w6e06'), { permissions: 'production', workspace: true, label: 'w6e06' });
    const seen = await record(() => call({ userId: manager.userId, organisationId: manager.organisationId, workspaceId: manager.workspaceId }));
    const pinAt = seen.findIndex((q) => /set_config\('join_collapse_limit', '1', true\)/.test(q.sql));
    const countAt = seen.findIndex((q) => q.sql.includes(`SELECT count(*)::int AS count FROM ${fact}`));
    expect(pinAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(pinAt);
    expect(seen.find((q) => q.sql.startsWith('-- join_collapse_limit during count'))?.sql).toBe('-- join_collapse_limit during count = 1');

    // Transaction-local: a fresh statement on the pool sees the server default again.
    const [{ limit }] = await dataSource.query(`SELECT current_setting('join_collapse_limit') AS limit`);
    expect(limit).not.toBe('1');

    // EXPLAIN of the exact count statement, in the caller's tenant context, with the pin: every join in the main join tree
    // contains the fact table, so no two dimension tables are ever joined on their own (the 3.6 M-row shape).
    const count = seen[countAt]!;
    const plan = await app.get(TenantContextService).runInTenantContext(
      { organisationId: manager.organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        await m.query(`SELECT set_config('join_collapse_limit', '1', true)`);
        return (await m.query(`EXPLAIN (FORMAT JSON) ${count.sql}`, count.params))[0]['QUERY PLAN'][0].Plan;
      },
    );
    // Hash joins may put the fact table on either side; what must never happen is a dimension-only join subtree in the
    // main join tree. RLS policy sub-plans (SubPlan / InitPlan children) are not part of it and are skipped.
    type PlanNode = { 'Node Type'?: string; 'Parent Relationship'?: string; Plans?: PlanNode[]; Alias?: string };
    const mainChildren = (n: PlanNode): PlanNode[] => (n.Plans ?? []).filter((c) => c['Parent Relationship'] !== 'SubPlan' && c['Parent Relationship'] !== 'InitPlan');
    const aliases = (n: PlanNode): string[] => mainChildren(n).flatMap(aliases).concat(n.Alias ? [n.Alias] : []);
    const relationsUnderJoinsWithoutFact = (node: PlanNode): string[][] => {
      const own = /Join|Nested Loop/.test(node['Node Type'] ?? '') && !aliases(node).includes(fact.split(' ')[1]!) ? [aliases(node)] : [];
      return own.concat(mainChildren(node).flatMap(relationsUnderJoinsWithoutFact));
    };
    expect(aliases(plan)).toContain(fact.split(' ')[1]);
    expect(relationsUnderJoinsWithoutFact(plan)).toEqual([]);
  });
});
