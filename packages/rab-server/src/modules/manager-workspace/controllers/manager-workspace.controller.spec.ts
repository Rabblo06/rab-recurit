import 'reflect-metadata';

import { ManagerWorkspaceController, WORKSPACE_CREATE_THROTTLE } from './manager-workspace.controller';

/**
 * Phase B P8: the create route is also the owner's ONLY provisioning resume / retry path once the privileged worker
 * provisioner is retired, and each retry of a FAILED workspace re-runs the workspace DDL. It must carry its own,
 * tighter-than-global throttle (the global default tier is 120/min). The live 429 is exercised end to end in
 * workspace-provisioning-owner-flow.integration.spec.ts.
 */
describe('ManagerWorkspaceController throttles', () => {
  const limitOf = (handler: unknown) => Reflect.getMetadata('THROTTLER:LIMITdefault', handler as object);
  const ttlOf = (handler: unknown) => Reflect.getMetadata('THROTTLER:TTLdefault', handler as object);

  it('POST /manager-workspaces (create / resume / retry) has its own route throttle, tighter than the global 120/min', () => {
    const handler = ManagerWorkspaceController.prototype.create;
    expect(limitOf(handler)).toBe(WORKSPACE_CREATE_THROTTLE.default.limit);
    expect(ttlOf(handler)).toBe(WORKSPACE_CREATE_THROTTLE.default.ttl);
    expect(WORKSPACE_CREATE_THROTTLE.default.limit).toBeLessThan(120);
    expect(WORKSPACE_CREATE_THROTTLE.default.ttl).toBe(60_000);
  });

  it('the read poll (GET me) keeps the global default — the preparation screen polls it every 2.5 s', () => {
    expect(limitOf(ManagerWorkspaceController.prototype.getMine)).toBeUndefined();
  });
});
