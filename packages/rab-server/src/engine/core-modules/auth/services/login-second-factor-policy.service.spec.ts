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

  it('mobile targets are exempt by default and challenged only with AUTH_MFA_MOBILE_POLICY=require', async () => {
    const enrolled = { totpEnabled: true, isInitialManager: false };
    expect(await policyWith({}, enrolled).requirementFor(subject({ applicationTarget: 'staff_app' }))).toBe('none');
    expect(await policyWith({}, enrolled).requirementFor(subject({ applicationTarget: 'venue_manager_app' }))).toBe('none');
    expect(await policyWith({ AUTH_MFA_MOBILE_POLICY: 'require' }, enrolled).requirementFor(subject({ applicationTarget: 'staff_app' }))).toBe('verify');
  });

  it('fails closed: an account invisible in its own tenant context is an error, never "none"', async () => {
    const env = { get: () => false } as unknown as EnvironmentService;
    const tenant = { runInTenantContext: async (_c: unknown, run: (m: { query: () => Promise<unknown[]> }) => unknown) => run({ query: async () => [] }) } as unknown as TenantContextService;
    await expect(new LoginSecondFactorPolicyService(env, tenant).requirementFor(subject())).rejects.toThrow();
  });
});
