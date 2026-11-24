import { validate } from './env.validation';
import {
  PLATFORM_ADMIN_MFA_OVERRIDE_EVENT_TYPE,
  PLATFORM_ADMIN_MFA_OVERRIDE_KEY,
  platformAdminMfaOverrideActive,
  platformAdminMfaProductionProblem,
  reportPlatformAdminMfaOverride,
} from './platform-admin-mfa-production';
import type { SecurityAuditEvent, SecurityAuditSink } from '../audit-sink/security-audit-sink';

/**
 * Owner decision 2 (2026-11-21) + review of #327 (fail closed): production refuses to boot with platform-admin MFA off,
 * unless the break-glass override carries a written reason; the API logs and audits an active override at every start.
 */
const REASON = 'INC-42: the only platform admin lost the authenticator, reset in progress';

const productionEnv = {
  REDIS_URL: 'redis://localhost:6379',
  NODE_ENV: 'production',
  EMAIL_DRIVER: 'RESEND',
  STORAGE_DRIVER: 'S3',
  S3_BUCKET: 'bucket',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'key-id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_ENDPOINT: 'https://s3.example.com',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://accounts.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.12.7/32',
  APP_SECRET: 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA',
  PG_DATABASE_URL: 'postgres://rab:rab@db.example.com:5432/rab?sslmode=verify-full',
};

const MFA_REFUSAL = /AUTH_MFA_ENFORCE_PLATFORM_ADMIN must be true in production \(owner decision 2/;

function recordingSink(fail = false): SecurityAuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = [];
  return {
    mode: 'stdout',
    events,
    emit: async (event: SecurityAuditEvent) => {
      if (fail) throw new Error('sink down');
      events.push(event);
    },
  } as SecurityAuditSink & { events: SecurityAuditEvent[] };
}

describe('platform-admin MFA in production (owner decision 2, review of #327)', () => {
  describe('platformAdminMfaProductionProblem (pure)', () => {
    it('accepts the switch on, with or without an override', () => {
      expect(platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true })).toBeNull();
      expect(platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON })).toBeNull();
    });

    it('refuses the switch off or missing without an override', () => {
      expect(platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false })).toMatch(MFA_REFUSAL);
      expect(platformAdminMfaProductionProblem({})).toMatch(MFA_REFUSAL);
    });

    it('refuses an override whose reason is empty, blank or shorter than 20 characters', () => {
      for (const reason of ['', '   ', 'because', ' 19 characters long ']) {
        expect(platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: reason })).toMatch(MFA_REFUSAL);
      }
    });

    it('accepts the switch off with an override reason of at least 20 characters', () => {
      expect(platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON })).toBeNull();
      expect(platformAdminMfaOverrideActive({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON })).toBe(true);
      expect(platformAdminMfaOverrideActive({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON })).toBe(false);
    });

    it('the refusal names the variables, never the reason text', () => {
      const msg = platformAdminMfaProductionProblem({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: 'short secret' })!;
      expect(msg).toContain(PLATFORM_ADMIN_MFA_OVERRIDE_KEY);
      expect(msg).not.toContain('short secret');
    });
  });

  describe('validate() (the boot path shared by the API and the Worker)', () => {
    it('refuses a production boot with the switch false, and with it missing', () => {
      expect(() => validate({ ...productionEnv, AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'false' })).toThrow(MFA_REFUSAL);
      expect(() => validate({ ...productionEnv })).toThrow(MFA_REFUSAL);
    });

    it('boots with the switch true', () => {
      expect(validate({ ...productionEnv, AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'true' }).AUTH_MFA_ENFORCE_PLATFORM_ADMIN).toBe(true);
    });

    it('boots with the switch false only under the override with a reason', () => {
      const result = validate({ ...productionEnv, AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'false', AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON });
      expect(result.AUTH_MFA_ENFORCE_PLATFORM_ADMIN).toBe(false);
      expect(() => validate({ ...productionEnv, AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'false', AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: 'too short' })).toThrow(MFA_REFUSAL);
    });

    it('development and test keep the code default (false) with no refusal', () => {
      const dev = validate({ REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', NODE_ENV: 'development' });
      expect(dev.AUTH_MFA_ENFORCE_PLATFORM_ADMIN).toBe(false);
    });
  });

  describe('reportPlatformAdminMfaOverride (API start)', () => {
    const run = (env: Parameters<typeof reportPlatformAdminMfaOverride>[0]['env'], production: boolean, sink = recordingSink()) => {
      const lines: string[] = [];
      return reportPlatformAdminMfaOverride({ env, production, sink, processLabel: 'api process', log: (l) => lines.push(l) }).then((reported) => ({ reported, lines, sink }));
    };

    it('an active override in production is logged once and sent as one critical audit event with the reason', async () => {
      const { reported, lines, sink } = await run({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: `  ${REASON}  ` }, true);
      expect(reported).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/\[platform-admin-mfa\] WARNING api process: AUTH_MFA_ENFORCE_PLATFORM_ADMIN is off in production under the break-glass override/);
      expect(lines[0]).not.toContain(REASON);
      expect(sink.events).toEqual([
        { type: PLATFORM_ADMIN_MFA_OVERRIDE_EVENT_TYPE, severity: 'critical', process: 'api process', detail: { variable: PLATFORM_ADMIN_MFA_OVERRIDE_KEY, reason: REASON } },
      ]);
    });

    it('the reason in the event is truncated to 200 characters', async () => {
      const { sink } = await run({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: 'x'.repeat(450) }, true);
      expect((sink.events[0]!.detail as { reason: string }).reason).toHaveLength(200);
    });

    it('nothing is reported with the switch on, without an override, or outside production', async () => {
      for (const [env, production] of [
        [{ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON }, true],
        [{ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true }, true],
        [{ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON }, false],
      ] as const) {
        const { reported, lines, sink } = await run(env, production);
        expect(reported).toBe(false);
        expect(lines).toEqual([]);
        expect(sink.events).toEqual([]);
      }
    });

    it('fails closed: an override that cannot be audited throws (main.ts refuses the start)', async () => {
      await expect(run({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: false, AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE: REASON }, true, recordingSink(true))).rejects.toThrow('sink down');
    });
  });
});
