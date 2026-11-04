import { NotFoundException } from '@nestjs/common';

import { WorkspaceProvisioningService } from './workspace-provisioning.service';
import { DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR, serverProvisioningDeferredForTest, TestSeamDeferral } from './workspace-provisioning-test-seam';

/**
 * The test-only server-path provisioning deferral seam (owner-login architecture: REVOKE EXECUTE from crewflow_app no longer
 * defers anything). Three gates, all required; when effective it goes through the service's REAL deferral path.
 */
const marked = (marker: string | null) => ({ query: async () => [{ marker }] });

describe('serverProvisioningDeferredForTest: three gates, all required', () => {
  it('deferred only with the variable, NODE_ENV=test AND a database marked disposable', async () => {
    const warn = jest.fn();
    const on = { [DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR]: 'true', NODE_ENV: 'test' };
    expect(await serverProvisioningDeferredForTest(marked('true') as never, warn, on)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('variable unset / not exactly "true" → never deferred, no query, no warning', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      const warn = jest.fn();
      const query = jest.fn();
      expect(await serverProvisioningDeferredForTest({ query } as never, warn, { [DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR]: value, NODE_ENV: 'test' })).toBe(false);
      expect(query).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('NODE_ENV other than test → ignored (warned), the database is not even asked', async () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      const warn = jest.fn();
      const query = jest.fn();
      expect(await serverProvisioningDeferredForTest({ query } as never, warn, { [DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR]: 'true', NODE_ENV })).toBe(false);
      expect(query).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignored: it is honoured only with NODE_ENV=test/));
    }
  });

  it('a database NOT marked disposable (a real one) → ignored (warned), normal provisioning', async () => {
    for (const marker of [null, '', 'false', 'on']) {
      const warn = jest.fn();
      expect(await serverProvisioningDeferredForTest(marked(marker) as never, warn, { [DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR]: 'true', NODE_ENV: 'test' })).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not marked as a disposable test database/));
    }
  });

  it('the synthetic error is an infrastructure SQLSTATE (57014, query_canceled), never a business code', () => {
    expect(new TestSeamDeferral().code).toBe('57014');
  });
});

describe('WorkspaceProvisioningService with the seam effective: the real deferral path', () => {
  const ctx = { organisationId: '00000000-0000-4000-8000-0000000000aa', workspaceId: null, userId: '00000000-0000-4000-8000-0000000000bb', role: 'manager' };
  const WS = '00000000-0000-4000-8000-0000000000cc';
  const saved = { var: process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR], node: process.env.NODE_ENV };
  afterEach(() => {
    if (saved.var === undefined) delete process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR];
    else process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = saved.var;
    process.env.NODE_ENV = saved.node;
  });

  function harness(workspace: { schemaStatus: string; subdomain: string } | null, marker: string | null = 'true') {
    const statements: string[] = [];
    const manager = {
      findOne: async () => workspace,
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('org_active')) return [{ org_active: true, account_status: 'active' }];
        if (sql.includes('disposable_test_database')) return [{ marker }];
        if (sql.includes('core.provision_workspace')) return [{ outcome: 'READY' }];
        return [];
      },
    };
    let rolledBack = false;
    const tenantContext = {
      runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => {
        try {
          return await fn(manager);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };
    const audits: unknown[] = [];
    const service = new WorkspaceProvisioningService(
      tenantContext as never,
      { record: async (...args: unknown[]) => void audits.push(args) } as never,
      { invalidate: async () => undefined } as never,
    );
    return { service, statements, audits, rolledBack: () => rolledBack };
  }

  it('seam on (test, marked database): DEFERRED, core.provision_workspace never called, transaction rolled back, nothing audited', async () => {
    process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = 'true';
    process.env.NODE_ENV = 'test';
    const h = harness({ schemaStatus: 'CREATING', subdomain: 'seam' });
    await expect(h.service.provisionOwnWorkspace(ctx, WS)).resolves.toBe('DEFERRED');
    expect(h.statements.some((s) => s.includes('core.provision_workspace'))).toBe(false);
    expect(h.rolledBack()).toBe(true);
    expect(h.audits).toEqual([]);
  });

  it('seam on but the database is not marked: normal provisioning (READY)', async () => {
    process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = 'true';
    process.env.NODE_ENV = 'test';
    const h = harness({ schemaStatus: 'CREATING', subdomain: 'seam' }, null);
    await expect(h.service.provisionOwnWorkspace(ctx, WS)).resolves.toBe('READY');
    expect(h.statements.some((s) => s.includes('core.provision_workspace'))).toBe(true);
  });

  it('the checks before it are unchanged: a foreign / unknown workspace is still 404 and READY still short-circuits, seam or not', async () => {
    process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = 'true';
    process.env.NODE_ENV = 'test';
    await expect(harness(null).service.provisionOwnWorkspace(ctx, WS)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness({ schemaStatus: 'READY', subdomain: 'seam' }).service.provisionOwnWorkspace(ctx, WS)).resolves.toBe('ALREADY_READY');
  });

  it('seam off: normal provisioning (READY), the marker is never read', async () => {
    delete process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR];
    const h = harness({ schemaStatus: 'CREATING', subdomain: 'seam' });
    await expect(h.service.provisionOwnWorkspace(ctx, WS)).resolves.toBe('READY');
    expect(h.statements.some((s) => s.includes('disposable_test_database'))).toBe(false);
  });
});
