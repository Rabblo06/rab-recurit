import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { EnvironmentVariables } from './environment-variables';
import { normaliseKeyPrefix } from '../storage/storage-key-prefix';

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  // `KEY=` in a .env file sets an empty string, not undefined — @IsOptional()
  // only skips null/undefined, so an unset-but-present optional var (e.g.
  // SENTRY_DSN left blank, matching .env.example's own convention) would
  // otherwise fail its @IsUrl()/etc. validator instead of being treated as
  // "not provided". The key must be deleted entirely, not just set to
  // undefined — plainToInstance only falls back to a class's default
  // property initializer when the key is absent, not when it's present
  // with value undefined.
  const normalised = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );

  const validated = plainToInstance(EnvironmentVariables, normalised, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${message}`);
  }

  // Cross-field rule: an S3 deployment missing any of these must fail at boot, not on the first upload at 2am.
  // S3_ENDPOINT is required here (not merely "optional, only for non-AWS providers") because production's actual
  // target is Cloudflare R2, which has no default AWS endpoint to fall back to — a boot with S3 selected and no
  // endpoint is always a misconfiguration for this deployment, never a valid "plain AWS S3" state today.
  if (validated.STORAGE_DRIVER === 'S3') {
    const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT'] as const).filter((key) => !validated[key]);
    if (validated.S3_SERVER_SIDE_ENCRYPTION === 'aws:kms' && !validated.S3_KMS_KEY_ID) missing.push('S3_KMS_KEY_ID' as never);
    if (missing.length > 0) {
      throw new Error(`Invalid environment configuration:
STORAGE_DRIVER=S3 requires ${missing.join(', ')}`);
    }
  }

  // Fail fast on a malformed STORAGE_KEY_PREFIX (e.g. `../etc`) rather than on the first object write.
  try {
    normaliseKeyPrefix(validated.STORAGE_KEY_PREFIX);
  } catch (error) {
    throw new Error(`Invalid environment configuration:\n${(error as Error).message}`);
  }

  // P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.7): per-provider required-field checks
  // (client id/secret/callback when a provider is enabled) are already covered by the
  // @ValidateIf-gated class-validator decorators above — this is the one cross-field rule those
  // decorators cannot express on their own: the process must not start with NO way for anyone to
  // sign in at all. Independent of (layered on top of, not instead of) the per-organisation
  // CHECK constraint (organisation_auth_provider_not_all_disabled) — this is the SYSTEM-level
  // guard; that one is the TENANT-level guard.
  if (!validated.AUTH_PASSWORD_ENABLED && !validated.AUTH_GOOGLE_ENABLED && !validated.AUTH_MICROSOFT_ENABLED) {
    throw new Error(
      'Invalid environment configuration:\nAt least one of AUTH_PASSWORD_ENABLED, AUTH_GOOGLE_ENABLED, AUTH_MICROSOFT_ENABLED must be true — the process must not start with no way for anyone to sign in.',
    );
  }

  // Issuer overrides exist only for local mock identity providers in tests — never in production.
  if (validated.NODE_ENV === 'production' && (validated.AUTH_GOOGLE_ISSUER_URL || validated.AUTH_MICROSOFT_ISSUER_URL)) {
    throw new Error(
      'Invalid environment configuration:\nAUTH_GOOGLE_ISSUER_URL / AUTH_MICROSOFT_ISSUER_URL are test-only and must not be set in production.',
    );
  }

  // CF-40 / CF-16 / CF-34 (October 15 audit): production must never boot on a development default. Development and test
  // are untouched, so local Docker keeps working. Every rule names the variable to fix; no value is echoed.
  if (validated.NODE_ENV === 'production') {
    const problems = productionConfigurationProblems(validated);
    if (problems.length > 0) {
      throw new Error(`Invalid environment configuration for production:\n${problems.join('\n')}`);
    }
  }

  return validated;
}

/** Exported for its unit test. Pure: reads only the validated configuration. */
export function productionConfigurationProblems(env: EnvironmentVariables): string[] {
  const problems: string[] = [];
  if (env.EMAIL_DRIVER === 'LOGGER') problems.push('EMAIL_DRIVER=LOGGER writes live reset and invitation links to the logs. Configure a real email driver.');
  if (env.STORAGE_DRIVER === 'LOCAL') problems.push('STORAGE_DRIVER=LOCAL keeps uploads on one container disk. Configure S3-compatible storage.');
  if (env.PUSH_ENABLED && env.PUSH_PROVIDER === 'FAKE') problems.push('PUSH_ENABLED=true with PUSH_PROVIDER=FAKE sends nothing. Configure a real push provider or disable push.');
  for (const [name, value] of [['APP_URL', env.APP_URL], ['ACCOUNTS_URL', env.ACCOUNTS_URL]] as const) {
    if (!isHttpsPublicUrl(value)) problems.push(`${name} must be an https:// URL that is not localhost.`);
  }
  const origins = (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some((o) => !isHttpsPublicUrl(o))) {
    problems.push('CORS_ORIGINS must list only https:// origins that are not localhost (the development default is not allowed).');
  }
  const cidrs = (env.TRUSTED_PROXY_CIDRS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (cidrs.length === 0) {
    problems.push('TRUSTED_PROXY_CIDRS is empty. Behind a proxy every client then shares one rate-limit bucket (one attacker can lock everyone out of sign-in). List the exact proxy addresses.');
  } else {
    const broad = cidrs.filter(isOverBroadCidr);
    if (broad.length > 0) problems.push(`TRUSTED_PROXY_CIDRS contains over-broad range(s) (${broad.length}): anyone inside them could choose their own client IP. Use the exact proxy addresses (IPv4 /16 or narrower, IPv6 /48 or narrower).`);
  }
  return problems;
}

function isHttpsPublicUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'https:' && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function isOverBroadCidr(cidr: string): boolean {
  const [address, prefixText] = cidr.split('/');
  const isV6 = (address ?? '').includes(':');
  if (prefixText === undefined) return false; // a single address
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix)) return true; // malformed: treat as unsafe
  return isV6 ? prefix < 48 : prefix < 16;
}
