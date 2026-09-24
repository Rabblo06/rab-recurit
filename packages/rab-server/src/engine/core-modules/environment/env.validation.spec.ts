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

describe('validate — STORAGE_DRIVER / S3 (Cloudflare R2) conditional validation', () => {
  const validR2Env = {
    ...validEnv,
    STORAGE_DRIVER: 'S3',
    S3_BUCKET: 'rab-production-storage',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'r2-access-key',
    S3_SECRET_ACCESS_KEY: 'r2-secret-key',
    S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  };

  it('STORAGE_DRIVER defaults to LOCAL and boots with NO S3 vars at all', () => {
    const result = validate(validEnv);
    expect(result.STORAGE_DRIVER).toBe('LOCAL');
    expect(result.S3_BUCKET).toBeUndefined();
    expect(result.S3_ACCESS_KEY_ID).toBeUndefined();
  });

  it('STORAGE_DRIVER=LOCAL boots without S3 vars even when explicitly set', () => {
    expect(() => validate({ ...validEnv, STORAGE_DRIVER: 'LOCAL' })).not.toThrow();
  });

  it('accepts a fully specified R2-shaped S3 configuration', () => {
    const result = validate(validR2Env);
    expect(result.STORAGE_DRIVER).toBe('S3');
    expect(result.S3_REGION).toBe('auto');
    expect(result.S3_ENDPOINT).toBe('https://accountid.r2.cloudflarestorage.com');
  });

  it.each(['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT'] as const)(
    'STORAGE_DRIVER=S3 refuses to boot without %s',
    (missingKey) => {
      const { [missingKey]: _omit, ...rest } = validR2Env;
      expect(() => validate(rest)).toThrow(new RegExp(`STORAGE_DRIVER=S3 requires.*${missingKey}`));
    },
  );

  it('rejects an unknown STORAGE_DRIVER value at the field level', () => {
    expect(() => validate({ ...validEnv, STORAGE_DRIVER: 'AZURE_BLOB' })).toThrow(/STORAGE_DRIVER/);
  });

  it('S3_FORCE_PATH_STYLE parses "true"/"false" as real booleans, not JS truthiness of the string', () => {
    expect(validate({ ...validR2Env, S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
    expect(validate({ ...validR2Env, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
    // Boolean("false") === true is the exact footgun this must NOT reproduce.
    expect(validate({ ...validR2Env, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).not.toBe(true);
  });

  it('rejects an invalid S3_FORCE_PATH_STYLE value', () => {
    expect(() => validate({ ...validR2Env, S3_FORCE_PATH_STYLE: 'yes' })).toThrow(/S3_FORCE_PATH_STYLE/);
  });

  it('S3_SIGNED_URL_TTL_SECONDS must be a positive integer within range', () => {
    expect(validate({ ...validR2Env, S3_SIGNED_URL_TTL_SECONDS: '120' }).S3_SIGNED_URL_TTL_SECONDS).toBe(120);
    expect(() => validate({ ...validR2Env, S3_SIGNED_URL_TTL_SECONDS: '-5' })).toThrow(/S3_SIGNED_URL_TTL_SECONDS/);
    expect(() => validate({ ...validR2Env, S3_SIGNED_URL_TTL_SECONDS: 'soon' })).toThrow(/S3_SIGNED_URL_TTL_SECONDS/);
  });

  it('S3_MAX_UPLOAD_BYTES must be a positive integer', () => {
    expect(validate({ ...validR2Env, S3_MAX_UPLOAD_BYTES: '20971520' }).S3_MAX_UPLOAD_BYTES).toBe(20_971_520);
    expect(() => validate({ ...validR2Env, S3_MAX_UPLOAD_BYTES: '-1' })).toThrow(/S3_MAX_UPLOAD_BYTES/);
    expect(() => validate({ ...validR2Env, S3_MAX_UPLOAD_BYTES: 'huge' })).toThrow(/S3_MAX_UPLOAD_BYTES/);
  });

  it('S3_SERVER_SIDE_ENCRYPTION=NONE is valid (required for Cloudflare R2, which rejects AWS SSE headers)', () => {
    expect(validate({ ...validR2Env, S3_SERVER_SIDE_ENCRYPTION: 'NONE' }).S3_SERVER_SIDE_ENCRYPTION).toBe('NONE');
  });

  it('S3_SERVER_SIDE_ENCRYPTION=aws:kms without S3_KMS_KEY_ID refuses to boot', () => {
    expect(() => validate({ ...validR2Env, S3_SERVER_SIDE_ENCRYPTION: 'aws:kms' })).toThrow(/S3_KMS_KEY_ID/);
  });

  it('S3_SERVER_SIDE_ENCRYPTION=aws:kms WITH S3_KMS_KEY_ID boots fine', () => {
    expect(() => validate({ ...validR2Env, S3_SERVER_SIDE_ENCRYPTION: 'aws:kms', S3_KMS_KEY_ID: 'key-123' })).not.toThrow();
  });

  it('rejects an unknown S3_SERVER_SIDE_ENCRYPTION value', () => {
    expect(() => validate({ ...validR2Env, S3_SERVER_SIDE_ENCRYPTION: 'ROT13' })).toThrow(/S3_SERVER_SIDE_ENCRYPTION/);
  });

  it('STORAGE_KEY_PREFIX defaults to "dev" and normalises a messy value at boot, not on first write', () => {
    expect(validate(validEnv).STORAGE_KEY_PREFIX).toBe('dev');
    expect(() => validate({ ...validR2Env, STORAGE_KEY_PREFIX: '../escape' })).toThrow(/traversal/i);
    expect(() => validate({ ...validR2Env, STORAGE_KEY_PREFIX: '   ' })).toThrow(/empty/i);
  });
});
