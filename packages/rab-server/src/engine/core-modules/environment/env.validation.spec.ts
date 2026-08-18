import { validate } from './env.validation';

const validEnv = {
  DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
};

describe('validate', () => {
  it('accepts a fully specified valid environment', () => {
    const result = validate({ ...validEnv, PORT: '3000', NODE_ENV: 'production' });
    expect(result.PORT).toBe(3000);
    expect(result.NODE_ENV).toBe('production');
  });

  it('defaults PORT to 3000 and NODE_ENV to development', () => {
    const result = validate(validEnv);
    expect(result.PORT).toBe(3000);
    expect(result.NODE_ENV).toBe('development');
  });

  it('refuses to boot without APP_SECRET', () => {
    const { APP_SECRET, ...rest } = validEnv;
    expect(() => validate(rest)).toThrow(/APP_SECRET/);
  });

  it('refuses an APP_SECRET shorter than 32 characters', () => {
    expect(() => validate({ ...validEnv, APP_SECRET: 'too-short' })).toThrow(/APP_SECRET/);
  });

  it('refuses to boot without DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = validEnv;
    expect(() => validate(rest)).toThrow(/DATABASE_URL/);
  });

  it('refuses to boot without REDIS_URL', () => {
    const { REDIS_URL, ...rest } = validEnv;
    expect(() => validate(rest)).toThrow(/REDIS_URL/);
  });

  it('treats an empty-string optional var (e.g. "SENTRY_DSN=" in .env) as not provided, not invalid', () => {
    const result = validate({ ...validEnv, SENTRY_DSN: '' });
    expect(result.SENTRY_DSN).toBeUndefined();
  });

  it('still applies a class default when the empty-string var has one (CORS_ORIGINS)', () => {
    const result = validate({ ...validEnv, CORS_ORIGINS: '' });
    expect(result.CORS_ORIGINS).toBe('http://localhost:5173');
  });

  it('still refuses a required field left empty ("DATABASE_URL=")', () => {
    expect(() => validate({ ...validEnv, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
