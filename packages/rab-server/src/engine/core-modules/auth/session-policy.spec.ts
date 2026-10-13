import { absoluteSessionTtlMsFor, idleSessionTimeoutMsByTarget, idleSessionTimeoutMsFor } from './session-policy';

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

  // ---------------------------------------------------------------------------------------------- P0.3 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.2)
  describe('isPlatformAdmin — independent of roles, caps at the 24h policy regardless of target', () => {
    it('a platform admin with NO manager-tier role still gets 24h on a mobile target — the exact bug being fixed: core.platform_admin is keyed by user id, independent of roles, so roles alone previously let this fall through to the 90-day policy', () => {
      expect(absoluteSessionTtlMsFor(['staff'], 'staff_app', true)).toBe(24 * ONE_HOUR_MS);
      expect(absoluteSessionTtlMsFor(['venue_manager'], 'venue_manager_app', true)).toBe(24 * ONE_HOUR_MS);
      expect(absoluteSessionTtlMsFor([], 'staff_app', true)).toBe(24 * ONE_HOUR_MS); // no roles at all, still capped
    });

    it('isPlatformAdmin=false (or omitted) behaves exactly as before — no regression for the non-admin path', () => {
      expect(absoluteSessionTtlMsFor(['staff'], 'staff_app', false)).toBe(90 * ONE_DAY_MS);
      expect(absoluteSessionTtlMsFor(['staff'], 'staff_app')).toBe(90 * ONE_DAY_MS);
    });

    it('a platform admin who is ALSO a manager-tier role gets 24h either way (both inputs agree)', () => {
      expect(absoluteSessionTtlMsFor(['manager'], 'manager_web', true)).toBe(24 * ONE_HOUR_MS);
    });
  });

  // ---------------------------------------------------------------------------------------------- P2.2 idle-session timeout
  describe('idleSessionTimeoutMsFor — per application_target, never longer than the absolute ceiling', () => {
    it.each([
      ['manager_web' as const, 30 * 60 * 1000],
      ['staff_app' as const, 7 * ONE_DAY_MS],
      ['venue_manager_app' as const, 7 * ONE_DAY_MS],
    ])('%s -> %dms', (target, expectedMs) => {
      expect(idleSessionTimeoutMsFor(target)).toBe(expectedMs);
    });

    it('fails closed for an unrecognised application target', () => {
      expect(() => idleSessionTimeoutMsFor('not_a_real_target' as never)).toThrow(/No idle-session policy defined/);
    });

    it('every idle duration is strictly less than that target\'s own absolute ceiling', () => {
      const idle = idleSessionTimeoutMsByTarget();
      expect(idle.manager_web).toBeLessThan(absoluteSessionTtlMsFor(['manager'], 'manager_web'));
      expect(idle.staff_app).toBeLessThan(absoluteSessionTtlMsFor(['staff'], 'staff_app'));
      expect(idle.venue_manager_app).toBeLessThan(absoluteSessionTtlMsFor(['venue_manager'], 'venue_manager_app'));
    });

    it('idleSessionTimeoutMsByTarget returns all three targets, matching idleSessionTimeoutMsFor exactly', () => {
      const idle = idleSessionTimeoutMsByTarget();
      expect(idle.manager_web).toBe(idleSessionTimeoutMsFor('manager_web'));
      expect(idle.staff_app).toBe(idleSessionTimeoutMsFor('staff_app'));
      expect(idle.venue_manager_app).toBe(idleSessionTimeoutMsFor('venue_manager_app'));
    });
  });
});
