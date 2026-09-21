import { applicationAllowed, applicationDenied } from './application-access';

describe('application access', () => {
  it.each([
    ['staff', 'manager_web', false], ['staff', 'venue_manager_app', false], ['staff', 'staff_app', true],
    ['venue_manager', 'manager_web', false], ['venue_manager', 'venue_manager_app', true], ['venue_manager', 'staff_app', false],
    ['manager', 'manager_web', true], ['manager', 'venue_manager_app', true], ['manager', 'staff_app', true],
    ['ceo', 'manager_web', true], ['org_admin', 'manager_web', true],
    ['ceo', 'staff_app', true], ['org_admin', 'venue_manager_app', true],
  ] as const)('%s accessing %s: %s', (role, target, expected) => {
    expect(applicationAllowed([role], target)).toBe(expected);
  });
  it('fails closed for unknown and mixed venue roles', () => {
    expect(applicationAllowed([], 'staff_app', true)).toBe(true);
    expect(applicationAllowed([], 'manager_web')).toBe(false);
    expect(applicationAllowed(['venue_manager', 'manager'], 'manager_web')).toBe(false);
  });
  it('reports valid-credential application rejection as 403', () => {
    expect(applicationDenied('manager_web').getStatus()).toBe(403);
    expect(applicationDenied('manager_web').message).toBe('This account does not have access to the Manager system.');
  });
});
