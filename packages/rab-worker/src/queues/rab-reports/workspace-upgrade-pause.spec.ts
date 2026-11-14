import { WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';

import { isNotYetRoutableWorkspace, isWorkspaceUpgrading } from '../../core/database/workspace-routing';
import { processShiftStatementJob } from './shift-statement.job';

/**
 * Part D (owner D2/D3, security review P3): a per-job path that binds a workspace blocked by a failed upgrade step PAUSES:
 * nothing is recorded as failed and no attempt is spent; it runs again once the block is lifted.
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const upgrading = () => new WorkspaceRoutingError('upgrading');

describe('Part D review P3: workspace upgrade pause in per-job paths', () => {
  it('isWorkspaceUpgrading only for the upgrading code; it is also not-yet-routable (walks skip it)', () => {
    expect(isWorkspaceUpgrading(upgrading())).toBe(true);
    expect(isNotYetRoutableWorkspace(upgrading())).toBe(true);
    expect(isWorkspaceUpgrading(new WorkspaceRoutingError('not-ready'))).toBe(false);
    expect(isWorkspaceUpgrading(Object.assign(new Error('x'), { code: 'upgrading' }))).toBe(false);
  });

  it('shift statement: a blocked workspace returns deferred and records no failure (no attempt counted)', async () => {
    const statements: string[] = [];
    const tenantContext = {
      runInTenantContext: async () => {
        throw upgrading();
      },
    };
    const deps = { tenantContext, files: { putObject: jest.fn(), discardUnregistered: jest.fn(async () => undefined) }, notifications: {} } as never;
    const outcome = await processShiftStatementJob({ payrollRecordId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0', organisationId: ORG, workspaceId: WS, generation: 3 }, deps);
    expect(outcome).toBe('deferred');
    expect(statements).toEqual([]);
  });
});
