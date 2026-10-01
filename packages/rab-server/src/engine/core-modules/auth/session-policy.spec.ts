import { absoluteSessionTtlMsFor } from './session-policy';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

describe('session policy — application ACCESS vs session SECURITY CLASS are separate axes', () => {
  it.each([
    // role(s)                          target                 expected TTL
    [['manager'], 'manager_web' as const, 24 * ONE_HOUR_MS],
    // A manager using an ALLOWED mobile target must not thereby receive the
    // 90-day mobile-worker session length — see application-access.ts and
    // application-access.integration.spec.ts's "complete application
    // matrix" case for why manager+mobile-target is allowed at all.
    [['manager'], 'staff_app' as const, 24 * ONE_HOUR_MS],
    [['manager'], 'venue_manager_app' as const, 24 * ONE_HOUR_MS],
    // Admin-tier roles get the same treatment as manager.
    [['ceo'], 'staff_app' as const, 24 * ONE_HOUR_MS],
    [['org_admin'], 'venue_manager_app' as const, 24 * ONE_HOUR_MS],
    [['super_admin'], 'manager_web' as const, 24 * ONE_HOUR_MS],
    [['admin'], 'manager_web' as const, 24 * ONE_HOUR_MS],
    // Genuine mobile-worker roles get the 90-day policy — only for the one
    // target their role is actually scoped to.
    [['staff'], 'staff_app' as const, 90 * ONE_DAY_MS],
    [['venue_manager'], 'venue_manager_app' as const, 90 * ONE_DAY_MS],
    // A user holding both a manager-tier role and a mobile-worker role gets
    // the STRICTER (shorter) policy — manager-tier is checked first.
    [['manager', 'staff'], 'staff_app' as const, 24 * ONE_HOUR_MS],
  ] as const)('%s + %s -> %dms', (roles, target, expectedMs) => {
    expect(absoluteSessionTtlMsFor(roles, target)).toBe(expectedMs);
  });

  it('fails closed for an unrecognised application target', () => {
    expect(() => absoluteSessionTtlMsFor(['staff'], 'not_a_real_target' as never)).toThrow(
      /No session policy defined/,
    );
  });

  it('a client cannot obtain a longer session merely by presenting a different (still-allowed) target as the same role', () => {
    const managerWeb = absoluteSessionTtlMsFor(['manager'], 'manager_web');
    const managerStaffApp = absoluteSessionTtlMsFor(['manager'], 'staff_app');
    const managerVenueApp = absoluteSessionTtlMsFor(['manager'], 'venue_manager_app');
    expect(managerStaffApp).toBe(managerWeb);
    expect(managerVenueApp).toBe(managerWeb);
  });
});
