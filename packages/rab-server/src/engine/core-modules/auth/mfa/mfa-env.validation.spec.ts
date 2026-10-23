import { validate } from '../../environment/env.validation';

const validEnv = {
  DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
};

describe('wave 4 lane MFA — environment', () => {
  it('every enforcement switch defaults OFF; enrolment is available; mobile is exempt; handoff is off', () => {
    const env = validate({ ...validEnv });
    expect(env.AUTH_MFA_ENROLMENT_ENABLED).toBe(true);
    expect(env.AUTH_MFA_ENFORCE_PLATFORM_ADMIN).toBe(false);
    expect(env.AUTH_MFA_ENFORCE_ORGANISATION_OWNER).toBe(false);
    expect(env.AUTH_MFA_ENFORCE_INITIAL_MANAGER).toBe(false);
    expect(env.AUTH_MFA_ENFORCE_OTHER_WEB_USERS).toBe(false);
    expect(env.AUTH_MFA_MOBILE_POLICY).toBe('exempt');
    expect(env.AUTH_MFA_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(env.AUTH_MFA_CHALLENGE_MAX_ATTEMPTS).toBe(5);
    expect(env.AUTH_STEP_UP_WINDOW_SECONDS).toBe(300);
    expect(env.AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS).toBe(false);
    expect(env.AUTH_LOGIN_HANDOFF_ENABLED).toBe(false);
    expect(env.AUTH_LOGIN_HANDOFF_TTL_SECONDS).toBe(30);
  });

  it('security switches are strict booleans: a typo refuses to boot', () => {
    for (const key of ['AUTH_MFA_ENFORCE_PLATFORM_ADMIN', 'AUTH_MFA_ENFORCE_ORGANISATION_OWNER', 'AUTH_MFA_ENFORCE_INITIAL_MANAGER', 'AUTH_MFA_ENFORCE_OTHER_WEB_USERS', 'AUTH_MFA_ENROLMENT_ENABLED', 'AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS', 'AUTH_LOGIN_HANDOFF_ENABLED']) {
      expect(() => validate({ ...validEnv, [key]: 'yes' })).toThrow(/Invalid environment configuration/);
    }
    expect(() => validate({ ...validEnv, AUTH_MFA_MOBILE_POLICY: 'sometimes' })).toThrow(/Invalid environment configuration/);
  });

  it('bounds: challenge TTL 60..600 s, handoff TTL 10..60 s, step-up window 60..900 s', () => {
    expect(() => validate({ ...validEnv, AUTH_MFA_CHALLENGE_TTL_SECONDS: '30' })).toThrow();
    expect(() => validate({ ...validEnv, AUTH_MFA_CHALLENGE_TTL_SECONDS: '601' })).toThrow();
    expect(() => validate({ ...validEnv, AUTH_LOGIN_HANDOFF_TTL_SECONDS: '61' })).toThrow();
    expect(() => validate({ ...validEnv, AUTH_STEP_UP_WINDOW_SECONDS: '901' })).toThrow();
    expect(validate({ ...validEnv, AUTH_LOGIN_HANDOFF_TTL_SECONDS: '30' }).AUTH_LOGIN_HANDOFF_TTL_SECONDS).toBe(30);
  });

  it('the login handoff requires host routing AND registry-backed origin trust (boot refused otherwise)', () => {
    expect(() => validate({ ...validEnv, AUTH_LOGIN_HANDOFF_ENABLED: 'true' })).toThrow(/AUTH_LOGIN_HANDOFF_ENABLED=true requires/);
    expect(() => validate({ ...validEnv, AUTH_LOGIN_HANDOFF_ENABLED: 'true', WORKSPACE_HOST_ROUTING_ENABLED: 'true', WORKSPACE_BASE_DOMAIN: 'localhost:5173' })).toThrow(
      /AUTH_LOGIN_HANDOFF_ENABLED=true requires/,
    );
    const env = validate({
      ...validEnv,
      AUTH_LOGIN_HANDOFF_ENABLED: 'true',
      WORKSPACE_HOST_ROUTING_ENABLED: 'true',
      WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'true',
      WORKSPACE_BASE_DOMAIN: 'localhost:5173',
    });
    expect(env.AUTH_LOGIN_HANDOFF_ENABLED).toBe(true);
  });
});
