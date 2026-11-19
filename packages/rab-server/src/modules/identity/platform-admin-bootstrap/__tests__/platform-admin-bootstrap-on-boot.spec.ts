import { ForbiddenException, Logger } from '@nestjs/common';

import { EnvironmentService } from '../../../../engine/core-modules/environment/environment.service';
import {
  PLATFORM_ADMIN_BOOT_LOG,
  PlatformAdminBootstrapOnBoot,
  platformAdminBootFailureReason,
} from '../services/platform-admin-bootstrap-on-boot.service';
import {
  PlatformAdminBootstrapError,
  PlatformAdminBootstrapResult,
  PlatformAdminBootstrapService,
  readPlatformAdminBootstrapInput,
} from '../services/platform-admin-bootstrap.service';

/**
 * Unit spec (no database) for the boot-time adapter: what it calls, what it logs, and that it never throws. The database
 * guarantees (one-time, advisory lock, one email) are proven against PostgreSQL in
 * src/__tests__/integration/bootstrap-admin-at-boot.integration.spec.ts.
 */
describe('PlatformAdminBootstrapOnBoot (first platform admin at API boot)', () => {
  const EMAIL = 'First.Admin@Example.TEST';
  let run: jest.Mock<Promise<PlatformAdminBootstrapResult>, Parameters<PlatformAdminBootstrapService['run']>>;
  let mfaEnforced: boolean;
  let logs: { level: 'log' | 'warn' | 'error'; message: string }[];

  function provider(): PlatformAdminBootstrapOnBoot {
    const env = { get: (key: string) => (key === 'AUTH_MFA_ENFORCE_PLATFORM_ADMIN' ? mfaEnforced : undefined) } as unknown as EnvironmentService;
    return new PlatformAdminBootstrapOnBoot({ run } as unknown as PlatformAdminBootstrapService, env);
  }

  beforeEach(() => {
    run = jest.fn();
    mfaEnforced = false;
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push({ level, message: String(args[0]) });
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('BOOTSTRAP_ADMIN_EMAIL unset (or empty): does nothing and logs nothing', async () => {
    expect(await provider().runOnce({})).toBe('NOT_CONFIGURED');
    expect(await provider().runOnce({ BOOTSTRAP_ADMIN_EMAIL: '' })).toBe('NOT_CONFIGURED');
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('DENIAL: BOOTSTRAP_ADMIN_PASSWORD set -> refused, the bootstrap never runs (no password is ever accepted)', async () => {
    expect(await provider().runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' })).toBe('REFUSED_PASSWORD_SET');
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.passwordRefused }]);
    expect(JSON.stringify(logs)).not.toContain('Correct-Horse-Battery-42!');
  });

  it('the input has no password field at all, whatever the environment holds', () => {
    const input = readPlatformAdminBootstrapInput({ BOOTSTRAP_ADMIN_EMAIL: EMAIL, BOOTSTRAP_ADMIN_PASSWORD: 'x', BOOTSTRAP_ADMIN_ORG_SLUG: ' Platform ' });
    expect(input).toEqual({ email: 'first.admin@example.test', firstName: 'Admin', lastName: '', orgSlug: 'platform', orgName: null });
    expect(Object.keys(input!)).not.toContain('password');
  });

  it('fresh database: runs the shared service ONCE with the configured input (trigger api_boot, no self-heal) and logs the fixed creation line', async () => {
    const expiresAt = new Date('2026-11-20T10:00:00.000Z');
    run.mockResolvedValue({ outcome: 'CREATED_INVITED', userId: 'u1', organisationId: 'o1', createdOrganisation: true, activationExpiresAt: expiresAt });
    const env = { BOOTSTRAP_ADMIN_EMAIL: EMAIL, BOOTSTRAP_ADMIN_FIRST_NAME: ' Ada ', BOOTSTRAP_ADMIN_LAST_NAME: 'Lovelace', BOOTSTRAP_ADMIN_ORG_SLUG: 'acme', BOOTSTRAP_ADMIN_ORG_NAME: 'Acme' };
    expect(await provider().runOnce(env)).toBe('CREATED_INVITED');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { email: 'first.admin@example.test', firstName: 'Ada', lastName: 'Lovelace', orgSlug: 'acme', orgName: 'Acme' },
      { trigger: 'api_boot', selfHealExistingAdmin: false },
    );
    expect(logs).toEqual([
      { level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.created(expiresAt) },
      { level: 'warn', message: PLATFORM_ADMIN_BOOT_LOG.mfaNotEnforced },
    ]);
    // Fixed text: never the email address or an id.
    expect(JSON.stringify(logs).toLowerCase()).not.toContain('first.admin@example.test');
    expect(JSON.stringify(logs)).not.toMatch(/\bu1\b|\bo1\b/);
  });

  it('MFA: no warning when AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true (enrolment is then required at first sign-in)', async () => {
    mfaEnforced = true;
    run.mockResolvedValue({ outcome: 'GRANTED_EXISTING', userId: 'u1', organisationId: 'o1', createdOrganisation: false });
    expect(await provider().runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL })).toBe('GRANTED_EXISTING');
    expect(logs).toEqual([{ level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.grantedExisting }]);
  });

  it('an admin already exists: no-op, ONE line that the variable can be removed, and a second call in the same process does not run again', async () => {
    run.mockResolvedValue({ outcome: 'ALREADY_BOOTSTRAPPED', userId: 'u1', organisationId: 'o1' });
    const boot = provider();
    expect(await boot.runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL })).toBe('ALREADY_BOOTSTRAPPED');
    expect(await boot.runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL })).toBe('ALREADY_ATTEMPTED');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toMatchObject({ selfHealExistingAdmin: false });
    expect(logs).toEqual([{ level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.alreadyExists }]);
    expect(PLATFORM_ADMIN_BOOT_LOG.alreadyExists).toMatch(/can be removed/);
  });

  it.each([
    ['CLOSED', 'warn', PLATFORM_ADMIN_BOOT_LOG.closed],
    ['REFUSED_AMBIGUOUS_EMAIL', 'error', PLATFORM_ADMIN_BOOT_LOG.ambiguousEmail],
    ['REFUSED_AMBIGUOUS_ORGANISATION', 'error', PLATFORM_ADMIN_BOOT_LOG.ambiguousOrganisation],
  ] as const)('%s: nothing done, one fixed line, boot continues', async (outcome, level, message) => {
    run.mockResolvedValue({ outcome } as PlatformAdminBootstrapResult);
    expect(await provider().runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL })).toBe(outcome);
    expect(logs).toEqual([{ level, message }]);
  });

  it('FAIL CLOSED: any failure is logged with a fixed message and the boot continues (never throws, never retries)', async () => {
    run.mockRejectedValue(new Error(`insert into core."user" failed for ${EMAIL} as crewflow_owner`));
    const boot = provider();
    await expect(boot.runOnce({ BOOTSTRAP_ADMIN_EMAIL: EMAIL })).resolves.toBe('FAILED');
    await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined(); // the Nest hook itself never rejects
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.failed('unexpected-error') }]);
    expect(JSON.stringify(logs)).not.toContain(EMAIL);
    expect(JSON.stringify(logs)).not.toContain('crewflow_owner');
  });

  it('the Nest hook reads process.env and runs the same single attempt', async () => {
    const before = process.env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.BOOTSTRAP_ADMIN_EMAIL = EMAIL;
    try {
      run.mockResolvedValue({ outcome: 'ALREADY_BOOTSTRAPPED', userId: 'u1', organisationId: 'o1' });
      await provider().onApplicationBootstrap();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      if (before === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      else process.env.BOOTSTRAP_ADMIN_EMAIL = before;
    }
  });

  describe('failure reason labels (never the error message)', () => {
    it.each([
      [new PlatformAdminBootstrapError('NOT_AUTHORISED', 'role "crewflow_app" may not'), 'not-authorised'],
      [new PlatformAdminBootstrapError('FUNCTION_MISSING', 'x'), 'function-missing'],
      [new PlatformAdminBootstrapError('NO_RESULT', 'x'), 'unexpected-result'],
      [new PlatformAdminBootstrapError('UNEXPECTED_OUTCOME', 'x'), 'unexpected-result'],
      [Object.assign(new Error('a valid email address is required'), { code: '22023' }), 'invalid-input'],
      [{ driverError: { code: '40P01' }, message: 'deadlock' }, 'database-error-40P01'],
      [Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), 'database-error-57014'],
      [new ForbiddenException('This organisation has been suspended.'), 'organisation-suspended'],
      [Object.assign(new Error('x'), { code: 'not a sqlstate; DROP' }), 'unexpected-error'],
      ['a string', 'unexpected-error'],
      [null, 'unexpected-error'],
    ])('%p -> %s', (error, reason) => {
      expect(platformAdminBootFailureReason(error)).toBe(reason);
    });
  });
});
