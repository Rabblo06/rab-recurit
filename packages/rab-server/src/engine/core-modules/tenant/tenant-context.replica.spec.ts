import { DataSource, EntityManager } from 'typeorm';

import { databaseMetrics } from '../../../database/runtime/database-metrics';
import { PgReplicaService, ReplicaRoute } from '../../../database/runtime/replica/pg-replica.service';
import { EnvironmentService } from '../environment/environment.service';
import { SchemaResolverService } from './schema-resolver.service';
import { TenantContextService } from './tenant-context.service';

/**
 * B4: `{ useReplica: true }` routing in TenantContextService. Unit level (fake DataSources); the real standby is
 * exercised by __tests__/integration/replica-lab.integration.spec.ts.
 */
function side(name: string, failWith?: Error) {
  const calls: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      return undefined;
    }),
  } as unknown as EntityManager;
  const dataSource = {
    name,
    transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => {
      if (failWith) throw failWith;
      return fn(manager);
    }),
  } as unknown as DataSource;
  return { dataSource, manager, calls };
}

function replicaStub(route: ReplicaRoute, retry = true) {
  return {
    routeRead: jest.fn(() => route),
    shouldRetryOnPrimary: jest.fn(() => retry),
  } as unknown as PgReplicaService;
}

const env = (hws: boolean) => ({ get: jest.fn().mockReturnValue(hws) }) as unknown as EnvironmentService;
const resolver = () => ({ resolve: jest.fn().mockResolvedValue('workspace_abc') }) as unknown as SchemaResolverService;
const CTX = { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'user-1', role: 'MANAGER' };

describe('TenantContextService useReplica (B4)', () => {
  beforeEach(() => databaseMetrics.reset());

  it('without the option nothing changes: primary, no READ ONLY, replica never consulted', async () => {
    const primary = side('primary');
    const replica = replicaStub({ dataSource: side('replica').dataSource });
    const service = new TenantContextService(primary.dataSource, resolver(), env(false), replica);
    await service.runInTenantContext(CTX, async () => 1);
    expect(replica.routeRead).not.toHaveBeenCalled();
    expect(primary.calls[0]).toMatch(/^SELECT set_config\('rab.organisation_id'/);
    expect(primary.calls).not.toContain('SET TRANSACTION READ ONLY');
  });

  it('routes an opted-in read to the replica: READ ONLY first, then the same transaction-local GUC bind and search_path', async () => {
    const primary = side('primary');
    const rep = side('replica');
    const service = new TenantContextService(primary.dataSource, resolver(), env(false), replicaStub({ dataSource: rep.dataSource }));
    const result = await service.runInWorkspaceContext(CTX, async (m, schema) => {
      expect(m).toBe(rep.manager);
      return schema;
    }, { useReplica: true });
    expect(result).toBe('core');
    expect(primary.dataSource.transaction).not.toHaveBeenCalled();
    expect(rep.calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(rep.calls[1]).toMatch(/set_config\('rab.organisation_id', \$1, true\).*set_config\('rab.admin_scope', '', true\)/);
    expect(rep.calls[2]).toBe(`SELECT set_config('search_path', $1, true)`);
    expect(rep.calls.join()).not.toMatch(/\bSET (SESSION|ROLE)\b|set_config\([^)]*false\)/); // nothing session-scoped
    expect(databaseMetrics.snapshot().replica.reads).toBe(1);
  });

  it('HWS: the workspace schema is resolved on the PRIMARY (finished first), then bound on the replica', async () => {
    const primary = side('primary');
    const rep = side('replica');
    const schemaResolver = resolver();
    const service = new TenantContextService(primary.dataSource, schemaResolver, env(true), replicaStub({ dataSource: rep.dataSource }));
    await service.runInWorkspaceContext(CTX, async () => undefined, { useReplica: true });
    expect((schemaResolver.resolve as jest.Mock).mock.calls[0][0]).toBe(primary.manager);
    expect(primary.calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(rep.calls).toContain(`SELECT set_config('search_path', $1, true)`);
    expect((rep.manager.query as jest.Mock).mock.calls.find((c) => c[0].includes('search_path'))[1]).toEqual(['workspace_abc']);
  });

  it.each(['not-configured', 'not-validated', 'unavailable', 'stale', 'refused'] as const)(
    'falls back to the primary (still READ ONLY) when the replica is %s',
    async (reason) => {
      const primary = side('primary');
      const service = new TenantContextService(primary.dataSource, resolver(), env(false), replicaStub({ dataSource: null, reason }));
      await service.runInTenantContext(CTX, async () => undefined, { useReplica: true });
      expect(primary.calls[0]).toBe('SET TRANSACTION READ ONLY');
      const fallbacks = databaseMetrics.snapshot().replica.fallbacks as Record<string, number>;
      if (reason === 'not-configured') expect(Object.values(fallbacks).every((n) => n === 0)).toBe(true);
      else expect(fallbacks[reason]).toBe(1);
    },
  );

  it('no replica service at all (Worker, CLI, older wiring): primary READ ONLY', async () => {
    const primary = side('primary');
    const service = new TenantContextService(primary.dataSource, resolver(), env(false));
    await service.runInTenantContext(CTX, async () => 7, { useReplica: true });
    expect(primary.calls[0]).toBe('SET TRANSACTION READ ONLY');
  });

  it('a replica connection failure re-runs the read once on the primary', async () => {
    const primary = side('primary');
    const rep = side('replica', Object.assign(new Error('Connection terminated unexpectedly'), { code: undefined }));
    const replica = replicaStub({ dataSource: rep.dataSource }, true);
    const service = new TenantContextService(primary.dataSource, resolver(), env(false), replica);
    await expect(service.runInTenantContext(CTX, async () => 'from-primary', { useReplica: true })).resolves.toBe('from-primary');
    expect(replica.shouldRetryOnPrimary).toHaveBeenCalledTimes(1);
    expect(primary.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(databaseMetrics.snapshot().replica.fallbacks['replica-error']).toBe(1);
  });

  it('spy: a hidden write inside an opted-in read fails (25006) and is NOT retried on the primary', async () => {
    const primary = side('primary');
    const readOnly = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
    const rep = side('replica', readOnly);
    const service = new TenantContextService(primary.dataSource, resolver(), env(false), replicaStub({ dataSource: rep.dataSource }, false));
    await expect(service.runInTenantContext(CTX, async () => undefined, { useReplica: true })).rejects.toBe(readOnly);
    expect(primary.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('application errors from the read itself propagate unchanged (no retry)', async () => {
    const primary = side('primary');
    const rep = side('replica');
    const service = new TenantContextService(primary.dataSource, resolver(), env(false), replicaStub({ dataSource: rep.dataSource }, false));
    const notFound = new Error('Shift not found.');
    await expect(service.runInTenantContext(CTX, async () => { throw notFound; }, { useReplica: true })).rejects.toBe(notFound);
    expect(primary.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('counts query timeouts per pool without storing the error', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const primary = side('primary', timeout);
    const service = new TenantContextService(primary.dataSource, resolver(), env(false));
    await expect(service.runInTenantContext(CTX, async () => undefined)).rejects.toBe(timeout);
    expect(databaseMetrics.snapshot().pools.find((p) => p.name === 'primary')).toMatchObject({ queryTimeouts: 1 });
  });
});
