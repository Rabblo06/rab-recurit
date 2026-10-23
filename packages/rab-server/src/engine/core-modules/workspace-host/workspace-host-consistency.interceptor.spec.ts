import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';

import { PublicWorkspaceHostController } from './public-workspace-host.controller';
import { WorkspaceHostConsistencyInterceptor } from './workspace-host-consistency.interceptor';
import { WORKSPACE_HOST_MISMATCH, WorkspaceHostContext } from './workspace-host.types';

const WS_A = '00000000-0000-4000-8000-00000000000a';
const WS_B = '00000000-0000-4000-8000-00000000000b';
const hostA: WorkspaceHostContext = {
  kind: 'workspace',
  source: 'origin',
  label: 'acme',
  workspaceId: WS_A,
  organisationId: 'org-a',
  canonicalLabel: 'acme',
  canonicalOrigin: 'https://acme.workspaces.example.com',
  displayName: null,
};

function run(host: WorkspaceHostContext | undefined, authContext: Record<string, unknown> | undefined, path = '/rest/v1/staff', ownCanonical: string | null = 'https://bravo.workspaces.example.com') {
  const resolver = {
    canonicalOriginForWorkspace: jest.fn(async () => ownCanonical),
    defaultAppUrl: () => 'https://app.example.com',
  };
  const interceptor = new WorkspaceHostConsistencyInterceptor(resolver as any);
  const handler = { handle: jest.fn(() => of('handled')) };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ workspaceHost: host, authContext, path }) }),
  };
  return { result: lastValueFrom(interceptor.intercept(context as any, handler as any)), handler, resolver };
}

const sessionB = { userId: 'user-b', organisationId: 'org-b', workspaceId: WS_B, role: 'manager' };

describe('WorkspaceHostConsistencyInterceptor (the wrong-host check)', () => {
  it('no session → untouched (public routes, login)', async () => {
    const { result, handler } = run(hostA, undefined);
    await expect(result).resolves.toBe('handled');
    expect(handler.handle).toHaveBeenCalled();
  });

  it('default / API host (none) → untouched (mobile app, apex)', async () => {
    await expect(run({ kind: 'none' }, sessionB).result).resolves.toBe('handled');
    await expect(run(undefined, sessionB).result).resolves.toBe('handled');
  });

  it("the session's own workspace host → allowed, and nothing is added to the context", async () => {
    const ctx = { ...sessionB, workspaceId: WS_A };
    await expect(run(hostA, ctx).result).resolves.toBe('handled');
    expect(ctx.workspaceId).toBe(WS_A);
  });

  it('ABUSE: a session of workspace B on workspace A\'s host → 404 WORKSPACE_HOST_MISMATCH, the handler never runs', async () => {
    const { result, handler } = run(hostA, sessionB);
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    const error = (await result.catch((e) => e)) as NotFoundException;
    expect(error.getResponse()).toEqual({ code: WORKSPACE_HOST_MISMATCH, message: 'Not found.', canonicalUrl: 'https://bravo.workspaces.example.com' });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('ABUSE: the 404 body is IDENTICAL for another workspace, an unknown, a reserved, a renamed and a malformed host (no disclosure)', async () => {
    const hosts: WorkspaceHostContext[] = [
      hostA,
      { kind: 'not-found', source: 'host', label: 'ghost' },
      { kind: 'not-found', source: 'origin', label: 'admin' },
      { kind: 'renamed', source: 'host', label: 'oldname', canonicalOrigin: 'https://acme.workspaces.example.com' },
      { kind: 'not-found', source: 'host', label: null },
    ];
    const bodies = await Promise.all(hosts.map(async (host) => ((await run(host, sessionB).result.catch((e) => e)) as NotFoundException).getResponse()));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  });

  it('a session with no workspace (CEO without one, platform admin) on a workspace host → 404, canonical = default app URL', async () => {
    const { result } = run(hostA, { ...sessionB, workspaceId: null }, '/rest/v1/staff', null);
    expect(((await result.catch((e) => e)) as NotFoundException).getResponse()).toMatchObject({ canonicalUrl: 'https://app.example.com' });
  });

  it('sign-out is always allowed from any host (never trap the user on the wrong-host screen)', async () => {
    await expect(run(hostA, sessionB, '/rest/v1/auth/logout').result).resolves.toBe('handled');
  });

  it('registry unavailable → 503 for an authenticated request (fail closed, never "assume it matches")', async () => {
    await expect(run({ kind: 'unavailable', source: 'host', label: 'acme' }, { ...sessionB, workspaceId: WS_A }).result).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('admin inspect sessions never get a workspace URL in the body', async () => {
    const { result, resolver } = run(hostA, { ...sessionB, inspectedBy: 'admin-1' });
    expect(((await result.catch((e) => e)) as NotFoundException).getResponse()).toMatchObject({ canonicalUrl: 'https://app.example.com' });
    expect(resolver.canonicalOriginForWorkspace).not.toHaveBeenCalled();
  });
});

describe('PublicWorkspaceHostController (GET /rest/v1/public/workspace-host)', () => {
  const resolver = (enabled = true) => ({
    isRoutingEnabled: () => enabled,
    baseDomain: () => 'workspaces.example.com',
    defaultAppUrl: () => 'https://app.example.com',
  });

  it('routing off → default, base domain withheld', () => {
    expect(new PublicWorkspaceHostController(resolver(false) as any).resolve({ workspaceHost: hostA } as any)).toEqual({
      state: 'default',
      defaultUrl: 'https://app.example.com',
      workspaceBaseDomain: null,
    });
  });

  it('workspace host → public branding only (label + display name), canonical URL from the DB label', () => {
    const body = new PublicWorkspaceHostController(resolver() as any).resolve({ workspaceHost: hostA } as any);
    expect(body).toEqual({
      state: 'workspace',
      defaultUrl: 'https://app.example.com',
      workspaceBaseDomain: 'workspaces.example.com',
      canonicalUrl: 'https://acme.workspaces.example.com',
      workspace: { subdomain: 'acme', displayName: null },
    });
    expect(JSON.stringify(body)).not.toContain(WS_A); // no ids
    expect(JSON.stringify(body)).not.toContain('org-a');
  });

  it('renamed → canonical redirect target; not-found → default URL only; unavailable → 503', () => {
    const controller = new PublicWorkspaceHostController(resolver() as any);
    expect(controller.resolve({ workspaceHost: { kind: 'renamed', source: 'host', label: 'old', canonicalOrigin: 'https://acme.workspaces.example.com' } } as any)).toMatchObject({
      state: 'renamed',
      canonicalUrl: 'https://acme.workspaces.example.com',
    });
    expect(controller.resolve({ workspaceHost: { kind: 'not-found', source: 'host', label: 'ghost' } } as any)).toEqual({
      state: 'not-found',
      defaultUrl: 'https://app.example.com',
      workspaceBaseDomain: 'workspaces.example.com',
    });
    expect(() => controller.resolve({ workspaceHost: { kind: 'unavailable', source: 'host', label: 'x' } } as any)).toThrow(ServiceUnavailableException);
  });
});
