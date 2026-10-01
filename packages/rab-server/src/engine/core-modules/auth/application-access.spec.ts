import { applicationAllowed, applicationDenied } from './application-access';

describe('application access', () => {
  it.each([
    ['staff', 'manager_web', false], ['staff', 'venue_manager_app', false], ['staff', 'staff_app', true],
    ['venue_manager', 'manager_web', false], ['venue_manager', 'venue_manager_app', true], ['venue_manager', 'staff_app', false],
    // Internal Manager has intentional, documented multi-app access — see
    // application-access.integration.spec.ts's "complete application
    // matrix" case and test-identities.integration.spec.ts's "every
    // application (intentional multi-app access)" case, both pre-dating
    // Phase 10. Phase 10 does not change WHICH targets a manager may use;
    // it independently enforces that the resulting SESSION is always the
    // 24h policy regardless of target — see session-policy.spec.ts.
    ['manager', 'manager_web', true], ['manager', 'venue_manager_app', true], ['manager', 'staff_app', true],
    ['ceo', 'manager_web', true], ['org_admin', 'manager_web', true],
    ['ceo', 'staff_app', true], ['org_admin', 'venue_manager_app', true],
  ] as const)('%s accessing %s: %s', (role, target, expected) => {
    expect(applicationAllowed([role], target)).toBe(expected);
  });
  it('fails closed for unknown and mixed venue roles', () => {
    expect(applicationAllowed([], 'staff_app', true)).toBe(true);
    expect(applicationAllowed([], 'manager_web')).toBe(false);
    // venue_manager is checked first and is NOT part of the multi-app
    // bucket, even when the same user also holds 'manager' — a narrowly-
    // scoped venue_manager identity is never widened by an additional role.
    expect(applicationAllowed(['venue_manager', 'manager'], 'manager_web')).toBe(false);
  });
  it('PHASE 10 / Step 3: Staff cannot request manager_web', () => {
    expect(applicationAllowed(['staff'], 'manager_web')).toBe(false);
  });
  it('reports valid-credential application rejection as 403', () => {
    expect(applicationDenied('manager_web').getStatus()).toBe(403);
    expect(applicationDenied('manager_web').message).toBe('This account does not have access to the Manager system.');
  });
});
