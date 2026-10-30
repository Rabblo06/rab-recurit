import { validate } from './env.validation';

const validEnv = {
  DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
};

// CF-40: the minimum a production boot needs beyond the base fixture (real email + object storage, https origins, exact proxy).
const productionEnv = {
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
  // Wave 2 lane A2: production refuses a weak APP_SECRET (the base fixture's 'a'.repeat(32) has one distinct character).
  APP_SECRET: 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA',
  // Phase B (B1): production takes PG_DATABASE_URL only and refuses the legacy DATABASE_URL.
  PG_DATABASE_URL: 'postgres://rab:rab@db.example.com:5432/rab?sslmode=verify-full',
  DATABASE_URL: undefined,
};

describe('validate', () => {
  it('accepts a fully specified valid environment', () => {
    // CF-40: a production environment must carry production values (development defaults are refused, see below).
    const result = validate({ ...validEnv, ...productionEnv, PORT: '3000', NODE_ENV: 'production' });
    expect(result.PORT).toBe(3000);
    expect(result.NODE_ENV).toBe('production');
  });

  it('refuses production on development defaults (CF-40)', () => {
    expect(() => validate({ ...validEnv, PORT: '3000', NODE_ENV: 'production' })).toThrow(/for production/);
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

  it('APP_URL and ACCOUNTS_URL both default to the local dev server but are independently configurable', () => {
    const defaults = validate(validEnv);
    expect(defaults.APP_URL).toBe('http://localhost:5173');
    expect(defaults.ACCOUNTS_URL).toBe('http://localhost:5173');

    const configured = validate({
      ...validEnv,
      APP_URL: 'https://app.rabworkspaceteams.co.uk',
      ACCOUNTS_URL: 'https://accounts.rabworkspaceteams.co.uk',
    });
    expect(configured.APP_URL).toBe('https://app.rabworkspaceteams.co.uk');
    expect(configured.ACCOUNTS_URL).toBe('https://accounts.rabworkspaceteams.co.uk');
    expect(configured.APP_URL).not.toBe(configured.ACCOUNTS_URL);
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

describe('validate — wave 1 lane A security settings', () => {
  const keyring = JSON.stringify([{ kid: '2026-11', secret: 'r'.repeat(32) }]);

  it('defaults: legacy JWT verification ON, subdomain origin trust OFF, login limits set', () => {
    const env = validate(validEnv);
    expect(env.APP_JWT_LEGACY_VERIFY_ENABLED).toBe(true);
    expect(env.WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED).toBe(false);
    expect(env.AUTH_LOGIN_EMAIL_IP_BURST).toBe(5);
    expect(env.AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS).toBe(900);
    expect(env.AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT).toBe(30);
    expect(env.AUTH_LOGIN_ACCOUNT_BURST).toBe(50);
    expect(env.AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS).toBe(900);
    expect(env.AUTH_LOGIN_KNOWN_IP_TTL_DAYS).toBe(30);
  });

  it('APP_JWT_LEGACY_VERIFY_ENABLED=false without a keyring boots since wave 2 (the signing kid is derived-v1, never raw APP_SECRET)', () => {
    expect(validate({ ...validEnv, APP_JWT_LEGACY_VERIFY_ENABLED: 'false' }).APP_JWT_LEGACY_VERIFY_ENABLED).toBe(false);
  });

  it('APP_JWT_LEGACY_VERIFY_ENABLED=false with a keyring and active kid boots', () => {
    const env = validate({ ...validEnv, APP_JWT_LEGACY_VERIFY_ENABLED: 'false', APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
    expect(env.APP_JWT_LEGACY_VERIFY_ENABLED).toBe(false);
  });

  it('a security flag with a typo refuses to boot instead of guessing (fail closed)', () => {
    expect(() => validate({ ...validEnv, APP_JWT_LEGACY_VERIFY_ENABLED: 'flase' })).toThrow(/Invalid environment configuration/);
    expect(() => validate({ ...validEnv, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'yes' })).toThrow(/Invalid environment configuration/);
  });

  it('WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true requires WORKSPACE_BASE_DOMAIN', () => {
    expect(() => validate({ ...validEnv, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'true' })).toThrow(/requires WORKSPACE_BASE_DOMAIN/);
    expect(
      validate({ ...validEnv, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'true', WORKSPACE_HOST_ROUTING_ENABLED: 'true', WORKSPACE_BASE_DOMAIN: 'localhost:5173' })
        .WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED,
    ).toBe(true);
  });

  // Wave 3 lane H
  it('WORKSPACE_HOST_ROUTING_ENABLED defaults to false and requires WORKSPACE_BASE_DOMAIN', () => {
    expect(validate({ ...validEnv }).WORKSPACE_HOST_ROUTING_ENABLED).toBe(false);
    expect(() => validate({ ...validEnv, WORKSPACE_HOST_ROUTING_ENABLED: 'true' })).toThrow(/WORKSPACE_HOST_ROUTING_ENABLED=true requires WORKSPACE_BASE_DOMAIN/);
    expect(() => validate({ ...validEnv, WORKSPACE_HOST_ROUTING_ENABLED: 'yes', WORKSPACE_BASE_DOMAIN: 'localhost:5173' })).toThrow(/Invalid environment configuration/);
  });

  it('origin trust requires host routing (the wrong-host 404 is what contains a trusted workspace origin)', () => {
    expect(() => validate({ ...validEnv, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'true', WORKSPACE_BASE_DOMAIN: 'localhost:5173' })).toThrow(
      /requires WORKSPACE_HOST_ROUTING_ENABLED=true/,
    );
  });

  it.each(['https://workspaces.example.com', 'workspaces.example.com/', 'workspaces.example.com.', 'work spaces.example.com', '*.example.com'])(
    'WORKSPACE_BASE_DOMAIN must be a bare host[:port] (%s refused)',
    (value) => {
      expect(() => validate({ ...validEnv, WORKSPACE_BASE_DOMAIN: value })).toThrow(/WORKSPACE_BASE_DOMAIN must be a bare host/);
    },
  );

  it('login limits must be positive integers', () => {
    expect(() => validate({ ...validEnv, AUTH_LOGIN_EMAIL_IP_BURST: '0' })).toThrow(/Invalid environment configuration/);
    expect(() => validate({ ...validEnv, AUTH_LOGIN_ACCOUNT_BURST: 'many' })).toThrow(/Invalid environment configuration/);
  });
});

describe('validate — wave 2 lane A2 key separation and cookie flags', () => {
  const strong = 'p9Qw2Er7Ty1Ui8Op3As6Df0Gh5Jk4LzX';

  it('defaults: cookie prefix OFF, legacy migration ON, key separation not required', () => {
    const env = validate(validEnv);
    expect(env.AUTH_COOKIE_HOST_PREFIX_ENABLED).toBe(false);
    expect(env.AUTH_COOKIE_LEGACY_MIGRATION_ENABLED).toBe(true);
    expect(env.APP_KEY_SEPARATION_REQUIRED).toBe(false);
    expect(env.APP_AUTH_CACHE_HMAC_KEY).toBeUndefined();
  });

  it('the new flags are strict booleans (a typo refuses to boot)', () => {
    for (const key of ['AUTH_COOKIE_HOST_PREFIX_ENABLED', 'AUTH_COOKIE_LEGACY_MIGRATION_ENABLED', 'APP_KEY_SEPARATION_REQUIRED']) {
      expect(() => validate({ ...validEnv, [key]: 'yes' })).toThrow(/Invalid environment configuration/);
    }
    expect(validate({ ...validEnv, AUTH_COOKIE_HOST_PREFIX_ENABLED: 'true' }).AUTH_COOKIE_HOST_PREFIX_ENABLED).toBe(true);
  });

  it('a secret reused across key roles refuses to boot in every environment, naming roles but never the value', () => {
    let message = '';
    try {
      validate({ ...validEnv, APP_AUTH_CACHE_HMAC_KEY: validEnv.APP_SECRET });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/APP_SECRET and APP_AUTH_CACHE_HMAC_KEY use the same secret/);
    expect(message).not.toContain(validEnv.APP_SECRET);
  });

  it('APP_KEY_SEPARATION_REQUIRED=true refuses without dedicated keys and boots with them', () => {
    expect(() => validate({ ...validEnv, APP_KEY_SEPARATION_REQUIRED: 'true' })).toThrow(/APP_KEY_SEPARATION_REQUIRED=true requires/);
    const env = validate({
      ...validEnv,
      APP_KEY_SEPARATION_REQUIRED: 'true',
      APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k1', secret: strong }]),
      APP_JWT_ACTIVE_KID: 'k1',
      APP_JWT_LEGACY_VERIFY_ENABLED: 'false',
      APP_AUTH_CACHE_HMAC_KEY: 'M1n2B3v4C5x6Z7l8K9j0H1g2F3d4S5aQ',
    });
    expect(env.APP_KEY_SEPARATION_REQUIRED).toBe(true);
  });

  it('production refuses a weak APP_SECRET with the other production rules; development keeps working', () => {
    expect(() => validate({ ...validEnv, ...productionEnv, NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) })).toThrow(/for production:[\s\S]*APP_SECRET has fewer than 8 distinct characters/);
    expect(() => validate({ ...validEnv, APP_SECRET: 'x'.repeat(40) })).not.toThrow();
  });
});
