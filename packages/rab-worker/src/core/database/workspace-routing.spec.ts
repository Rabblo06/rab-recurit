import { WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';

import { isNotYetRoutableWorkspace } from './workspace-routing';

/** W6-E2E-07: only "still provisioning" refusals are skippable; integrity refusals keep failing the cycle. */
describe('isNotYetRoutableWorkspace', () => {
  it.each(['registry-missing', 'not-ready'] as const)('skips %s (workspace still being provisioned)', (code) => {
    expect(isNotYetRoutableWorkspace(new WorkspaceRoutingError(code))).toBe(true);
  });

  it.each(['name-mismatch', 'unsupported-version', 'missing-context'] as const)('never skips %s (integrity refusal)', (code) => {
    expect(isNotYetRoutableWorkspace(new WorkspaceRoutingError(code))).toBe(false);
  });

  it('never skips other errors, even ones that look similar', () => {
    expect(isNotYetRoutableWorkspace(new Error('registry-missing'))).toBe(false);
    expect(isNotYetRoutableWorkspace(Object.assign(new Error('x'), { code: 'not-ready' }))).toBe(false);
    expect(isNotYetRoutableWorkspace('registry-missing')).toBe(false);
    expect(isNotYetRoutableWorkspace(undefined)).toBe(false);
  });
});
