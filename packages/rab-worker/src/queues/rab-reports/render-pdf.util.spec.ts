import { chromium } from 'playwright';

import { CHROMIUM_ENV_KEYS, chromiumLaunchEnv, renderHtmlToPdf } from './render-pdf.util';

/**
 * Docker hardening H6: the browser process gets an ALLOWLISTED environment, never the Worker's credentials. Playwright's
 * default (no `env` option) hands Chromium the whole `process.env`; Chromium runs without its OS sandbox as the same uid.
 * No browser is started here: `chromium.launch` is intercepted and the options it would have received are inspected.
 */
const CREDENTIALS: Record<string, string> = {
  PG_DATABASE_URL: 'postgres://crewflow_app:h6-unit-pg@db:5432/rab',
  CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow:h6-unit-prov@db:5432/rab',
  REDIS_URL: 'redis://:h6-unit-redis@redis:6379',
  APP_SECRET: 'h6-unit-app-secret',
  APP_ENCRYPTION_KEYRING: 'h6-unit-keyring',
  S3_ACCESS_KEY_ID: 'h6-unit-s3-id',
  S3_SECRET_ACCESS_KEY: 'h6-unit-s3-secret',
  EMAIL_SMTP_PASSWORD: 'h6-unit-smtp',
  RESEND_API_KEY: 'h6-unit-resend',
  FIREBASE_SERVICE_ACCOUNT_JSON: '{"private_key":"h6-unit"}',
  APNS_AUTH_KEY_P8: 'h6-unit-apns',
  SENTRY_DSN: 'https://h6-unit@sentry.invalid/1',
  ANTHROPIC_API_KEY: 'h6-unit-anthropic',
  AUTH_GOOGLE_CLIENT_SECRET: 'h6-unit-google',
  SOME_SERVICE_TOKEN: 'h6-unit-token',
};
const CREDENTIAL_SHAPED = /URL|SECRET|KEY|TOKEN|PASSWORD|DSN|CREDENTIAL|PRIVATE/i;

describe('render-pdf browser environment (H6 allowlist)', () => {
  const saved: Record<string, string | undefined> = {};
  let captured: Array<{ env?: Record<string, unknown> } | undefined> = [];

  beforeEach(() => {
    captured = [];
    for (const [k, v] of Object.entries(CREDENTIALS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    jest.spyOn(chromium, 'launch').mockImplementation(async (opts) => {
      captured.push(opts as { env?: Record<string, unknown> });
      throw new Error('H6 unit: launch intercepted');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('passes an explicit env to chromium.launch (never the inherited process.env)', async () => {
    await expect(renderHtmlToPdf('<p>x</p>')).rejects.toThrow('launch intercepted');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.env).toBeDefined();
    expect(captured[0]?.env).not.toBe(process.env);
  });

  it('the launch env holds only allowlisted names and nothing credential-shaped (URL/SECRET/KEY/TOKEN/PASSWORD)', async () => {
    await expect(renderHtmlToPdf('<p>x</p>')).rejects.toThrow('launch intercepted');
    const env = captured[0]?.env ?? {};
    const names = Object.keys(env);
    const allowed = process.platform === 'win32' ? null : new Set(CHROMIUM_ENV_KEYS);
    if (allowed) expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    expect(names.filter((n) => CREDENTIAL_SHAPED.test(n))).toEqual([]);
    const values = Object.values(env).map(String).join('\n');
    for (const secret of Object.values(CREDENTIALS)) expect(values).not.toContain(secret);
  });

  it('chromiumLaunchEnv keeps exactly the allowlisted names it is given and drops everything else', () => {
    const source = { ...CREDENTIALS, PATH: '/usr/bin', HOME: '/nonexistent', TMPDIR: '/tmp/crewflow-jobs', XDG_CACHE_HOME: '/tmp/c', LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '--inspect', UNKNOWN: 'x' };
    expect(chromiumLaunchEnv(source, 'linux')).toEqual({ PATH: '/usr/bin', HOME: '/nonexistent', TMPDIR: '/tmp/crewflow-jobs', XDG_CACHE_HOME: '/tmp/c', LANG: 'C.UTF-8', TZ: 'UTC' });
    for (const name of CHROMIUM_ENV_KEYS) expect(CREDENTIAL_SHAPED.test(name)).toBe(false);
  });

  it('on Windows (local development only) it also keeps the system directories Chromium needs, case-insensitively, and still no credential', () => {
    const env = chromiumLaunchEnv({ ...CREDENTIALS, SystemRoot: 'C:\\Windows', Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\x', TEMP: 'C:\\t' }, 'win32');
    expect(Object.keys(env).sort()).toEqual(['LOCALAPPDATA', 'Path', 'SystemRoot', 'TEMP']);
  });
});
