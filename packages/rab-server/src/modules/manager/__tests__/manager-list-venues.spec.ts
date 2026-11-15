import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ManagerService } from '../services/manager.service';

/**
 * ManagerService.listVenues authorisation (Part C1, owner decision 0d 2026-11-14), service layer only (no guard): the
 * permission re-check, the organisation pin, the organisation-wide vs workspace-only scope and the workspace the venues are
 * read in. The database predicates themselves are covered by hws-c1-org-level-workspace-paths.integration.spec.ts.
 */
const ORG = 'org-1';
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const venue = { id: 'venue-b' };

interface Setup {
  permitted?: boolean;
  profile?: { workspaceId: string | null } | null;
  orgWide?: boolean;
  inOrg?: boolean;
}

function build(setup: Setup) {
  const calls = { orgWideQueries: 0, inOrgQueries: 0, readIn: [] as Array<string | null> };
  const tx = {
    findOne: jest.fn(async () => (setup.profile === undefined ? { workspaceId: WS_B } : setup.profile)),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('admin_workspace_in_org')) {
        calls.inOrgQueries += 1;
        return [{ ok: setup.inOrg ?? true }];
      }
      if (sql.includes('org_wide')) {
        calls.orgWideQueries += 1;
        return [{ org_wide: setup.orgWide ?? false }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  const builder = { innerJoin: () => builder, where: () => builder, getMany: async () => [venue] };
  const tenantContext = {
    runInTenantContext: jest.fn(async (_ctx: AuthContext, fn: (m: unknown) => unknown) => fn(tx)),
    runInWorkspaceContext: jest.fn(async (ctx: AuthContext, fn: (m: unknown) => unknown) => {
      calls.readIn.push(ctx.workspaceId);
      return fn({ createQueryBuilder: () => builder });
    }),
  };
  const service = new (ManagerService as unknown as new (...args: unknown[]) => ManagerService)(tenantContext, ...Array(13).fill({}));
  (service as unknown as { permissions: unknown }).permissions = { userHasPermissionTx: jest.fn(async () => setup.permitted ?? true) };
  return { service, calls };
}

const caller = (workspaceId: string | null): AuthContext => ({ organisationId: ORG, workspaceId, userId: 'caller', role: '' });

describe('ManagerService.listVenues (unit, owner decision 0d)', () => {
  it('layer 2: no manager.manage → 403 from the service, nothing read', async () => {
    const { service, calls } = build({ permitted: false });
    await expect(service.listVenues(caller(WS_A), 'target')).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.readIn).toEqual([]);
  });

  it('ABUSE: a profile outside the caller organisation (not found under the organisation pin) → 404', async () => {
    const { service } = build({ profile: null });
    await expect(service.listVenues(caller(WS_A), 'target')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a manager of the caller\'s own workspace: read in that workspace, no scope query needed', async () => {
    const { service, calls } = build({ profile: { workspaceId: WS_A } });
    await expect(service.listVenues(caller(WS_A), 'target')).resolves.toEqual([venue]);
    expect(calls).toMatchObject({ orgWideQueries: 0, inOrgQueries: 0, readIn: [WS_A] });
  });

  it('an organisation-wide holder bound to workspace A reads a manager of workspace B, in B\'s context', async () => {
    const { service, calls } = build({ profile: { workspaceId: WS_B }, orgWide: true, inOrg: true });
    await expect(service.listVenues(caller(WS_A), 'target')).resolves.toEqual([venue]);
    expect(calls).toMatchObject({ orgWideQueries: 1, inOrgQueries: 1, readIn: [WS_B] });
  });

  it('ABUSE: a caller whose manager.manage is workspace-only (custom role) gets 404 for another workspace, nothing read', async () => {
    const { service, calls } = build({ profile: { workspaceId: WS_B }, orgWide: false });
    await expect(service.listVenues(caller(WS_A), 'target')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toMatchObject({ orgWideQueries: 1, inOrgQueries: 0, readIn: [] });
  });

  it('ABUSE: an organisation-wide holder, target workspace not an active workspace of the organisation → 404', async () => {
    const { service, calls } = build({ profile: { workspaceId: WS_B }, orgWide: true, inOrg: false });
    await expect(service.listVenues(caller(WS_A), 'target')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.readIn).toEqual([]);
  });

  it('a workspace-bound caller asking for an in-organisation profile with no workspace → 404 (not [])', async () => {
    const { service } = build({ profile: { workspaceId: null }, orgWide: true });
    await expect(service.listVenues(caller(WS_A), 'target')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a workspace-less organisation administrator: no-workspace profile → []; another workspace → read there after the in-org check', async () => {
    const none = build({ profile: { workspaceId: null } });
    await expect(none.service.listVenues(caller(null), 'target')).resolves.toEqual([]);
    const other = build({ profile: { workspaceId: WS_B }, inOrg: true });
    await expect(other.service.listVenues(caller(null), 'target')).resolves.toEqual([venue]);
    expect(other.calls).toMatchObject({ orgWideQueries: 0, inOrgQueries: 1, readIn: [WS_B] });
  });

  it('a caller with no organisation → 404 before anything is read', async () => {
    const { service, calls } = build({});
    await expect(service.listVenues({ organisationId: null, workspaceId: null, userId: 'x', role: '' }, 'target')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.readIn).toEqual([]);
  });
});
