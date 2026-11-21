import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { claimRealtimeEvents } from '../../core/database/realtime-event';
import { dispatchEmailScope } from '../../queues/rab-email/email-dispatch.job';
import { dispatchPushScope } from '../../queues/rab-push/push-dispatch.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Index-fix tooling 4 (docs/plans/index-fix/CREWFLOW_INDEX_FIX_PROMPT.md "Tooling"): EXPLAIN regression checks for the
 * Worker's per-organisation dispatch claims, which run for every organisation on every sweep (IDX-A measured a Seq Scan of
 * the whole outbox per organisation before its indexes: ~19 s per email sweep at 200k rows).
 *
 * The SQL is never copied here: each case runs the PRODUCTION function (dispatchEmailScope, dispatchPushScope,
 * claimRealtimeEvents) inside the real tenant context (TenantContextService: the runtime login, RLS FORCE, organisation
 * bound), with the transaction's EntityManager wrapped so that its first statement, the claim, is EXPLAINed instead of
 * executed (and an empty result handed back, so the function returns without touching a row). `SET LOCAL
 * enable_seqscan = off` (this transaction only) makes the planner take any usable index however few rows the test database
 * holds: a Seq Scan in the plan then means NO index can serve the claim under RLS, which is the regression to catch. The
 * plan's node types are printed as evidence.
 *
 * Known gaps are listed with their reason and asserted to still be gaps, so the fix that closes one must update this list.
 */
jest.setTimeout(120_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

/** Claim → reason, for a claim that has no serving index today (none: the realtime claim is served by an existing index). */
const KNOWN_SEQ_SCAN: Readonly<Record<string, string>> = Object.freeze({});

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

function describePlan(plan: PlanNode): string {
  return nodesOf(plan)
    .map((n) => `${n['Node Type']}${n['Index Name'] ? ` using ${n['Index Name']}` : n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}`)
    .join(' > ');
}

describeIfDb('EXPLAIN regression: the Worker dispatch claims are index-served under RLS (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource: app.get(DataSource), adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    manager = await factory.createInternalManager(await factory.createOrganisation('claimplan'), { label: 'claimplan' });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (adminDataSource?.isInitialized) await adminDataSource.destroy();
  });

  /**
   * Runs `run` with a TenantContextService whose transactions are the real ones, but whose EntityManager EXPLAINs the first
   * statement instead of running it and returns `emptyResult`. Returns that statement's plan.
   */
  async function planOfClaim(emptyResult: unknown, run: (tenant: TenantContextService) => Promise<unknown>): Promise<PlanNode> {
    let plan: PlanNode | undefined;
    const explaining = {
      runInTenantContext: <T>(ctx: AuthContext, fn: (m: EntityManager) => Promise<T>): Promise<T> =>
        tenantContext.runInTenantContext(ctx, async (real) => {
          const wrapped = new Proxy(real, {
            get(target, prop, receiver) {
              if (prop !== 'query') return Reflect.get(target, prop, receiver);
              return async (sql: string, params?: unknown[]) => {
                if (plan) throw new Error('the claim statement should be the only statement before the empty result returns');
                await real.query('SET LOCAL enable_seqscan = off');
                const rows = await real.query<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
                plan = rows[0]!['QUERY PLAN'][0]!.Plan;
                return emptyResult;
              };
            },
          });
          return fn(wrapped);
        }),
    } as unknown as TenantContextService;
    await run(explaining);
    if (!plan) throw new Error('the claim statement never ran');
    return plan;
  }

  function expectIndexServed(name: string, table: string, plan: PlanNode): void {
    // eslint-disable-next-line no-console
    console.log(`[claim-plan] ${name}: ${describePlan(plan)}`);
    const seq = nodesOf(plan).filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table);
    if (KNOWN_SEQ_SCAN[name]) {
      expect(seq.length).toBeGreaterThan(0); // still a known gap: the PR that fixes it removes the KNOWN_SEQ_SCAN entry
      return;
    }
    expect(seq).toEqual([]);
    expect(nodesOf(plan).some((n) => n['Relation Name'] === table)).toBe(true);
  }

  const noop = async (): Promise<void> => undefined;

  it('email claim (per organisation, IDX-A email_outbox_claim_idx)', async () => {
    const plan = await planOfClaim([], (tenant) => dispatchEmailScope(tenant, manager.organisationId, undefined, noop, noop, false));
    expectIndexServed('email', 'email_outbox', plan);
  });

  it('push claim (per organisation, IDX-A push_delivery_claim_idx)', async () => {
    const plan = await planOfClaim([], (tenant) => dispatchPushScope(tenant, manager.organisationId, undefined, noop, noop, false));
    expectIndexServed('push', 'push_delivery', plan);
  });

  it('realtime claim (per organisation)', async () => {
    const ctx: AuthContext = { organisationId: manager.organisationId, workspaceId: null, userId: '', role: '' };
    const plan = await planOfClaim([[], 0], (tenant) =>
      tenant.runInTenantContext(ctx, (m) => claimRealtimeEvents(m, { limit: 50, claimToken: randomUUID() })),
    );
    expectIndexServed('realtime', 'realtime_event', plan);
  });
});
