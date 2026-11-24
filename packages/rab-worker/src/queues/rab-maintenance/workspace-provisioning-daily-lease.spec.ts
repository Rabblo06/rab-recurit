/**
 * XR-12: the Worker's two daily in-process loops (workspace schema drift, workspace core orphans) run behind the cluster
 * lease — once per interval for the whole cluster, not at every Worker start and not on every replica. Provisioning keeps
 * its own 5 s tick (its bounded advisory lock already serialises replicas) and never touches the lease. No database: the
 * connection, gate and cycle modules are replaced; only the loop registration is under test.
 */
jest.mock('@rab/server/database/postgres/index', () => ({
  createPgClient: jest.fn(),
  pgClientConfig: jest.fn(() => ({})),
  probePgSessionAffinity: jest.fn(async () => undefined),
}));
jest.mock('@rab/server/database/boot-checks/database-boot-gates', () => ({ checkSchemaCompatibility: jest.fn(async () => undefined) }));
jest.mock('../../core/database/reconnecting-pg-client', () => ({
  ReconnectingPgClient: jest.fn().mockImplementation(() => ({ acquire: jest.fn(async () => ({ query: jest.fn() })), invalidate: jest.fn(), close: jest.fn(async () => undefined) })),
}));
jest.mock('./workspace-provisioning.job', () => ({ runWorkspaceProvisioningCycle: jest.fn(async () => ({ lockAcquired: true, attempted: 0, ready: 0, failed: 0 })) }));
jest.mock('./workspace-schema-drift.job', () => ({ runWorkspaceSchemaDriftCycle: jest.fn(async () => ({ findings: [], checked: 2, ok: 2, notReady: 0 })) }));
jest.mock('./workspace-core-orphans.job', () => ({ runWorkspaceCoreOrphanCycle: jest.fn(async () => ({ findings: [], errors: [], checked: 2 })) }));

import { ClusterIntervalLease } from '../../core/scheduler/cluster-interval-lease';
import { runWorkspaceSchemaDriftCycle } from './workspace-schema-drift.job';
import { runWorkspaceCoreOrphanCycle } from './workspace-core-orphans.job';
import {
  startWorkspaceProvisioningLoops,
  WORKSPACE_CORE_ORPHAN_LEASE,
  WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS,
  WORKSPACE_SCHEMA_DRIFT_LEASE,
} from './workspace-provisioning.loops';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Loop = { name: string; intervalMs: number; run: () => Promise<boolean | void> };

async function register(dailyLease?: ClusterIntervalLease): Promise<Map<string, Loop>> {
  const loops = new Map<string, Loop>();
  await startWorkspaceProvisioningLoops({
    pg: {} as never,
    endpoint: 'primary',
    runtime: { every: (def: Loop) => loops.set(def.name, def), isShuttingDown: false } as never,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    intervalMs: 5_000,
    expectedMigrations: [],
    production: false,
    actAsCrewflow: false,
    dailyLease,
  });
  return loops;
}

describe('XR-12: daily provisioning-side loops behind the cluster lease', () => {
  beforeEach(() => jest.clearAllMocks());

  it('drift and orphans tick hourly and claim their own lease (a day less one minute) before any work', async () => {
    const claims: Array<[string, number]> = [];
    const lease: ClusterIntervalLease = { claim: async (name, ttl) => (claims.push([name, ttl]), true) };
    const loops = await register(lease);
    const drift = loops.get('workspace schema drift')!;
    const orphans = loops.get('workspace core orphans')!;
    expect(drift.intervalMs).toBe(HOUR);
    expect(orphans.intervalMs).toBe(HOUR);
    expect(WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS).toBe(DAY);
    await drift.run();
    await orphans.run();
    expect(claims).toEqual([
      [WORKSPACE_SCHEMA_DRIFT_LEASE, DAY - 60_000],
      [WORKSPACE_CORE_ORPHAN_LEASE, DAY - 60_000],
    ]);
    expect(runWorkspaceSchemaDriftCycle).toHaveBeenCalledTimes(1);
    expect(runWorkspaceCoreOrphanCycle).toHaveBeenCalledTimes(1);
  });

  it('a tick that loses the lease (another replica, or an earlier start, ran it this interval) does no work and is idle', async () => {
    const loops = await register({ claim: async () => false });
    await expect(loops.get('workspace schema drift')!.run()).resolves.toBe(false);
    await expect(loops.get('workspace core orphans')!.run()).resolves.toBe(false);
    expect(runWorkspaceSchemaDriftCycle).not.toHaveBeenCalled();
    expect(runWorkspaceCoreOrphanCycle).not.toHaveBeenCalled();
  });

  it('provisioning keeps its own interval and never claims the lease', async () => {
    const claim = jest.fn(async () => true);
    const loops = await register({ claim });
    const provisioning = loops.get('workspace provisioning')!;
    expect(provisioning.intervalMs).toBe(5_000);
    await provisioning.run();
    expect(claim).not.toHaveBeenCalled();
  });

  it('no lease (tests driving the loops by hand): the daily loops keep their full interval and run on every tick', async () => {
    const loops = await register(undefined);
    expect(loops.get('workspace schema drift')!.intervalMs).toBe(DAY);
    await loops.get('workspace schema drift')!.run();
    await loops.get('workspace schema drift')!.run();
    expect(runWorkspaceSchemaDriftCycle).toHaveBeenCalledTimes(2);
  });
});
