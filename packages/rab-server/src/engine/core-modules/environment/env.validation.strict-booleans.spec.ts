import { validate } from './env.validation';
import { EnvironmentVariables } from './environment-variables';

/**
 * Phase X3.1 (XR-05 / ENV-01): the fourteen on/off switches that used to read `value === 'true'` now go through the
 * shared strictBoolean helper. Before, any typo meant false, silently: `USER_SESSION_ENFORCEMENT_CUTOVER=True` left the
 * session cutover off, `EMAIL_DELIVERY_ENABLED=ture` stopped every email. Now:
 *   - exactly `true` / `false` (lower case, no spaces) are accepted;
 *   - unset or empty (`KEY=`) keeps the documented default;
 *   - anything else refuses to boot, naming the variable and never echoing a different variable's value.
 * AI_AGENTS_ENABLED stays loose on purpose (its own comment) and is pinned here too, so it is not tightened by accident.
 */
const base = { PG_DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

const GOOGLE = {
  AUTH_GOOGLE_CLIENT_ID: 'google-client-id',
  AUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
  AUTH_GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
};
const MICROSOFT = {
  AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
  AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
  AUTH_MICROSOFT_CALLBACK_URL: 'http://localhost:3000/auth/microsoft/callback',
};

type Flag = keyof EnvironmentVariables;

/** Each flag, its documented default, and what else a valid `true`/`false` needs so that only the flag is under test. */
const FLAGS: Array<{ flag: Flag; defaultValue: boolean; whenTrue?: Record<string, string>; whenFalse?: Record<string, string> }> = [
  { flag: 'EMAIL_DELIVERY_ENABLED', defaultValue: true },
  { flag: 'AUTH_CONTEXT_CACHE_ENABLED', defaultValue: false },
  { flag: 'USER_SESSION_CACHE_ENABLED', defaultValue: false },
  { flag: 'CORE_ENTITY_CACHE_ENABLED', defaultValue: false },
  { flag: 'WORKSPACE_METADATA_CACHE_ENABLED', defaultValue: false },
  { flag: 'WORKER_FAST_PUBLISH_NOTIFY', defaultValue: false },
  { flag: 'USER_SESSION_ENFORCEMENT_CUTOVER', defaultValue: false },
  // false alone would leave no sign-in method (a separate refusal), so Google is switched on for that case.
  { flag: 'AUTH_PASSWORD_ENABLED', defaultValue: true, whenFalse: { AUTH_GOOGLE_ENABLED: 'true', ...GOOGLE } },
  { flag: 'AUTH_GOOGLE_ENABLED', defaultValue: false, whenTrue: GOOGLE },
  { flag: 'AUTH_MICROSOFT_ENABLED', defaultValue: false, whenTrue: MICROSOFT },
  { flag: 'AUTH_OAUTH_HANDOFF_ENABLED', defaultValue: false },
  { flag: 'EMAIL_SMTP_NO_TLS', defaultValue: false },
  { flag: 'REALTIME_ENABLED', defaultValue: false },
  { flag: 'PUSH_ENABLED', defaultValue: false },
];

/** Typos an operator could plausibly type. Every one used to mean false; every one now refuses to boot. */
const TYPOS = ['True', 'TRUE', 'False', 'FALSE', '1', '0', 'yes', 'no', 'on', 'off', ' true', 'true ', 'flase', 'ture', '"true"'];

describe('X3.1 strict booleans: the fourteen formerly loose on/off switches', () => {
  describe.each(FLAGS)('$flag', ({ flag, defaultValue, whenTrue = {}, whenFalse = {} }) => {
    it(`unset keeps the documented default (${defaultValue})`, () => {
      const extra = defaultValue ? whenTrue : whenFalse;
      expect(validate({ ...base, ...extra })[flag]).toBe(defaultValue);
    });

    it(`empty (KEY=) keeps the documented default (${defaultValue})`, () => {
      const extra = defaultValue ? whenTrue : whenFalse;
      expect(validate({ ...base, ...extra, [flag]: '' })[flag]).toBe(defaultValue);
    });

    it('accepts exactly true', () => {
      expect(validate({ ...base, ...whenTrue, [flag]: 'true' })[flag]).toBe(true);
    });

    it('accepts exactly false', () => {
      expect(validate({ ...base, ...whenFalse, [flag]: 'false' })[flag]).toBe(false);
    });

    it.each(TYPOS)('refuses to boot on the typo %p', (typo) => {
      expect(() => validate({ ...base, ...whenTrue, ...whenFalse, [flag]: typo })).toThrow(
        new RegExp(`Invalid environment configuration:[\\s\\S]*${flag} must be exactly true or false`),
      );
    });
  });

  it('a refusal names the mistyped variable only and never echoes its value', () => {
    const error = (() => {
      try {
        validate({ ...base, USER_SESSION_ENFORCEMENT_CUTOVER: 'secret-looking-typo' });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected a refusal');
    })();
    expect(error.message).toMatch(/USER_SESSION_ENFORCEMENT_CUTOVER must be exactly true or false/);
    expect(error.message).not.toContain('secret-looking-typo');
  });

  it.each([
    ['AUTH_GOOGLE_ENABLED', /AUTH_GOOGLE_CLIENT_ID|AUTH_GOOGLE_CLIENT_SECRET|AUTH_GOOGLE_CALLBACK_URL/],
    ['AUTH_MICROSOFT_ENABLED', /AUTH_MICROSOFT_CLIENT_ID|AUTH_MICROSOFT_CLIENT_SECRET|AUTH_MICROSOFT_CALLBACK_URL|AUTH_MICROSOFT_TENANT/],
  ])('a typo in %s (no credentials set) is refused for the typo alone, never as a demand for that provider credentials', (flag, credentials) => {
    for (const typo of ['False', 'TRUE', 'yes']) {
      const error = (() => {
        try {
          validate({ ...base, [flag]: typo });
        } catch (caught) {
          return caught as Error;
        }
        throw new Error('expected a refusal');
      })();
      expect(error.message).toMatch(new RegExp(`${flag} must be exactly true or false`));
      expect(error.message).not.toMatch(credentials);
    }
  });

  it('S3_FORCE_PATH_STYLE (already strict) now uses the same helper: true/false accepted, a typo refused', () => {
    expect(validate({ ...base, S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
    expect(validate({ ...base, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
    expect(validate({ ...base }).S3_FORCE_PATH_STYLE).toBe(false);
    expect(() => validate({ ...base, S3_FORCE_PATH_STYLE: 'TRUE' })).toThrow(/S3_FORCE_PATH_STYLE must be exactly true or false/);
  });

  it('AI_AGENTS_ENABLED stays loose on purpose: only exactly true turns it on, anything else is off, never a refusal', () => {
    expect(validate({ ...base, AI_AGENTS_ENABLED: 'true' }).AI_AGENTS_ENABLED).toBe(true);
    for (const value of ['false', 'True', '1', 'yes', 'flase']) {
      expect(validate({ ...base, AI_AGENTS_ENABLED: value }).AI_AGENTS_ENABLED).toBe(false);
    }
  });
});
