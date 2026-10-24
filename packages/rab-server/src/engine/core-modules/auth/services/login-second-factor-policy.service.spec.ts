import { EnvironmentService } from '../../environment/environment.service';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { LoginSecondFactorPolicyService, SecondFactorSubject } from './login-second-factor-policy.service';

function policyWith(flags: Record<string, unknown>, facts: { totpEnabled: boolean; isInitialManager: boolean }) {
  const env = { get: (key: string) => flags[key] ?? (key === 'AUTH_MFA_MOBILE_POLICY' ? 'exempt' : false) } as unknown as EnvironmentService;
  const manager = {
    query: jest.fn(async (sql: string) => (sql.includes('totp_enabled') ? [{ totp_enabled: facts.totpEnabled }] : facts.isInitialManager ? [{ '?column?': 1 }] : [])),
  };
  const tenant = { runInTenantContext: jest.fn(async (_ctx: unknown, run: (m: typeof manager) => unknown) => run(manager)) } as unknown as TenantContextService;
  return new LoginSecondFactorPolicyService(env, tenant);
}

const subject = (over: Partial<SecondFactorSubject> = {}): SecondFactorSubject => ({
  userId: 'u',
  organisationId: 'o',
  workspaceId: 'w',
  roles: ['manager'],
  isPlatformAdmin: false,
  applicationTarget: 'manager_web',
  ...over,
});

describe('LoginSecondFactorPolicyService (wave 4)', () => {
  it("defaults: nobody is enforced, an un-enrolled account answers 'none' (no lockout on deploy)", async () => {
    const policy = policyWith({}, { totpEnabled: false, isInitialManager: true });
    for (const roles of [['ceo'], ['manager'], ['org_admin'], ['custom_x']]) {
      expect(await policy.requirementFor(subject({ roles, isPlatformAdmin: true }))).toBe('none');
    }
  });

  it("an ENROLLED account is always 'verify' on web, whatever the flags", async () => {
    expect(await policyWith({}, { totpEnabled: true, isInitialManager: false }).requirementFor(subject())).toBe('verify');
  });

  it.each([
    ['AUTH_MFA_ENFORCE_PLATFORM_ADMIN', subject({ isPlatformAdmin: true, roles: [] }), false],
    ['AUTH_MFA_ENFORCE_ORGANISATION_OWNER', subject({ roles: ['ceo'] }), false],
    ['AUTH_MFA_ENFORCE_INITIAL_MANAGER', subject({ roles: ['manager'] }), true],
    ['AUTH_MFA_ENFORCE_OTHER_WEB_USERS', subject({ roles: ['custom_ops'] }), false],
  ])("%s → 'enroll' for that class only", async (flag, who, initial) => {
    expect(await policyWith({ [flag]: true }, { totpEnabled: false, isInitialManager: initial }).requirementFor(who)).toBe('enroll');
    // The same flag does not reach an unrelated identity (a plain staff member).
    expect(await policyWith({ [flag]: true }, { totpEnabled: false, isInitialManager: false }).requirementFor(subject({ roles: ['staff'], applicationTarget: 'manager_web' }))).toBe('none');
  });

  it('mobile targets are exempt by default ONLY for the staff / venue-manager workforce; =require challenges them too', async () => {
    const enrolled = { totpEnabled: true, isInitialManager: false };
    expect(await policyWith({}, enrolled).requirementFor(subject({ roles: ['staff'], applicationTarget: 'staff_app' }))).toBe('none');
    expect(await policyWith({}, enrolled).requirementFor(subject({ roles: ['venue_manager'], applicationTarget: 'venue_manager_app' }))).toBe('none');
    expect(await policyWith({}, enrolled).requirementFor(subject({ roles: ['staff', 'venue_manager'], applicationTarget: 'venue_manager_app' }))).toBe('none');
    expect(await policyWith({ AUTH_MFA_MOBILE_POLICY: 'require' }, enrolled).requirementFor(subject({ roles: ['staff'], applicationTarget: 'staff_app' }))).toBe('verify');
  });

  it.each([
    ['a manager', { roles: ['manager'] }],
    ['a CEO', { roles: ['ceo'] }],
    ['an org admin', { roles: ['org_admin'] }],
    ['a manager who is also staff', { roles: ['staff', 'manager'] }],
    ['a custom-role member', { roles: ['custom_ops'] }],
    ['a platform admin with workforce roles', { roles: ['staff'], isPlatformAdmin: true }],
    ['a platform admin with no role', { roles: [], isPlatformAdmin: true }],
    ['an identity with no role at all', { roles: [] }],
  ] as Array<[string, Partial<SecondFactorSubject>]>)("ABUSE (M10-1): %s on a mobile target is NOT exempt — enrolled ⇒ 'verify'", async (_label, who) => {
    const enrolled = { totpEnabled: true, isInitialManager: false };
    for (const applicationTarget of ['staff_app', 'venue_manager_app'] as const) {
      expect(await policyWith({}, enrolled).requirementFor(subject({ ...who, applicationTarget }))).toBe('verify');
    }
  });

  it("ABUSE (M10-1): an ENFORCED higher-tier identity without a factor gets 'enroll' on mobile (never a silent password-only session)", async () => {
    const none = { totpEnabled: false, isInitialManager: true };
    expect(await policyWith({ AUTH_MFA_ENFORCE_INITIAL_MANAGER: true }, none).requirementFor(subject({ roles: ['manager'], applicationTarget: 'staff_app' }))).toBe('enroll');
    expect(await policyWith({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true }, none).requirementFor(subject({ roles: [], isPlatformAdmin: true, applicationTarget: 'venue_manager_app' }))).toBe('enroll');
    // Un-enforced, un-enrolled manager on mobile: nothing to verify, no lockout.
    expect(await policyWith({}, { totpEnabled: false, isInitialManager: false }).requirementFor(subject({ roles: ['manager'], applicationTarget: 'staff_app' }))).toBe('none');
    // Web enforcement never reaches the workforce on mobile.
    expect(await policyWith({ AUTH_MFA_ENFORCE_OTHER_WEB_USERS: true }, { totpEnabled: false, isInitialManager: false }).requirementFor(subject({ roles: ['venue_manager'], applicationTarget: 'venue_manager_app' }))).toBe('none');
  });

  it('fails closed: an account invisible in its own tenant context is an error, never "none"', async () => {
    const env = { get: () => false } as unknown as EnvironmentService;
    const tenant = { runInTenantContext: async (_c: unknown, run: (m: { query: () => Promise<unknown[]> }) => unknown) => run({ query: async () => [] }) } as unknown as TenantContextService;
    await expect(new LoginSecondFactorPolicyService(env, tenant).requirementFor(subject())).rejects.toThrow();
  });
});
