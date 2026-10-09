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

  return validated;
}
